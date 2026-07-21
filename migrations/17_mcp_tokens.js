/**
 * MCP access tokens — per-user bearer tokens for the /mcp platform endpoint.
 * Only a SHA-256 hash is stored; the plaintext token is shown exactly once
 * at mint time (WhatsApp "connect claude" command or ops script).
 */

exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS mcp_tokens (
      id SERIAL PRIMARY KEY,
      user_phone VARCHAR(50) NOT NULL,
      token_hash CHAR(64) NOT NULL UNIQUE,
      label VARCHAR(100) DEFAULT 'default',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_tokens_user ON mcp_tokens(user_phone);
  `);
};

exports.down = async () => {
  throw new Error(
    '17_mcp_tokens is intentionally not reversible because access tokens must be revoked, not silently dropped.'
  );
};
