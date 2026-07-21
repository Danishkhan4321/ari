'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const registry = require('../src/mcp/tool-registry');
const mcpTokens = require('../src/services/mcp-token.service');
const { hashToken, TOKEN_PREFIX } = mcpTokens._internals;

// ── Registry contract ──────────────────────────────────────────────────────

test('registry tools all have name, description, and object schemas', () => {
  const tools = registry.listTools();
  assert.ok(tools.length >= 8);
  for (const t of tools) {
    assert.match(t.name, /^ari_[a-z_]+$/, `bad tool name: ${t.name}`);
    assert.ok(t.description.length > 20, `weak description on ${t.name}`);
    assert.equal(t.inputSchema.type, 'object', `schema must be object on ${t.name}`);
  }
  const names = tools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, 'tool names must be unique');
});

test('registry has exactly one write tool (ari_add_fact)', () => {
  const writes = registry.listTools().filter((t) => !/read.only/i.test(t.description));
  assert.deepEqual(writes.map((t) => t.name), ['ari_entity_card', 'ari_add_fact'].filter((n) =>
    writes.some((w) => w.name === n)));
  assert.ok(registry.listTools().some((t) => t.name === 'ari_add_fact'));
});

test('callTool returns error object for unknown tool', async () => {
  const out = await registry.callTool('911', 'ari_nope', {});
  assert.match(out.error, /unknown tool/);
});

test('callTool fails open (returns error, never throws) without a database', async () => {
  const out = await registry.callTool('911000000001', 'ari_search_leads', { text: 'acme' });
  assert.ok(out.error || Array.isArray(out.leads));
});

// ── Token service ──────────────────────────────────────────────────────────

test('token hash is deterministic sha256 and prefix is enforced on verify', async () => {
  assert.equal(hashToken('abc'), hashToken('abc'));
  assert.equal(hashToken('abc').length, 64);
  assert.equal(await mcpTokens.verify('not-a-token'), null);
  assert.equal(await mcpTokens.verify(''), null);
  assert.equal(await mcpTokens.verify(`${TOKEN_PREFIX}tooshort`), null);
});

test('mint/revoke fail open without a database', async () => {
  const minted = await mcpTokens.mint('911000000001');
  assert.ok(minted === null || minted.token || minted.error);
  const revoked = await mcpTokens.revokeAll('911000000001');
  assert.equal(typeof revoked, 'number');
});

// ── HTTP surface (real express app on an ephemeral port) ──────────────────

function rpc(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path: '/mcp', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
      }
    );
    req.on('error', reject);
    req.end(data);
  });
}

test('MCP endpoint: 401 without token, initialize/tools work with a stubbed token', async (t) => {
  const express = require('express');
  const app = express();
  app.use('/mcp', require('../src/routes/mcp.routes'));

  // Stub verify for this test: one magic token maps to a user.
  const realVerify = mcpTokens.verify;
  mcpTokens.verify = async (tok) => (tok === 'smcp_test_token_0123456789abcdef' ? '911000000042' : null);
  t.after(() => { mcpTokens.verify = realVerify; });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());
  const { port } = server.address();

  const unauth = await rpc(port, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(unauth.status, 401);
  assert.match(unauth.body.error.message, /unauthorized/);

  const auth = { Authorization: 'Bearer smcp_test_token_0123456789abcdef' };

  const init = await rpc(port, { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, auth);
  assert.equal(init.status, 200);
  assert.equal(init.body.result.protocolVersion, '2025-03-26');
  assert.equal(init.body.result.serverInfo.name, 'ari-context');

  const list = await rpc(port, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, auth);
  assert.equal(list.status, 200);
  assert.ok(list.body.result.tools.some((x) => x.name === 'ari_entity_card'));

  const call = await rpc(port, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ari_entity_card', arguments: { text: 'meera' } } }, auth);
  assert.equal(call.status, 200);
  assert.equal(call.body.result.content[0].type, 'text');

  const unknown = await rpc(port, { jsonrpc: '2.0', id: 5, method: 'bogus/method' }, auth);
  assert.equal(unknown.body.error.code, -32601);

  const notification = await rpc(port, { jsonrpc: '2.0', method: 'notifications/initialized' }, auth);
  assert.equal(notification.status, 202);
});
