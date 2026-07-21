import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("login uses one polished Composio path without WhatsApp commands", () => {
  const page = read("app/login/page.tsx");
  const button = read("app/login/google-sign-in-button.tsx");

  assert.match(page, /Continue with Composio/);
  assert.match(button, /Continue with Composio/);
  assert.match(page + button, /Composio manages Google/);
  assert.doesNotMatch(page + button, /open dashboard|magic link|Copy command|Open WhatsApp/i);
  assert.doesNotMatch(page + button, /card-brutal|shadow-brutal|border-2 border-black/);
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
