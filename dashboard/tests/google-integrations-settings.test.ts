import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("settings presents every Google product with a connect-all action", () => {
  const settings = read("app/settings/settings-content.tsx");
  const icons = read("components/google-product-icon.tsx");

  assert.match(settings, /Connect all Google apps/);
  for (const product of ["Gmail", "Google Calendar", "Google Drive", "Google Docs", "Google Sheets", "Google Slides", "Google Tasks"]) {
    assert.match(settings, new RegExp(`name:\\s*"${product}"`), product);
  }
  assert.match(settings, /GoogleProductIcon/);
  assert.match(settings, /\/api\/settings\/google/);
  assert.match(settings, /connectGoogle\("all"\)/);
  assert.match(settings, /connectGoogle\(app\.id\)/);
  assert.match(settings, /window\.open\(result\.url/);
  assert.match(icons, /fonts\.gstatic\.com|www\.gstatic\.com/);
  assert.match(icons, /<img/);
  assert.doesNotMatch(icons, /<svg|<path/);
});

test("dashboard Google settings use the authenticated bot bridge", () => {
  const route = read("app/api/settings/google/route.ts");
  const overview = read("app/api/settings/overview/route.ts");
  assert.match(route, /getCurrentUserPhone/);
  assert.match(route, /callBotInternal/);
  assert.match(route, /dashboard-google-connect/);
  assert.match(route, /product/);
  assert.match(overview, /dashboard-google-status/);
});

test("backend exposes protected dashboard Google status and connect endpoints", () => {
  const routes = readFileSync(new URL("../../src/routes/webhook.routes.js", import.meta.url), "utf8");
  assert.match(routes, /internal\/dashboard-google-status/);
  assert.match(routes, /internal\/dashboard-google-connect/);
  assert.match(routes, /verifyInternalSecret/);
  assert.match(routes, /googleAuthService\.generateAuthUrl/);
});
