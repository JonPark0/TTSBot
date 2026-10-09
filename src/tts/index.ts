import { config, type TtsProvider } from '../config.ts';
import { logger } from '../logger.ts';
import { canSpendCredits, addCredits } from '../store.ts';
import { synthesize as synthesizeCloudflare } from './cloudflare.ts';
import { synthesizeBaze, type BazeError } from './baze.ts';
import { synthesizeLocal, type LocalError } from './local.ts';

// Provider chain, by TTS_PROVIDER:
//   local      → local card server → Gemini (if BAZE_API_KEY) → MeloTTS (if CF_*)
//   baze       → Gemini → MeloTTS
//   cloudflare → MeloTTS
// After a failure the bot stops trying that provider for a while instead of paying a failed
// round-trip on every message: auth/permission errors are a config problem (long pause),
// everything else (429, 5xx, timeouts, network, a stopped local server) is usually transient (short pause).
// A language the local server does not speak (zh) only sends that one message down the chain;
// a token or voice the server rejects (4xx) is a config problem and pauses it like an auth error.
const AUTH_COOLDOWN_MS = 30 * 60 * 1000;
const TRANSIENT_COOLDOWN_MS = 60 * 1000;
const LOCAL_DOWN_COOLDOWN_MS = 30 * 1000;

let bazeCooldownUntil = 0;
let localCooldownUntil = 0;
let budgetWarnedDate: string | null = null;

/** Thrown when there is nothing to say (the local server found nothing speakable). Not an error. */
export class SkipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkipError';
  }
}

function bazeSkipReason() {
  if (!config.bazeApiKey || config.ttsProvider === 'cloudflare') return 'disabled';
  if (Date.now() < bazeCooldownUntil) return 'cooldown';
  if (!canSpendCredits()) return 'budget';
  return null;
}

function onBazeFailure(err: BazeError) {
  const auth = err.status === 401 || err.status === 403;
  bazeCooldownUntil = Date.now() + (auth ? AUTH_COOLDOWN_MS : TRANSIENT_COOLDOWN_MS);
  const pause = auth ? '30 min' : '60 s';
  const message = `[tts] Gemini TTS failed (${err.message}) — using MeloTTS, retrying Gemini in ${pause}`;
  if (auth) logger.error(`${message}. Check BAZE_API_KEY / BAZE_TTS_MODEL.`);
  else logger.warn(message);
}

function onLocalFailure(err: LocalError) {
  if (err.kind === 'unsupported') {
    logger.debug(`[tts] local server does not speak this language (${err.message}) — next provider`);
    return;
  }
  const config4xx = err.kind === 'config';
  localCooldownUntil = Date.now() + (config4xx ? AUTH_COOLDOWN_MS : LOCAL_DOWN_COOLDOWN_MS);
  const message = `[tts] local TTS failed (${err.message}) — using the fallback, retrying local in ${config4xx ? '30 min' : '30 s'}`;
  if (config4xx) logger.error(`${message}. Check LOCAL_TTS_TOKEN (server TTS_SERVER_TOKEN) and LOCAL_TTS_VOICE.`);
  else logger.warn(message);
}

/**
 * Synthesize `text`. `lang` is the detected language (kr / jp / zh / en), used by the local server and
 * MeloTTS (Gemini detects it itself). Returns { audio: Buffer, provider }.
 * Throws SkipError when the local server says there is nothing to read, otherwise only if the last
 * provider in the chain fails. Pass `only` to force one provider (used by the probe script), and
 * `paid: false` to keep to the local server when the daily character budget for the paid/free-tier
 * cloud providers is spent.
 */
export async function synthesize(
  text: string,
  lang: string,
  { only, paid = true }: { only?: TtsProvider; paid?: boolean } = {},
): Promise<{ audio: Buffer; provider: TtsProvider }> {
  let lastError: Error | null = null;

  if (only === 'local' || (!only && config.ttsProvider === 'local')) {
    if (only || Date.now() >= localCooldownUntil) {
      try {
        const { audio, genMs } = await synthesizeLocal(text, lang);
        logger.debug(`[tts] local ok: ${audio.length} bytes in ${genMs} ms`);
        return { audio, provider: 'local' };
      } catch (err) {
        const e = err as LocalError;
        if (e.kind === 'empty') throw new SkipError(`nothing to read: ${e.message}`);
        if (only) throw err;
        onLocalFailure(e);
        lastError = e;
      }
    }
    if (!paid) throw lastError ?? new Error('local TTS paused and the daily budget for cloud TTS is spent');
  }

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
      onBazeFailure(err as BazeError);
      lastError = err as Error;
    }
  }

  if (!config.cloudflareEnabled) {
    throw lastError ?? new Error('no TTS provider available (MeloTTS needs CF_ACCOUNT_ID / CF_API_TOKEN)');
  }
  return { audio: await synthesizeCloudflare(text, lang), provider: 'cloudflare' };
}
