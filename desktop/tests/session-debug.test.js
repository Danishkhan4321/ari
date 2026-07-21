const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { resolveSessionLogPath, ensureSessionLogPath } = require('../src/session-debug');

const sessionId = '11111111-1111-4111-8111-111111111111';

test('session debug resolves and creates only UUID-named JSONL logs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ari-session-debug-'));
  const expected = path.join(root, `${sessionId}.jsonl`);
  assert.equal(resolveSessionLogPath(root, sessionId), expected);
  assert.equal(ensureSessionLogPath(root, sessionId), expected);
  assert.equal(fs.existsSync(expected), true);
  assert.equal(resolveSessionLogPath(root, '../escape'), null);
});
