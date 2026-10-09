"""Supertonic 3 → LLM-8850 카드용 ONNX 준비 (2026-10 변환에 실제로 쓴 스크립트). supertonic 1.3.1 + onnx + onnxsim 환경에서 실행.

NPU로 가는 것: 추정기(속도장 v만 출력, 시간 임베딩은 입력으로 받음)와 보코더. 정적 모양 하나(T, L).
호스트에 남는 것: 길이 예측기, 텍스트 인코더, 시간 임베딩 표(8단계), 잡음, 오일러 갱신 x = (x + v/steps) * mask.

  python st_export.py measure            # 시험 문장들의 text_ids 길이와 latent 길이 (ST_ROOT/data/sentences.jsonl)
  python st_export.py export --T 96 --L 96
  python st_export.py voc4d  --T 96 --L 96   # 보코더 1D conv → 2D (Pulsar2 TileFail 회피)
  python st_export.py check  --T 96 --L 96   # 동적 원본 대 정적 그래프(같은 잡음) 비교
  python st_export.py calib  --T 96 --L 96   # Pulsar2 보정 tar (NumpyObject)

경로: ST_ROOT(기본 /NHNHOME/ttsspike), ST_ONNX(원본 supertonic-3 onnx 폴더), ST_WORK(출력 폴더).
"""
import argparse
import io
import os
import json
import tarfile
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
from onnx.utils import Extractor

TS = Path(os.environ.get("ST_ROOT", "/NHNHOME/ttsspike"))
SRC = Path(os.environ.get("ST_ONNX", TS / "hf/supertonic/onnx"))
W = Path(os.environ.get("ST_WORK", TS / "st_card"))
STEPS, SPEED = 8, 1.05
TIME_OUT = "/vector_estimator/vector_field/time_encoder/mlp/mlp.2/linear/Gemm_output_0"
V_OUT = "/Sub_output_0"  # 추정기 안에서 조건/무조건 두 경로를 합친 속도장 (CFG)
EST_IN = ["noisy_latent", "text_emb", "style_ttl", "latent_mask", "text_mask"]
# 회전 위치 인코딩의 sin/cos는 실제 길이(마스크)로 정해져 상수로 접히지 않는다 → 호스트에서 계산해 입력으로
_A = "/vector_estimator/vector_field/main_blocks.3/attn/"
ROPE = {_A + "Sin_output_0": "rope_lat_sin", _A + "Cos_output_0": "rope_lat_cos",
        _A + "Sin_1_output_0": "rope_txt_sin", _A + "Cos_1_output_0": "rope_txt_cos"}
RENAME = {TIME_OUT: "time_emb", **ROPE}
CALIB_TEXTS = [  # 시험 문장과 겹치지 않는 보정용 문장
    ("ko", "주말에 친구들이랑 캠핑 가기로 했어요."), ("ko", "이 노래 제목이 뭐였는지 기억나세요?"),
    ("ko", "지하철이 고장 나서 조금 늦을 것 같아요."), ("ko", "오늘 저녁은 김치찌개를 끓여 먹을 거예요."),
    ("ko", "크크 그건 좀 너무했다"), ("ko", "다음 판은 내가 탱커 할게"), ("ko", "방송 소리가 너무 작아요"),
    ("ko", "삼십 분만 쉬었다가 다시 시작합시다."), ("ja", "週末は家でゆっくり映画を見ました。"),
    ("ja", "その件については後で連絡します。"), ("ja", "次のラウンドも頑張りましょう。"), ("ja", "音が途切れて聞こえません。"),
    ("en", "Let's take a short break and come back in five."), ("en", "Who wants to join the next match?"),
    ("en", "The stream audio is a little too quiet."), ("en", "I forgot to save my progress again."),
]
VOICES = ["F1", "M1"]


def engine():
    from supertonic import TTS
    tts = TTS(model="supertonic-3", auto_download=True, intra_op_num_threads=1, inter_op_num_threads=1)
    for obj in (tts, *vars(tts).values()):
        if hasattr(obj, "vector_est_ort"):
            return tts, obj
    raise RuntimeError("엔진을 찾지 못함")


