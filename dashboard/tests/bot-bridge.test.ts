import test from "node:test";
import assert from "node:assert/strict";
import { sendThroughBot } from "../lib/bot-bridge";
import { readJsonResponse } from "../lib/http";

process.env.INTERNAL_API_SECRET = "test-secret";
process.env.BOT_INTERNAL_URL = "http://127.0.0.1:43100";
const chatRequest = {
  runId: "33333333-3333-4333-8333-333333333333",
  sessionId: "11111111-1111-4111-8111-111111111111",
  clientMessageId: "22222222-2222-4222-8222-222222222222",
};

test("dashboard bridge marks local internal request as HTTPS", async () => {
  let headers: Headers | undefined;
  globalThis.fetch = async (_input, init) => {
    headers = new Headers(init?.headers);
    return Response.json({ ok: true, queued: true });
  };

  const result = await sendThroughBot("919999999999", "hello", [], chatRequest);

  assert.deepEqual(result, { ok: true });
  assert.equal(headers?.get("x-forwarded-proto"), "https");
  assert.equal(headers?.get("x-internal-secret"), "test-secret");
});

test("dashboard bridge never returns upstream HTML or internal details", async () => {
  globalThis.fetch = async () => new Response("<!DOCTYPE html><h1>Moved</h1>", {
    status: 502,
    headers: { "content-type": "text/html" },
  });

  const result = await sendThroughBot("919999999999", "hello", [], chatRequest);

  assert.deepEqual(result, {
    ok: false,
    error: "Ari chat is temporarily unavailable. Please try again shortly.",
  });
  assert.doesNotMatch(JSON.stringify(result), /DOCTYPE|Moved|127\.0\.0\.1|secret/i);
});

test("dashboard bridge maps authentication/configuration failures to a safe message", async () => {
  globalThis.fetch = async () => Response.json({ error: "Bad secret." }, { status: 401 });

  const result = await sendThroughBot("919999999999", "hello", [], chatRequest);

  assert.deepEqual(result, {
    ok: false,
    error: "Ari chat is not configured correctly. Please contact support.",
  });
});

test("dashboard JSON reader rejects an HTML error page without parsing it", async () => {
  const response = new Response("<!DOCTYPE html><title>Not found</title>", {
    status: 404,
    headers: { "content-type": "text/html" },
  });
  assert.equal(await readJsonResponse(response), null);
});
