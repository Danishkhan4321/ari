import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../lib/groups.ts", import.meta.url), "utf8");

test("dashboard group creation reuses the normalized database winner", () => {
  assert.match(source, /ON CONFLICT\s*\([\s\S]*lower\(btrim\(name\)\)[\s\S]*\)\s*DO UPDATE/i);
  assert.match(source, /DO UPDATE SET\s+user_phone\s*=\s*EXCLUDED\.user_phone/i);
});

test("dashboard group ownership accepts the desktop and bot phone formats", () => {
  assert.match(source, /regexp_replace\(g\.user_phone,\s*'\[\^0-9\]'/i);
  assert.match(source, /regexp_replace\(user_phone,\s*'\[\^0-9\]'/i);
});
