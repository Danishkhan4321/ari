'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const preferences = require('../src/services/desktop-ai-preferences.service');

test('desktop AI preferences default to Ari with Codex Auto available', () => {
  const file = path.join(os.tmpdir(), `ari-ai-missing-${process.pid}.json`);
  assert.deepEqual(preferences.readPreferences(file), {
    provider: 'ari', model: 'auto', codexConnected: false,
  });
});

test('desktop AI preferences preserve private runtime state while updating a choice', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ari-ai-'));
  const file = path.join(dir, 'preferences.json');
  fs.writeFileSync(file, JSON.stringify({
    provider: 'codex', model: 'auto', codexConnected: true, mcpToken: 'private-token',
  }));

  const result = preferences.writePreferences({ model: 'terra' }, file);
  assert.equal(result.model, 'terra');
  assert.equal(result.provider, 'codex');
  assert.equal(result.mcpToken, 'private-token');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Codex is selected only inside connected desktop mode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ari-ai-mode-'));
  const file = path.join(dir, 'preferences.json');
  fs.writeFileSync(file, JSON.stringify({ provider: 'codex', model: 'auto', codexConnected: true }));
  const previous = process.env.DESKTOP_MODE;
  process.env.DESKTOP_MODE = 'true';
  assert.equal(preferences.shouldUseCodex(file), true);
  process.env.DESKTOP_MODE = 'false';
  assert.equal(preferences.shouldUseCodex(file), false);
  if (previous === undefined) delete process.env.DESKTOP_MODE;
  else process.env.DESKTOP_MODE = previous;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('App Server is reserved for explicitly selected connected Codex mode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ari-ai-shared-'));
  const file = path.join(dir, 'preferences.json');
  const previousDesktop = process.env.DESKTOP_MODE;
  const previousShared = process.env.ARI_SHARED_APP_SERVER;
  process.env.DESKTOP_MODE = 'true';
  delete process.env.ARI_SHARED_APP_SERVER;

  fs.writeFileSync(file, JSON.stringify({ provider: 'ari', model: 'auto', codexConnected: false }));
  assert.equal(preferences.shouldUseSharedAppServer(file), false);
  fs.writeFileSync(file, JSON.stringify({ provider: 'codex', model: 'auto', codexConnected: true }));
  assert.equal(preferences.shouldUseSharedAppServer(file), true);
  fs.writeFileSync(file, JSON.stringify({ provider: 'codex', model: 'auto', codexConnected: false }));
  assert.equal(preferences.shouldUseSharedAppServer(file), false);

  process.env.ARI_SHARED_APP_SERVER = 'false';
  fs.writeFileSync(file, JSON.stringify({ provider: 'ari', model: 'auto', codexConnected: false }));
  assert.equal(preferences.shouldUseSharedAppServer(file), false);

  if (previousDesktop === undefined) delete process.env.DESKTOP_MODE;
  else process.env.DESKTOP_MODE = previousDesktop;
  if (previousShared === undefined) delete process.env.ARI_SHARED_APP_SERVER;
  else process.env.ARI_SHARED_APP_SERVER = previousShared;
  fs.rmSync(dir, { recursive: true, force: true });
});
