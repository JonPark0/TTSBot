# 로컬 TTS 서버: Supertonic 3 on LLM-8850

M5Stack LLM-8850(Axera AX8850 NPU) 카드에서 [Supertonic 3](https://huggingface.co/Supertone/supertonic-3)를 돌리는
HTTP 서버입니다. 봇은 `TTS_PROVIDER=local`일 때 이 서버를 먼저 부르고, 서버가 죽어 있거나 말할 수 없는 언어(중국어)일 때만
Gemini나 MeloTTS로 넘어갑니다.

- 한국어, 일본어, 영어. 목소리 10종(F1–F5 여성, M1–M5 남성), 목소리 복제는 없음.
- 메시지 하나에 카드 기준 약 0.18초(조각 하나)이고, 긴 메시지는 조각마다 0.18초씩 더 걸립니다.
  카드 메모리(CMM)는 약 99 MiB를 씁니다.
- 60문장 받아쓰기 오류율은 한국어 표준 0.3%, 채팅 6.5%, 일본어 2.2%, 영어 1.4%입니다. 원본 모델과의 비교는 [convert/README.md](convert/README.md)에 있습니다.

## 준비

1. **카드 런타임 (AXCL)**: Windows는 AXCL Windows 패키지(`libaxcl_rt.dll`, 기본 `C:\AXCL\axcl\out\axcl_win_x64\bin`),
   Linux는 AXCL 패키지(`/usr/lib/axcl/libaxcl_rt.so`)를 설치합니다. 다른 위치에 있으면 `AXCL_LIB_DIR`로 지정합니다.
2. **Python 3.10 이상**:
   ```bash
   python -m venv .venv && . .venv/bin/activate      # Windows: .venv\Scripts\activate
   pip install -r server/requirements.txt
   ```
   처음 실행할 때 `supertonic` 패키지가 Hugging Face에서 원본 모델(텍스트 처리기, 길이 예측기, 텍스트 인코더, 목소리)을
   `~/.cache/supertonic3`로 내려받습니다.
3. **카드용 모델**: `st_est.axmodel`(72 MB)과 `st_voc.axmodel`(29 MB)을 한 폴더에 둡니다. 저장소에는 넣지 않았습니다.
   직접 만드는 방법은 [convert/README.md](convert/README.md)에 있습니다.
   `st_rope_T96_L96.onnx`와 `time_table.npy`는 `server/assets/`에 들어 있습니다.

## 실행

저장소 루트에서:

```bash
python -m server.tts_server --models /path/to/models            # 카드 (기본 --backend ax)
python -m server.tts_server --models /path/to/models --backend ort   # 카드 없이 CPU float (st_est_T96_L96.onnx, st_voc_L96.onnx 필요)
```

| 옵션 / 환경 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `--models` / `TTS_MODELS` | — | 카드용 모델 폴더 |
| `--backend` / `TTS_BACKEND` | `ax` | `ax` 카드, `ort` CPU float |
| `--voice` / `TTS_VOICE` | `F1` | 요청에 목소리가 없을 때 쓸 목소리 |
| `--host` / `TTS_HOST` | `127.0.0.1` | 봇이 Docker에서 돌면 `0.0.0.0`(Linux에서는 Docker 브리지 `172.17.0.1`도 가능) |
| `--port` / `TTS_PORT` | `8850` | |
| `TTS_SERVER_TOKEN` | (없음) | 있으면 `Authorization: Bearer <token>` 요청만 받음. 봇의 `LOCAL_TTS_TOKEN`과 같게 |
| `AXCL_LIB_DIR` | 위 기본 경로 | AXCL 런타임 라이브러리 폴더 |

`0.0.0.0`으로 열 때는 같은 네트워크의 다른 기기도 접근할 수 있으니 `TTS_SERVER_TOKEN`을 함께 쓰세요.

## API

```bash
curl -s localhost:8850/health
# {"ok": true, "backend": "ax", "voices": ["F1", ...], "default_voice": "F1", "langs": ["en", "ja", "jp", "ko", "kr"]}

curl -s localhost:8850/tts -H 'Content-Type: application/json' \
  -d '{"text": "ㅇㅋ 10분 뒤에 들어갈게", "lang": "kr", "voice": "F1"}' -o out.wav
```

| 응답 | 뜻 | 봇의 처리 |
| --- | --- | --- |
| 200 `audio/wav` | 44.1 kHz 모노 16비트. `X-TTS-Gen-Ms`, `X-TTS-Audio-S`, `X-TTS-Pieces` 헤더 | 재생 |
| 422 `unsupported_language` | `zh` 등 | 이 메시지만 다음 공급자로 |
| 400 `empty_text` | 정규화 후 읽을 것이 없음 (`ㅠㅠ`, `ㅋ`) | 읽지 않고 넘어감 |
| 401, 400 `unknown_voice` 등 기타 4xx | 토큰 불일치, 없는 목소리 같은 설정 문제 | 30분 동안 다음 공급자 사용 (`ERROR` 로그) |
| 5xx, 연결 실패, 시간 초과 | 서버·카드 문제 | 30초 동안 다음 공급자 사용 |

## 텍스트 처리

봇이 Discord 마크업, URL, 이모지를 먼저 정리해서 보냅니다. 서버는 Supertonic이 잘못 읽는 것만 고칩니다(`textnorm.py`).
원문 그대로 넣고 음성 인식 결과를 비교해서 정했습니다.

- **숫자는 그대로 둡니다.** "3시 30분", "15,000원", "2026년 10월 9일", "3:30" 모두 바르게 읽습니다.
- **자음만 쓴 채팅 말을 바꿉니다.** `ㅇㅋ`→오케이, `ㄹㅇ`→리얼, `ㄴㄴ`→노노, `ㄱ`→고, `ㅋㅋ`→크크, `ㅎㅎ`→흐흐. 바꾸지 않으면 소리가 없거나 엉뚱하게 읽힙니다.
  `ㅠㅠ`처럼 목록에 없는 자모는 지웁니다.
- 한국어 문장 속 `gg`→지지, `ok`→오케이, `lol`→크크. 일본어 `www`는 지웁니다.

카드 입력 크기가 텍스트 96, 음성 약 6.7초로 고정이라, 긴 메시지는 길이 예측기로 재 가며 나눕니다.
문장 단위로 먼저 나누고, 그래도 긴 문장은 쉼표 단위로 나눕니다. 쉼표도 없으면 길이가 고르면서 "~는데", "~고", "~면" 같은
연결 어미 뒤에서 끊기도록 띄어쓰기 단위로 나눕니다. 조각 사이에는 0.12초 쉼을 넣고, 메시지 전체의 최대 음량을 맞춥니다.

## 서버 없이 시험

```bash
python -m server.say --models /path/to/models --out out/say "안녕하세요" "ㅇㅋ 10분 뒤에 들어갈게"
python -m unittest server.test_textnorm
```

## 상시 실행 (Linux, systemd 예시)

```ini
# /etc/systemd/system/supertonic-tts.service
[Unit]
Description=Supertonic 3 TTS on LLM-8850
After=network.target

[Service]
WorkingDirectory=/opt/TTSBot
Environment=TTS_MODELS=/opt/supertonic-ax8850
ExecStart=/opt/TTSBot/.venv/bin/python -m server.tts_server
Restart=on-failure

[Install]
WantedBy=multi-user.target
```
