"""Provider-neutral model construction for Ari's pinned Agno worker."""

from __future__ import annotations

import base64
import binascii
import json
import os
from typing import Any

if __package__:
    from .settings import (
        build_gemini_options,
        build_openrouter_options,
        normalize_model_provider,
    )
else:
    from settings import (
        build_gemini_options,
        build_openrouter_options,
        normalize_model_provider,
    )


def decode_vertex_credentials(value: str) -> dict[str, Any]:
    """Decode Ari's supported raw-JSON or base64 service-account formats."""
    encoded = str(value or "").strip()
    if not encoded:
        raise ValueError("Vertex credentials are empty")
    if not encoded.startswith("{"):
        encoded = base64.b64decode(encoded, validate=True).decode("utf-8")
    parsed = json.loads(encoded)
    if not isinstance(parsed, dict):
        raise ValueError("Vertex credentials must decode to an object")
    return parsed


def build_model(config: dict[str, Any]):
    """Create the configured Agno model without importing unused providers."""
    provider = normalize_model_provider(config.get("model_provider"))
    if provider == "gemini":
        try:
            from agno.models.google import Gemini
        except ImportError as error:
            raise ImportError(
                "Gemini dependencies are missing. Install agno_runtime/requirements.txt."
            ) from error
        options = build_gemini_options(config)
        inline_credentials = os.getenv("GOOGLE_VERTEX_CREDENTIALS", "").strip()
        if options.get("vertexai") and inline_credentials:
            try:
                from google.oauth2.service_account import Credentials

                options["credentials"] = Credentials.from_service_account_info(
                    decode_vertex_credentials(inline_credentials),
                    scopes=["https://www.googleapis.com/auth/cloud-platform"],
                )
            except (
                ImportError,
                TypeError,
                ValueError,
                UnicodeDecodeError,
                binascii.Error,
                json.JSONDecodeError,
            ) as error:
                raise ValueError("GOOGLE_VERTEX_CREDENTIALS is not a valid service-account document") from error
        return Gemini(**options)

    try:
        from agno.models.openrouter import OpenRouter
    except ImportError as error:
        raise ImportError(
            "OpenRouter dependencies are missing. Install agno_runtime/requirements.txt."
        ) from error
    return OpenRouter(**build_openrouter_options(config))
