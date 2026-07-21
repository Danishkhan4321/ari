'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createDesktopDictationRouter, MAX_RECOVERY_BYTES } = require('../src/routes/desktop-dictation.routes');

async function withServer(t) {
  const app = express();
  app.use('/internal/desktop/dictation', createDesktopDictationRouter({
    token: 'secret',
    assembly: {
      async createStreamingSession() { return { websocketUrl: 'wss://example.test?token=temp', expiresInSeconds: 60, maxSessionSeconds: 600 }; },
      async transcribeRecording(audio) { assert.equal(audio.toString(), 'audio'); return { text: 'raw words', languageCodes: ['en'] }; },
    },
    polisher: { async polish({ rawText, appCategory }) { return { text: `${rawText}:${appCategory}`, polished: true }; } },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}/internal/desktop/dictation`;
}

function headers(extra = {}) {
  return { 'x-ari-desktop-token': 'secret', 'x-ari-user-phone': 'wa_12345', ...extra };
}

test('desktop dictation routes require launch auth and expose bounded session/polish/retry contracts', async (t) => {
  const base = await withServer(t);
  assert.equal((await fetch(`${base}/session`, { method: 'POST' })).status, 401);

  const session = await fetch(`${base}/session`, { method: 'POST', headers: headers() });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).maxSessionSeconds, 600);

  const polish = await fetch(`${base}/polish`, {
    method: 'POST', headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ rawText: 'hello', appCategory: 'chat' }),
  });
  assert.equal((await polish.json()).text, 'hello:chat');

  const retry = await fetch(`${base}/retry`, {
    method: 'POST', headers: headers({ 'content-type': 'audio/webm', 'x-ari-app-category': 'email' }), body: Buffer.from('audio'),
  });
  const recovered = await retry.json();
  assert.equal(recovered.rawText, 'raw words');
  assert.equal(recovered.text, 'raw words:email');

  const oversized = await fetch(`${base}/retry`, {
    method: 'POST',
    headers: headers({ 'content-type': 'audio/webm' }),
    body: Buffer.alloc(MAX_RECOVERY_BYTES + 1),
  });
  assert.equal(oversized.status, 413);
  assert.match((await oversized.json()).error, /exceeds/i);
});
