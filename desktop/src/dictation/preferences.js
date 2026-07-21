'use strict';

const fs = require('node:fs');
const path = require('node:path');

function defaults() {
  return { enabled: true, updatedAt: new Date().toISOString() };
}

function readPreferences(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return { ...defaults(), enabled: parsed.enabled !== false, updatedAt: parsed.updatedAt || defaults().updatedAt };
  } catch (_) {
    return defaults();
  }
}

function writePreferences(filePath, patch = {}) {
  const current = readPreferences(filePath);
  const next = {
    ...current,
    ...(typeof patch.enabled === 'boolean' ? { enabled: patch.enabled } : {}),
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
  return next;
}

module.exports = { defaults, readPreferences, writePreferences };
