"""Small dependency-free state helpers for the one-turn Agno worker."""

from __future__ import annotations

from typing import Any


def records_successful_clear(tool_name: str, result: Any) -> bool:
    """Only a confirmed successful clear tool may erase persisted history."""
    return (
        tool_name == "clear_chat_history"
        and isinstance(result, dict)
        and result.get("status") == "success"
    )


def clear_persisted_session(database: Any, request: dict[str, Any], requested: bool) -> bool:
    """Delete the tenant-scoped Agno session after its clear turn was saved."""
    if not requested:
        return False
    database.delete_session(
        session_id=str(request["session_id"]),
        user_id=str(request["user_id"]),
    )
    return True
