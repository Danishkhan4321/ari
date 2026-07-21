'use strict';

/**
 * ensure-mem0-peer-stubs.js — postinstall hook.
 *
 * Why this exists
 * ---------------
 * mem0ai's bundled OSS build (node_modules/mem0ai/dist/oss/index.js) EAGERLY
 * requires every provider SDK it supports (ollama, redis, groq-sdk, azure,
 * qdrant, better-sqlite3, ...) at module load, but declares them only as
 * peerDependencies. Our CI installs with --legacy-peer-deps (forced by
 * mem0ai pinning @anthropic-ai/sdk@^0.40 while the bot needs ^0.91), which
 * SKIPS peer auto-install — so `require('mem0ai/oss')` crashed with
 * "Cannot find module 'ollama'" and the whole Mem0 semantic-memory layer
 * silently died in production (every add/search fell back to legacy paths).
 *
 * The fix
 * -------
 * Providers we actually use are real dependencies of this project already
 * (openai, pg) or installed explicitly (natural, compromise, @langchain/core,
 * ollama — the ones mem0 can touch at runtime in our openai+pgvector config).
 * The remaining provider SDKs are never instantiated with our config, so we
 * write tiny throw-on-use stubs into node_modules for any that are missing —
 * enough for mem0ai's eager top-level requires to resolve. If someone later
 * configures mem0 with one of these providers, the stub throws a clear
 * "install the real package" error instead of failing mysteriously.
 *
 * Idempotent: real installations are never touched; stubs are re-created
 * only when the module cannot be resolved at all.
 */

const fs = require('fs');
const path = require('path');

// Provider SDKs mem0ai@3.x eagerly requires but never uses with our config
// (embedder/llm: openai-shape → Gemini; vectorStore: pgvector; history: off).
const STUB_MODULES = [
  'better-sqlite3',          // history store — we set disableHistory: true
  'redis',                   // redis vector store — unused
  'groq-sdk',                // groq LLM provider — unused
  'cloudflare',              // cloudflare vectorize — unused
  '@qdrant/js-client-rest',  // qdrant vector store — unused
  '@mistralai/mistralai',    // mistral LLM provider — unused
  '@google/genai',           // google-native provider — we use Gemini via the openai-compat shape
  '@azure/identity',         // azure search — unused
  '@azure/search-documents', // azure search — unused
];

// mem0ai requires subpaths of some packages; the stub must resolve those too.
const SUBPATHS = {
  '@langchain/core': ['documents', 'messages'], // real dep now, listed for completeness
};

const projectRoot = path.join(__dirname, '..');
const nodeModules = path.join(projectRoot, 'node_modules');

function isResolvable(name) {
  try {
    require.resolve(name, { paths: [projectRoot] });
    return true;
  } catch (_) {
    return false;
  }
}

function stubSource(name) {
  return `'use strict';
// STUB installed by scripts/ensure-mem0-peer-stubs.js — see that file for why.
// This satisfies mem0ai's eager top-level require. Any actual USE throws.
const NAME = ${JSON.stringify(name)};
function fail() {
  throw new Error(
    NAME + ' is a stub module (mem0ai peer dep, unused with this project\\'s ' +
    'mem0 config). To use this mem0 provider, install the real package: ' +
    'npm install ' + NAME + ' --legacy-peer-deps'
  );
}
function throwingExport() {
  return new Proxy(function StubExport() { fail(); }, {
    get(_t, prop) {
      if (prop === '__esModule') return false;
      if (prop === Symbol.toPrimitive || prop === 'toString') return () => '[stub ' + NAME + ']';
      if (prop === 'prototype') return {};
      return throwingExport();
    },
    construct() { fail(); },
    apply() { fail(); },
  });
}
module.exports = new Proxy({}, {
  get(_t, prop) {
    if (prop === '__esModule') return false;
    if (prop === Symbol.toPrimitive || prop === 'toString') return () => '[stub ' + NAME + ']';
    if (prop === 'default') return module.exports;
    return throwingExport();
  },
});
`;
}

let created = 0;
for (const name of STUB_MODULES) {
  if (isResolvable(name)) continue; // real (or previous stub) already present

  const dir = path.join(nodeModules, ...name.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), stubSource(name));
  const pkg = {
    name,
    version: '0.0.0-stub',
    description: 'Throw-on-use stub for an unused mem0ai peer dependency (see scripts/ensure-mem0-peer-stubs.js)',
    main: 'index.js',
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));

  for (const sub of SUBPATHS[name] || []) {
    fs.writeFileSync(path.join(dir, `${sub}.js`), stubSource(`${name}/${sub}`));
  }
  created++;
  console.log(`[mem0-stubs] created stub: ${name}`);
}

if (created === 0) {
  console.log('[mem0-stubs] all mem0 peer modules resolvable — nothing to do');
} else {
  console.log(`[mem0-stubs] ${created} stub(s) written to node_modules`);
}
