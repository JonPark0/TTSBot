"""python -m unittest server.test_buckets  (onnxruntime이 깔린 환경에서)"""
import tempfile
import unittest
from pathlib import Path

from .engine import Engine, _Bucket, find_buckets, parse_buckets


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


if __name__ == "__main__":
    unittest.main()
