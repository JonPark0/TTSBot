// Diagnostic: synthesize one message with the configured providers and save the result.
//   docker compose exec tts-bot node dist/probe.js "안녕하세요 테스트입니다" kr            # configured chain
//   docker compose exec tts-bot node dist/probe.js "안녕하세요 테스트입니다" kr baze       # Gemini only
//   docker compose exec tts-bot node dist/probe.js "你好，这是一个测试。" zh google       # Google only
//   docker compose exec tts-bot node dist/probe.js "ㅇㅋ 10분 뒤에 들어갈게" kr local     # local card server only
//   docker compose exec tts-bot node dist/probe.js "Guten Morgen, wie geht's?" de google  # Google only
// Locally (without building first): node src/probe.ts "..." kr
// The local server and Google get the Claude read-aloud rewrite when ANTHROPIC_API_KEY is set.
// The file extension follows the returned format (every provider produces WAV).
// Then copy the file out:  docker compose cp tts-bot:/tmp/probe-kr.wav ./
import { writeFileSync } from 'node:fs';
import { config, type TtsSource } from './config.ts';
import { initStore, usageInfo, flushStore } from './store.ts';
import { synthesize } from './tts/index.ts';
import { sniff } from './tts/audio.ts';
import { normalizeForTts, normalizeState, probeNormalizer } from './text/normalize.ts';

const EXT: Record<string, string> = { 'mp3(ID3)': 'mp3', 'mp3(frame)': 'mp3', wav: 'wav', ogg: 'ogg' };

const text = process.argv[2] || '안녕하세요. 테스트입니다.';
const lang = process.argv[3] || config.defaultLang;
const providerArg = process.argv[4];
const only: TtsSource | undefined =
  providerArg === 'local' || providerArg === 'baze' || providerArg === 'google' ? providerArg : undefined;
if (providerArg && providerArg !== 'auto' && !only) {
  console.error('provider must be one of: auto, local, baze, google');
  process.exit(1);
}

console.log(`provider = ${only || `auto (primary: ${config.ttsProvider})`}`);
console.log(`local = ${config.localTtsUrl ? `${config.localTtsUrl} / voice ${config.localTtsVoice || '(server default)'}` : '(no LOCAL_TTS_URL)'}`);
console.log(`gemini = ${config.bazeApiKey ? `${config.bazeTtsModel} / voice ${config.bazeTtsVoice}` : '(no BAZE_API_KEY)'}`);
console.log(`google = ${config.googleTtsApiKey ? (config.googleVoices[lang] ?? `(no voice for ${lang})`) : '(no GOOGLE_TTS_API_KEY)'}`);
console.log(`lang = ${lang}`);
console.log(`text = ${JSON.stringify(text)}`);

// Credits and dollars spent here count toward the bot's daily budgets, like a real message.
await initStore();
await probeNormalizer();
console.log(`normalize = ${normalizeState()} -> ${JSON.stringify(await normalizeForTts(text, lang))}`);
console.log('---');

const before = usageInfo().credits;
try {
  const t0 = Date.now();
  const { audio, provider } = await synthesize(text, lang, { only });
  const format = sniff(audio);
  const out = `/tmp/probe-${lang}.${EXT[format] ?? 'bin'}`;
  writeFileSync(out, audio);
  console.log(`OK  provider=${provider} ${audio.length} bytes, format=${format}, in ${Date.now() - t0}ms`);
  console.log(`credits used: ${(usageInfo().credits - before).toFixed(3)} (today: ${usageInfo().credits.toFixed(1)} / ${config.bazeDailyCreditLimit || '∞'})`);
  console.log(`saved -> ${out}`);
} catch (err) {
  console.error(`FAIL  ${(err as Error).message}`);
  process.exitCode = 1;
}
await flushStore();
