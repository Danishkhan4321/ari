'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionManager } = require('../src/meeting-capture/session-manager');

async function tempCaptureRoot(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ari-session-test-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  return root;
}

test('finalize is idempotent and preserves a recoverable manifest', async (t) => {
  const root = await tempCaptureRoot(t);
  const manager = createSessionManager({ root, minFreeBytes: 1, freeBytes: async () => 1_000_000 });
  const session = await manager.prepare({ platform: 'win32', codec: 'webm-opus' });
  assert.match(session.recordingPath, /\.webm$/);
  await manager.start(session.id);
  await manager.writeChunk(session.id, Buffer.from('audio'));
  const first = await manager.stop(session.id);
  const second = await manager.stop(session.id);
  assert.deepEqual(second, first);
  assert.equal(first.bytes, 5);
  assert.equal((await manager.recover())[0].state, 'finalized');
});

test('pause serializes writes and cancel removes only the recording', async (t) => {
  const root = await tempCaptureRoot(t);
  const manager = createSessionManager({ root, minFreeBytes: 1, maxChunkBytes: 10, freeBytes: async () => 1_000_000 });
  const session = await manager.prepare({ platform: 'darwin', codec: 'caf-pcm' });
  assert.match(session.recordingPath, /\.caf$/);
  await manager.start(session.id);
  await manager.pause(session.id);
  await assert.rejects(manager.writeChunk(session.id, Buffer.from('x')), /paused/);
  await manager.resume(session.id);
  await manager.writeChunk(session.id, Buffer.from('pcm'));
  const cancelled = await manager.cancel(session.id);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(fs.existsSync(session.recordingPath), false);
  assert.equal((await manager.recover()).length, 0);
});

test('prepare refuses low disk and chunks are bounded', async (t) => {
  const root = await tempCaptureRoot(t);
  const lowDisk = createSessionManager({ root, minFreeBytes: 100, freeBytes: async () => 99 });
  await assert.rejects(lowDisk.prepare({ platform: 'win32', codec: 'opus' }), /free disk space/);
  const bounded = createSessionManager({ root, minFreeBytes: 1, maxChunkBytes: 2, freeBytes: async () => 1000 });
  const session = await bounded.prepare({ platform: 'win32', codec: 'opus' });
  await bounded.start(session.id);
  await assert.rejects(bounded.writeChunk(session.id, Buffer.from('abc')), /chunk size/);
});

test('a failed upload keeps finalized audio available for retry', async (t) => {
  const root = await tempCaptureRoot(t);
  const manager = createSessionManager({ root, minFreeBytes: 1, freeBytes: async () => 1_000_000 });
  const session = await manager.prepare({ platform: 'win32', codec: 'webm-opus' });
  await manager.start(session.id);
  await manager.writeChunk(session.id, Buffer.from('audio'));
  await manager.stop(session.id);
  await manager.markUploading(session.id);
  await manager.markFailed(session.id, 'network failed');
  assert.equal((await manager.stop(session.id)).state, 'failed');
  assert.equal((await manager.markUploading(session.id)).state, 'uploading');
  assert.equal(fs.existsSync(session.recordingPath), true);
});
