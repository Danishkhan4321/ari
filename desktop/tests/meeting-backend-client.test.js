'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');
const { createBackendClient } = require('../src/meeting-capture/backend-client');

test('backend upload streams bytes with private headers and progress', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ari-upload-test-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const recordingPath = path.join(root, 'capture.webm');
  await fs.promises.writeFile(recordingPath, 'recording');
  let requestOptions;
  let uploaded = '';
  const requestImpl = (_url, options, callback) => {
    requestOptions = options;
    const req = new Writable({ write(chunk, _encoding, done) { uploaded += chunk.toString(); done(); } });
    req.once('finish', () => {
      const response = new EventEmitter();
      response.statusCode = 202;
      response.setEncoding = () => {};
      callback(response);
      response.emit('data', JSON.stringify({ ok: true, meetingId: 8, processingStage: 'captured' }));
      response.emit('end');
    });
    return req;
  };
  const progress = [];
  const client = createBackendClient({
    backendUrl: 'http://127.0.0.1:43100', internalToken: 'private-token', userPhone: 'wa_12345', requestImpl,
  });
  const result = await client.upload({
    id: 'capture-session-123', title: 'Review', platform: 'win32', codec: 'webm-opus', recordingPath,
  }, { onProgress: (event) => progress.push(event) });
  assert.equal(result.meetingId, 8);
  assert.equal(uploaded, 'recording');
  assert.equal(requestOptions.headers['x-ari-desktop-token'], 'private-token');
  assert.equal(requestOptions.headers['content-length'], '9');
  assert.equal(progress.at(-1).ratio, 1);
});

test('backend client rejects non-loopback endpoints', () => {
  assert.throws(() => createBackendClient({
    backendUrl: 'https://example.com', internalToken: 'x', userPhone: 'wa_1',
  }), /loopback/);
});
