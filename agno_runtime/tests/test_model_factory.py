import base64
import json
import unittest

from agno_runtime.model_factory import decode_vertex_credentials


class VertexCredentialDecodingTests(unittest.TestCase):
    def test_accepts_raw_or_base64_json(self):
        document = {"type": "service_account", "project_id": "ari-test"}
        raw = json.dumps(document)
        encoded = base64.b64encode(raw.encode("utf-8")).decode("ascii")

        self.assertEqual(decode_vertex_credentials(raw), document)
        self.assertEqual(decode_vertex_credentials(encoded), document)

    def test_rejects_empty_or_non_object_credentials(self):
        with self.assertRaises(ValueError):
            decode_vertex_credentials("")
        with self.assertRaises(ValueError):
            decode_vertex_credentials("[]")


if __name__ == "__main__":
    unittest.main()
