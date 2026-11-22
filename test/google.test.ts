import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setTestEnv, installFetch, type FetchState } from './helpers.ts';

// Google only. TTS_PROVIDER=cloudflare is what an .env from the MeloTTS days says; it now means google.
// A 40-character Google budget allows the first four messages below.
setTestEnv({
  TTS_PROVIDER: 'cloudflare',
  BAZE_API_KEY: 'baze-test-key',
  GOOGLE_TTS_API_KEY: 'google-test-key',
  GOOGLE_TTS_DAILY_CHAR_LIMIT: '40',
});
mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-29T01:00:00Z') });

const { config } = await import('../src/config.ts');
const { initStore, usageInfo } = await import('../src/store.ts');
const { synthesize } = await import('../src/tts/index.ts');
await initStore();

const state: FetchState = { baze: 'ok' };
const calls = installFetch(state);

// The cases share module state (cooldown, budget), so they run in order.
test('the retired cloudflare provider is read as google', () => {
  assert.equal(config.ttsProvider, 'google');
});

test('German goes to Google with the German voice; the key is sent as a header', async () => {
  const { provider } = await synthesize('Guten Morgen', 'de');
  assert.equal(provider, 'google');
  assert.deepEqual(calls.googleBodies[0].voice, { languageCode: 'de-DE', name: 'de-DE-Chirp3-HD-Kore' });
  assert.equal(calls.googleKey, 'google-test-key');
  assert.equal(usageInfo().googleChars, 'Guten Morgen'.length);
});

test('Italian goes to Google with the Italian voice', async () => {
  assert.equal((await synthesize('Ciao a tutti', 'it')).provider, 'google');
  assert.deepEqual(calls.googleBodies[1].voice, { languageCode: 'it-IT', name: 'it-IT-Chirp3-HD-Kore' });
});

test('the other languages use Google with their own voice and never Gemini', async () => {
  assert.equal((await synthesize('안녕하세요', 'kr')).provider, 'google');
  assert.deepEqual(calls.googleBodies[2].voice, { languageCode: 'ko-KR', name: 'ko-KR-Chirp3-HD-Kore' });
  assert.equal((await synthesize('hello', 'en')).provider, 'google');
  assert.deepEqual(calls.googleBodies[3].voice, { languageCode: 'en-US', name: 'en-US-Chirp3-HD-Kore' });
  assert.equal(calls.baze, 0);
});

test('a Google error surfaces; while Google is paused for 60 s messages are skipped quietly', async () => {
  state.google = 503;
  await assert.rejects(synthesize('Hallo', 'de'), /HTTP 503/);
  assert.equal(calls.google, 5);

  state.google = 'ok';
  await assert.rejects(synthesize('Hallo', 'de'), { name: 'SkipError' });
  await assert.rejects(synthesize('안녕', 'kr'), { name: 'SkipError' });
  assert.equal(calls.google, 5, 'Google must not be called during the cooldown');

  mock.timers.tick(61_000);
  assert.equal((await synthesize('Hallo', 'de')).provider, 'google');
});

test('once the daily Google budget is spent, messages wait for the next UTC day', async () => {
  await assert.rejects(synthesize('Das ist ein ziemlich langer Satz', 'de'), { name: 'SkipError' });
  const before = calls.google;

  mock.timers.tick(24 * 60 * 60_000);
  assert.equal((await synthesize('Das ist ein ziemlich langer Satz', 'de')).provider, 'google');
  assert.equal(calls.google, before + 1);
});