def front(eng, style, text, lang):
    """텍스트 → (text_ids, text_mask, text_emb, latent_len, wav_len). 동적 원본 그래프로."""
    ids, tmask = eng.text_processor([text], lang)
    dur, *_ = eng.dp_ort.run(None, {"text_ids": ids, "style_dp": style.dp, "text_mask": tmask})
    dur = dur / SPEED
    emb, *_ = eng.text_enc_ort.run(None, {"text_ids": ids, "style_ttl": style.ttl, "text_mask": tmask})
    wav_len = int(dur[0] * eng.sample_rate)
    chunk = eng.base_chunk_size * eng.chunk_compress_factor
    lat_len = (wav_len + chunk - 1) // chunk
    return ids, tmask, emb, lat_len, wav_len


def sentences():
    for l in open(TS / "data/sentences.jsonl", encoding="utf-8"):
        if l.strip():
            yield json.loads(l)


def pad(x, n, axis=-1):
    w = [(0, 0)] * x.ndim
    w[axis] = (0, n - x.shape[axis])
    return np.pad(x, w)


def cmd_measure(a):
    tts, eng = engine()
    rows = []
    for v in VOICES:
        st = tts.get_voice_style(v)
        for s in sentences():
            ids, _, _, lat, _ = front(eng, st, s["text"], s["lang"])
            rows.append((s["id"], v, ids.shape[1], lat))
    t = np.array([r[2] for r in rows]); l = np.array([r[3] for r in rows])
    print(f"text_ids len: max {t.max()} p95 {np.percentile(t, 95):.0f} mean {t.mean():.1f}")
    print(f"latent len  : max {l.max()} p95 {np.percentile(l, 95):.0f} mean {l.mean():.1f}  (~14.4 frames/s)")
    print("longest:", sorted(rows, key=lambda r: -r[3])[:4])


def replace_edge_pads(m):
    """Pulsar2 양자화기는 3차원 edge Pad를 못 돌린다 → 첫/끝 프레임 조각을 Tile해 Concat으로 바꾼다 (값은 같음)."""
    from onnx import helper, numpy_helper
    g = m.graph
    init = {i.name: i for i in g.initializer}
    nodes, k = [], 0
    for n in g.node:
        mode = [helper.get_attribute_value(a) for a in n.attribute if a.name == "mode"]
        if n.op_type != "Pad" or mode != [b"edge"]:
            nodes.append(n)
            continue
        p = numpy_helper.to_array(init[n.input[1]]).tolist()
        assert len(p) == 6 and p[0] == p[1] == p[3] == p[4] == 0, p
        x, parts, q = n.input[0], [], f"ep{k}"
        for side, (st, en), rep in (("l", (0, 1), p[2]), ("r", (-1, 2**31 - 1), p[5])):
            if rep == 0:
                continue
            for nm, arr in ((f"{q}{side}_s", [st]), (f"{q}{side}_e", [en]), (f"{q}{side}_a", [2]), (f"{q}{side}_t", [1, 1, rep])):
                g.initializer.append(numpy_helper.from_array(np.array(arr, np.int64), nm))
            nodes += [helper.make_node("Slice", [x, f"{q}{side}_s", f"{q}{side}_e", f"{q}{side}_a"], [f"{q}{side}_1"], name=f"{q}{side}_1"),
                      helper.make_node("Tile", [f"{q}{side}_1", f"{q}{side}_t"], [f"{q}{side}"], name=f"{q}{side}")]
            parts.append((side, f"{q}{side}"))
        order = [v for s, v in parts if s == "l"] + [x] + [v for s, v in parts if s == "r"]
        nodes.append(helper.make_node("Concat", order, list(n.output), name=n.name, axis=2))
        k += 1
    del g.node[:]
    g.node.extend(nodes)
    print(f"replace_edge_pads: {k}")
    return m


