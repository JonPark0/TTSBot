import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTestEnv, installFetch } from './helpers.ts';

// No BAZE_API_KEY: existing deployments must keep running on MeloTTS only.
setTestEnv({ BAZE_API_KEY: '' });
// A store.json written by the previous version has no `credits` field.
writeFileSync(
  path.join(process.env.DATA_DIR!, 'store.json'),
  JSON.stringify({ guilds: { 1: { ttsChannelId: '2' } }, usage: { date: '2026-10-02', chars: 21 } }),
);

const { config } = await import('../src/config.ts');
const { initStore, usageInfo, getTtsChannel } = await import('../src/store.ts');
const { synthesize } = await import('../src/tts/index.ts');

test('without a key the provider is cloudflare and Gemini is never called', async () => {
  await initStore();
  assert.equal(config.ttsProvider, 'cloudflare');
  const calls = installFetch({ baze: 'ok' });
  const { provider } = await synthesize('안녕하세요', 'kr');
  assert.equal(provider, 'cloudflare');
  assert.equal(calls.baze, 0);
});

test('an old store.json without credits still loads', () => {
  assert.equal(getTtsChannel('1'), '2');
  assert.equal(typeof usageInfo().credits, 'number');
  assert.ok(Number.isFinite(usageInfo().credits));
});
