import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTestEnv, installFetch, fakePcm, type FetchState } from './helpers.ts';

setTestEnv({ BAZE_API_KEY: 'baze-test-key', BAZE_TTS_VOICE: 'Puck' });
const { pcmToWav, creditsFor, synthesizeBaze, BazeError } = await import('../src/tts/baze.ts');
const { sniff } = await import('../src/tts/cloudflare.ts');

test('pcmToWav writes a 24 kHz mono 16-bit header that sniff() recognises', () => {
  const pcm = fakePcm(0.5);
  const wav = pcmToWav(pcm);
  assert.equal(wav.length, pcm.length + 44);
  assert.equal(sniff(wav), 'wav');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(20), 1); // PCM
  assert.equal(wav.readUInt16LE(22), 1); // mono
  assert.equal(wav.readUInt32LE(24), 24000); // sample rate
  assert.equal(wav.readUInt32LE(28), 48000); // byte rate
  assert.equal(wav.readUInt16LE(32), 2); // block align
  assert.equal(wav.readUInt16LE(34), 16); // bits
  assert.equal(wav.readUInt32LE(40), pcm.length); // data size
  assert.equal(wav.readUInt32LE(4), pcm.length + 36); // RIFF size
});

test('creditsFor uses the per-model rates and charges unknown models the top rate', () => {
  // Matches the real call: 13 input + 111 output tokens on 3.1 Flash = 2.233 credits.
  assert.equal(creditsFor('gemini-3.1-flash-tts-preview', 13, 111), (13 * 10 + 111 * 200) / 10000);
  assert.equal(creditsFor('gemini-2.5-flash-preview-tts', 13, 111), (13 * 5 + 111 * 100) / 10000);
  assert.equal(creditsFor('some-future-model', 13, 111), creditsFor('gemini-3.1-flash-tts-preview', 13, 111));
});

test('synthesizeBaze sends model/voice/text with the bearer key and returns WAV + credits', async () => {
  const state: FetchState = { baze: 'ok' };
  const calls = installFetch(state);
  const { audio, credits } = await synthesizeBaze('안녕하세요');
  assert.equal(sniff(audio), 'wav');
  assert.equal(calls.bazeAuth, 'Bearer baze-test-key');
  assert.deepEqual(calls.bazeBodies[0], {
    model: 'gemini-3.1-flash-tts-preview',
    input: '안녕하세요',
    voice: 'Puck',
  });
  assert.ok(Math.abs(credits - 2.233) < 1e-9);
});

test('synthesizeBaze throws BazeError with the HTTP status on failure', async () => {
  const state: FetchState = { baze: 429 };
  installFetch(state);
  await assert.rejects(synthesizeBaze('x'), (err) => err instanceof BazeError && err.status === 429);
  state.baze = 'json200';
  await assert.rejects(synthesizeBaze('x'), (err) => err instanceof BazeError && /unexpected JSON/.test(err.message));
  state.baze = 'network';
  await assert.rejects(synthesizeBaze('x'), (err) => err instanceof BazeError && err.status === undefined);
});
