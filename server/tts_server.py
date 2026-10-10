"""LLM-8850 카드에서 Supertonic 3를 돌리는 로컬 TTS HTTP 서버. 봇의 `local` 공급자가 부른다.

  python -m server.tts_server --models <모델 폴더> [--backend ax|ort] [--host 127.0.0.1] [--port 8850]

  GET  /health  → {"ok": true, "backend": "ax", "buckets": [[96, 96], [192, 192]], "voices": [...], "langs": [...]}
  POST /tts     {"text": "...", "lang": "kr", "voice": "F1"}  → audio/wav (44.1 kHz 모노 16비트)
                X-TTS-Gen-Ms, X-TTS-Audio-S, X-TTS-Pieces 헤더에 생성 시간·음성 길이·조각 수
       422 {"error": "unsupported_language"}  봇은 이 메시지만 다른 공급자로 넘긴다 (서버 고장 아님)
       400 {"error": "empty_text"}             읽을 내용이 없음

카드는 한 번에 한 요청만 처리하므로 합성은 전용 스레드 하나에서 차례로 돈다
(AXCL 문맥은 스레드마다 따로라서 요청 스레드에서 직접 부르지 않는다).
TTS_SERVER_TOKEN 환경 변수를 두면 Authorization: Bearer <token> 이 맞는 요청만 받는다.
"""
import argparse
import io
import json
import logging
import os
import signal
import threading
import wave
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

from .engine import Engine, parse_buckets
from .textnorm import normalize

log = logging.getLogger("tts_server")
# 봇이 쓰는 언어 코드(kr/jp/en/zh)와 ISO 코드를 Supertonic 코드로. zh는 Supertonic이 지원하지 않는다.
LANGS = {"kr": "ko", "ko": "ko", "jp": "ja", "ja": "ja", "en": "en"}
MAX_BODY = 64 * 1024


def to_wav(wav, sr):
    pcm = (np.clip(wav, -1, 1) * 32767).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes(pcm)
    return buf.getvalue()


class Service:
    def __init__(self, args):
        self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="synth")
        # 카드 세션은 합성 스레드에서 만들어야 그 스레드의 AXCL 문맥에 묶인다
        self.engine = self.worker.submit(Engine, args.models, args.backend, args.voc_backend, args.threads,
                                         buckets=parse_buckets(args.buckets)).result()
        self.voices = self.engine.voices()
        self.default_voice = args.voice if args.voice in self.voices else self.voices[0]
        self.max_chars = args.max_chars
        self.token = os.environ.get("TTS_SERVER_TOKEN", "")
        self.worker.submit(self.engine.synth, "준비", "ko", self.default_voice, 0).result()  # 첫 호출 준비 시간 제외

    def synth(self, text, lang, voice):
        return self.worker.submit(self.engine.synth, text, lang, voice).result()

    def close(self):
        self.worker.submit(self.engine.close).result()
        self.worker.shutdown()