def conv1d_to_2d(m):
    """1D Conv를 Unsqueeze → 2D Conv(커널 1×K, 시간은 W 축) → Squeeze로. Pulsar2 백엔드가 1D 축을 잘못 잡는 것을 피한다."""
    from onnx import helper, numpy_helper
    g = m.graph
    init = {i.name: i for i in g.initializer}
    shapes = {v.name: [d.dim_value for d in v.type.tensor_type.shape.dim]
              for v in onnx.shape_inference.infer_shapes(m).graph.value_info}
    g.initializer.append(numpy_helper.from_array(np.array([2], np.int64), "c2d_axes"))
    nodes, k = [], 0
    for n in g.node:
        wn = n.input[1] if n.op_type == "Conv" else None
        wshape = list(numpy_helper.to_array(init[wn]).shape) if wn in init else shapes.get(wn)
        if n.op_type != "Conv" or not wshape or len(wshape) != 3:
            nodes.append(n)
            continue
        q = f"c2d{k}"
        if wn in init:  # 상수 가중치는 바로 4D로
            g.initializer.append(numpy_helper.from_array(numpy_helper.to_array(init[wn])[:, :, None, :].copy(), q + "_w"))
        else:  # weight norm처럼 계산되는 가중치는 Unsqueeze 노드로 (Pulsar2가 상수로 접음)
            nodes.append(helper.make_node("Unsqueeze", [wn, "c2d_axes"], [q + "_w"], name=q + "_w"))
        at = {a.name: helper.get_attribute_value(a) for a in n.attribute}
        pads = at.get("pads", [0, 0])
        kw = dict(kernel_shape=[1, wshape[2]], pads=[0, pads[0], 0, pads[1]], strides=[1, at.get("strides", [1])[0]],
                  dilations=[1, at.get("dilations", [1])[0]], group=at.get("group", 1))
        nodes += [helper.make_node("Unsqueeze", [n.input[0], "c2d_axes"], [q + "_x"], name=q + "_x"),
                  helper.make_node("Conv", [q + "_x", q + "_w", *n.input[2:]], [q + "_y"], name=n.name, **kw),
                  helper.make_node("Squeeze", [q + "_y", "c2d_axes"], list(n.output), name=q + "_sq")]
        k += 1
    del g.node[:]
    g.node.extend(nodes)
    print(f"conv1d_to_2d: {k}")
    return m


def cmd_voc4d(a):
    m = conv1d_to_2d(onnx.load(str(W / f"st_voc_L{a.L}.onnx")))
    onnx.save(m, str(W / f"st_voc4d_L{a.L}.onnx"))
    o = sess(W / f"st_voc_L{a.L}.onnx"); n = sess(W / f"st_voc4d_L{a.L}.onnx")
    rng = np.random.default_rng(0)
    f = {"latent": rng.standard_normal((1, 144, a.L)).astype(np.float32), "voc_mask": np.ones((1, 1, 6 * a.L), np.float32),
         "voc_last": np.eye(6 * a.L, 1, -(6 * a.L - 1)).astype(np.float32)}
    print("voc4d vs voc max abs:", float(np.abs(o.run(None, f)[0] - n.run(None, f)[0]).max()))


