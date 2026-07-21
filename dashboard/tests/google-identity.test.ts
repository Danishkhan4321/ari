import assert from "node:assert/strict";
import test from "node:test";
import { deriveGoogleUserPhone, resetGoogleIdentityTableForTests, resolveGoogleIdentity } from "../lib/google-identity";

test("Google subjects map to stable non-routable compatibility identities", () => {
  const first = deriveGoogleUserPhone("109876543210987654321");
  assert.match(first, /^000\d{17}$/);
  assert.equal(first, deriveGoogleUserPhone("109876543210987654321"));
  assert.notEqual(first, deriveGoogleUserPhone("209876543210987654321"));
});

test("first-time Google login creates an identity without requiring WhatsApp", async () => {
  resetGoogleIdentityTableForTests();
  const subject = "109876543210987654321";
  const expected = deriveGoogleUserPhone(subject);
  const statements: string[] = [];
  const queryFn = async <T>(sql: string): Promise<{ rows: T[] }> => {
    statements.push(sql);
    if (sql.includes("SELECT user_phone FROM ari_user_identities")) return { rows: [] };
    if (sql.includes("SELECT user_phone FROM google_tokens")) return { rows: [] };
    if (sql.includes("INSERT INTO ari_user_identities")) return { rows: [{ user_phone: expected } as T] };
    return { rows: [] };
  };

  const userPhone = await resolveGoogleIdentity({
    sub: subject,
    email: "Judge@Example.com",
    name: "Hackathon Judge",
  }, queryFn);

  assert.equal(userPhone, expected);
  assert.ok(statements.some((sql) => sql.includes("INSERT INTO ari_user_identities")));
  assert.ok(statements.some((sql) => sql.includes("INSERT INTO users")));
});

test("Google login reuses an existing WhatsApp-linked identity", async () => {
  resetGoogleIdentityTableForTests();
  const queryFn = async <T>(sql: string): Promise<{ rows: T[] }> => {
    if (sql.includes("SELECT user_phone FROM ari_user_identities")) return { rows: [] };
    if (sql.includes("SELECT user_phone FROM google_tokens")) return { rows: [{ user_phone: "919876543210" } as T] };
    if (sql.includes("INSERT INTO ari_user_identities")) return { rows: [{ user_phone: "919876543210" } as T] };
    return { rows: [] };
  };
  const userPhone = await resolveGoogleIdentity({ sub: "123", email: "existing@example.com" }, queryFn);
  assert.equal(userPhone, "919876543210");
});
