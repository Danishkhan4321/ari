import assert from "node:assert/strict";
import test from "node:test";
import { groupMessagesIntoSessions } from "../lib/chat-sessions";

test("groups related turns into one sidebar session", () => {
  const sessions = groupMessagesIntoSessions([
    { id: 1, role: "user", content: "Plan my day", created_at: "2026-07-17T09:00:00.000Z" },
    { id: 2, role: "assistant", content: "Here is your plan", created_at: "2026-07-17T09:00:04.000Z" },
    { id: 3, role: "user", content: "Move the first task", created_at: "2026-07-17T09:04:00.000Z" },
    { id: 4, role: "assistant", content: "Done", created_at: "2026-07-17T09:04:05.000Z" },
    { id: 5, role: "user", content: "Review sales", created_at: "2026-07-17T11:00:00.000Z" },
  ]);

  assert.deepEqual(sessions.map(({ id, startId, endId, content }) => ({ id, startId, endId, content })), [
    { id: 1, startId: 1, endId: 4, content: "Plan my day" },
    { id: 5, startId: 5, endId: 5, content: "Review sales" },
  ]);
});
