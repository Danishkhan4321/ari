import assert from "node:assert/strict";
import test from "node:test";
import { createChatSessionStore, isChatSessionId, normalizeSessionTitle } from "../lib/chat-session-store";

const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";

test("creates a distinct empty session for every request", async () => {
  const ids = [FIRST, SECOND];
  const store = createChatSessionStore({
    idFactory: () => ids.shift()!,
    ensureLogFile: async () => undefined,
    queryFn: async (_sql, params = []) => ({ rows: [{ id: params[0], title: null, is_legacy: false, created_at: "now", updated_at: "now" }] }),
  });
  const first = await store.createSession("+919999999999");
  const second = await store.createSession("+919999999999");
  assert.notEqual(first.id, second.id);
});

test("session ownership queries by user and UUID", async () => {
  let values: unknown[] = [];
  const store = createChatSessionStore({
    ensureLogFile: async () => undefined,
    queryFn: async (_sql, params = []) => {
      values = params;
      return { rows: [{ id: params[1], title: null, is_legacy: false, created_at: "now", updated_at: "now" }] };
    },
  });
  await store.requireOwnedSession("+919999999999", FIRST);
  assert.deepEqual(values, ["+919999999999", FIRST]);
});

test("session IDs and titles are validated", () => {
  assert.equal(isChatSessionId(FIRST), true);
  assert.equal(isChatSessionId("../secret"), false);
  assert.equal(normalizeSessionTitle("  Sales follow-up  "), "Sales follow-up");
  assert.equal(normalizeSessionTitle(" "), null);
  assert.equal(normalizeSessionTitle("x".repeat(121)), null);
});
