// Diagnostic: synthesize one message with the configured providers and save the result.
//   docker compose exec tts-bot node src/probe.js "안녕하세요 테스트입니다" kr            # Gemini, MeloTTS fallback
//   docker compose exec tts-bot node src/probe.js "안녕하세요 테스트입니다" kr baze       # Gemini only
//   docker compose exec tts-bot node src/probe.js "你好，这是一个测试。" zh cloudflare  # MeloTTS only
// The file extension follows the returned format (both providers produce WAV).
// Then copy the file out:  docker compose cp tts-bot:/tmp/probe-kr.wav ./
import { writeFileSync } from 'node:fs';
import { config } from './config.js';
import { initStore, usageInfo, flushStore } from './store.js';
import { synthesize } from './tts/index.js';
import { sniff } from './tts/cloudflare.js';

const EXT = { 'mp3(ID3)': 'mp3', 'mp3(frame)': 'mp3', wav: 'wav', ogg: 'ogg' };

const text = process.argv[2] || '안녕하세요. 테스트입니다.';
const lang = process.argv[3] || config.defaultLang;
const only = process.argv[4] && process.argv[4] !== 'auto' ? process.argv[4] : undefined;
if (only && !['baze', 'cloudflare'].includes(only)) {
  console.error('provider must be one of: auto, baze, cloudflare');
  process.exit(1);
}

console.log(`provider = ${only || `auto (primary: ${config.ttsProvider})`}`);
console.log(`gemini = ${config.bazeApiKey ? `${config.bazeTtsModel} / voice ${config.bazeTtsVoice}` : '(no BAZE_API_KEY)'}`);
console.log(`melotts = ${config.cfTtsModel} via ${config.cfGatewayUrl || 'direct api'}`);
console.log(`lang = ${lang}`);
console.log(`text = ${JSON.stringify(text)}`);
console.log('---');

// Credits spent here count toward the bot's daily Gemini budget, like a real message.
await initStore();
const before = usageInfo().credits;
try {
  const t0 = Date.now();
  const { audio, provider } = await synthesize(text, lang, { only });
  const format = sniff(audio);
  const out = `/tmp/probe-${lang}.${EXT[format] ?? 'bin'}`;
  writeFileSync(out, audio);
  const gain = provider === 'cloudflare' ? (config.langGain[lang] ?? 1) : 1;
  console.log(`OK  provider=${provider} ${audio.length} bytes, format=${format}, in ${Date.now() - t0}ms`);
  console.log(`credits used: ${(usageInfo().credits - before).toFixed(3)} (today: ${usageInfo().credits.toFixed(1)} / ${config.bazeDailyCreditLimit || '∞'})`);
  console.log(`playback gain = ${gain} (applied at playback, not to the saved file)`);
  console.log(`saved -> ${out}`);
} catch (err) {
  console.error(`FAIL  ${err.message}`);
  process.exitCode = 1;
}
await flushStore();
