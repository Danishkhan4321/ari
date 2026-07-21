'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadOrCreateInternalToken, removeInternalToken, tokenPath } = require('../src/internal-token');

test('desktop launch token survives a crash restart and rotates after graceful cleanup', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ari-token-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = loadOrCreateInternalToken(root);
  const recovered = loadOrCreateInternalToken(root);
  assert.match(first.token, /^[a-f0-9]{64}$/);
  assert.equal(recovered.token, first.token);
  assert.equal(recovered.reused, true);
  assert.doesNotMatch(fs.readFileSync(tokenPath(root), 'utf8'), /[^a-f0-9\s]/);
  removeInternalToken(first.filePath);
  const rotated = loadOrCreateInternalToken(root);
  assert.notEqual(rotated.token, first.token);
});
