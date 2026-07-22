import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("login uses Ari-owned email sign-in without WhatsApp commands", () => {
  const page = read("app/login/page.tsx");
  const form = read("app/login/email-sign-in-form.tsx");

  assert.match(page, /Use your email to open Ari immediately/);
  assert.match(form, /Continue to Ari/);
  assert.match(form, /\/api\/auth\/email/);
  assert.doesNotMatch(page + form, /api\/auth\/google\/start|open dashboard|magic link|Copy command|Open WhatsApp/i);
  assert.doesNotMatch(page + form, /card-brutal|shadow-brutal|border-2 border-black/);
});

test("legacy magic-link entry returns users to the shared sign-in", () => {
  const page = read("app/auth/page.tsx");
  assert.match(page, /redirect\("\/login"\)/);
  assert.doesNotMatch(page, /api\/auth\/claim|link_codes/);
});

test("verified Google login continues through Composio before workspace entry", () => {
  const callback = read("app/api/auth/google/callback/route.ts");
  const connect = read("app/auth/connect/composio-connect-client.tsx");
  assert.match(callback, /\/auth\/connect/);
  assert.match(connect, /product: "all"/);
  assert.match(connect, /destination: desktop \? "desktop" : "dashboard"/);
});
