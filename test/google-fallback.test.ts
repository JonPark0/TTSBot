import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTestEnv, installFetch, type FetchState } from './helpers.ts';

// Gemini in the chain (TTS_PROVIDER=baze): it speaks German too, so it backs Google up.
setTestEnv({ BAZE_API_KEY: 'baze-test-key', GOOGLE_TTS_API_KEY: 'google-test-key' });

const { initStore } = await import('../src/store.ts');
const { synthesize } = await import('../src/tts/index.ts');
await initStore();

const state: FetchState = { baze: 'ok', google: 403 };
const calls = installFetch(state);

test('a rejected Google key falls back to Gemini, not MeloTTS', async () => {
  assert.equal((await synthesize('Guten Morgen', 'de')).provider, 'baze');
  assert.equal(calls.google, 1);
  assert.equal(calls.cloudflare, 0);
});

test('only: "google" surfaces the error instead of falling back', async () => {
  await assert.rejects(synthesize('Ciao', 'it', { only: 'google' }), /HTTP 403/);
});
