"""Pure configuration helpers for the Agno worker.

This module intentionally has no Agno imports, so configuration can be tested
before the optional Python environment is installed.
"""

from __future__ import annotations

from typing import Any


SUPPORTED_MODEL_PROVIDERS = {"openrouter", "gemini"}


def bounded_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, parsed))


def normalize_postgres_url(value: Any) -> str:
    """Select SQLAlchemy's psycopg v3 dialect for conventional Postgres URLs."""
    url = str(value or "").strip()
    if url.startswith("postgresql://"):
        return "postgresql+psycopg://" + url.removeprefix("postgresql://")
    if url.startswith("postgres://"):
        return "postgresql+psycopg://" + url.removeprefix("postgres://")
    return url


def normalize_model_provider(value: Any) -> str:
    """Return Ari's canonical Agno model-provider name."""
    provider = str(value or "openrouter").strip().lower()
    if provider == "google":
        provider = "gemini"
    if provider not in SUPPORTED_MODEL_PROVIDERS:
        supported = ", ".join(sorted(SUPPORTED_MODEL_PROVIDERS))
        raise ValueError(
            f"Unsupported Agno model provider '{provider}'. Supported providers: {supported}"
        )
    return provider


def build_openrouter_options(config: dict[str, Any]) -> dict[str, Any]:
    models = [str(item).strip() for item in config.get("models", []) if str(item).strip()]
    if not models:
        raise ValueError("At least one canonical OpenRouter model slug is required")
    if any("/" not in model for model in models):
        raise ValueError("OpenRouter model IDs must use canonical author/model slugs")

    provider_input = config.get("provider") or {}
    provider = {
        "allow_fallbacks": bool(provider_input.get("allow_fallbacks", True)),
        "require_parameters": bool(provider_input.get("require_parameters", True)),
        "data_collection": "deny" if provider_input.get("data_collection", "deny") == "deny" else "allow",
        "zdr": bool(provider_input.get("zdr", True)),
    }
    headers = {}
    if config.get("http_referer"):
        headers["HTTP-Referer"] = str(config["http_referer"])
    if config.get("app_title"):
        headers["X-OpenRouter-Title"] = str(config["app_title"])

    return {
        "id": models[0],
        "models": models[1:] or None,
        "max_tokens": bounded_int(config.get("max_output_tokens"), 2500, 256, 32000),
        "strict_output": False,
        "api_key": config.get("api_key") or None,
        "base_url": config.get("base_url") or "https://openrouter.ai/api/v1",
        "timeout": bounded_int(config.get("request_timeout_seconds"), 45, 5, 180),
        # Keep retry ownership in Ari. Nested OpenAI/Agno retries can multiply
        # side effects and make an interrupted outcome impossible to classify.
        "max_retries": 0,
        "retries": 0,
        "request_params": {"parallel_tool_calls": False},
        "extra_body": {"provider": provider},
        "extra_headers": headers or None,
    }


def build_gemini_options(config: dict[str, Any]) -> dict[str, Any]:
    """Build options accepted by ``agno.models.google.Gemini`` in Agno 2.7.4."""
    model_id = str(config.get("model_id") or "").strip()
    if not model_id:
        raise ValueError("A Gemini model ID is required")

    gemini = config.get("gemini") or {}
    vertexai = bool(gemini.get("vertexai", False))
    project_id = str(gemini.get("project_id") or "").strip() or None
    location = str(gemini.get("location") or "").strip() or None
    if vertexai and not project_id:
        raise ValueError("A Google Cloud project is required for Vertex Gemini")

    return {
        "id": model_id,
        "api_key": gemini.get("api_key") or None,
        "vertexai": vertexai,
        "project_id": project_id,
        "location": location,
        "max_output_tokens": bounded_int(
            config.get("max_output_tokens"), 2500, 256, 32000
        ),
        "timeout": bounded_int(
            config.get("request_timeout_seconds"), 45, 5, 180
        ),
        # Ari owns retry and side-effect classification. A nested model retry
        # must never cause an uncertain function call to be replayed.
        "retries": 0,
    }


def build_agent_options(config: dict[str, Any]) -> dict[str, Any]:
    return {
        "add_history_to_context": True,
        "num_history_runs": bounded_int(config.get("history_runs"), 4, 1, 12),
        "max_tool_calls_from_history": bounded_int(config.get("history_tool_calls"), 12, 0, 50),
        "enable_session_summaries": bool(config.get("enable_session_summaries", True)),
        "add_session_summary_to_context": True,
        "tool_call_limit": bounded_int(config.get("max_tool_calls"), 12, 1, 50),
        "tool_choice": "auto",
        "store_media": True,
        "store_tool_messages": True,
        "store_history_messages": False,
        "telemetry": False,
        "debug_mode": False,
        "markdown": False,
    }
