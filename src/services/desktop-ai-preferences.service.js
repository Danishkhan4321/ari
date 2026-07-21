'use strict';

const fs = require('node:fs');
const path = require('node:path');

const VALID_PROVIDERS = new Set(['ari', 'codex']);
const VALID_MODELS = new Set(['auto', 'sol', 'terra', 'luna']);

function defaults() {
  return {
    provider: 'ari',
    model: 'auto',
    codexConnected: false,
  };
}

function preferencePath() {
  return process.env.ARI_DESKTOP_AI_CONFIG || '';
}

function readPreferences(filePath = preferencePath()) {
  if (!filePath) return defaults();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      ...defaults(),
      ...parsed,
      provider: VALID_PROVIDERS.has(parsed.provider) ? parsed.provider : 'ari',
      model: VALID_MODELS.has(parsed.model) ? parsed.model : 'auto',
      codexConnected: parsed.codexConnected === true,
    };
  } catch {
    return defaults();
  }
}

function writePreferences(patch, filePath = preferencePath()) {
  if (!filePath) return readPreferences(filePath);
  const current = readPreferences(filePath);
  const next = {
    ...current,
    ...(patch && typeof patch === 'object' ? patch : {}),
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.backend.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
  return readPreferences(filePath);
}

function shouldUseCodex(filePath = preferencePath()) {
  if (process.env.DESKTOP_MODE !== 'true') return false;
  const preferences = readPreferences(filePath);
  return preferences.provider === 'codex' && preferences.codexConnected;
}

function shouldUseSharedAppServer(filePath = preferencePath()) {
  if (process.env.DESKTOP_MODE !== 'true') return false;
  if (process.env.ARI_SHARED_APP_SERVER === 'false') return false;
  const preferences = readPreferences(filePath);
  // The App Server is Codex's runtime. Ari uses Agno over OpenRouter (with the
  // direct SDK fallback) and must not be tunneled through a local loopback.
  return preferences.provider === 'codex' && preferences.codexConnected;
}

module.exports = {
  defaults,
  preferencePath,
  readPreferences,
  shouldUseCodex,
  shouldUseSharedAppServer,
  writePreferences,
};
