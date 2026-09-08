import { config } from '../config.js';
import { logger } from '../logger.js';

// Map our internal detector codes to the MeloTTS `lang` values Workers AI expects.
// Upstream MeloTTS uses: EN, ES, FR, ZH, JP, KR (Cloudflare accepts them lower-cased).
// NOTE: Cloudflare's hosted @cf/myshell-ai/melotts is known to be unreliable for
// non-English input (see README troubleshooting). Adjust here if CF changes it.
const LANG_MAP = {
  kr: 'kr',
  ko: 'kr',
  jp: 'jp',
  ja: 'jp',
  zh: 'zh',
  'zh-cn': 'zh',
  'zh-tw': 'zh',
  en: 'en',
};

function endpoint() {
  if (config.cfGatewayUrl) {
    return `${config.cfGatewayUrl.replace(/\/+$/, '')}/${config.cfTtsModel}`;
  }
  return `https://api.cloudflare.com/client/v4/accounts/${config.cfAccountId}/ai/run/${config.cfTtsModel}`;
}

function sniff(buffer) {
  if (buffer.length >= 3 && buffer.toString('ascii', 0, 3) === 'ID3') return 'mp3(ID3)';
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return 'mp3(frame)';
  if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'RIFF') return 'wav';
  if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'OggS') return 'ogg';
  return 'unknown';
}

/**
 * Synthesize `text` in `lang` via Cloudflare Workers AI.
 * Returns a Buffer containing an audio file (MP3/WAV for MeloTTS).
 */
export async function synthesize(text, lang) {
  const mapped = LANG_MAP[lang] || LANG_MAP[config.defaultLang] || 'en';

  const response = await fetch(endpoint(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.cfApiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prompt: text, lang: mapped }),
  });

  const contentType = response.headers.get('content-type') || '';

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Cloudflare AI HTTP ${response.status} (lang=${mapped}): ${body.slice(0, 400)}`);
  }

  let audio;
  // MeloTTS returns JSON: { result: { audio: "<base64 mp3>" }, success: true }
  if (contentType.includes('application/json')) {
    const json = await response.json();
    if (json.success === false) {
      throw new Error(
        `Cloudflare AI error (lang=${mapped}): ${JSON.stringify(json.errors || json).slice(0, 400)}`,
      );
    }
    const base64 = json?.result?.audio ?? json?.audio;
    if (!base64) {
      throw new Error(
        `Cloudflare AI response had no audio (lang=${mapped}): ${JSON.stringify(json).slice(0, 400)}`,
      );
    }
    audio = Buffer.from(base64, 'base64');
  } else {
    // Some models / AI Gateway configs return raw audio bytes.
    audio = Buffer.from(await response.arrayBuffer());
  }

  logger.debug(
    `[tts] CF ok: lang=${mapped} status=${response.status} ct=${contentType || 'n/a'} ` +
      `bytes=${audio.length} format=${sniff(audio)}`,
  );
  if (audio.length < 800) {
    logger.warn(
      `[tts] CF returned only ${audio.length} bytes for lang=${mapped} — likely empty/failed synthesis`,
    );
  }

  return audio;
}