def replace_erf(m):
    """Pulsar2 7.0-patch1의 NPU용 Erf가 값을 틀리게 낸다(양자화 시뮬레이션은 정상, 컴파일본만 깨짐).
    erf(u) ≈ tanh(c·u·(1 + 0.08943·u²)), c = 2/√π (GELU tanh 근사와 같은 식). u는 ±4로 잘라 범위를 줄인다."""
    from onnx import helper, numpy_helper
    g = m.graph
    for nm, v in (("erf_lo", -4.0), ("erf_hi", 4.0), ("erf_k1", 1.1283792 * 0.0894300), ("erf_k2", 1.1283792)):
        g.initializer.append(numpy_helper.from_array(np.array(v, np.float32), nm))
    nodes, k = [], 0
    for n in g.node:
        if n.op_type != "Erf":
            nodes.append(n)
            continue
        u, q = n.input[0], f"erf{k}"
        nodes += [helper.make_node("Clip", [u, "erf_lo", "erf_hi"], [q + "_c"], name=q + "_c"),
                  helper.make_node("Mul", [q + "_c", q + "_c"], [q + "_w"], name=q + "_w"),
                  helper.make_node("Mul", [q + "_w", "erf_k1"], [q + "_a"], name=q + "_a"),
                  helper.make_node("Add", [q + "_a", "erf_k2"], [q + "_p"], name=q + "_p"),
                  helper.make_node("Mul", [q + "_c", q + "_p"], [q + "_z"], name=q + "_z"),
                  helper.make_node("Tanh", [q + "_z"], list(n.output), name=n.name)]
        k += 1
    del g.node[:]
    g.node.extend(nodes)
    print(f"replace_erf: {k}")
    return m


def static(model, shapes, path):
    import onnxsim
    m, ok = onnxsim.simplify(model, overwrite_input_shapes=shapes)
    assert ok, "onnxsim check failed"
    m = replace_erf(replace_edge_pads(m))
    left = sorted({n.op_type for n in m.graph.node} & {"Sin", "Cos", "Shape", "Range", "ConstantOfShape", "NonZero", "Loop", "If"})
    onnx.save(m, str(path))
    ops = {}
    for n in m.graph.node:
        ops[n.op_type] = ops.get(n.op_type, 0) + 1
    print(f"{path.name}: nodes {len(m.graph.node)}, dynamic-ish ops left {left or 'none'}")
    print("   ops:", dict(sorted(ops.items(), key=lambda x: -x[1])))
    return m


def rename(m, names):
    for n in m.graph.node:
        n.input[:] = [names.get(i, i) for i in n.input]
        n.output[:] = [names.get(o, o) for o in n.output]
    for v in (*m.graph.input, *m.graph.output):
        v.name = names.get(v.name, v.name)
    return m


def fill_edges(m, mask, last):
    """edge 모드 Pad 앞마다 x → x*mask + x[..., 실제 마지막 프레임]*(1-mask).
    0으로 채운 고정 길이에서도 원본(실제 길이에서 가장자리 복제)과 같은 값을 보게 한다.
    mask [1,1,N], last [N,1] (실제 마지막 프레임 위치만 1)는 호스트가 넣는다."""
    from onnx import helper, numpy_helper
    g = m.graph
    g.initializer.append(numpy_helper.from_array(np.array(1, np.float32), "fe_one"))
    nodes = [helper.make_node("Sub", ["fe_one", mask], ["fe_inv"], name="fe_inv")]
    k = 0
    for n in g.node:
        if n.op_type == "Pad":
            x, p = n.input[0], f"fe{k}"
            nodes += [helper.make_node("MatMul", [x, last], [p + "_last"], name=p + "_last"),
                      helper.make_node("Mul", [x, mask], [p + "_a"], name=p + "_a"),
                      helper.make_node("Mul", [p + "_last", "fe_inv"], [p + "_b"], name=p + "_b"),
                      helper.make_node("Add", [p + "_a", p + "_b"], [p + "_x"], name=p + "_x")]
            n.input[0] = p + "_x"
            k += 1
        nodes.append(n)
    del g.node[:]
    g.node.extend(nodes)
    names = {i.name for i in g.input}
    for nm, shape in ((mask, [1, 1, "fe_n"]), (last, ["fe_n", 1])):
        if nm not in names:
            g.input.append(helper.make_tensor_value_info(nm, onnx.TensorProto.FLOAT, shape))
    print(f"fill_edges: {k} Pad")
    return m


