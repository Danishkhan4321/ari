'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createDesktopInternalAuth, isLoopbackAddress } = require('../src/utils/desktop-internal-auth');
const { createByteLimitTransform, createDesktopMeetingsRouter } = require('../src/routes/desktop-meetings.routes');

function invokeAuth({ remoteAddress, token = 'secret', actualToken = 'secret', phone = 'wa_12345' }) {
  let status = 200;
  let nextCalled = false;
  const req = {
    socket: { remoteAddress },
    headers: { 'x-ari-desktop-token': actualToken, 'x-ari-user-phone': phone },
    get(name) { return this.headers[name.toLowerCase()]; },
  };
  const res = { status(code) { status = code; return this; }, json() { return this; } };
  createDesktopInternalAuth({ token })(req, res, () => { nextCalled = true; });
  return { status, nextCalled, req };
}

test('desktop meeting auth requires loopback, launch token, and user identity', () => {
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(invokeAuth({ remoteAddress: '203.0.113.2' }).status, 403);
  assert.equal(invokeAuth({ remoteAddress: '127.0.0.1', actualToken: 'wrong!' }).status, 401);
  assert.equal(invokeAuth({ remoteAddress: '127.0.0.1', phone: '' }).status, 400);
  const allowed = invokeAuth({ remoteAddress: '127.0.0.1' });
  assert.equal(allowed.nextCalled, true);
  assert.equal(allowed.req.ariUserPhone, 'wa_12345');
});

test('desktop meeting auth canonicalizes numeric phones without changing platform identities', () => {
  const numeric = invokeAuth({ remoteAddress: '127.0.0.1', phone: '+919876543210' });
  assert.equal(numeric.nextCalled, true);
  assert.equal(numeric.req.ariUserPhone, '919876543210');

  const platform = invokeAuth({ remoteAddress: '127.0.0.1', phone: 'wa_12345' });
  assert.equal(platform.nextCalled, true);
  assert.equal(platform.req.ariUserPhone, 'wa_12345');
});

test('observed upload size is bounded without content-length', async () => {
  const limiter = createByteLimitTransform(4);
  let error;
  limiter.on('error', (value) => { error = value; });
  limiter.write(Buffer.from('1234'));
  limiter.write(Buffer.from('5'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(error.code, 'UPLOAD_TOO_LARGE');
});

async function withServer(t, repo, processor, storage = { signRead: async () => '' }) {
  const app = express();
  app.use('/internal/desktop/meetings', createDesktopMeetingsRouter({
    token: 'secret', repo, processor, storage, maxBytes: 1024, logger: { error() {} },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}/internal/desktop/meetings`;
}

test('streamed upload creates one owned meeting and starts processing', async (t) => {
  const calls = [];
  const repo = {
    async createFromCapture(input) { calls.push(['create', input]); return { id: 7, processing_stage: 'captured' }; },
    async getOwned() { return null; },
    async renameSpeaker() { return null; },
  };
  const processor = { async process(input) { calls.push(['process', input]); }, async retry() {} };
  const base = await withServer(t, repo, processor);
  const response = await fetch(base, {
    method: 'POST',
    headers: {
      'content-type': 'audio/webm', 'x-ari-desktop-token': 'secret',
      'x-ari-user-phone': 'wa_12345', 'x-ari-capture-session': 'capture-session-123',
      'x-ari-meeting-title': 'Weekly review', 'x-ari-capture-platform': 'win32',
      'x-ari-capture-codec': 'opus',
    },
    body: Buffer.from('audio'),
  });
  const payload = await response.json();
  assert.equal(response.status, 202);
  assert.equal(payload.meetingId, 7);
  assert.equal(calls[0][1].userPhone, 'wa_12345');
  assert.equal(calls[1][1].meetingId, 7);
});

test('production upload is accepted only after the retained object is verified', async (t) => {
  const calls = [];
  const repo = {
    async createFromCapture() { return { id: 8, processing_stage: 'captured' }; },
    async getOwned() { return null; },
    async renameSpeaker() { return null; },
  };
  const processor = {
    async ingest(input) { calls.push(['ingest', input]); return { id: 8, processing_stage: 'transcribing' }; },
    async resume(input) { calls.push(['resume', input]); },
    async retry() {},
  };
  const base = await withServer(t, repo, processor);
  const response = await fetch(base, {
    method: 'POST',
    headers: {
      'content-type': 'audio/webm', 'x-ari-desktop-token': 'secret',
      'x-ari-user-phone': 'wa_12345', 'x-ari-capture-session': 'capture-session-456',
    },
    body: Buffer.from('audio'),
  });
  const payload = await response.json();
  assert.equal(response.status, 202);
  assert.equal(payload.processingStage, 'transcribing');
  assert.deepEqual(calls.map(([name]) => name), ['ingest', 'resume']);
});

test('rename and playback cannot read across owners', async (t) => {
  const repo = {
    async createFromCapture() { return { id: 1 }; },
    async getOwned() { return null; },
    async renameSpeaker() { throw Object.assign(new Error('missing'), { code: 'MEETING_NOT_FOUND' }); },
  };
  const base = await withServer(t, repo, { async process() {}, async retry() {} }, { signRead: async () => 'should-not-run' });
  const headers = { 'x-ari-desktop-token': 'secret', 'x-ari-user-phone': 'wa_12345' };
  const rename = await fetch(`${base}/9/speakers/A`, {
    method: 'PATCH', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Danish' }),
  });
  const playback = await fetch(`${base}/9/recording`, { headers });
  assert.equal(rename.status, 404);
  assert.equal(playback.status, 404);
});
