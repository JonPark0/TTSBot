# Discord TTS Bot (Cloudflare Workers AI)

지정한 텍스트 채널의 메시지를, **그 메시지를 쓴 사람이 들어가 있는 음성 채널**에서
읽어 주는 Discord 봇입니다. TTS는 Cloudflare Workers AI의 `@cf/myshell-ai/melotts`
모델(한국어 지원, 무료 한도 내 사용 가능)을 사용합니다.

## 기능

- 관리자가 `/tts-channel set` 으로 TTS 채널을 지정
- 해당 채널의 메시지를 작성자의 음성 채널에서 음성으로 출력
- 한국어 / 영어 / 중국어 / 일본어 **자동 감지** 후 해당 언어로 합성
- 이모지, 커스텀 이모지, 스티커, GIF/이미지 첨부, URL, 디스코드 마크다운,
  멘션, 스포일러, 특수문자/기타 유니코드 기호 **자동 정리(Sanitization)**
- 무료 한도 보호용 **일일 문자 수 상한**, 메시지 길이 제한, 큐 길이 제한
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

### 2. Cloudflare Workers AI

1. Cloudflare 대시보드 → **Workers & Pages** 우측의 **Account ID** → `CF_ACCOUNT_ID`
2. **My Profile → API Tokens → Create Token → "Workers AI"** 템플릿으로 토큰 생성 → `CF_API_TOKEN`
3. 무료 한도: 하루 10,000 Neurons. `TTS_DAILY_CHAR_LIMIT` 로 문자 수 기준 상한을 걸어
   초과 사용을 막습니다 (기본 100,000자 / UTC 하루).

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
| `CF_ACCOUNT_ID` | — | Cloudflare 계정 ID (필수) |
| `CF_API_TOKEN` | — | Workers AI 권한 토큰 (필수) |
| `CF_TTS_MODEL` | `@cf/myshell-ai/melotts` | 사용할 TTS 모델 ID |
| `CF_GATEWAY_URL` | (없음) | AI Gateway 경유 시 베이스 URL |
| `TTS_DEFAULT_LANG` | `kr` | 언어 감지 실패 시 사용할 언어 (`kr`/`en`/`zh`/`jp`) |
| `TTS_MAX_CHARS` | `200` | 한 메시지에서 읽을 최대 글자 수 |
| `TTS_QUEUE_MAX` | `20` | 서버별 대기 큐 최대 길이 |
| `TTS_IDLE_TIMEOUT_MS` | `300000` | 읽을 게 없을 때 음성 채널에서 나가기까지의 시간 |
| `TTS_READ_CUSTOM_EMOJI_NAMES` | `false` | 커스텀 이모지를 이름으로 읽을지 여부 |
| `TTS_DAILY_CHAR_LIMIT` | `100000` | 봇 전체 일일 문자 수 상한 (0이면 비활성) |
| `TTS_GAIN_KR` / `_JP` / `_EN` | `1` | 언어별 재생 음량 배율 (0 초과 10 이하) |
| `TTS_GAIN_ZH` | `4` | 중국어 재생 음량 배율 (MeloTTS 중국어 출력이 4~5배 작음) |
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

- Node.js 20.9 이상, 그리고 **ffmpeg** 가 PATH에 있어야 합니다.
  (Windows: `winget install Gyan.FFmpeg`, macOS: `brew install ffmpeg`)

```bash
npm install
npm start
```

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
- 라틴 문자 → 영어(`en`)
- 그 외 → `TTS_DEFAULT_LANG`

## 정리(Sanitization) 대상

코드블록/인라인코드, 스포일러(`||...||`), URL, 디스코드 타임스탬프,
유저/역할/채널 멘션(가능하면 이름으로 치환, `@everyone`/`@here` 제거),
커스텀 이모지(`<:name:id>`), 유니코드 이모지·픽토그램·국기·스킨톤,
마크다운 기호(`**`, `*`, `__`, `~~`, `` ` ``, 인용/헤더),
화이트리스트에 없는 특수문자·기호 → 공백 처리 후 공백 정리 및 길이 제한.
스티커 · 이미지 · GIF 등 첨부는 본문에 텍스트가 없으면 그대로 무시됩니다.

## 문제 해결

### 언어별 동작 현황 (2026-10-02 검증)

`@cf/myshell-ai/melotts` 로 합성한 음성을 Whisper(`@cf/openai/whisper-large-v3-turbo`)로
다시 받아써서 확인한 결과, **한국어·일본어·중국어·영어 모두 정상적으로 알아들을 수 있는
음성**이 나옵니다. (과거 보고된 한국어 빈 오디오 문제는 현재 재현되지 않습니다.)

- 응답 형식: 모델 스키마에는 MP3로 적혀 있지만 실제로는 **44.1kHz mono 16-bit WAV**
  (base64)가 옵니다. ffmpeg가 형식을 자동 판별하므로 재생에는 문제없습니다.
- 언어 코드: Workers AI는 `en`, `es`, `fr`, `jp`, `kr`, `zh` 만 받습니다
  (`ko` 는 `8007 Unsupported language` 오류). 매핑은 `LANG_MAP` 에서 처리합니다.
- **중국어 음량**: 중국어 출력은 다른 언어보다 4~5배 작게 나옵니다(RMS 약 0.02 vs 0.07~0.14).
  그래서 `TTS_GAIN_ZH=4` 를 기본값으로 재생 시 증폭합니다. 다른 언어도 `TTS_GAIN_*` 로 조정 가능합니다.

### 소리가 안 나거나 이상할 때

먼저 실제 응답을 확인하세요:

```bash
# 컨테이너 안에서 모델을 직접 호출해 결과를 저장 (확장자는 응답 형식에 맞춰 결정됨)
docker compose exec tts-bot node src/probe.js "안녕하세요 테스트입니다" kr
docker compose exec tts-bot node src/probe.js "你好，这是一个测试。" zh
# 저장된 파일을 호스트로 복사해서 재생 (출력의 saved -> 경로 참고)
docker compose cp tts-bot:/tmp/probe-kr.wav ./
```

`LOG_LEVEL=debug` 로 두면 매 요청의 `status / content-type / bytes / format` 이 로그에 남고,
응답이 800바이트 미만이면 `WARN` 이 찍힙니다.

`cf` CLI가 있다면 봇 없이도 모델을 직접 호출할 수 있습니다:

```bash
cf ai run @cf/myshell-ai/melotts --prompt "안녕하세요" --lang kr
```

참고: `CF_TTS_MODEL` 은 MeloTTS와 같은 요청 형식(`{ prompt, lang }`)을 쓰는 모델만 동작합니다.
현재 Workers AI의 다른 TTS 모델(`@cf/deepgram/aura-*`)은 요청 형식이 다르고 영어/스페인어만
지원하므로, 다른 모델로 설정하면 시작 시 경고가 출력됩니다.

## 참고

- `melotts` 의 `lang` 매핑은 `src/tts/cloudflare.js` 의 `LANG_MAP` 에서 조정합니다.
- 설정과 일일 사용량은 `store.json` 에 저장됩니다 (Docker: named volume `tts-data`,
  로컬: `DATA_DIR`). 내용 확인: `docker compose exec tts-bot cat /app/data/store.json`
