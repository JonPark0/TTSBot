"""Supertonic 3 음성 합성 엔진 (LLM-8850 카드 또는 CPU float).

호스트(CPU): 텍스트 처리, 길이 예측, 텍스트 인코더, rope, 잡음, 오일러 갱신.
카드(ax) 또는 CPU(ort): 추정기 8단계 + 보코더. 입력 크기가 텍스트 96, 잠재 96(약 6.7초)으로 고정이라
긴 메시지는 길이 예측기로 재 가며 문장 → 쉼표 → 띄어쓰기 → 글자 순으로 나눠 조각마다 따로 만든다.
조각 하나를 만드는 시간은 길이와 상관없이 일정하다 (카드 약 0.18초).

models 폴더: st_est.axmodel, st_voc.axmodel (ax) 또는 st_est_T96_L96.onnx, st_voc_L96.onnx (ort).
st_rope_T96_L96.onnx, time_table.npy는 models 폴더에 없으면 이 패키지의 assets/에서 읽는다.
텍스트 처리기·길이 예측기·텍스트 인코더·목소리는 supertonic 패키지의 모델 폴더(~/.cache/supertonic3)에서 읽는다.
"""
import re
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort

T, L, STEPS, SPEED = 96, 96, 8, 1.05
ROPE = ["rope_lat_sin", "rope_lat_cos", "rope_txt_sin", "rope_txt_cos"]
GAP_S = 0.12  # 조각 사이 쉼
PEAK, MAX_GAIN = 0.89, 3.0  # 메시지 단위 최대 진폭 맞추기 (-1 dBFS, 최대 3배)
SENTENCE = re.compile(r"(?<=[.!?。！？…])\s+|(?<=[。！？])|\n+")
CLAUSE = re.compile(r"(?<=[,、，;:])\s*")
# 띄어쓰기로 나눌 때 경계로 삼기 좋은 낱말 끝 (한국어 연결 어미, 문장 부호)
JOIN_END = re.compile(r"(는데|은데|인데|지만|니까|으니|면서|어서|아서|해서|고|면|며|요|죠|다|줘|자|네|[,.!?~])$")
ASSETS = Path(__file__).with_name("assets")


def _pad(x, n):
    return np.pad(x, [(0, 0)] * (x.ndim - 1) + [(0, n - x.shape[-1])])


def _ort(path, threads):
    o = ort.SessionOptions(); o.intra_op_num_threads = threads; o.inter_op_num_threads = 1
    o.log_severity_level = 3
    return ort.InferenceSession(str(path), o, providers=["CPUExecutionProvider"])


class _OrtModel:
    def __init__(self, path, threads):
        self.s = _ort(path, threads)

    def run(self, feeds):
        return self.s.run(None, feeds)[0]

    def close(self):
        pass


class _AxModel:
    """axcl_session.AxclSession 감싸기: 첫 출력을 float32 배열로 돌려준다. shared를 주면 그 런타임을 같이 쓴다."""

    def __init__(self, path, shared=None):
        from .axcl_session import AxclSession
        self.s = AxclSession(Path(path), shared_runtime=shared.s if shared else None)

    def run(self, feeds):
        out, _ms = self.s.run({k: np.ascontiguousarray(v, np.float32) for k, v in feeds.items()})
        return next(iter(out.values()))

    def close(self):
        self.s.close()


