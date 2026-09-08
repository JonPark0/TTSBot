// Lightweight, dependency-free script detection tuned for short chat messages.
// Returns one of: 'kr' | 'jp' | 'zh' | 'en' (falls back to `fallback`).

const RE_KANA = /[぀-ゟ゠-ヿｦ-ﾝ]/; // hiragana + katakana (incl. half-width)
const RE_HANGUL = /[가-힣ᄀ-ᇿ㄰-㆏]/; // hangul syllables + jamo
const RE_HAN = /[㐀-䶿一-鿿豈-﫿]/; // CJK ideographs
const RE_LATIN = /[A-Za-z]/;

export const SUPPORTED_LANGS = ['kr', 'jp', 'zh', 'en'];

export function detectLang(text, fallback = 'kr') {
  if (!text) return fallback;
  // Order matters: kana is unique to Japanese; hangul is unique to Korean.
  // Bare CJK ideographs (no kana/hangul) are treated as Chinese.
  if (RE_KANA.test(text)) return 'jp';
  if (RE_HANGUL.test(text)) return 'kr';
  if (RE_HAN.test(text)) return 'zh';
  if (RE_LATIN.test(text)) return 'en';
  return SUPPORTED_LANGS.includes(fallback) ? fallback : 'kr';
}
