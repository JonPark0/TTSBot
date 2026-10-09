import 'dotenv/config';

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

// Playback gain multiplier: must be a positive finite number, capped to avoid ear-splitting typos.
function gain(name: string, fallback: number): number {
  const value = number(name, fallback);
  return value > 0 ? Math.min(value, 10) : fallback;
}

function boolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

export type TtsProvider = 'local' | 'baze' | 'cloudflare';

const localTtsUrl = optional('LOCAL_TTS_URL', '');
const bazeApiKey = optional('BAZE_API_KEY', '');
const cfAccountId = optional('CF_ACCOUNT_ID', '');
const cfApiToken = optional('CF_API_TOKEN', '');
// MeloTTS on Workers AI is available only with both credentials; a local-only deployment needs neither.
const cloudflareEnabled = Boolean(cfAccountId && cfApiToken);

// Primary TTS provider:
//   "local"      — Supertonic 3 on the local LLM-8850 card server (LOCAL_TTS_URL); falls back to
//                  Gemini (if BAZE_API_KEY) and then MeloTTS (if CF_*) when the server is down
//   "baze"       — Gemini, falls back to MeloTTS
//   "cloudflare" — MeloTTS only
// Default: local when LOCAL_TTS_URL is set, else baze when a key is set, else cloudflare,
// so existing deployments keep working unchanged.
function ttsProvider(): TtsProvider {
  const fallback = localTtsUrl ? 'local' : bazeApiKey ? 'baze' : 'cloudflare';
  const requested = optional('TTS_PROVIDER', fallback).toLowerCase();
  if (requested !== 'local' && requested !== 'baze' && requested !== 'cloudflare') {
    console.error(`[config] TTS_PROVIDER must be "local", "baze" or "cloudflare" (got "${requested}")`);
    process.exit(1);
  }
  if (requested === 'local' && !localTtsUrl) {
    console.error('[config] TTS_PROVIDER=local needs LOCAL_TTS_URL (e.g. http://127.0.0.1:8850)');
    process.exit(1);
  }
  if (requested === 'baze' && !bazeApiKey) {
    console.warn('[config] TTS_PROVIDER=baze but BAZE_API_KEY is empty — using cloudflare (MeloTTS) only');
  }
  const provider = requested === 'baze' && !bazeApiKey ? 'cloudflare' : requested;
  if (provider !== 'local' && !cloudflareEnabled) {
    console.error(
      `[config] TTS_PROVIDER=${provider} needs CF_ACCOUNT_ID and CF_API_TOKEN (MeloTTS is its fallback); ` +
        'set them, or use TTS_PROVIDER=local with LOCAL_TTS_URL',
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

  // Cloudflare Workers AI (MeloTTS). Optional when TTS_PROVIDER=local.
  cfAccountId,
  cfApiToken,
  cloudflareEnabled,
  cfTtsModel: optional('CF_TTS_MODEL', '@cf/myshell-ai/melotts'),
  cfGatewayUrl: optional('CF_GATEWAY_URL', ''),

  // BAZE API Gateway (Google Gemini TTS). Primary when a key is set (and no LOCAL_TTS_URL);
  // after the local server when TTS_PROVIDER=local. Cloudflare MeloTTS stays the last fallback.
  bazeApiKey,
  bazeBaseUrl: optional('BAZE_BASE_URL', 'https://factchat-cloud.mindlogic.ai/v1/gateway'),
  bazeTtsModel: optional('BAZE_TTS_MODEL', 'gemini-3.1-flash-tts-preview'),
  bazeTtsVoice: optional('BAZE_TTS_VOICE', 'Kore'),
  // Soft daily credit budget for Gemini TTS (resets at 00:00 UTC). 0 disables it.
  // Default ~= 30,000 monthly credits / 31 days.
  bazeDailyCreditLimit: number('BAZE_DAILY_CREDIT_LIMIT', 900),
  ttsProvider: ttsProvider(),

  // TTS behaviour
  defaultLang: optional('TTS_DEFAULT_LANG', 'kr').toLowerCase(),
  maxChars: number('TTS_MAX_CHARS', 200),
  queueMax: number('TTS_QUEUE_MAX', 20),
  idleTimeoutMs: number('TTS_IDLE_TIMEOUT_MS', 300000),
  readCustomEmojiNames: boolean('TTS_READ_CUSTOM_EMOJI_NAMES', false),
  dailyCharLimit: number('TTS_DAILY_CHAR_LIMIT', 100000),
  // Per-language playback gain, applied to MeloTTS (Cloudflare) output only. MeloTTS renders
  // Chinese ~4-5x quieter (RMS ~0.02) than Korean/Japanese/English (RMS ~0.07-0.14), so zh is
  // boosted by default. Gemini output is already loud (peak ~0.85) and would clip if boosted.
  langGain: {
    kr: gain('TTS_GAIN_KR', 1),
    jp: gain('TTS_GAIN_JP', 1),
    zh: gain('TTS_GAIN_ZH', 4),
    en: gain('TTS_GAIN_EN', 1),
  } as Record<string, number>,

  // Runtime
  dataDir: optional('DATA_DIR', './data'),
  logLevel: optional('LOG_LEVEL', 'info').toLowerCase(),
};
