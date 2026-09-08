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

  // TTS behaviour
  defaultLang: optional('TTS_DEFAULT_LANG', 'kr').toLowerCase(),
  maxChars: number('TTS_MAX_CHARS', 200),
  queueMax: number('TTS_QUEUE_MAX', 20),
  idleTimeoutMs: number('TTS_IDLE_TIMEOUT_MS', 300000),
  readCustomEmojiNames: boolean('TTS_READ_CUSTOM_EMOJI_NAMES', false),
  dailyCharLimit: number('TTS_DAILY_CHAR_LIMIT', 100000),

  // Runtime
  dataDir: optional('DATA_DIR', './data'),
  logLevel: optional('LOG_LEVEL', 'info').toLowerCase(),
};