def cmd_export(a):
    W.mkdir(parents=True, exist_ok=True)
    est = onnx.load(str(SRC / "vector_estimator.onnx"))
    ex = Extractor(est)
    npu = ex.extract_model(EST_IN + [TIME_OUT, *ROPE], [V_OUT])
    need = [i.name for i in npu.graph.input]
    assert "current_step" not in need and "total_step" not in need, need
    sub = [n for n in est.graph.node if V_OUT in n.output][0]
    print("v node:", sub.op_type, list(sub.input))
    time_m = ex.extract_model(["current_step", "total_step"], [TIME_OUT])
    s = ort.InferenceSession(time_m.SerializeToString(), providers=["CPUExecutionProvider"])
    table = np.stack([s.run(None, {"current_step": np.array([k], np.float32), "total_step": np.array([STEPS], np.float32)})[0]
                      for k in range(STEPS)]).astype(np.float32)
    np.save(W / "time_table.npy", table)
    print("time table:", table.shape, "rows identical:", bool(np.allclose(table[:, 0], table[:, -1])))
    # 호스트용 rope 그래프 (마스크 → sin/cos), 정적 모양으로
    rope = rename(ex.extract_model(["latent_mask", "text_mask"], list(ROPE)), ROPE)
    rope = static(rope, {"latent_mask": [1, 1, a.L], "text_mask": [1, 1, a.T]}, W / f"st_rope_T{a.T}_L{a.L}.onnx")
    rs = ort.InferenceSession(rope.SerializeToString(), providers=["CPUExecutionProvider"])
    shp = {o.name: list(x.shape) for o, x in zip(rope.graph.output, rs.run(None, {
        "latent_mask": np.ones((1, 1, a.L), np.float32), "text_mask": np.ones((1, 1, a.T), np.float32)}))}
    print("rope shapes:", shp)
    npu = fill_edges(rename(npu, RENAME), "latent_mask", "lat_last")
    static(npu, {"noisy_latent": [1, 144, a.L], "text_emb": [1, 256, a.T], "style_ttl": [1, 50, 256],
                 "latent_mask": [1, 1, a.L], "text_mask": [1, 1, a.T], "time_emb": list(table.shape[1:]), **shp,
                 "lat_last": [a.L, 1]}, W / f"st_est_T{a.T}_L{a.L}.onnx")
    voc = fill_edges(onnx.load(str(SRC / "vocoder.onnx")), "voc_mask", "voc_last")  # 보코더 안의 시간 축은 6L
    static(voc, {"latent": [1, 144, a.L], "voc_mask": [1, 1, 6 * a.L], "voc_last": [6 * a.L, 1]}, W / f"st_voc_L{a.L}.onnx")


class Static:
    """정적 그래프로 생성. backend는 run(feed)->v / run(latent)->wav 를 주는 세션 두 개."""

    def __init__(self, est, voc, T, L):
        self.est, self.voc, self.T, self.L = est, voc, T, L
        self.table = np.load(W / "time_table.npy")
        self.rope = sess(W / f"st_rope_T{T}_L{L}.onnx")

    def __call__(self, noise, emb, tmask, style_ttl, lat_len, wav_len, dump=None):
        lmask = np.zeros((1, 1, self.L), np.float32); lmask[..., :lat_len] = 1
        tmask = pad(tmask.astype(np.float32), self.T)
        rope = dict(zip(ROPE.values(), self.rope.run(list(ROPE.values()), {"latent_mask": lmask, "text_mask": tmask})))
        last = np.zeros((self.L, 1), np.float32); last[lat_len - 1] = 1
        vmask = np.zeros((1, 1, 6 * self.L), np.float32); vmask[..., :6 * lat_len] = 1
        vlast = np.zeros((6 * self.L, 1), np.float32); vlast[6 * lat_len - 1] = 1
        base = {"text_emb": pad(emb, self.T), "style_ttl": style_ttl, "latent_mask": lmask, "text_mask": tmask,
                "lat_last": last, **rope}
        x = pad(noise, self.L) * lmask
        vs = []
        for k in range(STEPS):
            f = {"noisy_latent": x, "time_emb": self.table[k], **base}
            if dump is not None:
                dump.append(("est", f))
            v = self.est.run(None, f)[0]
            vs.append(v)
            x = (x + v / STEPS) * lmask
        vf = {"latent": x, "voc_mask": vmask, "voc_last": vlast}
        if dump is not None:
            dump.append(("voc", vf))
        wav = self.voc.run(None, vf)[0].reshape(-1)[:wav_len]
        return wav, vs


