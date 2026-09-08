import { config } from '../config.js';

// Map our internal detector codes to the MeloTTS `lang` values Workers AI expects.
// MeloTTS supports: en, es, fr, zh, jp, kr
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

/**
 * Synthesize `text` in `lang` via Cloudflare Workers AI.
 * Returns a Buffer containing an audio file (MP3 for MeloTTS).
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

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Cloudflare AI HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  const contentType = response.headers.get('content-type') || '';

  // MeloTTS returns JSON: { result: { audio: "<base64 mp3>" }, success: true }
  if (contentType.includes('application/json')) {
    const json = await response.json();
    if (json.success === false) {
      throw new Error(`Cloudflare AI error: ${JSON.stringify(json.errors || json).slice(0, 300)}`);
    }
    const base64 = json?.result?.audio ?? json?.audio;
    if (!base64) {
      throw new Error(`Cloudflare AI response had no audio: ${JSON.stringify(json).slice(0, 300)}`);
    }
    return Buffer.from(base64, 'base64');
  }

  // Some models / AI Gateway configs return raw audio bytes.
  return Buffer.from(await response.arrayBuffer());
}
