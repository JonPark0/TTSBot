"""python -m unittest server.test_engine  (onnxruntime이 깔린 환경에서, 모델 없이 돈다)"""
import tempfile
import unittest
from pathlib import Path

import numpy as np

from .engine import JA_UNIT, LEAD_S, TAIL_S, Engine, _Bucket, find_buckets, parse_buckets, trim


def touch(d, *names):
    for n in names:
        (Path(d) / n).write_bytes(b"")


class BucketTest(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(parse_buckets("96,192"), [96, 192])
        self.assertEqual(parse_buckets(" 96 "), [96])
        self.assertIsNone(parse_buckets(""))
        self.assertIsNone(parse_buckets(None))

    def test_old_card_names_are_the_96_bucket(self):
        with tempfile.TemporaryDirectory() as d:
            touch(d, "st_est.axmodel", "st_voc.axmodel", "st_est_T192_L192.axmodel", "st_voc_L192.axmodel")
            got = [(t, l, e.name, v.name) for t, l, e, v in find_buckets(d, "ax")]
            self.assertEqual(got, [(96, 96, "st_est.axmodel", "st_voc.axmodel"),
                                   (192, 192, "st_est_T192_L192.axmodel", "st_voc_L192.axmodel")])
            self.assertEqual([l for _, l, _, _ in find_buckets(d, "ax", only=[96])], [96])

    def test_ort_and_mixed_backends(self):
        with tempfile.TemporaryDirectory() as d:
            touch(d, "st_est_T96_L96.onnx", "st_voc_L96.onnx", "st_voc.axmodel")
            self.assertEqual([v.name for *_, v in find_buckets(d, "ort")], ["st_voc_L96.onnx"])
            self.assertEqual([v.name for *_, v in find_buckets(d, "ort", "ax")], ["st_voc.axmodel"])

    def test_missing_files(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(FileNotFoundError):
                find_buckets(d, "ax")
            touch(d, "st_est_T192_L192.axmodel")
            with self.assertRaises(FileNotFoundError):  # 보코더 없는 버킷
                find_buckets(d, "ax")

    def test_smallest_bucket_that_fits(self):
        eng = Engine.__new__(Engine)
        eng.buckets = [_Bucket(96, 96, None, None, None), _Bucket(192, 192, None, None, None)]
        self.assertEqual(eng._bucket(40, 96).L, 96)
        self.assertEqual(eng._bucket(97, 50).L, 192)  # 텍스트가 넘쳐도 큰 버킷으로
        self.assertEqual(eng._bucket(150, 192).L, 192)
        self.assertIsNone(eng._bucket(150, 193))


class JoinTest(unittest.TestCase):
    def test_trim_keeps_short_margins(self):
        sr = 44100
        t = np.arange(sr) / sr
        tone = (0.5 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
        wav = np.concatenate([np.zeros(int(0.5 * sr), np.float32), tone, np.zeros(int(0.6 * sr), np.float32)])
        out = trim(wav, sr)
        self.assertAlmostEqual(len(out) / sr, 1.0 + LEAD_S + TAIL_S, delta=0.02)
        self.assertLess(abs(out[0]), 1e-6)  # 페이드로 시작
        self.assertEqual(len(trim(np.zeros(sr, np.float32), sr)), sr)  # 무음은 그대로

    def test_japanese_units(self):
        text = "参加希望の方は今週の金曜日までに名前と希望する時間帯を書き込んでください。"
        units = [u for u in JA_UNIT.split(text) if u]
        self.assertEqual("".join(units), text)
        self.assertIn("書き込んでください。", units)  # 히라가나 앞에서는 끊지 않는다


if __name__ == "__main__":
    unittest.main()
