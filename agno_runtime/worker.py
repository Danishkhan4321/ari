"""One-turn Agno 2.7.4 worker for Ari.

Node owns business execution and durable idempotency. This process owns model
planning, Agno session history, and the model/tool loop. Only NDJSON is written
to the original stdout; library logs are redirected to stderr.
"""

from __future__ import annotations

import json
import os
import sys
from contextlib import redirect_stdout
from typing import Any

if __package__:  # Package imports for tests and ``python -m``.
    from .file_inputs import validate_file_specs
    from .model_factory import build_model
    from .protocol import (
        MAX_LINE_BYTES,
        PROTOCOL_VERSION,
        ProtocolFailure,
        ProtocolWriter,
        ToolResultBroker,
        normalize_unicode,
        utf8_byte_length,
    )
    from .runtime_state import clear_persisted_session, records_successful_clear
    from .settings import (
        bounded_int,
        build_agent_options,
        normalize_postgres_url,
    )
else:  # Direct script execution used by the Node bridge.
    from file_inputs import validate_file_specs
    from model_factory import build_model
    from protocol import (
        MAX_LINE_BYTES,
        PROTOCOL_VERSION,
        ProtocolFailure,
        ProtocolWriter,
        ToolResultBroker,
        normalize_unicode,
        utf8_byte_length,
    )
    from runtime_state import clear_persisted_session, records_successful_clear
    from settings import (
        bounded_int,
        build_agent_options,
        normalize_postgres_url,
    )


RESERVED_ARGUMENTS = {"agent", "team", "run_context", "fc", "files", "images", "videos", "audios"}


def read_run_request() -> dict[str, Any]:
    raw_line = sys.stdin.readline()
    if not raw_line:
        raise ProtocolFailure("No run request received")
    if utf8_byte_length(raw_line) > MAX_LINE_BYTES:
        raise ProtocolFailure("Run request exceeded the 2MB limit")
    request = normalize_unicode(json.loads(raw_line))
    if request.get("protocol_version") != PROTOCOL_VERSION or request.get("type") != "run":
        raise ProtocolFailure("Expected an Ari Agno protocol v1 run message")
    for field in ("request_id", "user_id", "session_id", "message", "tools", "config"):
        if field not in request:
            raise ProtocolFailure(f"Run request is missing {field}")
    if not request["user_id"] or not request["session_id"]:
        raise ProtocolFailure("Tenant-scoped user_id and session_id are required")
    return request


def json_result(value: Any) -> str:
    return json.dumps(normalize_unicode(value), ensure_ascii=False, separators=(",", ":"), default=str)


def build_functions(
    tool_specs: list[dict[str, Any]],
    broker: ToolResultBroker,
    run_state: dict[str, Any] | None = None,
):
    from agno.tools.function import Function
    from jsonschema import Draft7Validator

    seen: set[str] = set()
    functions = []
    for spec in tool_specs:
        name = str(spec.get("name") or "")
        schema = spec.get("input_schema")
        if not name or name in seen or not isinstance(schema, dict):
            raise ProtocolFailure(f"Invalid or duplicate tool contract: {name or '<missing>'}")
        seen.add(name)
        properties = schema.get("properties") or {}
        collision = RESERVED_ARGUMENTS.intersection(properties)
        if collision:
            raise ProtocolFailure(f"{name} uses reserved Agno arguments: {sorted(collision)}")
        Draft7Validator.check_schema(schema)
        validator = Draft7Validator(schema)

        def invoke(fc=None, _name=name, _validator=validator, **kwargs):
            errors = sorted(_validator.iter_errors(kwargs), key=lambda item: list(item.path))
            if errors:
                detail = "; ".join(
                    f"{'.'.join(map(str, error.path)) or 'input'}: {error.message}"
                    for error in errors
                )[:800]
                return json_result({
                    "status": "failure",
                    "error": {
                        "code": "invalid_tool_arguments",
                        "category": "validation",
                        "retryable": True,
                        "message": detail,
                    },
                    "user_summary": f"{_name} needs corrected inputs.",
                })
            result = broker.call(_name, kwargs, getattr(fc, "call_id", None))
            if run_state is not None and records_successful_clear(_name, result):
                run_state["clear_history"] = True
            return json_result(result)

        functions.append(Function(
            name=name,
            description=str(spec.get("description") or ""),
            parameters=schema,
            strict=False,
            entrypoint=invoke,
            skip_entrypoint_processing=True,
        ))
    return functions


