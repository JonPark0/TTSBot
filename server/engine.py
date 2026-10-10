"""Supertonic 3 음성 합성 엔진 (LLM-8850 카드 또는 CPU float).

호스트(CPU): 텍스트 처리, 길이 예측, 텍스트 인코더, rope, 잡음, 오일러 갱신.
카드(ax) 또는 CPU(ort): 추정기 8단계 + 보코더. 입력 크기가 고정된 버킷(텍스트 T, 잠재 L)으로 돈다.
기본 버킷은 T=L=96(약 6.7초)이고, models 폴더에 더 큰 버킷(예: T=L=192, 약 13초)이 있으면 같이 쓴다.
긴 메시지는 길이 예측기로 재 가며 가장 큰 버킷에 맞게 문장 → 쉼표 → 띄어쓰기 → 글자 순으로 나누고,
조각마다 들어가는 가장 작은 버킷으로 만든다. 한 버킷 안에서는 조각 길이와 상관없이 시간이 일정하다
(카드 96 버킷 약 0.18초, 192 버킷 약 0.35초).
모델은 조각마다 앞에 약 0.5초, 뒤에 약 0.6초 무음을 만든다. 잇기 전에 짧은 여유만 남기고 잘라서
첫 소리가 빨리 나오고 조각 사이 쉼이 자연스럽게 한다.

models 폴더 (버킷마다 한 쌍):
  ax : st_est_T{T}_L{L}.axmodel, st_voc_L{L}.axmodel. 96 버킷은 옛 이름 st_est.axmodel, st_voc.axmodel도 받는다.
  ort: st_est_T{T}_L{L}.onnx, st_voc_L{L}.onnx
st_rope_T{T}_L{L}.onnx, time_table.npy는 models 폴더에 없으면 이 패키지의 assets/에서 읽는다.
텍스트 처리기·길이 예측기·텍스트 인코더·목소리는 supertonic 패키지의 모델 폴더(~/.cache/supertonic3)에서 읽는다.
"""
import re
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort

T, L, STEPS, SPEED = 96, 96, 8, 1.05  # T, L: 기본 버킷
BUCKET_FILE = re.compile(r"st_est_T(\d+)_L(\d+)\.(axmodel|onnx)$")
ROPE = ["rope_lat_sin", "rope_lat_cos", "rope_txt_sin", "rope_txt_cos"]
TRIM_DB, LEAD_S, TAIL_S, FADE_S = -45.0, 0.06, 0.10, 0.01  # 무음 자르기: 문턱(조각 최대 대비), 남길 앞·뒤 여유, 페이드
GAP_S, SENT_GAP_S = 0.03, 0.15  # 자른 조각 사이에 더 넣는 쉼: 쉼표·낱말 경계 / 문장 경계
PEAK, MAX_GAIN = 0.89, 3.0  # 메시지 단위 최대 진폭 맞추기 (-1 dBFS, 최대 3배)
SENTENCE = re.compile(r"(?<=[.!?。！？…])\s+|(?<=[。！？])|\n+")
SENTENCE_END = re.compile(r"[.!?。！？…]\s*$")
CLAUSE = re.compile(r"(?<=[,、，;:])\s*")
# 띄어쓰기로 나눌 때 경계로 삼기 좋은 낱말 끝 (한국어 연결 어미, 문장 부호)
JOIN_END = re.compile(r"(는데|은데|인데|지만|니까|으니|면서|어서|아서|해서|고|면|며|요|죠|다|줘|자|네|[,.!?~])$")
# 띄어쓰기가 없는 일본어는 조사·て 뒤에 한자·가타카나가 이어지는 곳을 낱말 경계 대신 쓴다
# (뒤가 히라가나면 "で|きる"처럼 낱말 안일 수 있어서 뺀다). 글자 단위로 끊는 것보다 낫다.
JA_UNIT = re.compile(r"(?<=[はがをにでともへやて])(?=[\u3400-\u9fff\u30a0-\u30ff])")
ASSETS = Path(__file__).with_name("assets")


