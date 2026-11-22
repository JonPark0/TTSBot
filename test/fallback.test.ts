import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setTestEnv, installFetch, type FetchState } from './helpers.ts';

// Each successful Gemini call in these tests costs 2.233 credits; a limit of 5 allows two.
setTestEnv({ BAZE_API_KEY: 'baze-test-key', BAZE_DAILY_CREDIT_LIMIT: '5', GOOGLE_TTS_API_KEY: 'google-test-key' });
mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-03T01:00:00Z') });

const { config } = await import('../src/config.ts');
const { initStore, usageInfo } = await import('../src/store.ts');
const { synthesize } = await import('../src/tts/index.ts');
await initStore();

const state: FetchState = { baze: 'ok' };
const calls = installFetch(state);

// The cases share module state (cooldown, credits), so they run in order.
test('provider defaults to baze when a key is set', () => {
  assert.equal(config.ttsProvider, 'baze');
});

test('Gemini success is served by baze and its credits are recorded', async () => {
  const { provider } = await synthesize('안녕하세요', 'kr');
  assert.equal(provider, 'baze');
  assert.equal(calls.google, 0);
  assert.ok(Math.abs(usageInfo().credits - 2.233) < 1e-9);
});

test('a transient error (429) falls back to Google and pauses Gemini for 60 s', async () => {
  state.baze = 429;
  const first = await synthesize('x', 'kr');
  assert.equal(first.provider, 'google');
  assert.equal(calls.baze, 2);

  state.baze = 'ok';
  const during = await synthesize('x', 'kr');
  assert.equal(during.provider, 'google');
  assert.equal(calls.baze, 2, 'Gemini must not be called during the cooldown');

  mock.timers.tick(61_000);
  const after = await synthesize('x', 'kr');
  assert.equal(after.provider, 'baze');
  assert.equal(calls.baze, 3);
});

test('an auth error (401) pauses Gemini for 30 minutes', async () => {
  state.baze = 401;
  assert.equal((await synthesize('x', 'kr')).provider, 'google');
  state.baze = 'ok';

  mock.timers.tick(61_000);
  assert.equal((await synthesize('x', 'kr')).provider, 'google');
  assert.equal(calls.baze, 4, 'still paused after 61 s');

  mock.timers.tick(30 * 60_000);
  assert.equal((await synthesize('x', 'kr')).provider, 'baze');
  assert.equal(calls.baze, 5);
});

test('once the daily credit budget is spent, Google is used until the UTC day rolls over', async () => {
  assert.ok(usageInfo().credits >= 5, `credits so far: ${usageInfo().credits}`);
  assert.equal((await synthesize('x', 'kr')).provider, 'google');
  assert.equal(calls.baze, 5);

  mock.timers.tick(24 * 60 * 60_000);
  assert.equal((await synthesize('x', 'kr')).provider, 'baze');
  assert.ok(Math.abs(usageInfo().credits - 2.233) < 1e-9, 'credits reset with the new day');
});

test('only: "google" skips Gemini; only: "baze" surfaces Gemini errors instead of falling back', async () => {
  const before = calls.baze;
  assert.equal((await synthesize('x', 'kr', { only: 'google' })).provider, 'google');
  assert.equal(calls.baze, before);

  state.baze = 500;
  await assert.rejects(synthesize('x', 'kr', { only: 'baze' }), /HTTP 500/);
});
