import { config } from '../config.ts';

// Supertonic 3 on a local LLM-8850 (Axera AX8850) card, served by server/tts_server.py.
// POST {LOCAL_TTS_URL}/tts { text, lang, voice? } -> 44.1 kHz mono 16-bit WAV.
// The server applies its own Korean chat normalization (ㅇㅋ → 오케이, ㅋㅋ → 크크, gg → 지지, ...),
// splits long messages to fit the card's fixed input size and peak-normalizes the result.

export type LocalErrorKind = 'unsupported' | 'empty' | 'config' | 'down';

export class LocalError extends Error {
  status: number | undefined;
  kind: LocalErrorKind;

  constructor(message: string, kind: LocalErrorKind, status?: number) {
    super(message);
    this.name = 'LocalError';
    this.kind = kind;
    this.status = status; // HTTP status, or undefined for network errors / timeouts
  }
}

/**
 * Synthesize `text` in `lang` (kr / jp / en; zh is not supported by Supertonic) on the local card server.
 * Throws LocalError: kind 'unsupported' (this language), 'empty' (nothing speakable after the server's
 * normalization), 'config' (token mismatch, unknown voice, other 4xx) or 'down' (unreachable, timeout, 5xx,
 * bad response).
 */
export async function synthesizeLocal(text: string, lang: string): Promise<{ audio: Buffer; genMs: number }> {
  let response: Response;
  try {
    response = await fetch(`${config.localTtsUrl.replace(/\/+$/, '')}/tts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.localTtsToken ? { Authorization: `Bearer ${config.localTtsToken}` } : {}),
      },
      body: JSON.stringify({ text, lang, ...(config.localTtsVoice ? { voice: config.localTtsVoice } : {}) }),
      signal: AbortSignal.timeout(config.localTtsTimeoutMs),
    });
  } catch (err) {
    const { name, message } = err as Error;
    throw new LocalError(`request failed: ${name === 'TimeoutError' ? 'timed out' : message}`, 'down');
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const kind: LocalErrorKind =
      response.status === 422 ? 'unsupported'
      : response.status === 400 && body.includes('empty_text') ? 'empty'
      : response.status < 500 ? 'config'
      : 'down';
    throw new LocalError(`HTTP ${response.status}: ${body.slice(0, 300)}`, kind, response.status);
  }

  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF') {
    throw new LocalError(`unexpected response (${audio.length} bytes)`, 'down', response.status);
  }
  return { audio, genMs: Number(response.headers.get('x-tts-gen-ms')) || 0 };
}