def _pad(x, n):
    return np.pad(x, [(0, 0)] * (x.ndim - 1) + [(0, n - x.shape[-1])])


def trim(wav, sr):
    """앞뒤 조용한 구간을 LEAD_S·TAIL_S 여유만 남기고 자른다. 10 ms 프레임 RMS가 최대 대비 TRIM_DB를 넘는 곳이 소리."""
    f = int(0.01 * sr)
    n = len(wav) // f
    if n == 0:
        return wav
    rms = np.sqrt((wav[: n * f].reshape(n, f).astype(np.float64) ** 2).mean(1) + 1e-20)
    if rms.max() < 1e-6:
        return wav
    loud = np.nonzero(20 * np.log10(rms / rms.max()) > TRIM_DB)[0]
    a = max(0, loud[0] * f - int(LEAD_S * sr))
    b = min(len(wav), (loud[-1] + 1) * f + int(TAIL_S * sr))
    out = wav[a:b].copy()
    k = min(int(FADE_S * sr), len(out) // 2)
    ramp = np.linspace(0, 1, k, dtype=np.float32)
    if a > 0:
        out[:k] *= ramp
    if b < len(wav):
        out[len(out) - k:] *= ramp[::-1]
    return out


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


def parse_buckets(s):
    """"96,192" → [96, 192]. 비었으면 None (models 폴더에 있는 버킷 전부)."""
    return [int(x) for x in str(s).replace(" ", "").split(",") if x] or None if s else None


class _Bucket:
    """정적 크기 하나 (텍스트 T, 잠재 L): 추정기·보코더 세션과 호스트 rope 그래프."""

    def __init__(self, T, L, est, voc, rope):
        self.T, self.L, self.est, self.voc, self.rope = T, L, est, voc, rope


def find_buckets(models, backend="ax", voc_backend=None, only=None):
    """models 폴더의 버킷들 → [(T, L, 추정기 경로, 보코더 경로)], L 오름차순. only: 쓸 L 목록 (None이면 전부)."""
    m, voc_backend = Path(models), voc_backend or backend
    ext = {"ax": "axmodel", "ort": "onnx"}
    found = {}
    for p in m.glob(f"st_est_T*_L*.{ext[backend]}"):
        if mt := BUCKET_FILE.match(p.name):
            found[(int(mt[1]), int(mt[2]))] = p
    if backend == "ax" and (m / "st_est.axmodel").exists():
        found.setdefault((T, L), m / "st_est.axmodel")
    out = []
    for (t, l), est in sorted(found.items(), key=lambda kv: (kv[0][1], kv[0][0])):
        if only and l not in only:
            continue
        voc = m / f"st_voc_L{l}.{ext[voc_backend]}"
        if voc_backend == "ax" and l == L and not voc.exists():
            voc = m / "st_voc.axmodel"
        if not voc.exists():
            raise FileNotFoundError(f"vocoder for bucket T{t}_L{l} not found: {voc}")
        out.append((t, l, est, voc))
    if not out:
        raise FileNotFoundError(f"no estimator model for backend {backend} in {m}" + (f" (buckets {only})" if only else ""))
    return out


class Engine:
    def __init__(self, models, backend="ax", voc_backend=None, threads=1, model_dir=None, buckets=None):
        """buckets: 쓸 버킷의 L 목록 (예: [96]). None이면 models 폴더에 있는 버킷 전부."""
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
        self.table = np.load(local("time_table.npy")).astype(np.float32)
        self._styles = {}
        self.buckets, self._owner = [], None  # _owner: 카드 런타임을 가진 세션 (나머지는 그 런타임을 같이 쓴다)
        for t, l, est_p, voc_p in find_buckets(m, backend, voc_backend, buckets):
            est = _AxModel(est_p, shared=self._owner) if backend == "ax" else _OrtModel(est_p, threads)
            self._owner = self._owner or (est if backend == "ax" else None)
            voc = _AxModel(voc_p, shared=self._owner) if voc_backend == "ax" else _OrtModel(voc_p, threads)
            self._owner = self._owner or (voc if voc_backend == "ax" else None)
            self.buckets.append(_Bucket(t, l, est, voc, _ort(local(f"st_rope_T{t}_L{l}.onnx"), 1)))
        self.bucket_sizes = [[b.T, b.L] for b in self.buckets]

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

    def _bucket(self, n_ids, lat):
        """들어가는 가장 작은 버킷 (없으면 None)."""
        return next((b for b in self.buckets if n_ids <= b.T and lat <= b.L), None)

    def fits(self, text, lang, st):
        ids, _, _, lat = self._measure(text, lang, st)
        return self._bucket(ids.shape[1], lat) is not None

    def _balanced(self, words, lang, st, sep=" "):
        """띄어쓰기로만 나눌 수 있는 긴 문장을 동적 계획법으로 나눈다: 조각 수는 적게, 길이는 고르게,
        경계는 연결 어미(…는데, …고, …면) 뒤를 우선. 조각의 잠재 길이와 텍스트 길이는 앞부분 길이의 차로
        어림하고 (따로 읽으면 앞뒤 여백만큼 잠재가 약 9프레임 늘어난다), 고른 뒤 실제로 잰다.
        넘치는 조각이 있으면 여유를 늘려 다시 나누고, 끝내 안 되면 None (낱말 단위로 채우는 방식으로 넘어감).
        sep="" (일본어)이면 words는 조사 뒤에서 자른 단위라서 모든 경계를 똑같이 본다."""
        n, big = len(words), self.buckets[-1]
        m = [self._measure(sep.join(words[:k]), lang, st) for k in range(1, n + 1)]
        pre, pre_ids = [0] + [x[3] for x in m], [0] + [x[0].shape[1] for x in m]
        for margin in range(5, big.L // 2, 8):
            best, back = [0.0] + [float("inf")] * n, [0] * (n + 1)
            for b in range(1, n + 1):
                bad_end = 0 if b == n or not sep or JOIN_END.search(words[b - 1]) else 0.35
                for a in range(b - 1, -1, -1):
                    e = pre[b] - pre[a] + (9 if a else 0)
                    if e > big.L - margin or pre_ids[b] - pre_ids[a] > big.T - margin:
                        break
                    c = best[a] + 1.0 + 2 * (e / big.L) ** 2 + bad_end
                    if c < best[b]:
                        best[b], back[b] = c, a
            if best[n] == float("inf"):
                return None
            cuts, b = [], n
            while b:
                cuts.append((back[b], b)); b = back[b]
            pieces = [sep.join(words[a:b]) for a, b in reversed(cuts)]
            if all(self.fits(p, lang, st) for p in pieces):
                return pieces
        return None

    def _split(self, text, lang, st, level=0):
        """넘치는 문장을 쉼표(0) → 띄어쓰기(1, 일본어는 조사 뒤) → 글자(2) 단위로 나눠, 들어가는 만큼씩 묶는다."""
        if self.fits(text, lang, st):
            return [text]
        sep = "" if level == 2 or lang == "ja" else " "
        if level == 0:
            parts = [p for p in CLAUSE.split(text) if p.strip()]
        elif level == 1:
            parts = [p for p in JA_UNIT.split(text) if p] if lang == "ja" else text.split()
        else:
            parts = list(text)
        if len(parts) <= 1:
            return self._split(text, lang, st, level + 1) if level < 2 else [text]
        if level == 1 and (pieces := self._balanced(parts, lang, st, sep)):
            return pieces
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
        """메시지를 가장 큰 버킷에 맞는 조각들로. 문장으로 먼저 나누고, 들어가는 만큼 다시 합친다."""
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
        b = self._bucket(ids.shape[1], lat)
        if b is None:
            big = self.buckets[-1]
            raise ValueError(f"piece too long: text {ids.shape[1]}/{big.T}, latent {lat}/{big.L}")
        T, L = b.T, b.L
        emb = self.enc.run(None, {"text_ids": ids, "style_ttl": st.ttl, "text_mask": tmask})[0]
        lmask = np.zeros((1, 1, L), np.float32); lmask[..., :lat] = 1
        tm = _pad(tmask.astype(np.float32), T)
        rope = dict(zip(ROPE, b.rope.run(ROPE, {"latent_mask": lmask, "text_mask": tm})))
        last = np.zeros((L, 1), np.float32); last[lat - 1] = 1
        base = {"text_emb": _pad(emb.astype(np.float32), T), "style_ttl": st.ttl.astype(np.float32),
                "latent_mask": lmask, "text_mask": tm, "lat_last": last, **rope}
        x = _pad(np.random.default_rng(seed).standard_normal((1, 144, lat)).astype(np.float32), L) * lmask
        t1 = time.perf_counter()
        for k in range(STEPS):
            v = b.est.run({"noisy_latent": x, "time_emb": self.table[k], **base})
            x = (x + v.reshape(x.shape) / STEPS) * lmask
        t2 = time.perf_counter()
        vmask = np.zeros((1, 1, 6 * L), np.float32); vmask[..., :6 * lat] = 1
        vlast = np.zeros((6 * L, 1), np.float32); vlast[6 * lat - 1] = 1
        wav = b.voc.run({"latent": x, "voc_mask": vmask, "voc_last": vlast}).reshape(-1)[:wav_len]
        t3 = time.perf_counter()
        return wav.astype(np.float32), {"text": text, "host_ms": round((t1 - t0) * 1e3, 1), "est_ms": round((t2 - t1) * 1e3, 1),
                                        "voc_ms": round((t3 - t2) * 1e3, 1), "audio_s": round(wav_len / self.sr, 3),
                                        "latent_len": int(lat), "text_len": int(ids.shape[1]), "bucket": L}

    def synth(self, text, lang, voice="F1", seed=None):
        """메시지 → (float32 음성 전체, 정보). 조각마다 앞뒤 무음을 자르고, 사이에 쉼(문장 경계 SENT_GAP_S,
        그 밖 GAP_S)을 넣어 잇고, 메시지 단위로 최대 진폭을 맞춘다.
        seed=None이면 매번 다른 잡음, 정수면 조각마다 seed+순번 (같은 입력 → 같은 음성)."""
        t0 = time.perf_counter()
        pieces = self.plan(text, lang, voice)
        plan_ms = (time.perf_counter() - t0) * 1e3
        wavs, infos = [], []
        for i, piece in enumerate(pieces):
            w, info = self.synth_piece(piece, lang, voice, None if seed is None else seed + i)
            if i:
                gap = SENT_GAP_S if SENTENCE_END.search(pieces[i - 1]) else GAP_S
                wavs.append(np.zeros(int(gap * self.sr), np.float32))
            wavs.append(trim(w, self.sr))
            infos.append(info)
        wav = np.concatenate(wavs) if wavs else np.zeros(0, np.float32)
        peak = float(np.abs(wav).max()) if wav.size else 0.0
        if peak > 0:
            wav = wav * min(PEAK / peak, MAX_GAIN)
        return wav, {"pieces": infos, "plan_ms": round(plan_ms, 1), "gen_s": round(time.perf_counter() - t0, 4),
                     "audio_s": round(wav.size / self.sr, 3)}

    def close(self):
        sessions = [s for b in reversed(self.buckets) for s in (b.voc, b.est)]
        for s in sorted(sessions, key=lambda s: s is self._owner):  # 카드 런타임을 가진 세션을 마지막에 닫는다
            s.close()
