'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.LOG_TO_FILES = 'false';
process.env.LOG_LEVEL = 'silent';

const { FileService } = require('../src/services/file.service');
const { createLocalFileStorage } = require('../src/services/local-file-storage.service');

async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ari-file-service-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function createQueryRecorder({ failInsert = false } = {}) {
  const calls = [];
  const queryFn = async (sql, params = []) => {
    calls.push({ sql, params });
    if (/INSERT\s+INTO\s+user_files/i.test(sql)) {
      if (failInsert) throw new Error('database unavailable');
      return { rows: [{ id: 73 }] };
    }
    return { rows: [] };
  };
  return { calls, queryFn };
}

test('FileService persists a stable user_file artifact locally when object storage is absent', async (t) => {
  const root = await temporaryRoot(t);
  const storage = createLocalFileStorage({ root });
  const queries = createQueryRecorder();
  const service = new FileService({
    queryFn: queries.queryFn,
    supabase: null,
    localFileStorage: storage,
  });
  const bytes = Buffer.from('quarterly customer export');

  const result = await service.saveUploadedBuffer(
    '919000000001', bytes, 'text/csv', 'customers.csv', 'customer export',
  );

  assert.equal(result.success, true);
  assert.equal(result.artifactId, 'user_file:73');
  const inserted = queries.calls.find(({ sql }) => /INSERT\s+INTO\s+user_files/i.test(sql));
  assert.ok(inserted);
  assert.equal(inserted.params[1], 'ari-local://stored');
  assert.equal(inserted.params[12], bytes.length);
  assert.equal(inserted.params[13], crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal((await fs.readFile(inserted.params[11])).toString(), bytes.toString());
  assert.match(path.relative(root, inserted.params[11]), /^user-files[\\/]/);
});

test('FileService removes a local fallback if the database write fails', async (t) => {
  const root = await temporaryRoot(t);
  const service = new FileService({
    queryFn: createQueryRecorder({ failInsert: true }).queryFn,
    supabase: null,
    localFileStorage: createLocalFileStorage({ root }),
  });

  const result = await service.saveUploadedBuffer(
    '919000000001', Buffer.from('temporary'), 'text/plain', 'note.txt', 'note',
  );

  assert.equal(result.success, false);
  const tenantRoot = path.join(root, 'user-files');
  const entries = await fs.readdir(tenantRoot, { recursive: true }).catch(() => []);
  assert.equal(entries.filter((entry) => /\.[a-z0-9]+$/i.test(String(entry))).length, 0);
});

test('FileService falls back locally when the object-storage SDK throws', async (t) => {
  const root = await temporaryRoot(t);
  const queries = createQueryRecorder();
  const supabase = {
    storage: {
      from() {
        return {
          upload: async () => { throw new Error('storage offline'); },
          getPublicUrl: () => ({ data: {} }),
        };
      },
    },
  };
  const service = new FileService({
    queryFn: queries.queryFn,
    supabase,
    localFileStorage: createLocalFileStorage({ root }),
  });

  const result = await service.saveUploadedBuffer(
    '919000000001', Buffer.from('durable'), 'text/plain', 'note.txt', 'note',
  );

  assert.equal(result.success, true);
  const inserted = queries.calls.find(({ sql }) => /INSERT\s+INTO\s+user_files/i.test(sql));
  assert.equal(inserted.params[1], 'ari-local://stored');
  assert.ok(inserted.params[11]);
});
