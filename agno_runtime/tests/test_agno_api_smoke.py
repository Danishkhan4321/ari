"""Offline compatibility checks for the exact pinned Agno public APIs."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

try:
    from agno.db.postgres import PostgresDb
    from agno.models.google import Gemini
    from agno.models.openrouter import OpenRouter
    from agno.tools.function import Function
except ImportError:  # setup:agno has not been run in this environment
    PostgresDb = Gemini = OpenRouter = Function = None

from agno_runtime.model_factory import build_model
from agno_runtime.settings import normalize_postgres_url
from agno_runtime.worker import build_files


@unittest.skipIf(Function is None, "install agno_runtime/requirements.txt first")
class AgnoApiSmokeTests(unittest.TestCase):
    def test_dynamic_function_and_openrouter_fallback_configuration(self):
        schema = {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
            "additionalProperties": False,
        }
        function = Function(
            name="echo",
            description="Return the validated text.",
            parameters=schema,
            strict=False,
            entrypoint=lambda text: text,
            skip_entrypoint_processing=True,
        )
        self.assertEqual(function.parameters, schema)
        self.assertEqual(function.entrypoint(text="ok"), "ok")

        model = OpenRouter(
            id="openai/gpt-4.1-mini",
            models=["google/gemini-2.5-flash"],
            request_params={"parallel_tool_calls": False},
            extra_body={
                "provider": {
                    "allow_fallbacks": True,
                    "require_parameters": True,
                    "data_collection": "deny",
                    "zdr": True,
                },
            },
        )
        self.assertEqual(model.id, "openai/gpt-4.1-mini")
        self.assertEqual(model.models, ["google/gemini-2.5-flash"])
        self.assertFalse(model.request_params["parallel_tool_calls"])
        self.assertEqual(model.extra_body["provider"]["data_collection"], "deny")

    def test_postgres_db_uses_the_installed_psycopg_driver(self):
        database = PostgresDb(
            db_url=normalize_postgres_url("postgresql://user:pass@localhost:5432/ari"),
            create_schema=False,
        )
        self.assertEqual(database.db_engine.url.drivername, "postgresql+psycopg")

    def test_provider_factory_builds_native_gemini_without_openrouter(self):
        model = build_model({
            "model_provider": "gemini",
            "model_id": "gemini-test-model",
            "gemini": {"api_key": "test-google-key"},
            "max_output_tokens": 2048,
        })

        self.assertIsInstance(model, Gemini)
        self.assertEqual(model.id, "gemini-test-model")
        self.assertEqual(model.api_key, "test-google-key")
        self.assertEqual(model.max_output_tokens, 2048)
        self.assertEqual(model.retries, 0)

    def test_provider_factory_builds_vertex_gemini_with_project_scope(self):
        model = build_model({
            "model_provider": "gemini",
            "model_id": "gemini-vertex-test",
            "gemini": {
                "vertexai": True,
                "project_id": "ari-project",
                "location": "global",
            },
        })

        self.assertIsInstance(model, Gemini)
        self.assertTrue(model.vertexai)
        self.assertEqual(model.project_id, "ari-project")
        self.assertEqual(model.location, "global")

    def test_worker_builds_agno_files_only_after_root_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            filepath = root / "session" / "report.pdf"
            filepath.parent.mkdir()
            filepath.write_bytes(b"report")
            descriptor = {
                "artifact_id": "session:33333333-3333-4333-8333-333333333333",
                "path": str(filepath),
                "name": "report.pdf",
                "mime_type": "application/pdf",
                "size": filepath.stat().st_size,
            }
            with patch.dict(os.environ, {
                "ARI_SESSION_ATTACHMENT_DIR": str(root),
            }, clear=False):
                files = build_files([descriptor])

        self.assertEqual(len(files), 1)
        self.assertEqual(files[0].id, descriptor["artifact_id"])
        self.assertEqual(files[0].filepath, str(filepath))
        self.assertEqual(files[0].size, descriptor["size"])


if __name__ == "__main__":
    unittest.main()
