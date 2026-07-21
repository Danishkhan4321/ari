'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createMeetingIpcHandlers } = require('../src/meeting-capture/ipc');

function fixture() {
  const sessions = new Map();
  const manager = {
    async prepare(meta) { const value = { id: 'session-12345678901234567890', state: 'prepared', bytes: 0, ...meta, recordingPath: 'private' }; sessions.set(value.id, value); return value; },
    async start(id) { const value = { ...sessions.get(id), state: 'recording' }; sessions.set(id, value); return value; },
    async writeChunk(id, chunk) { const value = { ...sessions.get(id), bytes: chunk.length }; sessions.set(id, value); return value; },
    async pause(id) { return { ...sessions.get(id), state: 'paused' }; },
    async resume(id) { return { ...sessions.get(id), state: 'recording' }; },
    async stop(id) { return { ...sessions.get(id), state: 'finalized' }; },
    async markUploading(id) { return { ...sessions.get(id), state: 'uploading' }; },
    async markSubmitted(id, result) { return { ...sessions.get(id), state: 'submitted', ...result }; },
    async markFailed() {}, async cancel(id) { return { ...sessions.get(id), state: 'cancelled' }; },
  };
  const backend = { async upload(_session, { onProgress }) { onProgress({ ratio: 1 }); return { meetingId: 7, processingStage: 'captured' }; } };
  const handlers = createMeetingIpcHandlers({ sessionManager: manager, backendClient: backend, fromLocalDashboard: (event) => event.local, platform: 'win32' });
  return { handlers };
}

test('meeting IPC rejects nonlocal callers and chunks for another window', async () => {
  const { handlers } = fixture();
  const outside = { local: false, sender: { id: 1, send() {} } };
  await assert.rejects(handlers.prepare(outside), /outside Ari/);
  const owner = { local: true, sender: { id: 1, send() {} } };
  const other = { local: true, sender: { id: 2, send() {} } };
  const session = await handlers.prepare(owner, { title: 'Review' });
  await handlers.start(owner, session.id);
  await assert.rejects(handlers.writeChunk(other, session.id, Buffer.from('audio')), /does not belong/);
  const result = await handlers.stop(owner, session.id);
  assert.equal(result.meetingId, 7);
});

test('preload exposes only the bounded meeting surface and no token', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  for (const name of ['capabilities', 'prepare', 'start', 'writeChunk', 'pause', 'resume', 'stop', 'cancel', 'onProgress']) {
    assert.match(source, new RegExp(`${name}:`));
  }
  assert.doesNotMatch(source, /ARI_DESKTOP_INTERNAL_TOKEN|desktopInternalToken/i);
});

test('preload exposes bounded voice input start and stop controls', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  assert.match(source, /start:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('desktop:dictation:start'\)/);
  assert.match(source, /stop:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('desktop:dictation:stop'\)/);
  assert.doesNotMatch(source, /dictationBackend|internalToken/i);
});
