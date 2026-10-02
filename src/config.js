import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    console.error(`[config] Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value.trim();
}

function optional(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value.trim();
}

function number(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// Playback gain multiplier: must be a positive finite number, capped to avoid ear-splitting typos.
function gain(name, fallback) {
  const value = number(name, fallback);
  return value > 0 ? Math.min(value, 10) : fallback;
}

function boolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

export const config = {
  // Discord
  discordToken: required('DISCORD_TOKEN'),
  discordClientId: required('DISCORD_CLIENT_ID'),

  // Cloudflare Workers AI
  cfAccountId: required('CF_ACCOUNT_ID'),
  cfApiToken: required('CF_API_TOKEN'),
  cfTtsModel: optional('CF_TTS_MODEL', '@cf/myshell-ai/melotts'),
  cfGatewayUrl: optional('CF_GATEWAY_URL', ''),

  // BAZE API Gateway (Google Gemini TTS). Used as the primary provider when a key is set;
  // Cloudflare MeloTTS above stays the fallback, so CF_* remain required.
  bazeApiKey: optional('BAZE_API_KEY', ''),
  bazeBaseUrl: optional('BAZE_BASE_URL', 'https://factchat-cloud.mindlogic.ai/v1/gateway'),
  bazeTtsModel: optional('BAZE_TTS_MODEL', 'gemini-3.1-flash-tts-preview'),
  bazeTtsVoice: optional('BAZE_TTS_VOICE', 'Kore'),
  // Soft daily credit budget for Gemini TTS (resets at 00:00 UTC). 0 disables it.
  // Default ~= 30,000 monthly credits / 31 days.
  bazeDailyCreditLimit: number('BAZE_DAILY_CREDIT_LIMIT', 900),

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
  },

  // Runtime
  dataDir: optional('DATA_DIR', './data'),
  logLevel: optional('LOG_LEVEL', 'info').toLowerCase(),
};

// Primary TTS provider: "baze" (Gemini, falls back to MeloTTS) or "cloudflare" (MeloTTS only).
// Defaults to baze only when a key is configured, so existing deployments keep working.
const requestedProvider = optional('TTS_PROVIDER', config.bazeApiKey ? 'baze' : 'cloudflare').toLowerCase();
if (!['baze', 'cloudflare'].includes(requestedProvider)) {
  console.error(`[config] TTS_PROVIDER must be "baze" or "cloudflare" (got "${requestedProvider}")`);
  process.exit(1);
}
if (requestedProvider === 'baze' && !config.bazeApiKey) {
  console.warn('[config] TTS_PROVIDER=baze but BAZE_API_KEY is empty — using cloudflare (MeloTTS) only');
}
config.ttsProvider = requestedProvider === 'baze' && config.bazeApiKey ? 'baze' : 'cloudflare';
