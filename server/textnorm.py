"""Discord 메시지 → Supertonic 3에 넣을 문장과 언어.

측정(2026-10-10, 원문 16문장을 그대로 넣고 음성 인식 결과 비교)에 맞춰 필요한 것만 바꾼다.
- 숫자는 손대지 않는다: "3시 30분", "15,000원", "2026년 10월 9일", "10 minutes", "3:30" 모두 원문 그대로 바르게 읽었다.
- 자음·모음만 쓴 채팅 말(ㅇㅋ, ㄹㅇ, ㄴㄴ, ㄱ, ㅋㅋ)은 소리가 사라지거나 엉뚱하게 읽혀서 말로 바꾼다.
- URL은 글자를 하나씩 읽어 버려서 "링크"로 바꾼다. 한국어 문장 속 "gg"는 "G"로 읽혀서 "지지"로 바꾼다.
- 이모지는 SDK가 지운다. Discord 마크업(사용자 지정 이모지, 코드 블록, 스포일러, 강조 기호)은 여기서 지운다.
"""
import re
import unicodedata

LINK = {"ko": "링크", "ja": "リンク", "en": "link"}
CODE = {"ko": "코드", "ja": "コード", "en": "code"}

# 자음·모음 채팅 말. 긴 것부터 맞춘다. 목록에 없는 자모 덩어리는 지운다 (그대로 두면 소리가 없거나 엉뚱하게 읽힌다).
JAMO_WORDS = {
    "ㅇㅋㅇㅋ": "오케이 오케이", "ㅇㅋ": "오케이", "ㅇㅇ": "응응", "ㄴㄴ": "노노", "ㄱㄱ": "고고", "ㄱ": "고",
    "ㄹㅇ": "리얼", "ㅇㅈ": "인정", "ㅅㄱ": "수고", "ㅊㅋ": "축하", "ㄷㄷ": "덜덜", "ㅈㅅ": "죄송",
    "ㄱㅅ": "감사", "ㄳ": "감사", "ㅂㅂ": "바이바이", "ㅃㅃ": "바이바이", "ㅎㅇ": "하이", "ㅇㅎ": "아하",
    "ㄲㅂ": "까비", "ㅁㄹ": "몰라", "ㄴㅇㄱ": "노이해", "ㅊㅊ": "추천",
}
JAMO_RUN = re.compile(r"[\u3131-\u318E]+")  # 한글 호환 자모
LAUGH = re.compile(r"ㅋ{2,}|ㅎ{2,}")
CRY = re.compile(r"[ㅠㅜ]{1,}")

# 한국어 문장 속 로마자 채팅 말 (단어 단위, 대소문자 무시)
KO_LATIN = {"gg": "지지", "ok": "오케이", "lol": "크크", "omg": "오마이갓"}

URL = re.compile(r"https?://\S+|www\.\S+")
CUSTOM_EMOJI = re.compile(r"<a?:\w+:\d+>")
RAW_MENTION = re.compile(r"<(?:@[!&]?|#)\d+>")  # clean_content를 안 쓴 경우를 위한 대비
TIMESTAMP = re.compile(r"<t:\d+(?::[a-zA-Z])?>")
CODE_BLOCK = re.compile(r"```.*?```", re.S)
INLINE_CODE = re.compile(r"`([^`]*)`")
SPOILER = re.compile(r"\|\|.*?\|\|", re.S)
MARKS = re.compile(r"(\*\*|__|~~|\*|(?<!\w)_|_(?!\w))")
LINE_PREFIX = re.compile(r"^\s*(?:>+|#{1,3}|-#|[-*]|\d+\.)\s+", re.M)
REPEAT_PUNCT = re.compile(r"([!?.~])\1{2,}")
SPACE_BEFORE_PUNCT = re.compile(r"\s+([!?.,~])")
JA_LAUGH = re.compile(r"(?<![A-Za-z])[wｗ]{2,}(?![A-Za-z])")
SPACES = re.compile(r"\s+")

HANGUL = re.compile(r"[\uAC00-\uD7A3\u3131-\u318E]")
KANA = re.compile(r"[\u3040-\u30FF\u31F0-\u31FF]")
HAN = re.compile(r"[\u4E00-\u9FFF]")
LATIN = re.compile(r"[A-Za-z]")


def detect_lang(text: str, default: str = "ko") -> str:
    """한글이 있으면 ko, 가나가 있으면 ja, 한자만 있으면 ja, 로마자면 en, 아무것도 없으면 default."""
    if HANGUL.search(text):
        return "ko"
    if KANA.search(text) or HAN.search(text):
        return "ja"
    if LATIN.search(text):
        return "en"
    return default


def _jamo(text: str) -> str:
    text = LAUGH.sub(lambda m: m.group(0)[0].replace("ㅋ", "크").replace("ㅎ", "흐") * min(len(m.group(0)), 3), text)
    text = CRY.sub(" ", text)

    def word(m):
        run = m.group(0)
        out, i = [], 0
        while i < len(run):
            for n in range(min(4, len(run) - i), 0, -1):
                if run[i:i + n] in JAMO_WORDS:
                    out.append(JAMO_WORDS[run[i:i + n]]); i += n
                    break
            else:
                i += 1  # 모르는 자모는 버린다
        return " " + " ".join(out) + " " if out else " "
    return JAMO_RUN.sub(word, text)


def _ko_latin(text: str) -> str:
    return re.sub(r"\b[A-Za-z]+\b", lambda m: KO_LATIN.get(m.group(0).lower(), m.group(0)), text)


def normalize(text: str, lang: str | None = None, default_lang: str = "ko", max_chars: int = 300) -> tuple[str, str]:
    """Discord 메시지 하나를 (읽을 문장, 언어)로 바꾼다. 읽을 것이 없으면 문장은 빈 문자열."""
    text = unicodedata.normalize("NFC", text)
    text = CODE_BLOCK.sub(" \x00CODE\x00 ", text)
    text = SPOILER.sub(" ", text)
    text = URL.sub(" \x00LINK\x00 ", text)
    for pat in (CUSTOM_EMOJI, RAW_MENTION, TIMESTAMP):
        text = pat.sub(" ", text)
    text = INLINE_CODE.sub(r"\1", text)
    text = LINE_PREFIX.sub("", text)
    text = MARKS.sub("", text)
    text = text.replace("@", " ")  # clean_content의 @이름 → 이름 (SDK는 @를 "at"으로 읽는다)
    lang = lang or detect_lang(text.replace("\x00LINK\x00", "").replace("\x00CODE\x00", ""), default_lang)
    if lang == "ko":
        text = _ko_latin(_jamo(text))
    elif lang == "ja":
        text = JA_LAUGH.sub(" ", text)  # www(웃음)는 로마자로 읽혀서 지운다
    text = text.replace("\x00LINK\x00", LINK.get(lang, "link")).replace("\x00CODE\x00", CODE.get(lang, "code"))
    text = REPEAT_PUNCT.sub(r"\1", text)
    text = SPACE_BEFORE_PUNCT.sub(r"\1", SPACES.sub(" ", text).strip())
    if len(text) > max_chars:
        text = text[:max_chars].rsplit(" ", 1)[0]
    return (text if re.search(r"\w", text) else ""), lang
