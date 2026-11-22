// Docker Compose passes the variables in (env_file). For `npm run dev` / `node src/...` outside a
// container, read ./.env when there is one.
try {
  process.loadEnvFile();
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    console.error(`[config] Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value.trim();
}

function number(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

export type TtsProvider = 'local' | 'baze' | 'google';
/** Who synthesized a message: one of the TTS_PROVIDER values. */
export type TtsSource = TtsProvider;

const localTtsUrl = optional('LOCAL_TTS_URL', '');
const bazeApiKey = optional('BAZE_API_KEY', '');
const googleTtsApiKey = optional('GOOGLE_TTS_API_KEY', '');

// Cloudflare Workers AI retired @cf/myshell-ai/melotts on 2026-11-20 (HTTP 410, error 5028) and
// has no other TTS model that speaks Korean, Japanese or Chinese, so MeloTTS was removed and
// Google Cloud TTS took its place as the last fallback.
if (process.env.CF_ACCOUNT_ID || process.env.CF_API_TOKEN || process.env.CF_TTS_MODEL) {
  console.warn('[config] CF_ACCOUNT_ID / CF_API_TOKEN / CF_TTS_MODEL are ignored: MeloTTS was retired on 2026-11-20');
}

// Primary TTS provider:
//   "local"  : Supertonic 3 on the local LLM-8850 card server (LOCAL_TTS_URL); falls back to
//              Gemini (if BAZE_API_KEY) and then Google (if GOOGLE_TTS_API_KEY) when the server is down
//   "baze"   : Gemini, falls back to Google
//   "google" : Google Cloud TTS only
// German and Italian go to Google before Gemini (Google's free tier is cheaper than Gemini credits).
// Default: local when LOCAL_TTS_URL is set, else baze when a key is set, else google.
// "cloudflare" (the old MeloTTS-only mode) is read as "google" so an existing .env keeps working.
function ttsProvider(): TtsProvider {
  const fallback = localTtsUrl ? 'local' : bazeApiKey ? 'baze' : 'google';
  let requested = optional('TTS_PROVIDER', fallback).toLowerCase();
  if (requested === 'cloudflare') {
    console.warn('[config] TTS_PROVIDER=cloudflare (MeloTTS) was retired, using "google"');
    requested = 'google';
  }
  if (requested !== 'local' && requested !== 'baze' && requested !== 'google') {
    console.error(`[config] TTS_PROVIDER must be "local", "baze" or "google" (got "${requested}")`);
    process.exit(1);
  }
  if (requested === 'local' && !localTtsUrl) {
    console.error('[config] TTS_PROVIDER=local needs LOCAL_TTS_URL (e.g. http://127.0.0.1:8850)');
    process.exit(1);
  }
  if (requested === 'baze' && !bazeApiKey) {
    console.warn('[config] TTS_PROVIDER=baze but BAZE_API_KEY is empty, using google only');
  }
  const provider = requested === 'baze' && !bazeApiKey ? 'google' : requested;
  if (provider === 'google' && !googleTtsApiKey) {
    console.error(
      '[config] TTS_PROVIDER=google needs GOOGLE_TTS_API_KEY; set it, or set BAZE_API_KEY (Gemini) ' +
        'or LOCAL_TTS_URL (local card server)',
    );
    process.exit(1);
  }
  return provider;
}

export const config = {
  // Discord
  discordToken: required('DISCORD_TOKEN'),
  discordClientId: required('DISCORD_CLIENT_ID'),

  // Local Supertonic 3 server on the LLM-8850 card (server/ in this repo)
  localTtsUrl,
  localTtsVoice: optional('LOCAL_TTS_VOICE', ''), // empty = the server's default voice
  localTtsToken: optional('LOCAL_TTS_TOKEN', ''), // must match the server's TTS_SERVER_TOKEN if it has one
  localTtsTimeoutMs: number('LOCAL_TTS_TIMEOUT_MS', 10000),

  // BAZE API Gateway (Google Gemini TTS). Primary when a key is set (and no LOCAL_TTS_URL);
  // after the local server when TTS_PROVIDER=local. Google Cloud TTS is the last fallback.
  bazeApiKey,
  bazeBaseUrl: optional('BAZE_BASE_URL', 'https://factchat-cloud.mindlogic.ai/v1/gateway'),
  bazeTtsModel: optional('BAZE_TTS_MODEL', 'gemini-3.1-flash-tts-preview'),
  bazeTtsVoice: optional('BAZE_TTS_VOICE', 'Kore'),
  // Soft daily credit budget for Gemini TTS (resets at 00:00 UTC). 0 disables it.
  // Default ~= 30,000 monthly credits / 31 days.
  bazeDailyCreditLimit: number('BAZE_DAILY_CREDIT_LIMIT', 900),

  // Google Cloud Text-to-Speech: German and Italian first (the other providers can't or cost more),
  // and every other language as the last fallback. Voices are Chirp 3 HD by default (Kore, the
  // Gemini voice's name); the language comes from the voice name.
  googleTtsApiKey,
  googleVoices: {
    kr: optional('GOOGLE_TTS_VOICE_KR', 'ko-KR-Chirp3-HD-Kore'),
    jp: optional('GOOGLE_TTS_VOICE_JP', 'ja-JP-Chirp3-HD-Kore'),
    zh: optional('GOOGLE_TTS_VOICE_ZH', 'cmn-CN-Chirp3-HD-Kore'),
    en: optional('GOOGLE_TTS_VOICE_EN', 'en-US-Chirp3-HD-Kore'),
    de: optional('GOOGLE_TTS_VOICE_DE', 'de-DE-Chirp3-HD-Kore'),
    it: optional('GOOGLE_TTS_VOICE_IT', 'it-IT-Chirp3-HD-Kore'),
  } as Record<string, string>,
  // Daily character budget for Google (resets at 00:00 UTC; 0 disables it). The Chirp 3 HD free
  // tier is 1M characters a month, so 30,000 a day stays inside it.
  googleDailyCharLimit: number('GOOGLE_TTS_DAILY_CHAR_LIMIT', 30000),
  ttsProvider: ttsProvider(),

  // TTS behaviour
  defaultLang: optional('TTS_DEFAULT_LANG', 'kr').toLowerCase(),
  maxChars: number('TTS_MAX_CHARS', 200),
  queueMax: number('TTS_QUEUE_MAX', 20),
  idleTimeoutMs: number('TTS_IDLE_TIMEOUT_MS', 300000),
  readCustomEmojiNames: boolean('TTS_READ_CUSTOM_EMOJI_NAMES', false),
  dailyCharLimit: number('TTS_DAILY_CHAR_LIMIT', 100000),

  // Claude (Anthropic API) rewrites numbers, units and Latin abbreviations into how they are read
  // aloud before the text goes to the local card server or Google (Gemini reads them well by itself).
  // Optional and failsafe: without a key, or while the API is failing or the daily budget is spent,
  // the text is read as it is.
  anthropicApiKey: optional('ANTHROPIC_API_KEY', ''),
  normalizeEnabled: boolean('TTS_NORMALIZE', true),
  normalizeModel: optional('TTS_NORMALIZE_MODEL', 'claude-haiku-5-5'),
  normalizeTimeoutMs: number('TTS_NORMALIZE_TIMEOUT_MS', 1500),
  // Soft daily budget in USD (resets at 00:00 UTC; 0 disables it).
  normalizeDailyUsd: number('TTS_NORMALIZE_DAILY_USD', 0.3),
  // Model prices in USD per million tokens (Claude Haiku 5.5, prompts up to 100K tokens).
  normalizePriceIn: number('TTS_NORMALIZE_PRICE_IN', 0.1),
  normalizePriceOut: number('TTS_NORMALIZE_PRICE_OUT', 0.5),

  // Runtime
  dataDir: optional('DATA_DIR', './data'),
  logLevel: optional('LOG_LEVEL', 'info').toLowerCase(),
};
