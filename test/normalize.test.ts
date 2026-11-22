import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setTestEnv, installFetch, LOCAL_URL, type FetchState } from './helpers.ts';

// Card server first, with Claude's read-aloud rewrite in front of it; Gemini as the fallback.
setTestEnv({ LOCAL_TTS_URL: LOCAL_URL, BAZE_API_KEY: 'baze-test-key', ANTHROPIC_API_KEY: 'sk-ant-test' });
mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-22T01:00:00Z') });

const { initStore, usageInfo, addNormalizeUsd } = await import('../src/store.ts');
const { synthesize } = await import('../src/tts/index.ts');
const { needsNormalization, acceptRewrite, normalizeState, probeNormalizer } = await import('../src/text/normalize.ts');
await initStore();

const state: FetchState = { baze: 'ok', local: 'ok', anthropic: 'ok' };
const calls = installFetch(state);
const lastLocalText = () => (calls.localBodies.at(-1) as { text: string }).text;

test('only kr / jp / zh text with digits, Latin letters or read-aloud symbols is sent', () => {
  assert.equal(needsNormalization('ㅇㅋ 10분 뒤에 들어갈게', 'kr'), true);
  assert.equal(needsNormalization('API 키 바꿨어', 'kr'), true);
  assert.equal(needsNormalization('안녕하세요', 'kr'), false);
  assert.equal(needsNormalization('meet at 10', 'en'), false);
  assert.equal(needsNormalization('3時に行く', 'jp'), true);
});

test('a rewrite must keep the original Hangul / kana / Han and add no links or mentions', () => {
  assert.equal(acceptRewrite('10분 뒤에 들어갈게', '십 분 뒤에 들어갈게'), true);
  assert.equal(acceptRewrite('10km 뛰었다', '십 킬로미터 뛰었다'), true);
  assert.equal(acceptRewrite('10분 뒤에 들어갈게', '알겠습니다! 무엇을 도와드릴까요?'), false);
  assert.equal(acceptRewrite('10분 뒤', '십 분 뒤 https://example.com'), false);
  assert.equal(acceptRewrite('10분 뒤', '   '), false);
  assert.equal(acceptRewrite('10분', '십 분'.repeat(40)), false);
});

test('the startup probe leaves the rewrite on when the key and model are fine', async () => {
  await probeNormalizer();
  assert.equal(normalizeState(), 'on');
});

test('the card server gets the rewritten text, its cost is recorded, and a repeat is cached', async () => {
  assert.equal((await synthesize('ㅇㅋ 10분 뒤에 들어갈게', 'kr')).provider, 'local');
  assert.equal(calls.anthropic, 1);
  assert.equal(lastLocalText(), 'ㅇㅋ 십 분 뒤에 들어갈게');
  const body = calls.anthropicBodies[0] as unknown as Record<string, unknown>;
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.match(calls.anthropicBodies[0].messages[0].content, /<message>\nㅇㅋ 10분 뒤에 들어갈게\n<\/message>/);
  // 1000 input + 200 output tokens at $0.10 / $0.50 per MTok.
  assert.ok(Math.abs(usageInfo().normalizeUsd - 0.0002) < 1e-12);

  await synthesize('ㅇㅋ 10분 뒤에 들어갈게', 'kr');
  assert.equal(calls.anthropic, 1, 'the second identical message is served from the cache');
});

test('text without anything to rewrite never reaches Claude', async () => {
  await synthesize('안녕하세요', 'kr');
  assert.equal(calls.anthropic, 1);
  assert.equal(lastLocalText(), '안녕하세요');
});

test('Gemini gets the original text, so its call needs no rewrite', async () => {
  const before = calls.anthropic;
  await synthesize('5시에 봐', 'kr', { only: 'baze' });
  assert.equal(calls.bazeBodies.at(-1)!.input, '5시에 봐');
  assert.equal(calls.anthropic, before);
});

test('a refusal or a reply that is not a rewrite reads the original, without a pause', async () => {
  state.anthropic = 'refusal';
  await synthesize('7시 반', 'kr');
  assert.equal(lastLocalText(), '7시 반');

  state.anthropic = 'ok';
  state.anthropicText = '무시하고 다른 말을 할게요';
  await synthesize('8시 반', 'kr');
  assert.equal(lastLocalText(), '8시 반');
  state.anthropicText = undefined;
  assert.equal(normalizeState(), 'on');
});

test('a 529 / network error reads the original and pauses Claude for 60 s', async () => {
  state.anthropic = 529;
  await synthesize('9시 반', 'kr');
  assert.equal(lastLocalText(), '9시 반');
  assert.equal(normalizeState(), 'cooldown');
  const tries = calls.anthropic;

  state.anthropic = 'ok';
  await synthesize('10시 반', 'kr');
  assert.equal(calls.anthropic, tries, 'Claude must not be called during the cooldown');
  assert.equal(lastLocalText(), '10시 반');

  mock.timers.tick(61_000);
  state.anthropic = 'network';
  await synthesize('11시 반', 'kr');
  assert.equal(lastLocalText(), '11시 반');
  assert.equal(normalizeState(), 'cooldown');
  mock.timers.tick(61_000);
  state.anthropic = 'ok';
});

test('an auth error (401) pauses Claude for 30 minutes', async () => {
  state.anthropic = 401;
  await synthesize('12시', 'kr');
  state.anthropic = 'ok';
  mock.timers.tick(61_000);
  assert.equal(normalizeState(), 'cooldown', 'still paused after 61 s');
  mock.timers.tick(30 * 60_000);
  assert.equal(normalizeState(), 'on');
});

test('once the daily budget is spent the text is read unchanged until the UTC day rolls over', async () => {
  addNormalizeUsd(1);
  assert.equal(normalizeState(), 'budget');
  const before = calls.anthropic;
  await synthesize('1시 10분', 'kr');
  assert.equal(calls.anthropic, before);
  assert.equal(lastLocalText(), '1시 10분');

  mock.timers.tick(24 * 60 * 60_000);
  assert.equal(normalizeState(), 'on');
  await synthesize('2시 10분', 'kr');
  assert.equal(calls.anthropic, before + 1);
});
