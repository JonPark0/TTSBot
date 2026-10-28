import { config } from '../config.ts';

// Google Cloud Text-to-Speech (POST /v1/text:synthesize), used for the languages MeloTTS has no
// voice for: German and Italian (googleVoices in config.ts).
// Docs: https://cloud.google.com/text-to-speech/docs/reference/rest/v1/text/synthesize
// LINEAR16 comes back as a complete WAV (24 kHz mono 16-bit for Chirp 3 HD), base64 in JSON.
// The key goes in a header, not the URL, so it never shows up in an error message.

const ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const REQUEST_TIMEOUT_MS = 10000;

export class GoogleError extends Error {
  status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'GoogleError';
    this.status = status; // HTTP status, or undefined for network errors / timeouts
  }
}

/** "de-DE-Chirp3-HD-Kore" -> "de-DE" */
function languageCode(voice: string): string {
  return voice.split('-').slice(0, 2).join('-');
}

/** True when Google speaks `lang` (a detector code: de / it) and has a key. */
export function googleSpeaks(lang: string): boolean {
  return Boolean(config.googleTtsApiKey && config.googleVoices[lang]);
}

/**
 * Synthesize `text` in `lang` with that language's Google voice (GOOGLE_TTS_VOICE_DE / _IT).
 * Returns a WAV Buffer. Throws GoogleError on any failure.
 */
export async function synthesizeGoogle(text: string, lang: string): Promise<Buffer> {
  const voice = config.googleVoices[lang];
  if (!voice) throw new GoogleError(`no Google voice for "${lang}"`);
  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'X-Goog-Api-Key': config.googleTtsApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: languageCode(voice), name: voice },
        audioConfig: { audioEncoding: 'LINEAR16' },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const { name, message } = err as Error;
    throw new GoogleError(`request failed: ${name === 'TimeoutError' ? 'timed out' : message}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new GoogleError(`HTTP ${response.status}: ${body.slice(0, 300)}`, response.status);
  }

  const json = (await response.json().catch(() => null)) as { audioContent?: string } | null;
  const audio = json?.audioContent ? Buffer.from(json.audioContent, 'base64') : Buffer.alloc(0);
  if (audio.length === 0) throw new GoogleError('empty audio response', response.status);
  return audio;
}
