# Discord TTS Bot (LLM-8850 Supertonic + Gemini TTS + Google Cloud TTS)

지정한 텍스트 채널의 메시지를, **그 메시지를 쓴 사람이 들어가 있는 음성 채널**에서
읽어 주는 Discord 봇입니다. TTS는 다음 세 가지를 씁니다.

- **로컬 Supertonic 3** (LLM-8850 카드, 선택): `LOCAL_TTS_URL` 이 있으면 기본으로 사용.
  비용 없이 한 메시지 약 0.2초. 서버가 꺼져 있거나 중국어일 때만 아래로 넘어갑니다 → [server/README.md](server/README.md)
- **Google Gemini TTS** (BAZE API Gateway 경유, 선택): `BAZE_API_KEY` 가 있으면 기본으로 사용
- **Google Cloud Text-to-Speech** (`GOOGLE_TTS_API_KEY`, Chirp 3 HD 월 100만 자 무료):
  독일어·이탈리아어는 먼저, 나머지 언어는 앞의 TTS가 실패·일시 중지·한도 초과일 때 **자동 백업**
  → [Google Cloud TTS](#google-cloud-tts)

선택으로, 숫자·단위·영문 약어를 소리 내어 읽는 형태로 바꾸는 **Claude 읽기 전 정규화**를 켤 수 있습니다
→ [읽기 전 정규화 (Claude)](#읽기-전-정규화-claude).

> Cloudflare Workers AI의 `@cf/myshell-ai/melotts` 는 2026-11-20에 서비스가 종료되어(HTTP 410)
> 제거했습니다. Workers AI에는 한국어·일본어·중국어를 읽는 다른 TTS 모델이 없어 Google이 그 자리를 대신합니다.
> 예전 `.env` 의 `CF_*` 는 무시되고, `TTS_PROVIDER=cloudflare` 는 `google` 로 처리됩니다.

## 기능

- 관리자가 `/tts-channel set` 으로 TTS 채널을 지정
- 해당 채널의 메시지를 작성자의 음성 채널에서 음성으로 출력
- 한국어 / 영어 / 중국어 / 일본어 / 독일어 / 이탈리아어 **자동 감지** 후 해당 언어로 합성
- 이모지, 커스텀 이모지, 스티커, GIF/이미지 첨부, URL, 디스코드 마크다운,
  멘션, 스포일러, 특수문자/기타 유니코드 기호 **자동 정리(Sanitization)**
- 무료 한도 보호용 **일일 문자 수 상한**, Gemini **일일 크레딧 상한**, 메시지 길이 제한, 큐 길이 제한
- 설정은 `.env`, 배포는 Docker Compose V2

## 사전 준비

### 1. Discord 애플리케이션

1. https://discord.com/developers/applications → **New Application**
2. **Bot** 탭에서 토큰 발급 → `DISCORD_TOKEN`
3. 같은 화면에서 **MESSAGE CONTENT INTENT** 를 **켭니다** (필수)
4. **General Information** 의 Application ID → `DISCORD_CLIENT_ID`
5. **OAuth2 → URL Generator** 에서
   - scopes: `bot`, `applications.commands`
   - bot permissions: `View Channels`, `Connect`, `Speak`
   - 생성된 URL로 봇을 서버에 초대

### 2. (선택) Gemini TTS — BAZE API Gateway

1. BAZE → **API Gateway** (왼쪽 아래 사이드바)에서 키 발급 → `BAZE_API_KEY`
   (키는 발급 시 한 번만 표시됩니다. 사용량은 키를 발급한 계정의 크레딧에서 차감됩니다.)
2. 키 확인: `curl -H "Authorization: Bearer <KEY>" https://factchat-cloud.mindlogic.ai/v1/gateway/credits/`
3. 키가 없으면 이 단계는 건너뛰어도 되며, 봇은 Google만 사용합니다 (카드 서버가 없을 때).

### 3. Google Cloud Text-to-Speech (카드 서버도 Gemini도 없으면 필수)

1. Google Cloud 콘솔에서 프로젝트를 고르고 **Cloud Text-to-Speech API** 를 사용 설정
2. **API 및 서비스 → 사용자 인증 정보 → API 키 만들기** → 키 제한에서 API를
   **Cloud Text-to-Speech API** 하나로 제한 → `GOOGLE_TTS_API_KEY`
3. 키가 없으면 백업이 없어, 앞의 TTS가 실패한 메시지와 (Gemini가 없을 때) 독일어·이탈리아어 메시지는 읽지 않습니다.

### 4. (선택) 읽기 전 정규화 — Claude (Anthropic API)

1. https://platform.claude.com → **API keys** 에서 키 발급 → `ANTHROPIC_API_KEY`
2. Console에서 워크스페이스 지출 한도를 걸어 두면 봇의 `TTS_NORMALIZE_DAILY_USD` 와 함께 이중으로 막을 수 있습니다.
3. 키가 없으면 이 기능만 꺼지고, 메시지는 쓰인 그대로 읽습니다.

## 설정

```bash
cp .env.example .env
# .env 를 열어 값 채우기
```

설정/사용량 파일(`store.json`)은 Docker named volume `tts-data` 에 저장됩니다.
로컬(비-Docker) 실행 시에는 `DATA_DIR`(기본 `./data`) 경로에 저장됩니다.

주요 환경 변수:

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `DISCORD_TOKEN` | — | 봇 토큰 (필수) |
| `DISCORD_CLIENT_ID` | — | 애플리케이션 ID, 슬래시 명령 등록에 사용 (필수) |
| `LOCAL_TTS_URL` | (없음) | 로컬 카드 TTS 서버 주소. 있으면 카드를 기본으로 사용 |
| `LOCAL_TTS_VOICE` | (서버 기본, F1) | 목소리 `F1`–`F5`(여), `M1`–`M5`(남) |
| `LOCAL_TTS_TOKEN` | (없음) | 서버의 `TTS_SERVER_TOKEN` 과 같은 값 |
| `LOCAL_TTS_TIMEOUT_MS` | `10000` | 카드 서버 요청 시간 제한 |
| `BAZE_API_KEY` | (없음) | BAZE API Gateway 키. 있으면 Gemini TTS를 기본으로 사용 |
| `TTS_PROVIDER` | `LOCAL_TTS_URL` 있으면 `local`, 키 있으면 `baze`, 없으면 `google` | `local` (카드 → Gemini → Google) / `baze` (Gemini → 실패 시 Google) / `google` (Google만). 예전 값 `cloudflare` 는 `google` 로 처리 |
| `BAZE_BASE_URL` | `https://factchat-cloud.mindlogic.ai/v1/gateway` | 게이트웨이 주소 |
| `BAZE_TTS_MODEL` | `gemini-3.1-flash-tts-preview` | Gemini TTS 모델 |
| `BAZE_TTS_VOICE` | `Kore` | 목소리 (여: Kore, Aoede, Leda… / 남: Charon, Puck, Fenrir…) |
| `BAZE_DAILY_CREDIT_LIMIT` | `900` | Gemini 일일 크레딧 상한, 넘으면 그날은 Google (0이면 비활성) |
| `GOOGLE_TTS_API_KEY` | (없음) | Google Cloud TTS 키 (Text-to-Speech API만 허용). `TTS_PROVIDER=google` 이면 필수 |
| `GOOGLE_TTS_VOICE_KR` / `_JP` / `_ZH` / `_EN` / `_DE` / `_IT` | `ko-KR-Chirp3-HD-Kore` / `ja-JP-…` / `cmn-CN-…` / `en-US-…` / `de-DE-…` / `it-IT-…` | 언어별 목소리. 언어는 이름 앞부분에서 정해짐 |
| `GOOGLE_TTS_DAILY_CHAR_LIMIT` | `30000` | Google 일일 문자 수 상한 (0이면 비활성). Chirp 3 HD 무료 한도는 월 100만 자 |
| `TTS_DEFAULT_LANG` | `kr` | 언어 감지 실패 시 사용할 언어 (`kr`/`en`/`zh`/`jp`/`de`/`it`) |
| `TTS_MAX_CHARS` | `200` | 한 메시지에서 읽을 최대 글자 수 |
| `TTS_QUEUE_MAX` | `20` | 서버별 대기 큐 최대 길이 |
| `TTS_IDLE_TIMEOUT_MS` | `300000` | 읽을 게 없을 때 음성 채널에서 나가기까지의 시간 |
| `TTS_READ_CUSTOM_EMOJI_NAMES` | `false` | 커스텀 이모지를 이름으로 읽을지 여부 |
| `TTS_DAILY_CHAR_LIMIT` | `100000` | 클라우드 TTS 일일 문자 수 상한 (0이면 비활성). 카드로 읽은 메시지는 세지 않음 |
| `ANTHROPIC_API_KEY` | (없음) | Claude 읽기 전 정규화용 키. 없으면 정규화 없이 읽음 |
| `TTS_NORMALIZE` | `true` | `false` 면 키가 있어도 정규화를 끔 |
| `TTS_NORMALIZE_MODEL` | `claude-haiku-5-5` | 정규화 모델 |
| `TTS_NORMALIZE_TIMEOUT_MS` | `1500` | 이 시간 안에 답이 없으면 원문 그대로 읽음 |
| `TTS_NORMALIZE_DAILY_USD` | `0.3` | 정규화 일일 비용 상한(USD, 0이면 비활성) |
| `TTS_NORMALIZE_PRICE_IN` / `_OUT` | `0.1` / `0.5` | 비용 계산용 100만 토큰당 가격(USD) |
| `DATA_DIR` | `./data` | 설정/사용량 저장 경로 |
| `LOG_LEVEL` | `info` | `error`/`warn`/`info`/`debug` |

## 실행 (Docker Compose V2)

```bash
docker compose up -d --build
docker compose logs -f
```

중지:

```bash
docker compose down
```

## 실행 (로컬, Docker 없이)

- Node.js 26 이상, 그리고 **ffmpeg** 가 PATH에 있어야 합니다.
  (Windows: `winget install Gyan.FFmpeg`, macOS: `brew install ffmpeg`)

```bash
npm install
npm run build   # src/*.ts → dist/*.js
npm start       # node dist/index.js
```

개발 중에는 빌드 없이 `npm run dev` 로 실행할 수 있습니다 (Node가 `src/index.ts` 를 직접 실행하고,
파일이 바뀌면 재시작). 타입 검사는 `npm run typecheck`, 테스트는 `npm test` 입니다.

> 운영(`npm start`, Docker)은 컴파일된 `dist/` 를 실행합니다. Node가 `.ts` 를 직접 실행하면
> 타입 제거기(type stripping)가 프로세스가 끝날 때까지 메모리에 남아 상주 메모리가 약 14–19 MB 늘기 때문입니다.
> 그래서 소스는 Node가 그대로 실행할 수 있는 형태로만 씁니다 (`tsconfig.json` 이 검사):
> 상대 경로 import 에 `.ts` 확장자, 타입만 가져올 때 `import type`, `enum`·`namespace`·생성자 매개변수 프로퍼티 금지.

> Opus 인코딩은 순수 JS 구현인 `opusscript` 로 동작하므로 별도 빌드 도구가 필요 없습니다.
> 빌드 도구(예: Visual Studio Build Tools)가 있으면 더 빠른 네이티브 `@discordjs/opus`
> (optional dependency)가 자동으로 사용됩니다.

## 사용법

1. 서버 관리 권한이 있는 사용자가 TTS로 읽을 채널에서:
   ```
   /tts-channel set
   ```
   (다른 채널을 지정하려면 `channel` 옵션 사용)
2. 음성 채널에 들어간 뒤, 지정된 텍스트 채널에 메시지를 입력하면 봇이 그 음성 채널로 들어와 읽어 줍니다.
3. 해제: `/tts-channel clear` · 상태 확인: `/tts-channel status`

## 언어 감지 방식

문자 종류로 판별합니다.

- 히라가나/가타카나 포함 → 일본어(`jp`)
- 한글 포함 → 한국어(`kr`)
- 한자만 포함 → 중국어(`zh`)
- 라틴 문자 → 기본은 영어(`en`). `ä ö ü ß` 가 있거나 독일어 기능어(ich, und, nicht, danke…)가
  영어·이탈리아어보다 많으면 독일어(`de`), 이탈리아어 기능어(ciao, grazie, che, non, sono…)가
  더 많으면 이탈리아어(`it`). 세 언어에 같이 쓰이는 단어(in, so, die, come…)는 세지 않으므로
  애매하면 영어입니다.
- 그 외 → `TTS_DEFAULT_LANG`

## 정리(Sanitization) 대상

코드블록/인라인코드, 스포일러(`||...||`), URL, 디스코드 타임스탬프,
유저/역할/채널 멘션(가능하면 이름으로 치환, `@everyone`/`@here` 제거),
커스텀 이모지(`<:name:id>`), 유니코드 이모지·픽토그램·국기·스킨톤,
마크다운 기호(`**`, `*`, `__`, `~~`, `` ` ``, 인용/헤더),
화이트리스트에 없는 특수문자·기호 → 공백 처리 후 공백 정리 및 길이 제한.
스티커 · 이미지 · GIF 등 첨부는 본문에 텍스트가 없으면 그대로 무시됩니다.

## 로컬 TTS: LLM-8850 카드의 Supertonic 3

M5Stack LLM-8850(Axera AX8850) 카드가 꽂힌 PC에서 `server/` 의 TTS 서버를 띄우고 `LOCAL_TTS_URL` 을 지정하면,
카드를 기본 TTS로 쓰고 Gemini/Google은 백업이 됩니다. 설치·모델·API는 [server/README.md](server/README.md) 를 보세요.
카드용 모델은 Hugging Face [jonpark0/supertonic-3-AX650](https://huggingface.co/jonpark0/supertonic-3-AX650) 에 있습니다.

```bash
# 카드가 있는 PC에서
git clone https://huggingface.co/jonpark0/supertonic-3-AX650 /path/to/models   # git lfs install 필요
python -m server.tts_server --models /path/to/models --host 0.0.0.0   # 봇이 Docker면 0.0.0.0 + TTS_SERVER_TOKEN 권장
# .env
LOCAL_TTS_URL=http://host.docker.internal:8850   # Docker 없이 같은 PC면 http://127.0.0.1:8850
```

| 상황 | 동작 |
| --- | --- |
| 카드 서버 정상 | 카드로 읽음 (일일 문자 수 상한에 세지 않음) |
| 중국어 메시지 (Supertonic 미지원) | 그 메시지만 Gemini/Google |
| 서버 꺼짐 · 5xx · 시간 초과 | Gemini/Google 사용, 카드는 **30초간** 건너뜀 (`WARN` 로그) |
| 토큰 불일치·없는 목소리 등 설정 문제 (4xx) | Gemini/Google 사용, 카드는 **30분간** 건너뜀 (`ERROR` 로그) |
| 정규화 후 읽을 내용 없음 (`ㅠㅠ` 등) | 읽지 않음 |

`GOOGLE_TTS_API_KEY` 와 `BAZE_API_KEY` 는 이때 선택입니다. 둘 다 없으면 카드만 쓰고, 서버가 꺼져 있는 동안의 메시지는 읽지 않습니다.
카드 하나로 메시지당 약 0.18초(13초까지의 긴 메시지는 약 0.35초)라 여러 서버에서 동시에 써도 대기열이 짧습니다.

```bash
node dist/probe.js "ㅇㅋ 10분 뒤에 들어갈게" kr local   # 카드 서버만으로 합성해 /tmp/probe-kr.wav 저장
```

## Gemini TTS와 Google 백업

`BAZE_API_KEY` 가 설정되어 있으면 메시지마다 먼저 Gemini TTS를 호출하고, 다음 경우에는
그 메시지를 Google로 읽습니다 (`GOOGLE_TTS_API_KEY` 가 있을 때).

| 상황 | 동작 |
| --- | --- |
| 401 / 403 (키 오류, 조직에서 모델 비활성) | Google 사용, Gemini를 **30분간** 건너뜀 (`ERROR` 로그) |
| 429 / 5xx / 시간 초과(15초) / 네트워크 오류 | Google 사용, Gemini를 **60초간** 건너뜀 (`WARN` 로그) |
| 오늘 사용한 크레딧 ≥ `BAZE_DAILY_CREDIT_LIMIT` | 00:00 UTC까지 Google 사용 |

- Gemini는 문장의 언어를 스스로 판단합니다. 언어 감지 결과는 카드 서버와 Google 백업에 쓰입니다.
- 게이트웨이는 raw PCM(24kHz 모노 16비트)을 돌려주므로 WAV 헤더를 붙여 재생합니다.
- 크레딧은 응답 헤더의 토큰 수로 계산합니다. 모델별 10k 토큰당 크레딧(입력/출력):
  `gemini-3.1-flash-tts-preview` 10/200, `gemini-2.5-flash-preview-tts` 5/100,
  `gemini-2.5-pro-preview-tts` 10/200. 3.1 Flash 기준 한국어 25자 문장 ≈ 2.2 크레딧
  (출력 토큰 ≈ 오디오 1초당 32개).
- 오늘 사용량은 `/tts-channel status` 에서 확인할 수 있습니다.

## Google Cloud TTS

독일어·이탈리아어는 Google Cloud Text-to-Speech로 먼저 읽고(카드 서버에 목소리가 없고 Gemini보다 저렴),
나머지 언어는 `TTS_PROVIDER` 순서의 마지막 백업으로 씁니다.

| 상황 | 동작 |
| --- | --- |
| `de` / `it` 메시지 | Google → 실패 시 Gemini(`TTS_PROVIDER` 가 `local`/`baze` 일 때) → 그래도 안 되면 **읽지 않음** |
| 그 외 언어 | 카드 서버 / Gemini 가 실패·일시 중지·한도 초과면 Google |
| 400 / 401 / 403 (키·목소리 오류) | Google을 **30분간** 건너뜀 (`ERROR` 로그) |
| 429 / 5xx / 시간 초과(10초) / 네트워크 오류 | Google을 **60초간** 건너뜀 (`WARN` 로그) |
| 오늘 Google 사용량 ≥ `GOOGLE_TTS_DAILY_CHAR_LIMIT` | 00:00 UTC까지 Google을 쓰지 않음 (하루 한 번 `WARN`) |
| 읽을 수 있는 TTS가 하나도 없음 | 그 메시지는 읽지 않음 (`GOOGLE_TTS_API_KEY` 가 없으면 처음 한 번 `WARN`) |

- 응답은 `LINEAR16` WAV(Chirp 3 HD는 24kHz 모노 16비트)를 base64로 받습니다. 키는 URL이 아닌
  `X-Goog-Api-Key` 헤더로 보내 오류 메시지에 남지 않습니다.
- Google로 읽은 글자는 `TTS_DAILY_CHAR_LIMIT` 에도, `GOOGLE_TTS_DAILY_CHAR_LIMIT` 에도 셉니다.
  오늘 사용량은 `/tts-channel status` 에서 볼 수 있습니다.

```bash
docker compose exec tts-bot node dist/probe.js "Guten Morgen! Wie geht es dir heute?" de google
docker compose exec tts-bot node dist/probe.js "Ciao a tutti! Arrivo tra dieci minuti." it google
docker compose exec tts-bot node dist/probe.js "你好，这是一个测试。" zh google
```

## 읽기 전 정규화 (Claude)

`ANTHROPIC_API_KEY` 가 있으면, 한국어·일본어·중국어 메시지에 숫자·단위·기호·영문이 있을 때 카드 서버나
Google에 보내기 전에 Claude(`claude-haiku-5-5`)가 읽는 형태로 바꿉니다
(`10km 뛰었다` → `십 킬로미터 뛰었다`, `3개` → `세 개`, `API` → `에이피아이`).
Gemini는 이런 표현을 스스로 잘 읽으므로 원문을 그대로 보냅니다.

어떤 경우에도 TTS를 막지 않도록 만들어져 있습니다. 문제가 생기면 그 메시지는 **쓰인 그대로** 읽습니다.

| 상황 | 동작 |
| --- | --- |
| 키 없음 / `TTS_NORMALIZE=false` | 정규화 꺼짐 |
| 바꿀 것이 없는 메시지 (숫자·영문 없음, 영어·독일어·이탈리아어) | Claude를 부르지 않음 |
| `TTS_NORMALIZE_TIMEOUT_MS`(1.5초) 안에 답 없음 · 429 · 5xx · 네트워크 오류 | 원문, Claude를 **60초간** 건너뜀 (`WARN`) |
| 401 / 403 / 404 / 410 / 400 (키 오류, 없어진 모델 등) | 원문, **30분간** 건너뜀 (`ERROR`) |
| 거절(`refusal`) · 형식이 틀린 답 · 원문의 한글·가나·한자를 지우거나 링크·멘션을 넣은 답 | 그 메시지만 원문 |
| 오늘 비용 ≥ `TTS_NORMALIZE_DAILY_USD` | 00:00 UTC까지 원문 (하루 한 번 `WARN`) |

- 시작할 때 모델 정보(무료 Models API)를 조회해 키나 모델 ID 문제를 바로 로그에 남깁니다.
- 같은 문장은 최근 200개까지 캐시해 다시 부르지 않습니다.
- 메시지 본문이 Anthropic으로 전송됩니다. 서버 구성원에게 알리고, 원하지 않으면 `TTS_NORMALIZE=false` 로 끄세요.
- 비용: 메시지당 약 $0.0001. 상태와 오늘 비용은 `/tts-channel status` 에서 볼 수 있습니다.

## 문제 해결

### 소리가 안 나거나 이상할 때

먼저 실제 응답을 확인하세요:

```bash
# 컨테이너 안에서 직접 합성해 결과를 저장 (확장자는 응답 형식에 맞춰 결정됨)
# 세 번째 인자: auto(기본, TTS_PROVIDER 순서) | local(카드만) | baze(Gemini만) | google(Google만)
# 정규화 결과(normalize = ...)도 함께 출력됩니다.
docker compose exec tts-bot node dist/probe.js "안녕하세요 테스트입니다" kr
docker compose exec tts-bot node dist/probe.js "안녕하세요 테스트입니다" kr baze
docker compose exec tts-bot node dist/probe.js "오늘 10km 뛰었다" kr google
# 저장된 파일을 호스트로 복사해서 재생 (출력의 saved -> 경로 참고)
docker compose cp tts-bot:/tmp/probe-kr.wav ./
```

`LOG_LEVEL=debug` 로 두면 각 TTS 응답 크기와 정규화 전후 문장이 로그에 남습니다.

## 참고

- 슬래시 명령어는 봇이 시작할 때와 새 서버에 들어갈 때 **서버별로 자동 등록**됩니다.
  명령어를 바꿨다면 `docker compose up -d --build` 로 재시작만 하면 바로 반영됩니다.
  (예전에 전역으로 등록된 명령어가 있으면 시작 시 자동으로 지워 중복 표시를 막습니다.)
- 테스트: `npm test` (네트워크 없이 가짜 응답으로 카드 서버·Gemini·Google·Claude 호출, 백업 전환, 일일 한도를 검사),
  `python -m unittest server.test_textnorm` (카드 서버의 텍스트 정규화)
- 설정과 일일 사용량은 `store.json` 에 저장됩니다 (Docker: named volume `tts-data`,
  로컬: `DATA_DIR`). 내용 확인: `docker compose exec tts-bot cat /app/data/store.json`
