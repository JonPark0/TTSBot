import { config } from '../config.js';
import { logger } from '../logger.js';
import { canSpendCredits, addCredits } from '../store.js';
import { synthesize as synthesizeCloudflare } from './cloudflare.js';
import { synthesizeBaze } from './baze.js';

// Provider chain: Gemini (BAZE) first when configured, Cloudflare MeloTTS as the fallback.
// After a Gemini failure the bot stops trying it for a while instead of paying a failed
// round-trip on every message: auth/permission errors are a config problem (long pause),
// everything else (429, 5xx, timeouts, network) is usually transient (short pause).
const AUTH_COOLDOWN_MS = 30 * 60 * 1000;
const TRANSIENT_COOLDOWN_MS = 60 * 1000;

let bazeCooldownUntil = 0;
let budgetWarnedDate = null;

function bazeSkipReason() {
  if (config.ttsProvider !== 'baze') return 'disabled';
  if (Date.now() < bazeCooldownUntil) return 'cooldown';
  if (!canSpendCredits()) return 'budget';
  return null;
}

function onBazeFailure(err) {
  const auth = err.status === 401 || err.status === 403;
  bazeCooldownUntil = Date.now() + (auth ? AUTH_COOLDOWN_MS : TRANSIENT_COOLDOWN_MS);
  const pause = auth ? '30 min' : '60 s';
  const message = `[tts] Gemini TTS failed (${err.message}) — using MeloTTS, retrying Gemini in ${pause}`;
  if (auth) logger.error(`${message}. Check BAZE_API_KEY / BAZE_TTS_MODEL.`);
  else logger.warn(message);
}

/**
 * Synthesize `text`. `lang` is the detected language, used by MeloTTS (Gemini detects it itself).
 * Returns { audio: Buffer, provider: 'baze' | 'cloudflare' }. Throws only if the fallback fails.
 * Pass `only` to force one provider (used by the probe script).
 */
export async function synthesize(text, lang, { only } = {}) {
  const skip = only === 'cloudflare' ? 'forced' : only === 'baze' ? null : bazeSkipReason();

  if (skip === 'budget') {
    const today = new Date().toISOString().slice(0, 10);
    if (budgetWarnedDate !== today) {
      budgetWarnedDate = today;
      logger.warn(
        `[tts] Gemini daily credit budget (${config.bazeDailyCreditLimit}) reached — using MeloTTS until 00:00 UTC`,
      );
    }
  }

  if (!skip) {
    try {
      const { audio, credits } = await synthesizeBaze(text);
      addCredits(credits);
      logger.debug(`[tts] Gemini ok: ${audio.length} bytes, ${credits.toFixed(3)} credits`);
      return { audio, provider: 'baze' };
    } catch (err) {
      if (only === 'baze') throw err;
      onBazeFailure(err);
    }
  }

  return { audio: await synthesizeCloudflare(text, lang), provider: 'cloudflare' };
}
