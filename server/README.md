# 로컬 TTS 서버: Supertonic 3 on LLM-8850

M5Stack LLM-8850(Axera AX8850 NPU) 카드에서 [Supertonic 3](https://huggingface.co/Supertone/supertonic-3)를 돌리는
HTTP 서버입니다. 봇은 `TTS_PROVIDER=local`일 때 이 서버를 먼저 부르고, 서버가 죽어 있거나 말할 수 없는 언어(중국어)일 때만
Gemini나 MeloTTS로 넘어갑니다.

- 한국어, 일본어, 영어. 목소리 10종(F1–F5 여성, M1–M5 남성), 목소리 복제는 없음.
- 카드 기준으로 약 6.7초까지의 메시지는 0.18초, 약 13초까지는 긴 버킷으로 0.35초에 한 번에 만듭니다.
  더 긴 메시지는 조각마다 그만큼 더 걸립니다. 카드 메모리(CMM)는 두 버킷을 다 올리면 약 220 MiB(96 버킷만이면 약 99 MiB)를 씁니다.
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
3. **카드용 모델**: Hugging Face [jonpark0/supertonic-3-AX650](https://huggingface.co/jonpark0/supertonic-3-AX650)에서 내려받습니다.
   기본 버킷(텍스트 96, 약 6.7초) `st_est.axmodel`(72 MB), `st_voc.axmodel`(29 MB), 긴 버킷(텍스트 192, 약 13초)
   `st_est_T192_L192.axmodel`(73 MB), `st_voc_L192.axmodel`(29 MB)과 호스트용 rope 그래프, `time_table.npy`가 들어 있고,
   이 폴더를 그대로 `--models`로 씁니다. 서버는 폴더에 있는 버킷을 모두 씁니다.
   ```bash
   git lfs install
   git clone https://huggingface.co/jonpark0/supertonic-3-AX650 /path/to/models
   ```
   직접 만드는 방법은 [convert/README.md](convert/README.md)에 있습니다.
   모델 가중치는 원본과 같은 OpenRAIL-M 라이선스로, 사용 제한(합성 음성임을 밝히기 등)이 함께 적용됩니다.

## 실행

저장소 루트에서:

```bash
python -m server.tts_server --models /path/to/models            # 카드 (기본 --backend ax)
python -m server.tts_server --models /path/to/models --backend ort   # 카드 없이 CPU float (버킷마다 st_est_T{T}_L{L}.onnx, st_voc_L{L}.onnx 필요)
```

| 옵션 / 환경 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `--models` / `TTS_MODELS` | — | 카드용 모델 폴더 |
| `--backend` / `TTS_BACKEND` | `ax` | `ax` 카드, `ort` CPU float |
| `--buckets` / `TTS_BUCKETS` | 폴더에 있는 것 전부 | 쓸 버킷의 길이 목록. `96`이면 긴 버킷을 올리지 않음(카드 메모리 절약) |
| `--voice` / `TTS_VOICE` | `F1` | 요청에 목소리가 없을 때 쓸 목소리 |
| `--host` / `TTS_HOST` | `127.0.0.1` | 봇이 Docker에서 돌면 `0.0.0.0`(Linux에서는 Docker 브리지 `172.17.0.1`도 가능) |
| `--port` / `TTS_PORT` | `8850` | |
| `TTS_SERVER_TOKEN` | (없음) | 있으면 `Authorization: Bearer <token>` 요청만 받음. 봇의 `LOCAL_TTS_TOKEN`과 같게 |
| `AXCL_LIB_DIR` | 위 기본 경로 | AXCL 런타임 라이브러리 폴더 |

`0.0.0.0`으로 열 때는 같은 네트워크의 다른 기기도 접근할 수 있으니 `TTS_SERVER_TOKEN`을 함께 쓰세요.

## API

```bash
curl -s localhost:8850/health
# {"ok": true, "backend": "ax", "buckets": [[96, 96], [192, 192]], "voices": ["F1", ...], "default_voice": "F1", "langs": [...]}

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

카드 입력 크기는 버킷마다 고정입니다(기본 텍스트 96·음성 약 6.7초, 긴 버킷 192·약 13초). 긴 메시지는 길이 예측기로 재 가며
가장 큰 버킷에 맞게 나누고, 조각마다 들어가는 가장 작은 버킷으로 만듭니다. 그래서 짧은 메시지는 늘 0.18초입니다.
문장 단위로 먼저 나누고, 그래도 긴 문장은 쉼표 단위로 나눕니다. 쉼표도 없으면 길이가 고르면서 "~는데", "~고", "~면" 같은
연결 어미 뒤에서 끊기도록 띄어쓰기 단위로 나눕니다. 일본어는 띄어쓰기 대신 조사 뒤에서 끊습니다.

모델은 조각마다 앞에 약 0.5초, 뒤에 약 0.6초 무음을 만듭니다. 서버는 이것을 앞 0.06초, 뒤 0.1초만 남기고 잘라서
첫 소리가 바로 나오게 하고, 조각 사이에는 문장 끝이면 0.15초, 아니면 0.03초 쉼을 더해 잇습니다(이음새 쉼 약 0.2–0.3초).
마지막으로 메시지 전체의 최대 음량을 맞춥니다.

## 서버 없이 시험

```bash
python -m server.say --models /path/to/models --out out/say "안녕하세요" "ㅇㅋ 10분 뒤에 들어갈게"
python -m unittest server.test_textnorm server.test_engine
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