def dynamic(eng, noise, emb, tmask, style, lat_len, wav_len):
    lmask = np.ones((1, 1, lat_len), np.float32)
    x = noise * lmask
    for k in range(STEPS):
        x, *_ = eng.vector_est_ort.run(None, {"noisy_latent": x, "text_emb": emb, "style_ttl": style.ttl, "text_mask": tmask,
                                              "latent_mask": lmask, "current_step": np.array([k], np.float32),
                                              "total_step": np.array([STEPS], np.float32)})
    return eng.vocoder_ort.run(None, {"latent": x})[0].reshape(-1)[:wav_len]


def snr(ref, x):
    n = min(len(ref), len(x))
    ref, x = ref[:n], x[:n]
    return 10 * np.log10((ref ** 2).sum() / max(((ref - x) ** 2).sum(), 1e-20)), float(np.corrcoef(ref, x)[0, 1])


def sess(p):
    o = ort.SessionOptions(); o.intra_op_num_threads = 1; o.inter_op_num_threads = 1
    return ort.InferenceSession(str(p), o, providers=["CPUExecutionProvider"])


def cmd_check(a):
    tts, eng = engine()
    st = Static(sess(W / f"st_est_T{a.T}_L{a.L}.onnx"), sess(W / f"st_voc_L{a.L}.onnx"), a.T, a.L)
    style = tts.get_voice_style("F1")
    rng = np.random.default_rng(0)
    picks = [s for s in sentences() if s["id"] in ("k01", "k09", "k17", "c01", "c03", "c14", "j02", "j08", "e02", "e05")]
    for s in picks:
        ids, tmask, emb, lat, wl = front(eng, style, s["text"], s["lang"])
        noise = rng.standard_normal((1, 144, lat)).astype(np.float32)
        ref = dynamic(eng, noise, emb, tmask, style, lat, wl)
        out, _ = st(noise, emb, tmask, style.ttl, lat, wl)
        d, c = snr(ref, out)
        print(f"{s['id']}: T={ids.shape[1]} L={lat}  static vs dynamic SNR {d:.1f} dB corr {c:.5f}")


def add(tar, i, d):
    buf = io.BytesIO()
    np.save(buf, d, allow_pickle=True)
    info = tarfile.TarInfo(f"{i:04d}.npy"); info.size = buf.tell(); buf.seek(0)
    tar.addfile(info, buf)


def cmd_calib(a):
    tts, eng = engine()
    st = Static(sess(W / f"st_est_T{a.T}_L{a.L}.onnx"), sess(W / f"st_voc_L{a.L}.onnx"), a.T, a.L)
    rng = np.random.default_rng(1)
    dump = []
    for v in VOICES:
        style = tts.get_voice_style(v)
        for lang, text in CALIB_TEXTS:
            ids, tmask, emb, lat, wl = front(eng, style, text, lang)
            assert ids.shape[1] <= a.T and lat <= a.L, (text, ids.shape, lat)
            st(rng.standard_normal((1, 144, lat)).astype(np.float32), emb, tmask, style.ttl, lat, wl, dump=dump)
    for kind in ("est", "voc"):
        items = [d for k, d in dump if k == kind]
        p = W / f"calib_{kind}_T{a.T}_L{a.L}_n{len(items)}.tar"
        with tarfile.open(p, "w") as tar:
            for i, d in enumerate(items):
                add(tar, i, d)
        print(p.name, len(items), f"{p.stat().st_size / 2**20:.1f} MiB")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("cmd", choices=["measure", "export", "check", "calib", "voc4d"])
    p.add_argument("--T", type=int, default=64)
    p.add_argument("--L", type=int, default=128)
    a = p.parse_args()
    globals()[f"cmd_{a.cmd}"](a)
