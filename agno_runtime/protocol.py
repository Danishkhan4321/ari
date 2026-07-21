"""Thread-safe NDJSON transport used by Agno tool callbacks."""

from __future__ import annotations

import json
import queue
import threading
import uuid
from typing import Any, TextIO


PROTOCOL_VERSION = 1
MAX_LINE_BYTES = 2 * 1024 * 1024


class ProtocolFailure(RuntimeError):
    pass


def utf8_byte_length(value: str) -> int:
    """Count transport bytes even when decoded input contains surrogates."""
    return len(value.encode("utf-8", "surrogatepass"))


def normalize_unicode(value: Any) -> Any:
    """Make JSON-derived text safe for UTF-8 providers and NDJSON transport.

    JavaScript can serialize lone UTF-16 surrogates. Python's ``json.loads``
    preserves them, but provider SDKs later reject the resulting string when
    they encode it as UTF-8. Valid surrogate pairs are combined; isolated
    halves are replaced without discarding the rest of the request.
    """
    if isinstance(value, str):
        try:
            value.encode("utf-8")
            return value
        except UnicodeEncodeError:
            return value.encode("utf-16", "surrogatepass").decode("utf-16", "replace")
    if isinstance(value, dict):
        return {
            normalize_unicode(key): normalize_unicode(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [normalize_unicode(item) for item in value]
    if isinstance(value, tuple):
        return tuple(normalize_unicode(item) for item in value)
    return value


class ProtocolWriter:
    def __init__(self, stream: TextIO, request_id: str):
        self.stream = stream
        self.request_id = request_id
        self._lock = threading.Lock()

    def emit(self, message_type: str, **payload: Any) -> None:
        envelope = normalize_unicode({
            "protocol_version": PROTOCOL_VERSION,
            "request_id": self.request_id,
            "type": message_type,
            **payload,
        })
        encoded = json.dumps(envelope, ensure_ascii=False, separators=(",", ":"))
        if utf8_byte_length(encoded) > MAX_LINE_BYTES:
            raise ProtocolFailure("Protocol message exceeded the 2MB limit")
        with self._lock:
            self.stream.write(encoded + "\n")
            self.stream.flush()


class ToolResultBroker:
    """Lets synchronous Agno functions wait while a reader thread consumes stdin."""

    def __init__(self, input_stream: TextIO, writer: ProtocolWriter, timeout_seconds: int = 300):
        self.input_stream = input_stream
        self.writer = writer
        self.timeout_seconds = max(1, timeout_seconds)
        self._pending: dict[str, queue.Queue[Any]] = {}
        self._lock = threading.Lock()
        self._closed = False

    def start(self) -> None:
        threading.Thread(target=self._read_loop, name="ari-agno-protocol-reader", daemon=True).start()

    def call(self, name: str, arguments: dict[str, Any], call_id: str | None = None) -> dict[str, Any]:
        stable_call_id = str(call_id or uuid.uuid4())
        response_queue: queue.Queue[Any] = queue.Queue(maxsize=1)
        with self._lock:
            if self._closed:
                raise ProtocolFailure("Node tool transport is closed")
            if stable_call_id in self._pending:
                raise ProtocolFailure(f"Duplicate tool call ID: {stable_call_id}")
            self._pending[stable_call_id] = response_queue
        try:
            self.writer.emit(
                "tool_call",
                call_id=stable_call_id,
                idempotency_key=stable_call_id,
                name=name,
                arguments=arguments,
            )
            try:
                received = response_queue.get(timeout=self.timeout_seconds)
            except queue.Empty as error:
                raise ProtocolFailure(f"Timed out waiting for Node result for {name}") from error
            if isinstance(received, BaseException):
                raise received
            if not isinstance(received, dict):
                raise ProtocolFailure(f"Node returned a non-object result for {name}")
            return received
        finally:
            with self._lock:
                self._pending.pop(stable_call_id, None)

    def _fail_all(self, error: BaseException) -> None:
        with self._lock:
            self._closed = True
            queues = list(self._pending.values())
        for response_queue in queues:
            try:
                response_queue.put_nowait(error)
            except queue.Full:
                pass

    def _read_loop(self) -> None:
        try:
            for raw_line in self.input_stream:
                if utf8_byte_length(raw_line) > MAX_LINE_BYTES:
                    raise ProtocolFailure("Incoming protocol line exceeded the 2MB limit")
                try:
                    message = normalize_unicode(json.loads(raw_line))
                except json.JSONDecodeError as error:
                    raise ProtocolFailure("Node emitted invalid NDJSON") from error
                if message.get("protocol_version") != PROTOCOL_VERSION:
                    raise ProtocolFailure("Unsupported protocol version")
                if message.get("request_id") != self.writer.request_id:
                    raise ProtocolFailure("Mismatched request_id in tool result")
                if message.get("type") != "tool_result":
                    raise ProtocolFailure(f"Unexpected Node message type: {message.get('type')}")
                call_id = str(message.get("call_id") or "")
                with self._lock:
                    response_queue = self._pending.get(call_id)
                if response_queue is None:
                    # A timed-out or duplicated late result is never attached
                    # to a different tool invocation.
                    continue
                response_queue.put(message.get("result"))
            self._fail_all(ProtocolFailure("Node closed the tool transport"))
        except BaseException as error:
            self._fail_all(error)
