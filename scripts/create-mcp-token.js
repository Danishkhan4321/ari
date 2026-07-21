#!/usr/bin/env node
'use strict';

/**
 * Ops helper: mint an MCP bearer token for a user.
 *
 * Usage:
 *   node -r dotenv/config scripts/create-mcp-token.js <user_phone> [label]
 *
 * The plaintext token is printed ONCE. Only its hash is stored.
 */

const mcpTokens = require('../src/services/mcp-token.service');
const { pool } = require('../src/config/database');

(async () => {
  const [phone, label] = process.argv.slice(2);
  if (!phone) {
    console.error('Usage: node -r dotenv/config scripts/create-mcp-token.js <user_phone> [label]');
    process.exitCode = 1;
    return;
  }
  const minted = await mcpTokens.mint(phone.replace(/\D/g, ''), label || 'ops');
  if (minted?.token) {
    const base = (process.env.APP_BASE_URL || 'http://127.0.0.1:43100').replace(/\/$/, '');
    console.log(`MCP endpoint : ${base}/mcp`);
    console.log(`Bearer token : ${minted.token}`);
    console.log('Shown once — only the hash is stored.');
  } else {
    console.error(`Failed: ${minted?.error || 'could not mint token (DB reachable?)'}`);
    process.exitCode = 1;
  }
  try { await pool.end(); } catch (_) { /* ignore */ }
})();
