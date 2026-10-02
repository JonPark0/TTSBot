import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setTestEnv, installFetch } from './helpers.js';

// Each successful Gemini call in these tests costs 2.233 credits; a limit of 5 allows two.
setTestEnv({ BAZE_API_KEY: 'baze-test-key', BAZE_DAILY_CREDIT_LIMIT: '5' });
mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-03T01:00:00Z') });

const { config } = await import('../src/config.js');
const { initStore, usageInfo } = await import('../src/store.js');
const { synthesize } = await import('../src/tts/index.js');
await initStore();

const state = { baze: 'ok' };
const calls = installFetch(state);

// The cases share module state (cooldown, credits), so they run in order.
test('provider defaults to baze when a key is set', () => {
  assert.equal(config.ttsProvider, 'baze');
});

test('Gemini success is served by baze and its credits are recorded', async () => {
  const { provider } = await synthesize('안녕하세요', 'kr');
  assert.equal(provider, 'baze');
  assert.equal(calls.cloudflare, 0);
  assert.ok(Math.abs(usageInfo().credits - 2.233) < 1e-9);
});

test('a transient error (429) falls back to MeloTTS and pauses Gemini for 60 s', async () => {
  state.baze = 429;
  const first = await synthesize('x', 'kr');
  assert.equal(first.provider, 'cloudflare');
  assert.equal(calls.baze, 2);

  state.baze = 'ok';
  const during = await synthesize('x', 'kr');
  assert.equal(during.provider, 'cloudflare');
  assert.equal(calls.baze, 2, 'Gemini must not be called during the cooldown');

  mock.timers.tick(61_000);
  const after = await synthesize('x', 'kr');
  assert.equal(after.provider, 'baze');
  assert.equal(calls.baze, 3);
});

test('an auth error (401) pauses Gemini for 30 minutes', async () => {
  state.baze = 401;
  assert.equal((await synthesize('x', 'kr')).provider, 'cloudflare');
  state.baze = 'ok';

  mock.timers.tick(61_000);
  assert.equal((await synthesize('x', 'kr')).provider, 'cloudflare');
  assert.equal(calls.baze, 4, 'still paused after 61 s');

  mock.timers.tick(30 * 60_000);
  assert.equal((await synthesize('x', 'kr')).provider, 'baze');
  assert.equal(calls.baze, 5);
});

test('once the daily credit budget is spent, MeloTTS is used until the UTC day rolls over', async () => {
  assert.ok(usageInfo().credits >= 5, `credits so far: ${usageInfo().credits}`);
  assert.equal((await synthesize('x', 'kr')).provider, 'cloudflare');
  assert.equal(calls.baze, 5);

  mock.timers.tick(24 * 60 * 60_000);
  assert.equal((await synthesize('x', 'kr')).provider, 'baze');
  assert.ok(Math.abs(usageInfo().credits - 2.233) < 1e-9, 'credits reset with the new day');
});

test('only: "cloudflare" skips Gemini; only: "baze" surfaces Gemini errors instead of falling back', async () => {
  const before = calls.baze;
  assert.equal((await synthesize('x', 'kr', { only: 'cloudflare' })).provider, 'cloudflare');
  assert.equal(calls.baze, before);

  state.baze = 500;
  await assert.rejects(synthesize('x', 'kr', { only: 'baze' }), /HTTP 500/);
});