class Engine:
    def __init__(self, models, backend="ax", voc_backend=None, threads=1, model_dir=None):
        from supertonic import loader
        m = Path(models)
        voc_backend = voc_backend or backend
        md = Path(model_dir) if model_dir else loader.get_cache_dir("supertonic-3")
        if not loader.has_all_onnx_modules(md):
            loader.download_model(md, "supertonic-3")
        cfg = loader.load_configs(md)
        self.sr = cfg["ae"]["sample_rate"]
        self.chunk = cfg["ae"]["base_chunk_size"] * cfg["ttl"]["chunk_compress_factor"]
        self.model_dir = md
        self.backend = backend if backend == voc_backend else f"{backend}+{voc_backend}"
        self.tp = loader.load_text_processor(md)
        self.dp = _ort(md / "onnx" / "duration_predictor.onnx", threads)
        self.enc = _ort(md / "onnx" / "text_encoder.onnx", threads)
        local = lambda name: m / name if (m / name).exists() else ASSETS / name
        self.rope = _ort(local("st_rope_T96_L96.onnx"), 1)
        self.table = np.load(local("time_table.npy")).astype(np.float32)
        self._styles = {}
        self.est = _AxModel(m / "st_est.axmodel") if backend == "ax" else _OrtModel(m / "st_est_T96_L96.onnx", threads)
        if voc_backend == "ax":
            self.voc = _AxModel(m / "st_voc.axmodel", shared=self.est if backend == "ax" else None)
        else:
            self.voc = _OrtModel(m / "st_voc_L96.onnx", threads)

    # ---------- 목소리 ----------
    def voices(self):
        return sorted(p.stem for p in (self.model_dir / "voice_styles").glob("*.json"))

    def style(self, voice):
        if voice not in self._styles:
            from supertonic import loader
            self._styles[voice] = loader.load_voice_style_from_name(self.model_dir, voice)
        return self._styles[voice]

    # ---------- 나누기 ----------
    def _measure(self, text, lang, st):
        """(text_ids, text_mask, 음성 길이, 잠재 길이). 길이 예측기는 길이 제한이 없어 T를 넘는 글도 잰다."""
        ids, tmask = self.tp([text], lang)
        dur = self.dp.run(None, {"text_ids": ids, "style_dp": st.dp, "text_mask": tmask})[0]
        wav_len = int(dur[0] / SPEED * self.sr)
        return ids, tmask, wav_len, (wav_len + self.chunk - 1) // self.chunk

    def fits(self, text, lang, st):
        ids, _, _, lat = self._measure(text, lang, st)
        return ids.shape[1] <= T and lat <= L

    def _balanced(self, words, lang, st):
        """띄어쓰기로만 나눌 수 있는 긴 문장을 동적 계획법으로 나눈다: 조각 수는 적게, 길이는 고르게,
        경계는 연결 어미(…는데, …고, …면) 뒤를 우선. 조각 길이는 앞부분 길이의 차로 어림하고
        (따로 읽으면 앞뒤 여백만큼 약 9프레임 늘어난다), 고른 뒤 실제로 재서 확인한다."""
        n = len(words)
        pre = [0] + [self._measure(" ".join(words[:k]), lang, st)[3] for k in range(1, n + 1)]
        est = lambda a, b: pre[b] - pre[a] + (9 if a else 0)
        best, back = [0.0] + [float("inf")] * n, [0] * (n + 1)
        for b in range(1, n + 1):
            bad_end = 0 if b == n or JOIN_END.search(words[b - 1]) else 0.35
            for a in range(b - 1, -1, -1):
                e = est(a, b)
                if e > L - 5:
                    break
                c = best[a] + 1.0 + 2 * (e / L) ** 2 + bad_end
                if c < best[b]:
                    best[b], back[b] = c, a
        if best[n] == float("inf"):
            return None
        cuts, b = [], n
        while b:
            cuts.append((back[b], b)); b = back[b]
        out = []
        for a, b in reversed(cuts):
            piece = " ".join(words[a:b])
            out.extend([piece] if self.fits(piece, lang, st) else self._split(piece, lang, st, 2))
        return out

    def _split(self, text, lang, st, level=0):
        """넘치는 문장을 쉼표(0) → 띄어쓰기(1) → 글자(2) 단위로 나눠, 들어가는 만큼씩 묶는다."""
        if self.fits(text, lang, st):
            return [text]
        parts = [p for p in CLAUSE.split(text) if p.strip()] if level == 0 else text.split() if level == 1 else list(text)
        if len(parts) <= 1:
            return self._split(text, lang, st, level + 1) if level < 2 else [text]
        if level == 1 and (pieces := self._balanced(parts, lang, st)):
            return pieces
        sep = "" if level == 2 else " "
        out, cur = [], ""
        for p in parts:
            cand = cur + sep + p if cur else p
            if self.fits(cand, lang, st):
                cur = cand
                continue
            if cur:
                out.append(cur)
            cur = ""
            if self.fits(p, lang, st):
                cur = p
            else:
                out.extend(self._split(p, lang, st, level + 1))
        if cur:
            out.append(cur)
        return out

    def plan(self, text, lang, voice):
        """메시지를 카드 크기에 맞는 조각들로. 문장으로 먼저 나누고, 들어가는 만큼 다시 합친다."""
        st = self.style(voice)
        pieces = []
        for s in (x.strip() for x in SENTENCE.split(text)):
            if s:
                pieces.extend(self._split(s, lang, st))
        out, sep = [], "" if lang == "ja" else " "
        for p in pieces:
            if out and self.fits(out[-1] + sep + p, lang, st):
                out[-1] += sep + p
            else:
                out.append(p)
        return out

    # ---------- 합성 ----------
    def synth_piece(self, text, lang, voice, seed=None):
        """조각 하나 → (float32 음성, 정보). 조각은 plan()이 돌려준 것이어야 한다."""
        t0 = time.perf_counter()
        st = self.style(voice)
        ids, tmask, wav_len, lat = self._measure(text, lang, st)
        if ids.shape[1] > T or lat > L:
            raise ValueError(f"piece too long: text {ids.shape[1]}/{T}, latent {lat}/{L}")
        emb = self.enc.run(None, {"text_ids": ids, "style_ttl": st.ttl, "text_mask": tmask})[0]
        lmask = np.zeros((1, 1, L), np.float32); lmask[..., :lat] = 1
        tm = _pad(tmask.astype(np.float32), T)
        rope = dict(zip(ROPE, self.rope.run(ROPE, {"latent_mask": lmask, "text_mask": tm})))
        last = np.zeros((L, 1), np.float32); last[lat - 1] = 1
        base = {"text_emb": _pad(emb.astype(np.float32), T), "style_ttl": st.ttl.astype(np.float32),
                "latent_mask": lmask, "text_mask": tm, "lat_last": last, **rope}
        x = _pad(np.random.default_rng(seed).standard_normal((1, 144, lat)).astype(np.float32), L) * lmask
        t1 = time.perf_counter()
        for k in range(STEPS):
            v = self.est.run({"noisy_latent": x, "time_emb": self.table[k], **base})
            x = (x + v.reshape(x.shape) / STEPS) * lmask
        t2 = time.perf_counter()
        vmask = np.zeros((1, 1, 6 * L), np.float32); vmask[..., :6 * lat] = 1
        vlast = np.zeros((6 * L, 1), np.float32); vlast[6 * lat - 1] = 1
        wav = self.voc.run({"latent": x, "voc_mask": vmask, "voc_last": vlast}).reshape(-1)[:wav_len]
        t3 = time.perf_counter()
        return wav.astype(np.float32), {"text": text, "host_ms": round((t1 - t0) * 1e3, 1), "est_ms": round((t2 - t1) * 1e3, 1),
                                        "voc_ms": round((t3 - t2) * 1e3, 1), "audio_s": round(wav_len / self.sr, 3),
                                        "latent_len": int(lat), "text_len": int(ids.shape[1])}

    def synth(self, text, lang, voice="F1", seed=None):
        """메시지 → (float32 음성 전체, 정보). 조각 사이에 GAP_S 쉼을 넣고 메시지 단위로 최대 진폭을 맞춘다.
        seed=None이면 매번 다른 잡음, 정수면 조각마다 seed+순번 (같은 입력 → 같은 음성)."""
        t0 = time.perf_counter()
        pieces = self.plan(text, lang, voice)
        plan_ms = (time.perf_counter() - t0) * 1e3
        wavs, infos = [], []
        gap = np.zeros(int(GAP_S * self.sr), np.float32)
        for i, piece in enumerate(pieces):
            w, info = self.synth_piece(piece, lang, voice, None if seed is None else seed + i)
            wavs += [gap, w] if i else [w]
            infos.append(info)
        wav = np.concatenate(wavs) if wavs else np.zeros(0, np.float32)
        peak = float(np.abs(wav).max()) if wav.size else 0.0
        if peak > 0:
            wav = wav * min(PEAK / peak, MAX_GAIN)
        return wav, {"pieces": infos, "plan_ms": round(plan_ms, 1), "gen_s": round(time.perf_counter() - t0, 4),
                     "audio_s": round(wav.size / self.sr, 3)}

    def close(self):
        for s in (self.voc, self.est):  # 카드 런타임을 가진 세션(est)을 마지막에 닫는다
            s.close()
