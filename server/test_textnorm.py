"""python -m unittest server.test_textnorm"""
import unittest

from .textnorm import detect_lang, normalize


class TextNormTest(unittest.TestCase):
    def test_numbers_are_left_alone(self):
        # Supertonic이 원문 숫자를 바르게 읽는다 (2026-10-10 측정)
        for s in ("오늘 오후 3시 30분에 회의가 있습니다.", "이번 달 전기 요금이 15,000원이나 나왔어요.", "The meeting starts at 3:30 this afternoon."):
            self.assertEqual(normalize(s)[0], s)

    def test_korean_chat_jamo(self):
        cases = {"ㅋㅋㅋㅋ 그거 진짜 웃기다": "크크크 그거 진짜 웃기다", "오늘 롤 한판 ㄱ?": "오늘 롤 한판 고?",
                 "ㅇㅋ 10분 뒤에 들어갈게": "오케이 10분 뒤에 들어갈게", "헐 대박 ㄹㅇ?": "헐 대박 리얼?",
                 "ㄴㄴ 그건 아니지": "노노 그건 아니지", "오 개꿀 ㅋㅋ": "오 개꿀 크크", "ㅠㅠ 또 졌어": "또 졌어",
                 "gg 다음 판 가자": "지지 다음 판 가자", "ㅇㅋ, 갈게": "오케이, 갈게"}
        for raw, want in cases.items():
            self.assertEqual(normalize(raw), (want, "ko"), raw)

    def test_nothing_to_read(self):
        for s in ("ㅋ", "ㅠㅠㅠㅠ", "😂😂", "<:pepe:123456>", "||스포||"):
            self.assertEqual(normalize(s)[0], "", s)

    def test_discord_markup(self):
        self.assertEqual(normalize("님들 이거 봄? https://youtu.be/abc123")[0], "님들 이거 봄? 링크")
        self.assertEqual(normalize("**굵게** 쓰고 ~~취소~~ 했어 ||스포||")[0], "굵게 쓰고 취소 했어")
        self.assertEqual(normalize("@철수 내일 봐")[0], "철수 내일 봐")
        self.assertEqual(normalize("see you https://x.com/a")[0], "see you link")

    def test_japanese_laugh(self):
        self.assertEqual(normalize("今日はいい天気ですね www"), ("今日はいい天気ですね", "ja"))

    def test_detect_lang(self):
        self.assertEqual(detect_lang("안녕"), "ko")
        self.assertEqual(detect_lang("こんにちは"), "ja")
        self.assertEqual(detect_lang("hello"), "en")
        self.assertEqual(detect_lang("123", "ko"), "ko")


if __name__ == "__main__":
    unittest.main()
