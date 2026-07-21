'use strict';

/**
 * MCP token service — per-user bearer tokens for the /mcp platform endpoint.
 *
 * Tokens look like `smcp_<48 hex chars>`. Only the SHA-256 hash is stored;
 * mint() returns the plaintext exactly once. Verification is a single
 * indexed lookup on the hash, so leaked DB rows reveal nothing usable.
 */

const crypto = require('crypto');
const { query } = require('../config/database');
const logger = require('../utils/logger');

const TOKEN_PREFIX = 'smcp_';
const MAX_ACTIVE_TOKENS_PER_USER = 5;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

class McpTokenService {
  constructor() {
    this.tableReady = false;
  }

  async _ensureTable() {
    if (this.tableReady) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS mcp_tokens (
          id SERIAL PRIMARY KEY,
          user_phone VARCHAR(50) NOT NULL,
          token_hash CHAR(64) NOT NULL UNIQUE,
          label VARCHAR(100) DEFAULT 'default',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_used_at TIMESTAMPTZ,
          revoked_at TIMESTAMPTZ
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_mcp_tokens_user ON mcp_tokens(user_phone)`);
      this.tableReady = true;
    } catch (error) {
      logger.error(`[McpToken] ensureTable failed: ${error.message}`);
    }
  }

  /**
   * Mint a new token for a user. Returns the PLAINTEXT token (show once)
   * or null on failure.
   */
  async mint(userPhone, label = 'default') {
    if (!userPhone) return null;
    await this._ensureTable();
    try {
      const active = await query(
        `SELECT COUNT(*)::int AS n FROM mcp_tokens WHERE user_phone = $1 AND revoked_at IS NULL`,
        [userPhone]
      );
      if ((active.rows[0]?.n || 0) >= MAX_ACTIVE_TOKENS_PER_USER) {
        return { error: `You already have ${MAX_ACTIVE_TOKENS_PER_USER} active tokens. Say "revoke mcp tokens" first.` };
      }

      const token = TOKEN_PREFIX + crypto.randomBytes(24).toString('hex');
      await query(
        `INSERT INTO mcp_tokens (user_phone, token_hash, label) VALUES ($1, $2, $3)`,
        [userPhone, hashToken(token), String(label).slice(0, 100)]
      );
      return { token };
    } catch (error) {
      logger.error(`[McpToken] mint failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Verify a bearer token. Returns the owning user_phone or null.
   * Touches last_used_at (fire-and-forget).
   */
  async verify(token) {
    const record = await this.verifyRecord(token);
    return record?.userPhone || null;
  }

  /** Verify a token and return its scoped metadata. */
  async verifyRecord(token) {
    const raw = String(token || '').trim();
    if (!raw.startsWith(TOKEN_PREFIX) || raw.length < 20) return null;
    await this._ensureTable();
    try {
      const result = await query(
        `SELECT id, user_phone, label FROM mcp_tokens
          WHERE token_hash = $1 AND revoked_at IS NULL
          LIMIT 1`,
        [hashToken(raw)]
      );
      const row = result.rows[0];
      if (!row) return null;
      query(`UPDATE mcp_tokens SET last_used_at = NOW() WHERE id = $1`, [row.id]).catch(() => {});
      return { id: row.id, userPhone: row.user_phone, label: row.label || 'default' };
    } catch (error) {
      logger.warn(`[McpToken] verify failed (non-fatal): ${error.message}`);
      return null;
    }
  }

  /**
   * Mint the single local desktop token used by Ari's embedded Codex agent.
   * Rotating the previous token keeps the public five-token allowance intact.
   */
  async mintDesktop(userPhone, label = 'ari-codex-desktop') {
    if (!userPhone) return null;
    await this._ensureTable();
    try {
      await query(
        `UPDATE mcp_tokens SET revoked_at = NOW()
          WHERE user_phone = $1 AND label = $2 AND revoked_at IS NULL`,
        [userPhone, String(label).slice(0, 100)]
      );
      return this.mint(userPhone, label);
    } catch (error) {
      logger.error(`[McpToken] desktop mint failed: ${error.message}`);
      return null;
    }
  }

  /** Revoke all active tokens for a user. Returns the count revoked. */
  async revokeAll(userPhone) {
    if (!userPhone) return 0;
    await this._ensureTable();
    try {
      const result = await query(
        `UPDATE mcp_tokens SET revoked_at = NOW()
          WHERE user_phone = $1 AND revoked_at IS NULL`,
        [userPhone]
      );
      return result.rowCount || 0;
    } catch (error) {
      logger.warn(`[McpToken] revokeAll failed: ${error.message}`);
      return 0;
    }
  }
}

module.exports = new McpTokenService();
module.exports._internals = { hashToken, TOKEN_PREFIX };
