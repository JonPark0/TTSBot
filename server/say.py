"""서버 없이 엔진만 돌려 보는 도구. 한 줄에 메시지 하나, 또는 {"id","text","lang"} JSONL.

  python -m server.say --models <폴더> --backend ax --out out/say "안녕하세요" "ㅇㅋ 10분 뒤에 들어갈게"
  python -m server.say --models <폴더> --backend ort --out out/say --jsonl sentences.jsonl [--field raw]

out/wav/<id>.wav, out/timings.jsonl (gen_s, audio_s, 조각별 text·시간)을 쓴다.
"""
import argparse
import json
import sys
import time
import wave
import zlib
from pathlib import Path

import numpy as np

from .engine import Engine, parse_buckets
from .textnorm import normalize


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--models", required=True)
    p.add_argument("--backend", choices=["ax", "ort"], default="ax")
    p.add_argument("--voc-backend", choices=["ax", "ort"], default=None)
    p.add_argument("--voice", default="F1")
    p.add_argument("--buckets", help="쓸 버킷의 L 목록, 예: 96 또는 96,192 (기본: models 폴더에 있는 것 전부)")
    p.add_argument("--out", required=True)
    p.add_argument("--jsonl", help="입력 JSONL (id, text, lang)")
    p.add_argument("--field", default="text", help="JSONL에서 읽을 글 필드 (예: raw)")
    p.add_argument("--seed", choices=["id", "random"], default="id", help="id: 같은 입력 → 같은 음성")
    p.add_argument("messages", nargs="*")
    a = p.parse_args()

    if a.jsonl:
        rows = [json.loads(l) for l in open(a.jsonl, encoding="utf-8") if l.strip()]
        items = [(r["id"], r[a.field], r.get("lang")) for r in rows]
    else:
        msgs = a.messages or [l.rstrip("\n") for l in sys.stdin if l.strip()]
        items = [(f"m{i:03d}", m, None) for i, m in enumerate(msgs)]

    t0 = time.perf_counter()
    eng = Engine(a.models, a.backend, a.voc_backend, buckets=parse_buckets(a.buckets))
    print(f"load {time.perf_counter() - t0:.1f}s, backend {eng.backend}, buckets {eng.bucket_sizes}", flush=True)
    eng.synth("준비", "ko", a.voice, 0)
    out = Path(a.out); (out / "wav").mkdir(parents=True, exist_ok=True)
    with open(out / "timings.jsonl", "w", encoding="utf-8") as f:
        for id_, raw, lang in items:
            text, lang = normalize(raw, lang)
            if not text:
                print(id_, "(읽을 내용 없음)", repr(raw)); continue
            seed = zlib.crc32(id_.encode()) if a.seed == "id" else None
            wav, info = eng.synth(text, lang, a.voice, seed)
            with wave.open(str(out / "wav" / f"{id_}.wav"), "wb") as w:
                w.setnchannels(1); w.setsampwidth(2); w.setframerate(eng.sr)
                w.writeframes((np.clip(wav, -1, 1) * 32767).astype("<i2").tobytes())
            f.write(json.dumps({"id": id_, "lang": lang, "input": raw, "spoken": text, **info}, ensure_ascii=False) + "\n")
            print(id_, lang, f"{info['gen_s']:.3f}s for {info['audio_s']:.2f}s, {len(info['pieces'])} piece(s):",
                  " | ".join(pc["text"] for pc in info["pieces"]), flush=True)
    (out / "meta.json").write_text(json.dumps({"model": "Supertone/supertonic-3", "voice": a.voice, "backend": eng.backend,
                                               "buckets": eng.bucket_sizes}))
    eng.close()


if __name__ == "__main__":
    main()
