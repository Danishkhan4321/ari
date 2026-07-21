'use strict';

// Codex has one supported runtime: the bundled App Server. Keeping a second
// subprocess SDK path created a separate stateless MCP cancellation channel
// that could not be isolated safely across dashboard sessions.
const {
  CodexAppServerError,
  runCodexAppServerAgent,
} = require('./codex-app-server.service');

async function runCodexAgent(options) {
  return runCodexAppServerAgent(options);
}

module.exports = {
  CodexRunError: CodexAppServerError,
  runCodexAgent,
};
