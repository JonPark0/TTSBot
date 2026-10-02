import { config } from '../config.js';

// Google Gemini TTS through the BAZE API Gateway (POST /audio/speech/).
// Docs: https://docs.mindlogic.ai/docs/inu/api-gateway/reference/audio-tts
// The response is raw PCM (24 kHz, mono, 16-bit LE) with no container, which ffmpeg
// can't probe — so it is wrapped in a WAV header before playback.

const PCM_SAMPLE_RATE = 24000;
const PCM_CHANNELS = 1;
const PCM_BITS = 16;
const REQUEST_TIMEOUT_MS = 15000;

// Credits per 10k tokens, from the gateway's model table. Unknown models are charged at the
// highest known rate so the daily budget over-counts rather than under-counts.
const CREDIT_RATES = {
  'gemini-3.1-flash-tts-preview': { input: 10, output: 200 },
  'gemini-2.5-flash-preview-tts': { input: 5, output: 100 },
  'gemini-2.5-pro-preview-tts': { input: 10, output: 200 },
};
const FALLBACK_RATE = { input: 10, output: 200 };

export class BazeError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'BazeError';
    this.status = status; // HTTP status, or undefined for network errors / timeouts
  }
}

export function pcmToWav(pcm, sampleRate = PCM_SAMPLE_RATE, channels = PCM_CHANNELS, bits = PCM_BITS) {
  const blockAlign = (channels * bits) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28); // byte rate
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function creditsFor(model, inputTokens, outputTokens) {
  const rate = CREDIT_RATES[model] || FALLBACK_RATE;
  return (inputTokens * rate.input + outputTokens * rate.output) / 10000;
}

/**
 * Synthesize `text` with Gemini TTS. Gemini picks the language from the text itself.
 * Returns { audio: <WAV Buffer>, credits }. Throws BazeError on any failure.
 */
export async function synthesizeBaze(text) {
  let response;
  try {
    response = await fetch(`${config.bazeBaseUrl.replace(/\/+$/, '')}/audio/speech/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.bazeApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: config.bazeTtsModel, input: text, voice: config.bazeTtsVoice }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new BazeError(`request failed: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new BazeError(`HTTP ${response.status}: ${body.slice(0, 300)}`, response.status);
  }

  // A JSON body on a 2xx would be an error envelope, not audio — never play it as PCM noise.
  if ((response.headers.get('content-type') || '').includes('json')) {
    const body = await response.text().catch(() => '');
    throw new BazeError(`unexpected JSON response: ${body.slice(0, 300)}`, response.status);
  }

  const pcm = Buffer.from(await response.arrayBuffer());
  if (pcm.length === 0) throw new BazeError('empty audio response', response.status);

  const inputTokens = Number(response.headers.get('x-input-tokens')) || 0;
  const outputTokens = Number(response.headers.get('x-output-tokens')) || 0;
  return {
    audio: pcmToWav(pcm),
    credits: creditsFor(config.bazeTtsModel, inputTokens, outputTokens),
  };
}
