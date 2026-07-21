const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('dev-only session context menu copies the isolated JSONL path', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  const recentChats = fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard', 'components', 'recent-chats.tsx'), 'utf8');

  assert.match(main, /app\.isPackaged \|\| !fromLocalDashboard/);
  assert.match(main, /label: 'Copy session log path'/);
  assert.match(main, /clipboard\.writeText\(sessionLogPath\)/);
  assert.match(preload, /process\.argv\.includes\('--ari-session-debug'\)/);
  assert.match(preload, /desktop:debug:session-menu/);
  assert.match(recentChats, /onContextMenu/);
  assert.match(recentChats, /showSessionContextMenu/);
});
