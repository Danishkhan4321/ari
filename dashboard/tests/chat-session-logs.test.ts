import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { resolveSessionLogPath } from "../lib/chat-session-logs";

const SESSION = "11111111-1111-4111-8111-111111111111";

test("session log path stays inside its configured root", () => {
  const root = path.resolve("C:\\AriLogs\\sessions");
  assert.equal(resolveSessionLogPath(root, SESSION), path.join(root, `${SESSION}.jsonl`));
  assert.throws(() => resolveSessionLogPath(root, "..\\secrets"));
});
