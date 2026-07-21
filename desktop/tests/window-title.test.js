const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('keeps the native title bar free of dashboard copy', () => {
  const source = readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.match(source, /title:\s*' '/);
  assert.match(source, /page-title-updated/);
  assert.match(source, /win\.setTitle\(' '\)/);
  assert.match(source, /titleBarStyle:\s*process\.platform === 'darwin' \? 'hiddenInset' : 'hidden'/);
  assert.match(source, /titleBarOverlay/);
});
