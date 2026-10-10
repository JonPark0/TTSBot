import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTestEnv, installFetch, LOCAL_URL } from './helpers.ts';

// A card-only deployment: no Cloudflare credentials, no Gemini key.
setTestEnv({ LOCAL_TTS_URL: LOCAL_URL, LOCAL_TTS_VOICE: 'M1', CF_ACCOUNT_ID: '', CF_API_TOKEN: '', BAZE_API_KEY: '' });

const { config } = await import('../src/config.ts');
const { initStore } = await import('../src/store.ts');
const { synthesize } = await import('../src/tts/index.ts');
await initStore();

test('local-only config starts without CF credentials', () => {
  assert.equal(config.ttsProvider, 'local');
  assert.equal(config.cloudflareEnabled, false);
});

test('the configured voice is sent to the server', async () => {
  const calls = installFetch({ baze: 'ok', local: 'ok' });
  assert.equal((await synthesize('안녕하세요', 'kr')).provider, 'local');
  assert.deepEqual(calls.localBodies[0], { text: '안녕하세요', lang: 'kr', voice: 'M1' });
});

test('with no fallback configured a local failure surfaces as an error', async () => {
  const calls = installFetch({ baze: 'ok', local: 'network' });
  await assert.rejects(synthesize('x', 'kr'), /fetch failed/);
  assert.equal(calls.cloudflare, 0);
  assert.equal(calls.baze, 0);
});
