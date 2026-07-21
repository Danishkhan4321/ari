const fs = require('node:fs');
const path = require('node:path');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function resolveSessionLogPath(root, sessionId) {
  if (!UUID_PATTERN.test(String(sessionId || ''))) return null;
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, `${sessionId}.jsonl`);
  if (path.dirname(resolvedPath) !== resolvedRoot) return null;
  return resolvedPath;
}

function ensureSessionLogPath(root, sessionId) {
  const logPath = resolveSessionLogPath(root, sessionId);
  if (!logPath) return null;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.closeSync(fs.openSync(logPath, 'a'));
  return logPath;
}

module.exports = { UUID_PATTERN, resolveSessionLogPath, ensureSessionLogPath };
