import assert from "node:assert/strict";
import test from "node:test";
import { conversationPhoneCandidates } from "../lib/chat-phone";

test("conversation history finds the same account with or without a plus prefix", () => {
  assert.deepEqual(conversationPhoneCandidates("+919814209823"), ["+919814209823", "919814209823"]);
});