def build_files(file_specs: list[dict[str, Any]]):
    from agno.media import File

    files = []
    for validated in validate_file_specs(file_specs):
        files.append(File(
            id=validated.artifact_id,
            filepath=str(validated.path),
            filename=validated.name,
            mime_type=validated.mime_type,
            size=validated.size,
        ))
    return files


def run_request(request: dict[str, Any], writer: ProtocolWriter) -> None:
    try:
        from agno.agent import Agent
        from agno.db.postgres import PostgresDb
    except ImportError as error:
        raise ProtocolFailure(
            'Agno dependencies are missing. Install agno_runtime/requirements.txt.'
        ) from error

    # Validate host file descriptors before initializing a database session or
    # starting the tool-result reader thread.
    files = build_files(request.get("files") or [])
    config = request["config"]
    db_url = normalize_postgres_url(config.get("db_url") or os.getenv("DATABASE_URL"))
    if not db_url:
        raise ProtocolFailure("DATABASE_URL is required for persistent Agno sessions")

    try:
        model = build_model(config)
    except ImportError as error:
        raise ProtocolFailure(str(error)) from error
    database = PostgresDb(
        db_url=db_url,
        db_schema=str(config.get("db_schema") or "public"),
        session_table=str(config.get("session_table") or "ari_agno_sessions"),
        memory_table=str(config.get("memory_table") or "ari_agno_memories"),
        metrics_table=str(config.get("metrics_table") or "ari_agno_metrics"),
        eval_table=str(config.get("eval_table") or "ari_agno_eval_runs"),
        create_schema=True,
    )
    broker = ToolResultBroker(
        sys.stdin,
        writer,
        bounded_int(config.get("tool_timeout_seconds"), 300, 1, 600),
    )
    run_state: dict[str, Any] = {"clear_history": False}
    tools = build_functions(request["tools"], broker, run_state)
    broker.start()

    instructions = [str(item) for item in request.get("instructions", []) if str(item).strip()]
    agent = Agent(
        id="ari-agno",
        name="Ari",
        model=model,
        tools=tools,
        db=database,
        user_id=str(request["user_id"]),
        session_id=str(request["session_id"]),
        instructions=instructions,
        **build_agent_options(config),
    )
    writer.emit(
        "event",
        event={
            "type": "model.turn.started",
            "summary": "Agno is understanding the request",
        },
    )
    # Agno's synchronous path executes a provider-returned tool batch in order.
    # The reader thread remains available while a callback waits for Node.
    with redirect_stdout(sys.stderr):
        output = agent.run(str(request["message"]), files=files or None, stream=False)
        # Agent.run persists this final turn before it returns. Delete only now
        # so a successful clear cannot be followed by the clear turn itself
        # reappearing in the next request.
        clear_persisted_session(database, request, bool(run_state["clear_history"]))

    status = getattr(output.status, "value", str(output.status or "completed"))
    content = output.content
    if not isinstance(content, str):
        content = json_result(content) if content is not None else ""
    metrics = output.metrics.to_dict() if hasattr(output.metrics, "to_dict") else output.metrics
    tool_records = []
    for tool in output.tools or []:
        record = tool.to_dict() if hasattr(tool, "to_dict") else {}
        if isinstance(record.get("result"), str) and len(record["result"]) > 12000:
            record["result"] = record["result"][:12000] + "…"
        tool_records.append(record)
    writer.emit(
        "final",
        status=status,
        content=content,
        run_id=output.run_id,
        session_id=output.session_id,
        model=output.model,
        model_provider=output.model_provider,
        metrics=metrics,
        tools=tool_records,
    )


def main() -> int:
    protocol_stdout = sys.stdout
    # Agno/provider libraries may print diagnostics. Preserve stdout as a
    # versioned NDJSON-only transport for the parent Node process.
    sys.stdout = sys.stderr
    request_id = "unknown"
    writer = None
    try:
        request = read_run_request()
        request_id = str(request["request_id"])
        writer = ProtocolWriter(protocol_stdout, request_id)
        run_request(request, writer)
        return 0
    except BaseException as error:
        if writer is None:
            writer = ProtocolWriter(protocol_stdout, request_id)
        code = (
            "agno_dependency_missing"
            if isinstance(error.__cause__, ImportError)
            else "agno_worker_error"
        )
        try:
            writer.emit("error", code=code, message=str(error)[:1200])
        except BaseException:
            pass
        print(f"Ari Agno worker failed: {error}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
