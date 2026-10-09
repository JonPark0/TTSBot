// Shared setup for tests: dummy credentials, a throwaway data dir, and a fake `fetch`
// that answers the local card server, BAZE and Cloudflare endpoints without touching the network.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const BAZE_URL = 'https://baze.test/v1/gateway';
export const LOCAL_URL = 'http://tts.test:8850';

export function setTestEnv(extra: Record<string, string> = {}) {
  Object.assign(process.env, {
    DISCORD_TOKEN: 'test',
    DISCORD_CLIENT_ID: 'test',
    CF_ACCOUNT_ID: 'acc',
    CF_API_TOKEN: 'cf-token',
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

/** A minimal WAV, base64-wrapped the way Workers AI returns MeloTTS audio. */
function fakeMeloJson() {
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(2000)]);
  return JSON.stringify({ result: { audio: wav.toString('base64') }, success: true, errors: [] });
}

export interface FetchState {
  baze: 'ok' | 'json200' | 'network' | number;
  local?: 'ok' | 'network' | 'unsupported' | 'empty' | number;
}

export interface FetchCalls {
  local: number;
  localBodies: unknown[];
  baze: number;
  cloudflare: number;
  bazeBodies: unknown[];
  bazeAuth?: string;
}

/**
 * Install a fake fetch. `baze` decides the BAZE response per call:
 * 'ok' | an HTTP status number | 'json200' | 'network'.
 * Returns a `calls` record of which endpoints were hit.
 */
export function installFetch(state: FetchState): FetchCalls {
  const calls: FetchCalls = { local: 0, localBodies: [], baze: 0, cloudflare: 0, bazeBodies: [] };
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
    if (String(url).includes('api.cloudflare.com')) {
      calls.cloudflare++;
      return new Response(fakeMeloJson(), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return calls;
}
