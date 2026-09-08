// Diagnostic: call the configured Cloudflare TTS model directly and save the result.
//   docker compose exec tts-bot node src/probe.js "안녕하세요 테스트입니다" kr
//   docker compose exec tts-bot node src/probe.js "hello world" en
// Then copy the file out:  docker compose cp tts-bot:/tmp/probe-kr.mp3 ./
import { writeFileSync } from 'node:fs';
import { config } from './config.js';
import { synthesize } from './tts/cloudflare.js';

const text = process.argv[2] || '안녕하세요. 테스트입니다.';
const lang = process.argv[3] || config.defaultLang;

console.log(`model = ${config.cfTtsModel}`);
console.log(`gateway = ${config.cfGatewayUrl || '(direct api)'}`);
console.log(`lang = ${lang}`);
console.log(`text = ${JSON.stringify(text)}`);
console.log('---');

try {
  const t0 = Date.now();
  const buf = await synthesize(text, lang);
  const out = `/tmp/probe-${lang}.mp3`;
  writeFileSync(out, buf);
  console.log(`OK  ${buf.length} bytes in ${Date.now() - t0}ms`);
  console.log(`first 16 bytes (hex): ${buf.subarray(0, 16).toString('hex')}`);
  console.log(`saved -> ${out}`);
} catch (err) {
  console.error(`FAIL  ${err.message}`);
  process.exit(1);
}
