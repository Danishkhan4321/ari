import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app/contacts/contacts-content.tsx", import.meta.url), "utf8");

test("lead enrichment results hide provider, pricing, and conflict review language", () => {
  assert.doesNotMatch(source, /Actual \$/);
  assert.doesNotMatch(source, /estimated \$/i);
  assert.doesNotMatch(source, /Exa found|Use Exa/);
  assert.doesNotMatch(source, /Review conflicts/);
});
