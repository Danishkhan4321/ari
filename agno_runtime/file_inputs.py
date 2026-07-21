"""Validate local file descriptors before they cross into Agno.

Node resolves tenant ownership. This module provides a second, process-local
boundary: only current-turn session artifacts under the configured attachment
root can become Agno ``File`` objects.
"""

from __future__ import annotations

import hashlib
import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_MAX_FILE_COUNT = 10
DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024
DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024
HARD_MAX_FILE_COUNT = 50
HARD_MAX_FILE_BYTES = 100 * 1024 * 1024
HARD_MAX_TOTAL_BYTES = 250 * 1024 * 1024
GENERIC_ATTACHMENT_FAILURE = "One or more attached files could not be loaded safely"

_ALLOWED_FIELDS = {"artifact_id", "path", "name", "mime_type", "size", "sha256"}
_REQUIRED_FIELDS = {"artifact_id", "path", "name", "mime_type", "size"}
_SESSION_ARTIFACT = re.compile(
    r"^session:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-"
    r"[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_SHA256 = re.compile(r"^[0-9a-f]{64}$", re.IGNORECASE)


class AttachmentInputFailure(RuntimeError):
    """A deliberately non-enumerating attachment validation failure."""


@dataclass(frozen=True, slots=True)
class ValidatedFileInput:
    artifact_id: str
    path: Path
    name: str
    mime_type: str
    size: int


def _configured_limit(name: str, default: int, hard_maximum: int) -> int:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    value = int(raw)
    if value < 1:
        raise ValueError("limit must be positive")
    return min(value, hard_maximum)


def _absolute_without_links(value: str) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = Path.cwd() / path
    return Path(os.path.abspath(path))


def _reject_symlink_components(root: Path, candidate: Path) -> None:
    relative = candidate.relative_to(root)
    cursor = root
    for component in relative.parts:
        cursor /= component
        if cursor.is_symlink():
            raise ValueError("symlinked attachment path")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _validate_file_specs(file_specs: Any) -> list[ValidatedFileInput]:
    if not isinstance(file_specs, list):
        raise TypeError("files must be a list")
    if not file_specs:
        return []

    max_count = _configured_limit(
        "ARI_AGENT_FILE_MAX_COUNT", DEFAULT_MAX_FILE_COUNT, HARD_MAX_FILE_COUNT
    )
    max_file_bytes = _configured_limit(
        "ARI_AGENT_FILE_MAX_BYTES", DEFAULT_MAX_FILE_BYTES, HARD_MAX_FILE_BYTES
    )
    max_total_bytes = _configured_limit(
        "ARI_AGENT_FILE_TOTAL_MAX_BYTES",
        DEFAULT_MAX_TOTAL_BYTES,
        HARD_MAX_TOTAL_BYTES,
    )
    if len(file_specs) > max_count:
        raise ValueError("too many attachments")

    root_value = os.getenv("ARI_SESSION_ATTACHMENT_DIR", "").strip()
    if not root_value:
        raise ValueError("attachment root is not configured")
    lexical_root = _absolute_without_links(root_value)
    resolved_root = lexical_root.resolve(strict=True)
    root_stat = os.stat(resolved_root, follow_symlinks=False)
    if not stat.S_ISDIR(root_stat.st_mode):
        raise ValueError("attachment root is not a directory")

    validated: list[ValidatedFileInput] = []
    seen_ids: set[str] = set()
    seen_paths: set[str] = set()
    total_bytes = 0

    for descriptor in file_specs:
        if not isinstance(descriptor, dict):
            raise TypeError("attachment descriptor must be an object")
        fields = set(descriptor)
        if not _REQUIRED_FIELDS.issubset(fields) or not fields.issubset(_ALLOWED_FIELDS):
            raise ValueError("attachment descriptor fields are invalid")

        artifact_id = descriptor["artifact_id"]
        filepath = descriptor["path"]
        name = descriptor["name"]
        mime_type = descriptor["mime_type"]
        expected_size = descriptor["size"]
        expected_hash = descriptor.get("sha256")

        if not isinstance(artifact_id, str) or not _SESSION_ARTIFACT.fullmatch(artifact_id):
            raise ValueError("attachment ID is invalid")
        if not isinstance(filepath, str) or not filepath or not Path(filepath).is_absolute():
            raise ValueError("attachment path must be absolute")
        if (
            not isinstance(name, str)
            or not name
            or len(name) > 255
            or name in {".", ".."}
            or "/" in name
            or "\\" in name
            or any(ord(character) < 32 or ord(character) == 127 for character in name)
        ):
            raise ValueError("attachment name is invalid")
        if (
            not isinstance(mime_type, str)
            or not mime_type
            or len(mime_type) > 255
            or any(ord(character) < 32 or ord(character) == 127 for character in mime_type)
        ):
            raise ValueError("attachment MIME type is invalid")
        if type(expected_size) is not int or expected_size < 0:
            raise ValueError("attachment size is invalid")
        if expected_hash is not None and (
            not isinstance(expected_hash, str) or not _SHA256.fullmatch(expected_hash)
        ):
            raise ValueError("attachment digest is invalid")

        lexical_path = _absolute_without_links(filepath)
        if lexical_path == lexical_root or not lexical_path.is_relative_to(lexical_root):
            raise ValueError("attachment path is outside the configured root")
        _reject_symlink_components(lexical_root, lexical_path)
        resolved_path = lexical_path.resolve(strict=True)
        if resolved_path == resolved_root or not resolved_path.is_relative_to(resolved_root):
            raise ValueError("attachment path resolves outside the configured root")

        before = os.stat(resolved_path, follow_symlinks=False)
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("attachment is not a regular file")
        if before.st_size != expected_size or before.st_size > max_file_bytes:
            raise ValueError("attachment size is inconsistent or too large")

        normalized_id = artifact_id.casefold()
        normalized_path = os.path.normcase(str(resolved_path))
        if normalized_id in seen_ids or normalized_path in seen_paths:
            raise ValueError("duplicate attachment")
        seen_ids.add(normalized_id)
        seen_paths.add(normalized_path)

        total_bytes += before.st_size
        if total_bytes > max_total_bytes:
            raise ValueError("attachment total is too large")

        if expected_hash is not None:
            actual_hash = _sha256_file(resolved_path)
            after = os.stat(resolved_path, follow_symlinks=False)
            identity_before = (
                before.st_dev,
                before.st_ino,
                before.st_size,
                before.st_mtime_ns,
            )
            identity_after = (
                after.st_dev,
                after.st_ino,
                after.st_size,
                after.st_mtime_ns,
            )
            if identity_before != identity_after or actual_hash != expected_hash.lower():
                raise ValueError("attachment digest is inconsistent")

        validated.append(ValidatedFileInput(
            artifact_id=artifact_id,
            path=resolved_path,
            name=name,
            mime_type=mime_type,
            size=before.st_size,
        ))

    return validated


def validate_file_specs(file_specs: Any) -> list[ValidatedFileInput]:
    """Return safe descriptors or one generic error with no host path details."""
    try:
        return _validate_file_specs(file_specs)
    except AttachmentInputFailure:
        raise
    except Exception:
        raise AttachmentInputFailure(GENERIC_ATTACHMENT_FAILURE) from None

