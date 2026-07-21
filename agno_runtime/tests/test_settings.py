import unittest

from agno_runtime.settings import (
    build_agent_options,
    build_gemini_options,
    build_openrouter_options,
    normalize_model_provider,
    normalize_postgres_url,
)


class SettingsTests(unittest.TestCase):
    def test_openrouter_options_use_verified_274_fields(self):
        options = build_openrouter_options({
            "models": ["openai/gpt-4.1-mini", "google/gemini-2.5-flash"],
            "provider": {
                "allow_fallbacks": True,
                "require_parameters": True,
                "data_collection": "deny",
                "zdr": True,
            },
            "http_referer": "https://ari.example",
            "app_title": "Ari",
        })
        self.assertEqual(options["id"], "openai/gpt-4.1-mini")
        self.assertEqual(options["models"], ["google/gemini-2.5-flash"])
        self.assertEqual(options["request_params"], {"parallel_tool_calls": False})
        self.assertTrue(options["extra_body"]["provider"]["require_parameters"])
        self.assertEqual(options["extra_body"]["provider"]["data_collection"], "deny")
        self.assertEqual(options["max_retries"], 0)
        self.assertEqual(options["retries"], 0)

    def test_model_slug_must_be_canonical(self):
        with self.assertRaisesRegex(ValueError, "author/model"):
            build_openrouter_options({"models": ["gpt-4.1-mini"]})

    def test_gemini_options_support_ai_studio_without_openrouter_fields(self):
        options = build_gemini_options({
            "model_id": "gemini-test-model",
            "max_output_tokens": 1800,
            "request_timeout_seconds": 30,
            "gemini": {"api_key": "test-google-key"},
        })

        self.assertEqual(options["id"], "gemini-test-model")
        self.assertEqual(options["api_key"], "test-google-key")
        self.assertEqual(options["max_output_tokens"], 1800)
        self.assertEqual(options["timeout"], 30)
        self.assertFalse(options["vertexai"])
        self.assertNotIn("extra_body", options)
        self.assertEqual(options["retries"], 0)

    def test_gemini_options_support_vertex_credentials_without_an_api_key(self):
        options = build_gemini_options({
            "model_id": "gemini-vertex-test",
            "gemini": {
                "vertexai": True,
                "project_id": "ari-project",
                "location": "global",
            },
        })

        self.assertTrue(options["vertexai"])
        self.assertEqual(options["project_id"], "ari-project")
        self.assertEqual(options["location"], "global")
        self.assertIsNone(options["api_key"])

    def test_model_provider_is_explicit_and_rejects_unsupported_values(self):
        self.assertEqual(normalize_model_provider(" Google "), "gemini")
        self.assertEqual(normalize_model_provider("openrouter"), "openrouter")
        with self.assertRaisesRegex(ValueError, "Unsupported Agno model provider"):
            normalize_model_provider("codex")

    def test_agent_history_is_bounded_and_summarized(self):
        options = build_agent_options({"history_runs": 999, "max_tool_calls": 0})
        self.assertEqual(options["num_history_runs"], 12)
        self.assertEqual(options["tool_call_limit"], 1)
        self.assertTrue(options["enable_session_summaries"])
        self.assertFalse(options["store_history_messages"])
        self.assertFalse(options["telemetry"])

    def test_plain_postgres_urls_select_the_installed_psycopg_driver(self):
        self.assertEqual(
            normalize_postgres_url("postgresql://user:pass@db.example/ari"),
            "postgresql+psycopg://user:pass@db.example/ari",
        )
        self.assertEqual(
            normalize_postgres_url("postgres://user:pass@db.example/ari"),
            "postgresql+psycopg://user:pass@db.example/ari",
        )

    def test_explicit_postgres_driver_is_preserved(self):
        url = "postgresql+psycopg://user:pass@db.example/ari?sslmode=require"
        self.assertEqual(normalize_postgres_url(url), url)


if __name__ == "__main__":
    unittest.main()
