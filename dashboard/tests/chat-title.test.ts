import assert from "node:assert/strict";
import test from "node:test";
import { normalizeChatTitle } from "../lib/chat-titles";

test("chat titles are trimmed and kept concise", () => {
  assert.equal(normalizeChatTitle("  Priya follow-up  "), "Priya follow-up");
  assert.equal(normalizeChatTitle("   "), null);
  assert.equal(normalizeChatTitle("x".repeat(121)), null);
});

