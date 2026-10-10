import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setTestEnv, installFetch, LOCAL_URL, type FetchState } from './helpers.ts';

// Local card server as primary, MeloTTS (CF_* from setTestEnv) as the fallback, no Gemini key.
setTestEnv({ LOCAL_TTS_URL: LOCAL_URL, BAZE_API_KEY: '' });
mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-10T01:00:00Z') });

const { config } = await import('../src/config.ts');
const { initStore } = await import('../src/store.ts');
const { synthesize, SkipError } = await import('../src/tts/index.ts');
await initStore();

const state: FetchState = { baze: 'ok', local: 'ok' };
const calls = installFetch(state);

// The cases share module state (cooldown), so they run in order.
test('provider defaults to local when LOCAL_TTS_URL is set', () => {
  assert.equal(config.ttsProvider, 'local');
  assert.equal(config.cloudflareEnabled, true);
});

test('local success is served by the card server with the detected language', async () => {
  const { provider, audio } = await synthesize('ㅇㅋ 10분 뒤에 들어갈게', 'kr');
  assert.equal(provider, 'local');
  assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
  assert.deepEqual(calls.localBodies.at(-1), { text: 'ㅇㅋ 10분 뒤에 들어갈게', lang: 'kr' });
  assert.equal(calls.cloudflare, 0);
  assert.equal(calls.baze, 0);
});

test('an unsupported language (422) sends only that message to MeloTTS, without a cooldown', async () => {
  state.local = 'unsupported';
  assert.equal((await synthesize('你好', 'zh')).provider, 'cloudflare');
  state.local = 'ok';
  assert.equal((await synthesize('안녕', 'kr')).provider, 'local');
  assert.equal(calls.local, 3);
});

test('nothing speakable (400 empty_text) is skipped, not read by the fallback', async () => {
  state.local = 'empty';
  const before = calls.cloudflare;
  await assert.rejects(synthesize('ㅠㅠ', 'kr'), SkipError);
  assert.equal(calls.cloudflare, before);
  state.local = 'ok';
});

test('a down server falls back to MeloTTS and is retried after 30 s', async () => {
  state.local = 'network';
  assert.equal((await synthesize('x', 'kr')).provider, 'cloudflare');
  const tries = calls.local;

  state.local = 'ok';
  assert.equal((await synthesize('x', 'kr')).provider, 'cloudflare');
  assert.equal(calls.local, tries, 'the local server must not be called during the cooldown');

  mock.timers.tick(31_000);
  assert.equal((await synthesize('x', 'kr')).provider, 'local');
  assert.equal(calls.local, tries + 1);
});

test('a 5xx from the card server also counts as down', async () => {
  state.local = 500;
  assert.equal((await synthesize('x', 'kr')).provider, 'cloudflare');
  state.local = 'ok';
  mock.timers.tick(31_000);
});

test('with the cloud budget spent (paid: false) a failed local call is not sent to the cloud', async () => {
  state.local = 'network';
  const before = calls.cloudflare;
  await assert.rejects(synthesize('x', 'kr', { paid: false }), /fetch failed/);
  assert.equal(calls.cloudflare, before);
  mock.timers.tick(31_000);
  state.local = 'ok';
  assert.equal((await synthesize('x', 'kr', { paid: false })).provider, 'local');
});

test('a rejected token or voice (4xx) pauses the local server for 30 minutes', async () => {
  state.local = 401;
  assert.equal((await synthesize('x', 'kr')).provider, 'cloudflare');
  const tries = calls.local;
  state.local = 'ok';
  mock.timers.tick(31_000);
  assert.equal((await synthesize('x', 'kr')).provider, 'cloudflare');
  assert.equal(calls.local, tries, 'still paused after 31 s');
  mock.timers.tick(30 * 60_000);
  assert.equal((await synthesize('x', 'kr')).provider, 'local');
});

test('only: "local" surfaces local errors instead of falling back', async () => {
  state.local = 503;
  await assert.rejects(synthesize('x', 'kr', { only: 'local' }), /HTTP 503/);
  state.local = 'ok';
});
