// Lightweight, dependency-free script detection tuned for short chat messages.
// Returns one of: 'kr' | 'jp' | 'zh' | 'en' | 'de' | 'it' (falls back to `fallback`).

const RE_KANA = /[぀-ゟ゠-ヿｦ-ﾝ]/; // hiragana + katakana (incl. half-width)
const RE_HANGUL = /[가-힣ᄀ-ᇿ㄰-㆏]/; // hangul syllables + jamo
const RE_HAN = /[㐀-䶿一-鿿豈-﫿]/; // CJK ideographs
const RE_LATIN = /[A-Za-zÀ-ÿ]/;
const RE_GERMAN_LETTER = /[äöüßẞ]/i; // only German among en / de / it

// Latin-script text is English unless it has a German letter or more German (Italian) function
// words than English ones. Words the languages share (in, a, so, die, was, come, will…) count for
// one language only or not at all, so a tie stays English.
const WORDS: Record<'en' | 'de' | 'it', Set<string>> = {
  en: new Set(
    ('the and is are am i you he she it we they to of that this what with not for on be have has do does ' +
      'my your yes thanks thank please good today but how why where hello hi ok okay just will can at ' +
      'there here me minutes coming see').split(' '),
  ),
  de: new Set(
    ('ich du er wir ihr und ist sind bin bist nicht kein keine der das den dem des ein eine einen mit ' +
      'auf für ja nein danke bitte gut heute morgen aber auch noch schon wie wer wo warum hallo tschüss ' +
      'mein dein sehr mal doch zu von bei jetzt gerne gern komme kommst minuten bis später geht es oder ' +
      'nur dort habe hast sie').split(' '),
  ),
  it: new Set(
    ('il lo gli la le che non sono sei siamo è io tu lui lei noi voi loro di del della dei delle per con ' +
      'un una uno ciao grazie prego perché cosa molto bene oggi domani anche ma questo questa ho hai ' +
      'buongiorno buonasera arrivo tra minuti dove quando sì va sto stai alla al nel nella poi').split(' '),
  ),
};

function latinLang(text: string): 'en' | 'de' | 'it' {
  if (RE_GERMAN_LETTER.test(text)) return 'de';
  const score = { en: 0, de: 0, it: 0 };
  // "l'amico", "c'è", "geht's" split at the apostrophe, so the function word counts
  for (const word of text.toLowerCase().match(/[a-zà-ÿ]+/g) ?? []) {
    if (WORDS.en.has(word)) score.en++;
    if (WORDS.de.has(word)) score.de++;
    if (WORDS.it.has(word)) score.it++;
  }
  if (score.de > score.en && score.de > score.it) return 'de';
  if (score.it > score.en && score.it > score.de) return 'it';
  return 'en';
}

export const SUPPORTED_LANGS: readonly string[] = ['kr', 'jp', 'zh', 'en', 'de', 'it'];

export function detectLang(text: string, fallback = 'kr'): string {
  if (!text) return fallback;
  // Order matters: kana is unique to Japanese; hangul is unique to Korean.
  // Bare CJK ideographs (no kana/hangul) are treated as Chinese.
  if (RE_KANA.test(text)) return 'jp';
  if (RE_HANGUL.test(text)) return 'kr';
  if (RE_HAN.test(text)) return 'zh';
  if (RE_LATIN.test(text)) return latinLang(text);
  return SUPPORTED_LANGS.includes(fallback) ? fallback : 'kr';
}
