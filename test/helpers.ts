// Shared setup for tests: dummy credentials, a throwaway data dir, and a fake `fetch`
// that answers the local card server, BAZE, Google and Anthropic endpoints without touching the network.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const BAZE_URL = 'https://baze.test/v1/gateway';
export const LOCAL_URL = 'http://tts.test:8850';

export function setTestEnv(extra: Record<string, string> = {}) {
  Object.assign(process.env, {
    DISCORD_TOKEN: 'test',
    DISCORD_CLIENT_ID: 'test',
    ANTHROPIC_API_KEY: '',
    BAZE_BASE_URL: BAZE_URL,
    DATA_DIR: mkdtempSync(path.join(tmpdir(), 'ttsbot-test-')),
    LOG_LEVEL: 'error',
    ...extra,
  });
}

/** 0.1 s of a 440 Hz tone as raw 24 kHz mono s16le PCM, like the gateway returns. */
export function fakePcm(seconds = 0.1) {
  const n = Math.round(24000 * seconds);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 24000) * 12000), i * 2);
  return buf;
}

/** A minimal WAV like the local card server returns. */
function fakeWav() {
  return Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(2000)]);
}

/** A Messages API reply whose text block carries `json` (structured output). */
function fakeClaude(text: string, stopReason = 'end_turn') {
  return JSON.stringify({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content: stopReason === 'refusal' ? [] : [{ type: 'text', text }],
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 1000, output_tokens: 200 },
  });
}

export interface FetchState {
  baze: 'ok' | 'json200' | 'network' | number;
  local?: 'ok' | 'network' | 'unsupported' | 'empty' | number;
  google?: 'ok' | 'network' | number;
  /** 'ok' answers with `anthropicText` (default: a fixed Korean rewrite). */
  anthropic?: 'ok' | 'refusal' | 'network' | number;
  anthropicText?: string;
}

export interface FetchCalls {
  local: number;
  localBodies: unknown[];
  baze: number;
  bazeBodies: { input: string }[];
  bazeAuth?: string;
  google: number;
  googleBodies: { voice: { languageCode: string; name: string } }[];
  googleKey?: string;
  googleTexts: string[];
  anthropic: number;
  anthropicBodies: { messages: { content: string }[] }[];
}

/**
 * Install a fake fetch. `baze` decides the BAZE response per call:
 * 'ok' | an HTTP status number | 'json200' | 'network'.
 * Returns a `calls` record of which endpoints were hit.
 */
export function installFetch(state: FetchState): FetchCalls {
  const calls: FetchCalls = {
    local: 0,
    localBodies: [],
    baze: 0,
    bazeBodies: [],
    google: 0,
    googleBodies: [],
    googleTexts: [],
    anthropic: 0,
    anthropicBodies: [],
  };
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(LOCAL_URL)) {
      calls.local++;
      calls.localBodies.push(JSON.parse(String(init?.body)));
      const mode = state.local ?? 'ok';
      if (mode === 'network') throw new TypeError('fetch failed');
      if (mode === 'unsupported') {
        return new Response('{"error":"unsupported_language","lang":"zh"}', { status: 422, headers: { 'content-type': 'application/json' } });
      }
      if (mode === 'empty') {
        return new Response('{"error":"empty_text"}', { status: 400, headers: { 'content-type': 'application/json' } });
      }
      if (typeof mode === 'number') {
        return new Response(`{"error":"status ${mode}"}`, { status: mode, headers: { 'content-type': 'application/json' } });
      }
      return new Response(fakeWav(), { status: 200, headers: { 'content-type': 'audio/wav', 'x-tts-gen-ms': '180' } });
    }
    if (String(url).startsWith(BAZE_URL)) {
      calls.baze++;
      calls.bazeBodies.push(JSON.parse(String(init?.body)));
      calls.bazeAuth = (init?.headers as Record<string, string>).Authorization;
      const mode = state.baze;
      if (mode === 'network') throw new TypeError('fetch failed');
      if (mode === 'json200') {
        return new Response('{"error":"weird"}', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (typeof mode === 'number') {
        return new Response(`{"error":"status ${mode}"}`, { status: mode, headers: { 'content-type': 'application/json' } });
      }
      return new Response(fakePcm(), {
        status: 200,
        headers: { 'content-type': 'audio/pcm', 'x-input-tokens': '13', 'x-output-tokens': '111' },
      });
    }
    if (String(url).startsWith('https://texttospeech.googleapis.com/')) {
      calls.google++;
      const body = JSON.parse(String(init?.body));
      calls.googleBodies.push(body);
      calls.googleTexts.push(body.input.text);
      calls.googleKey = (init?.headers as Record<string, string>)['X-Goog-Api-Key'];
      const mode = state.google ?? 'ok';
      if (mode === 'network') throw new TypeError('fetch failed');
      if (typeof mode === 'number') {
        return new Response(`{"error":{"code":${mode}}}`, { status: mode, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ audioContent: fakeWav().toString('base64') }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (String(url).startsWith('https://api.anthropic.com/')) {
      const json = { 'content-type': 'application/json' };
      if (String(url).includes('/v1/models/')) {
        return new Response('{"type":"model","id":"claude-haiku-5-5"}', { status: 200, headers: json });
      }
      calls.anthropic++;
      calls.anthropicBodies.push(JSON.parse(String(init?.body)));
      const mode = state.anthropic ?? 'ok';
      if (mode === 'network') throw new TypeError('fetch failed');
      if (typeof mode === 'number') {
        return new Response(`{"type":"error","error":{"type":"api_error","message":"status ${mode}"}}`, { status: mode, headers: json });
      }
      const text = JSON.stringify({ text: state.anthropicText ?? 'ㅇㅋ 십 분 뒤에 들어갈게' });
      return new Response(fakeClaude(text, mode === 'refusal' ? 'refusal' : 'end_turn'), { status: 200, headers: json });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return calls;
}
