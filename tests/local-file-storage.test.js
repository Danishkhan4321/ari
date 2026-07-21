'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createLocalFileStorage } = require('../src/services/local-file-storage.service');

async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ari-local-files-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('local fallback stores and reloads an owned file with size and SHA-256 integrity', async (t) => {
  const root = await temporaryRoot(t);
  const storage = createLocalFileStorage({ root });
  const bytes = Buffer.from('persistent WhatsApp document');

  const stored = await storage.store({
    userPhone: '919000000001', buffer: bytes, fileName: 'report.pdf',
  });
  const loaded = await storage.read(stored.localPath, stored);

  assert.equal(loaded.buffer.toString(), bytes.toString());
  assert.equal(stored.sizeBytes, bytes.length);
  assert.equal(stored.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.match(path.relative(root, stored.localPath), /^user-files[\\/]/);
});

test('local fallback rejects outside paths, symlinks, and integrity mismatches', async (t) => {
  const root = await temporaryRoot(t);
  const storage = createLocalFileStorage({ root });
  const outside = path.join(path.dirname(root), `outside-${crypto.randomUUID()}.txt`);
  await fs.writeFile(outside, 'secret');
  t.after(() => fs.rm(outside, { force: true }));

  await assert.rejects(() => storage.read(outside), (error) => error?.code === 'local_file_outside_root');

  const stored = await storage.store({ userPhone: '919000000001', buffer: Buffer.from('owned'), fileName: 'a.txt' });
  await assert.rejects(
    () => storage.read(stored.localPath, { ...stored, sizeBytes: stored.sizeBytes + 1 }),
    (error) => error?.code === 'local_file_integrity_mismatch',
  );
  await assert.rejects(
    () => storage.read(stored.localPath, { ...stored, sha256: '0'.repeat(64) }),
    (error) => error?.code === 'local_file_integrity_mismatch',
  );

  const link = path.join(root, 'linked.txt');
  try {
    await fs.symlink(stored.localPath, link);
    await assert.rejects(() => storage.read(link), (error) => error?.code === 'local_file_outside_root');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) throw error;
  }
});

test('local fallback requires an explicit shared root and enforces its byte limit', async () => {
  const unconfigured = createLocalFileStorage({ root: null });
  await assert.rejects(
    () => unconfigured.store({ userPhone: '919000000001', buffer: Buffer.from('x'), fileName: 'x.txt' }),
    (error) => error?.code === 'local_file_root_not_configured',
  );

  const bounded = createLocalFileStorage({ root: 'unused', maxBytes: 2 });
  await assert.rejects(
    () => bounded.store({ userPhone: '919000000001', buffer: Buffer.from('large'), fileName: 'x.txt' }),
    (error) => error?.code === 'local_file_too_large',
  );
});
