import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLang } from '../src/text/langDetect.ts';

test('scripts: Korean, Japanese, Chinese', () => {
  assert.equal(detectLang('ㅇㅋ 10분 뒤에 들어갈게'), 'kr');
  assert.equal(detectLang('今日はいい天気ですね'), 'jp');
  assert.equal(detectLang('你好，这是一个测试。'), 'zh');
});

test('German: by its letters or by its function words', () => {
  assert.equal(detectLang('Schöne Grüße'), 'de');
  assert.equal(detectLang('Guten Morgen! Wie geht es dir heute?'), 'de');
  assert.equal(detectLang('Ich komme in zehn Minuten'), 'de');
  assert.equal(detectLang('Danke'), 'de');
  assert.equal(detectLang("Wie geht's?"), 'de');
});

test('Italian: by its function words', () => {
  assert.equal(detectLang('Ciao a tutti! Arrivo tra dieci minuti, va bene?'), 'it');
  assert.equal(detectLang('Grazie mille'), 'it');
  assert.equal(detectLang("Che cos'è questo?"), 'it');
  assert.equal(detectLang('Non lo so'), 'it');
});

test('English stays English, including words the other languages share', () => {
  assert.equal(detectLang('Good morning! How are you today?'), 'en');
  assert.equal(detectLang("I'm coming in ten minutes"), 'en');
  assert.equal(detectLang('gg'), 'en');
  assert.equal(detectLang('lol ok'), 'en');
  assert.equal(detectLang('so what was that'), 'en');
  assert.equal(detectLang('come in'), 'en');
});

test('no letters: the fallback', () => {
  assert.equal(detectLang('123 !!', 'jp'), 'jp');
  assert.equal(detectLang('123', 'xx'), 'kr');
});