def make_handler(svc):
    class Handler(BaseHTTPRequestHandler):
        server_version = "supertonic-ax8850/1"

        def log_message(self, fmt, *a):
            log.debug("%s %s", self.address_string(), fmt % a)

        def _json(self, code, obj):
            body = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _authorized(self):
            if not svc.token:
                return True
            if self.headers.get("Authorization", "") == f"Bearer {svc.token}":
                return True
            self._json(401, {"error": "unauthorized"})
            return False

        def do_GET(self):
            if not self._authorized():
                return
            if self.path.rstrip("/") == "/health":
                return self._json(200, {"ok": True, "backend": svc.engine.backend, "buckets": svc.engine.bucket_sizes,
                                        "voices": svc.voices,
                                        "default_voice": svc.default_voice, "langs": sorted(set(LANGS))})
            self._json(404, {"error": "not_found"})

        def do_POST(self):
            if not self._authorized():
                return
            if self.path.rstrip("/") != "/tts":
                return self._json(404, {"error": "not_found"})
            try:
                n = int(self.headers.get("Content-Length", 0))
                if n > MAX_BODY:
                    return self._json(413, {"error": "too_large"})
                req = json.loads(self.rfile.read(n) or b"{}")
                text, lang_in = str(req.get("text", "")), str(req.get("lang", "")).lower()
            except (ValueError, TypeError):
                return self._json(400, {"error": "bad_request"})
            lang = LANGS.get(lang_in) if lang_in else None
            if lang_in and not lang:
                return self._json(422, {"error": "unsupported_language", "lang": lang_in})
            text, lang = normalize(text, lang, max_chars=svc.max_chars)
            if lang not in LANGS.values():
                return self._json(422, {"error": "unsupported_language", "lang": lang})
            if not text:
                return self._json(400, {"error": "empty_text"})
            voice = req.get("voice") or svc.default_voice
            if voice not in svc.voices:
                return self._json(400, {"error": "unknown_voice", "voices": svc.voices})
            try:
                wav, info = svc.synth(text, lang, voice)
            except Exception as e:  # 카드·런타임 오류: 봇은 5xx를 서버 고장으로 보고 잠시 다른 공급자를 쓴다
                log.exception("synthesis failed")
                return self._json(500, {"error": "synthesis_failed", "detail": str(e)[:300]})
            body = to_wav(wav, svc.engine.sr)
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-TTS-Gen-Ms", str(round(info["gen_s"] * 1000)))
            self.send_header("X-TTS-Audio-S", str(info["audio_s"]))
            self.send_header("X-TTS-Pieces", str(len(info["pieces"])))
            self.end_headers()
            self.wfile.write(body)
            log.info("%s %s %d piece(s) %.0f ms for %.2f s: %s", lang, voice, len(info["pieces"]),
                     info["gen_s"] * 1000, info["audio_s"], text[:60])

    return Handler


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--models", default=os.environ.get("TTS_MODELS", ""), required=not os.environ.get("TTS_MODELS"),
                   help="st_est.axmodel·st_voc.axmodel(ax) 또는 st_est_T96_L96.onnx·st_voc_L96.onnx(ort)가 있는 폴더")
    p.add_argument("--backend", choices=["ax", "ort"], default=os.environ.get("TTS_BACKEND", "ax"))
    p.add_argument("--voc-backend", choices=["ax", "ort"], default=None, help="보코더만 따로 (기본: --backend와 같음)")
    p.add_argument("--voice", default=os.environ.get("TTS_VOICE", "F1"))
    p.add_argument("--host", default=os.environ.get("TTS_HOST", "127.0.0.1"))
    p.add_argument("--port", type=int, default=int(os.environ.get("TTS_PORT", "8850")))
    p.add_argument("--buckets", default=os.environ.get("TTS_BUCKETS"),
                   help="쓸 버킷의 L 목록, 예: 96 또는 96,192 (기본: models 폴더에 있는 것 전부)")
    p.add_argument("--threads", type=int, default=1, help="호스트 쪽 ONNX 스레드 수")
    p.add_argument("--max-chars", type=int, default=300)
    p.add_argument("--log-level", default=os.environ.get("LOG_LEVEL", "info"))
    args = p.parse_args()
    logging.basicConfig(level=args.log_level.upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    svc = Service(args)
    httpd = ThreadingHTTPServer((args.host, args.port), make_handler(svc))
    stop = threading.Event()

    def shutdown(*_):
        if not stop.is_set():
            stop.set()
            threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    log.info("listening on http://%s:%d (backend %s, buckets %s, voice %s, %d voices)", args.host, args.port,
             svc.engine.backend, svc.engine.bucket_sizes, svc.default_voice, len(svc.voices))
    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()
        svc.close()  # 카드 세션을 닫아야 런타임이 정리된다
        log.info("stopped")


if __name__ == "__main__":
    main()
