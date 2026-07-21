'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

function rpc(port, body, token = 'smcp_desktop_test_0123456789abcdef') {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: '/mcp/desktop', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        Authorization: `Bearer ${token}`,
      },
    }, (res) => {
      let output = '';
      res.on('data', (chunk) => { output += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: output ? JSON.parse(output) : null }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('full Ari MCP tools are available only to the local desktop agent token', async (t) => {
  const express = require('express');
  const mcpTokens = require('../src/services/mcp-token.service');
  const previousDesktopMode = process.env.DESKTOP_MODE;
  process.env.DESKTOP_MODE = 'true';
  const realVerifyRecord = mcpTokens.verifyRecord;
  mcpTokens.verifyRecord = async (token) => token.includes('desktop_test')
    ? { userPhone: '911000000042', label: 'ari-codex-desktop' }
    : null;
  t.after(() => {
    mcpTokens.verifyRecord = realVerifyRecord;
    if (previousDesktopMode === undefined) delete process.env.DESKTOP_MODE;
    else process.env.DESKTOP_MODE = previousDesktopMode;
  });

  const app = express();
  app.use('/mcp', require('../src/routes/mcp.routes'));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => server.close());
  const { port } = server.address();

  const initialized = await rpc(port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(initialized.status, 200);
  assert.equal(initialized.body.result.serverInfo.name, 'ari-desktop');

  const listed = await rpc(port, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(listed.status, 200);
  assert.ok(listed.body.result.tools.length >= 80);
  assert.ok(listed.body.result.tools.some((tool) => tool.name === 'set_reminder'));

  const rejected = await rpc(port, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, 'smcp_public_token_0123456789abcdef');
  assert.equal(rejected.status, 401);
});
