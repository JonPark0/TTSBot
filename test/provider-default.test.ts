import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTestEnv, installFetch } from './helpers.ts';

// No BAZE_API_KEY and no LOCAL_TTS_URL: the bot runs on Google only.
setTestEnv({ BAZE_API_KEY: '', GOOGLE_TTS_API_KEY: 'google-test-key' });
// A store.json written by an older version has no `credits`, `googleChars` or `normalizeUsd` field.
writeFileSync(
  path.join(process.env.DATA_DIR!, 'store.json'),
  JSON.stringify({ guilds: { 1: { ttsChannelId: '2' } }, usage: { date: '2026-10-02', chars: 21 } }),
);

const { config } = await import('../src/config.ts');
const { initStore, usageInfo, getTtsChannel } = await import('../src/store.ts');
const { synthesize } = await import('../src/tts/index.ts');

test('without a Gemini key the provider is google and Gemini is never called', async () => {
  await initStore();
  assert.equal(config.ttsProvider, 'google');
  const calls = installFetch({ baze: 'ok' });
  const { provider } = await synthesize('안녕하세요', 'kr');
  assert.equal(provider, 'google');
  assert.equal(calls.baze, 0);
});

test('an old store.json without the newer counters still loads', () => {
  assert.equal(getTtsChannel('1'), '2');
  for (const value of [usageInfo().credits, usageInfo().googleChars, usageInfo().normalizeUsd]) {
    assert.equal(typeof value, 'number');
    assert.ok(Number.isFinite(value));
  }
});
