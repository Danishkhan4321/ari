import io
import json
import unittest

from agno_runtime.protocol import ProtocolWriter, normalize_unicode, utf8_byte_length


class UnicodeNormalizationTests(unittest.TestCase):
    def test_byte_length_accepts_lone_surrogate(self):
        self.assertEqual(utf8_byte_length("x" + chr(0xDC8D)), 4)

    def test_combines_valid_surrogate_pair(self):
        pair = "hello " + chr(0xD83D) + chr(0xDE00)
        self.assertEqual(normalize_unicode(pair), "hello " + chr(0x1F600))

    def test_replaces_lone_surrogate_recursively(self):
        value = {
            "message": "broken " + chr(0xDC8D),
            "nested": ["ok", "bad " + chr(0xD800)],
        }
        normalized = normalize_unicode(value)
        self.assertEqual(normalized["message"], "broken " + chr(0xFFFD))
        self.assertEqual(normalized["nested"], ["ok", "bad " + chr(0xFFFD)])
        json.dumps(normalized, ensure_ascii=False).encode("utf-8")

    def test_writer_emits_utf8_safe_ndjson(self):
        stream = io.StringIO()
        ProtocolWriter(stream, "request-1").emit(
            "event", summary="bad " + chr(0xDC8D)
        )
        encoded = stream.getvalue().encode("utf-8")
        payload = json.loads(encoded)
        self.assertEqual(payload["summary"], "bad " + chr(0xFFFD))


if __name__ == "__main__":
    unittest.main()
