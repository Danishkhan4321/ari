'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CodexRuntime, publicPreferences, targetTriple } = require('../src/codex-runtime');

test('Codex runtime supports Windows and macOS Intel and Apple Silicon targets', () => {
  assert.deepEqual(targetTriple('win32', 'x64').slice(1), ['x86_64-pc-windows-msvc', 'codex.exe']);
  assert.deepEqual(targetTriple('darwin', 'arm64').slice(1), ['aarch64-apple-darwin', 'codex']);
  assert.equal(targetTriple('linux', 'x64'), null);
});

test('desktop preference responses never expose the local MCP token', () => {
  const visible = publicPreferences({ provider: 'codex', model: 'auto', codexConnected: true, mcpToken: 'secret' });
  assert.deepEqual(visible, { provider: 'codex', model: 'auto', codexConnected: true });
  assert.equal('mcpToken' in visible, false);
});

test('Codex runtime defaults to Ari AI and Auto model mode', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ari-codex-runtime-'));
  const runtime = new CodexRuntime({ repoRoot: path.resolve(__dirname, '..', '..'), userDataPath });
  assert.equal(runtime.preferences().provider, 'ari');
  assert.equal(runtime.preferences().model, 'auto');
  assert.equal(runtime.preferences().codexConnected, false);
  runtime.updatePreferences({ model: 'sol' });
  assert.equal(runtime.preferences().model, 'sol');
  fs.rmSync(userDataPath, { recursive: true, force: true });
});
