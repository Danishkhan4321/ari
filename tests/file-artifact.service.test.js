'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.LOG_TO_FILES = 'false';
process.env.LOG_LEVEL = 'silent';

const { createFileArtifactService } = require('../src/services/file-artifact.service');
const { runWithChatSession } = require('../src/services/chat-session-context');

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const MESSAGE_ID = '22222222-2222-4222-8222-222222222222';
const FIRST_ID = '33333333-3333-4333-8333-333333333333';
const SECOND_ID = '44444444-4444-4444-8444-444444444444';

async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ari-artifact-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('current-turn Agno files use stable IDs and root-confined owned paths', async () => {
  const root = 'C:\\ari-attachments';
  const queries = [];
  const service = createFileArtifactService({
    localFileRoot: root,
    queryFn: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [
        { id: FIRST_ID, file_name: 'first.pdf', mime_type: 'application/pdf', local_path: `${root}\\session\\first.pdf`, size_bytes: 12 },
        { id: SECOND_ID, file_name: 'second.csv', mime_type: 'text/csv', local_path: `${root}\\session\\second.csv`, size_bytes: 15 },
      ] };
    },
    realpathFn: async (value) => value,
    lstatFn: async () => ({ isSymbolicLink: () => false }),
    statFn: async (value) => ({ isFile: () => true, size: value.endsWith('first.pdf') ? 12 : 15 }),
  });

  const files = await runWithChatSession({
    sessionId: SESSION_ID,
    clientMessageId: MESSAGE_ID,
  }, () => service.toAgentFilesForCurrentTurn('919000000001'));

  assert.deepEqual(files, [
    { artifact_id: `session:${FIRST_ID}`, path: `${root}\\session\\first.pdf`, name: 'first.pdf', mime_type: 'application/pdf', size: 12 },
    { artifact_id: `session:${SECOND_ID}`, path: `${root}\\session\\second.csv`, name: 'second.csv', mime_type: 'text/csv', size: 15 },
  ]);
  assert.match(queries[0].sql, /user_phone = \$1[\s\S]*session_id = \$2[\s\S]*client_message_id = \$3/);
  assert.deepEqual(queries[0].params, ['919000000001', SESSION_ID, MESSAGE_ID]);
});

test('agent file descriptors reject a database path outside the configured root', async () => {
  const service = createFileArtifactService({
    localFileRoot: 'C:\\safe-root',
    queryFn: async () => ({ rows: [{
      id: FIRST_ID,
      file_name: 'outside.pdf',
      mime_type: 'application/pdf',
      local_path: 'C:\\outside\\outside.pdf',
      size_bytes: 10,
    }] }),
    realpathFn: async (value) => value,
    lstatFn: async () => ({ isSymbolicLink: () => false }),
    statFn: async () => ({ isFile: () => true, size: 10 }),
  });

  await assert.rejects(
    () => runWithChatSession({ sessionId: SESSION_ID, clientMessageId: MESSAGE_ID },
      () => service.toAgentFilesForCurrentTurn('919000000001')),
    (error) => error?.code === 'artifact_path_outside_root',
  );
});

test('owned artifact resolution preserves requested order across session and legacy artifacts', async () => {
  const root = 'C:\\safe-root';
  const service = createFileArtifactService({
    localFileRoot: root,
    queryFn: async (sql, params) => {
      if (/FROM ari_chat_attachments/.test(sql)) {
        return params[2] === FIRST_ID ? { rows: [{
          id: FIRST_ID, file_name: 'local.pdf', mime_type: 'application/pdf',
          local_path: `${root}\\session\\local.pdf`, size_bytes: 11,
        }] } : { rows: [] };
      }
      if (/FROM user_files/.test(sql)) {
        return params[1] === 42 ? { rows: [{
          id: 42, file_name: 'legacy.csv', mime_type: 'text/csv',
          file_url: 'https://files.example.test/legacy.csv', created_at: '2026-07-17T12:00:00Z',
        }] } : { rows: [] };
      }
      throw new Error('unexpected query');
    },
    realpathFn: async (value) => value,
    lstatFn: async () => ({ isSymbolicLink: () => false }),
    statFn: async () => ({ isFile: () => true, size: 11 }),
    readFileFn: async () => Buffer.from('local bytes'),
    httpGet: async () => ({ data: Buffer.from('remote bytes') }),
  });

  const loaded = await runWithChatSession({ sessionId: SESSION_ID, clientMessageId: MESSAGE_ID },
    () => service.loadOwnedArtifacts('919000000001', [
      'user_file:42',
      `session:${FIRST_ID}`,
    ]));

  assert.deepEqual(loaded.map((item) => item.artifactId), [
    'user_file:42',
    `session:${FIRST_ID}`,
  ]);
  assert.deepEqual(loaded.map((item) => item.buffer.toString()), ['remote bytes', 'local bytes']);
});

test('foreign, unknown, and raw-path IDs fail identically without reading storage', async () => {
  let reads = 0;
  const service = createFileArtifactService({
    localFileRoot: 'C:\\safe-root',
    queryFn: async () => ({ rows: [] }),
    readFileFn: async () => { reads += 1; return Buffer.from('no'); },
    httpGet: async () => { reads += 1; return { data: Buffer.from('no') }; },
  });

  for (const artifactId of [`session:${FIRST_ID}`, 'user_file:99', 'C:\\secret.txt']) {
    await assert.rejects(
      () => runWithChatSession({ sessionId: SESSION_ID, clientMessageId: MESSAGE_ID },
        () => service.loadOwnedArtifact('919000000001', artifactId)),
      (error) => error?.code === 'artifact_not_found' && error.message === 'The requested artifact is unavailable.',
    );
  }
  assert.equal(reads, 0);
});

test('persistent user_file artifacts load from the confined local path with integrity checks', async (t) => {
  const root = await temporaryRoot(t);
  const localPath = path.join(root, 'owned.csv');
  const bytes = Buffer.from('name,email\nA,a@example.test');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(localPath, bytes);
  const service = createFileArtifactService({
    localFileRoot: root,
    queryFn: async () => ({ rows: [{
      id: 42,
      file_name: 'owned.csv',
      mime_type: 'text/csv',
      file_url: 'ari-local://stored',
      local_path: localPath,
      size_bytes: bytes.length,
      content_sha256: digest,
    }] }),
  });

  const loaded = await service.loadOwnedArtifact('919000000001', 'user_file:42');
  assert.equal(loaded.artifactId, 'user_file:42');
  assert.equal(loaded.buffer.toString(), bytes.toString());

  const changed = Buffer.from('tampered');
  await fs.writeFile(localPath, changed);
  await assert.rejects(
    () => service.loadOwnedArtifact('919000000001', 'user_file:42'),
    (error) => error?.code === 'artifact_integrity_mismatch',
  );
});

test('legacy buffer:local pointers fail honestly without attempting a download', async () => {
  let downloads = 0;
  const service = createFileArtifactService({
    localFileRoot: 'C:\\safe-root',
    queryFn: async () => ({ rows: [{
      id: 42,
      file_name: 'lost.pdf',
      mime_type: 'application/pdf',
      file_url: 'buffer:local',
      local_path: null,
    }] }),
    httpGet: async () => { downloads += 1; return { data: Buffer.from('no') }; },
  });

  await assert.rejects(
    () => service.loadOwnedArtifact('919000000001', 'user_file:42'),
    (error) => error?.code === 'artifact_unavailable',
  );
  assert.equal(downloads, 0);
});
