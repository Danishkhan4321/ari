import assert from "node:assert/strict";
import test from "node:test";
import { deriveEmailUserPhone, isValidEmail, normalizeEmail, resetEmailIdentityTableForTests, resolveEmailIdentity } from "../lib/email-identity";

test("email identity normalizes and validates addresses", () => {
  assert.equal(normalizeEmail("  Danish@Example.COM "), "danish@example.com");
  assert.equal(isValidEmail("danish@example.com"), true);
  assert.equal(isValidEmail("not-an-email"), false);
});

test("email identity derives a stable non-phone Ari key", () => {
  const first = deriveEmailUserPhone("danish@example.com");
  const second = deriveEmailUserPhone("DANISH@example.com");
  assert.equal(first, second);
  assert.match(first, /^001\d{17}$/);
});

test("email identity stores and reuses the same Ari user", async () => {
  resetEmailIdentityTableForTests();
  const statements: Array<{ sql: string; params?: unknown[] }> = [];
  const queryFn = async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
    statements.push({ sql, params });
    if (/RETURNING user_phone/.test(sql)) {
      return { rows: [{ user_phone: params?.[1] }] as T[] };
    }
    return { rows: [] as T[] };
  };

  const userPhone = await resolveEmailIdentity({ email: "user@example.com", name: "User" }, queryFn);
  assert.equal(userPhone, deriveEmailUserPhone("user@example.com"));
  assert.ok(statements.some(({ sql }) => /provider, provider_subject/.test(sql)));
});
