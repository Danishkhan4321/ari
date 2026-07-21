'use strict';

/**
 * /mcp — Ari's platform endpoint (Model Context Protocol, Streamable HTTP,
 * stateless JSON mode).
 *
 * A deliberately thin, dependency-free implementation of the MCP server
 * surface that tool clients (Claude, Cursor, partner agents) actually use:
 *
 *   initialize                → protocol handshake
 *   notifications/initialized → accepted (202)
 *   tools/list                → the registry (src/mcp/tool-registry.js)
 *   tools/call                → execute, scoped to the token's user
 *   ping                      → {}
 *
 * Session model: stateless. Each POST is authenticated independently via
 * `Authorization: Bearer smcp_…` (per-user token from mcp-token.service —
 * minted with the WhatsApp command "connect claude" or the ops script).
 * GET returns 405 (no server-push stream in stateless mode) per spec.
 *
 * Why hand-rolled instead of the official SDK: the registry is plain
 * JSON-Schema + execute functions, the stateless surface is ~5 methods,
 * and this avoids an ESM/zod-version dependency in a CommonJS app. If the
 * surface ever grows (resources, prompts, sampling), swap the transport
 * for @modelcontextprotocol/sdk — the registry stays as-is.
 */

const express = require('express');
const logger = require('../utils/logger');
const registry = require('../mcp/tool-registry');
const desktopRegistry = require('../mcp/desktop-tool-registry');
const { isAllowedInternalAddress } = require('../utils/internal-api-auth');

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

const router = express.Router();

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

async function authenticate(req, { record = false } = {}) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(\S+)$/i);
  if (!match) return null;
  const mcpTokens = require('../services/mcp-token.service');
  return record ? mcpTokens.verifyRecord(match[1]) : mcpTokens.verify(match[1]);
}

async function handleRpc(userPhone, rpc, activeRegistry = registry, profile = {}) {
  const { id, method, params } = rpc;

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      return rpcResult(id, {
        protocolVersion: SUPPORTED_VERSIONS.has(requested) ? requested : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: profile.name || 'ari-context', version: '1.0.0' },
        instructions: profile.instructions ||
          'Ari is a WhatsApp-first team OS. These tools expose one user\'s cross-feature '
          + 'context: CRM leads, meeting notes, tasks, reminders, and remembered business facts. '
          + 'Read-mostly: the only write is ari_add_fact (note-grade memory).',
      });
    }

    case 'ping':
      return rpcResult(id, {});

    case 'tools/list':
      return rpcResult(id, { tools: activeRegistry.listTools() });

    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments || {};
      if (!name) return rpcError(id, -32602, 'tools/call requires params.name');
      const out = await activeRegistry.callTool(userPhone, name, args);
      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        isError: activeRegistry === desktopRegistry
          ? out?.status === 'failure'
          : !!(out && out.error),
      });
    }

    // Graceful no-ops for optional surface clients sometimes probe.
    case 'resources/list':
      return rpcResult(id, { resources: [] });
    case 'prompts/list':
      return rpcResult(id, { prompts: [] });

    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

async function respond(req, res, userPhone, activeRegistry, profile) {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json(rpcError(null, -32700, 'parse error: JSON body required'));
  }

  const isNotification = (message) => message && typeof message === 'object' && message.id === undefined;
  if (Array.isArray(body)) {
    const responses = [];
    for (const rpc of body) {
      // eslint-disable-next-line no-await-in-loop
      if (!isNotification(rpc)) responses.push(await handleRpc(userPhone, rpc, activeRegistry, profile));
    }
    if (responses.length === 0) return res.status(202).end();
    return res.json(responses);
  }
  if (isNotification(body)) return res.status(202).end();
  return res.json(await handleRpc(userPhone, body, activeRegistry, profile));
}

// Full business-action surface for the bundled desktop Codex agent only.
// It is unavailable in hosted mode and rejects every non-loopback caller.
router.post('/desktop', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const rawIp = req.ip || req.connection?.remoteAddress || '';
    if (process.env.DESKTOP_MODE !== 'true' || !isAllowedInternalAddress(rawIp)) {
      return res.status(403).json(rpcError(null, -32003, 'desktop MCP is local-only'));
    }
    const record = await authenticate(req, { record: true });
    if (!record || !String(record.label || '').startsWith('ari-codex-desktop')) {
      return res.status(401).json(rpcError(null, -32001, 'unauthorized desktop agent'));
    }
    return respond(req, res, record.userPhone, desktopRegistry, {
      name: 'ari-desktop',
      instructions:
        'You control Ari, an operating system for modern teams. Use these tools for CRM, tasks, reminders, inbox, meetings, team operations, and other business actions. '
        + 'Respect waiting_approval results, never repeat a completed write, and use each result next_actions for recovery.',
    });
  } catch (error) {
    logger.error(`[MCP desktop] request failed: ${error.message}`);
    return res.status(500).json(rpcError(null, -32603, 'internal error'));
  }
});

router.post('/', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const userPhone = await authenticate(req);
    if (!userPhone) {
      return res.status(401).json(rpcError(null, -32001, 'unauthorized: send Authorization: Bearer <smcp token>'));
    }

    return respond(req, res, userPhone, registry, {});
  } catch (error) {
    logger.error(`[MCP] request failed: ${error.message}`);
    return res.status(500).json(rpcError(null, -32603, 'internal error'));
  }
});

// Stateless mode: no SSE stream, no session teardown.
router.get('/', (req, res) => res.status(405).json(rpcError(null, -32000, 'method not allowed: stateless server, POST only')));
router.delete('/', (req, res) => res.status(405).json(rpcError(null, -32000, 'method not allowed: stateless server')));

module.exports = router;
module.exports._internals = { authenticate, handleRpc, respond };
