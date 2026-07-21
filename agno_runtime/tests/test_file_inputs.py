from __future__ import annotations

import hashlib
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agno_runtime.file_inputs import AttachmentInputFailure, validate_file_specs


GENERIC_FAILURE = "One or more attached files could not be loaded safely"


class FileInputTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.root = Path(self.temporary_directory.name).resolve()
        self.file_path = self.root / "session" / "report.pdf"
        self.file_path.parent.mkdir()
        self.content = b"owned report bytes"
        self.file_path.write_bytes(self.content)

    def descriptor(self, **overrides):
        descriptor = {
            "artifact_id": "session:33333333-3333-4333-8333-333333333333",
            "path": str(self.file_path),
            "name": "report.pdf",
            "mime_type": "application/pdf",
            "size": len(self.content),
        }
        descriptor.update(overrides)
        return descriptor

    def assert_generic_failure(self, specs, environment=None):
        variables = {
            "ARI_SESSION_ATTACHMENT_DIR": str(self.root),
            **(environment or {}),
        }
        with patch.dict(os.environ, variables, clear=False):
            with self.assertRaises(AttachmentInputFailure) as raised:
                validate_file_specs(specs)
        self.assertEqual(str(raised.exception), GENERIC_FAILURE)

    def test_accepts_an_owned_regular_file_and_optional_matching_hash(self):
        digest = hashlib.sha256(self.content).hexdigest()
        with patch.dict(os.environ, {
            "ARI_SESSION_ATTACHMENT_DIR": str(self.root),
        }, clear=False):
            validated = validate_file_specs([
                self.descriptor(sha256=digest),
            ])

        self.assertEqual(len(validated), 1)
        self.assertEqual(validated[0].artifact_id, self.descriptor()["artifact_id"])
        self.assertEqual(validated[0].path, self.file_path)
        self.assertEqual(validated[0].size, len(self.content))

    def test_requires_the_attachment_root_only_when_files_are_present(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(validate_file_specs([]), [])
            with self.assertRaisesRegex(AttachmentInputFailure, f"^{GENERIC_FAILURE}$"):
                validate_file_specs([self.descriptor()])

    def test_rejects_outside_paths_unknown_fields_and_non_session_ids_generically(self):
        outside = self.root.parent / "outside-secret.txt"
        outside.write_bytes(b"secret")
        self.addCleanup(lambda: outside.unlink(missing_ok=True))

        invalid_specs = [
            [self.descriptor(path=str(outside), size=outside.stat().st_size)],
            [self.descriptor(host_path="ignored")],
            [self.descriptor(artifact_id="user_file:42")],
            {"not": "a list"},
        ]
        for specs in invalid_specs:
            with self.subTest(specs=specs):
                self.assert_generic_failure(specs)

    def test_rejects_symlinks_and_non_regular_files(self):
        symlink = self.root / "session" / "linked.pdf"
        try:
            symlink.symlink_to(self.file_path)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks are unavailable on this platform")

        self.assert_generic_failure([
            self.descriptor(path=str(symlink)),
        ])
        self.assert_generic_failure([
            self.descriptor(path=str(self.file_path.parent), size=0),
        ])

    def test_rejects_size_or_hash_mismatch(self):
        self.assert_generic_failure([
            self.descriptor(size=len(self.content) + 1),
        ])
        self.assert_generic_failure([
            self.descriptor(sha256="0" * 64),
        ])

    def test_enforces_count_per_file_and_total_byte_limits(self):
        second = self.root / "session" / "second.pdf"
        second.write_bytes(b"second")
        second_descriptor = self.descriptor(
            artifact_id="session:44444444-4444-4444-8444-444444444444",
            path=str(second),
            name="second.pdf",
            size=second.stat().st_size,
        )

        self.assert_generic_failure(
            [self.descriptor(), second_descriptor],
            {"ARI_AGENT_FILE_MAX_COUNT": "1"},
        )
        self.assert_generic_failure(
            [self.descriptor()],
            {"ARI_AGENT_FILE_MAX_BYTES": str(len(self.content) - 1)},
        )
        self.assert_generic_failure(
            [self.descriptor(), second_descriptor],
            {"ARI_AGENT_FILE_TOTAL_MAX_BYTES": str(len(self.content))},
        )

    def test_rejects_duplicate_ids_paths_and_unsafe_names(self):
        for specs in (
            [self.descriptor(), self.descriptor()],
            [self.descriptor(), self.descriptor(
                artifact_id="session:44444444-4444-4444-8444-444444444444",
            )],
            [self.descriptor(name="../report.pdf")],
        ):
            with self.subTest(specs=specs):
                self.assert_generic_failure(specs)


if __name__ == "__main__":
    unittest.main()
