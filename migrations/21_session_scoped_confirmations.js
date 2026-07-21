'use strict';

/** Prevent confirmations from crossing dashboard chat-session boundaries. */
exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS confirmation_gate_pending (
      scope_key TEXT PRIMARY KEY,
      user_phone TEXT NOT NULL,
      session_id UUID,
      action_type TEXT NOT NULL,
      summary TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE confirmation_gate_pending ADD COLUMN IF NOT EXISTS scope_key TEXT;
    ALTER TABLE confirmation_gate_pending ADD COLUMN IF NOT EXISTS session_id UUID;
    UPDATE confirmation_gate_pending SET scope_key = user_phone WHERE scope_key IS NULL;
    ALTER TABLE confirmation_gate_pending ALTER COLUMN scope_key SET NOT NULL;
    ALTER TABLE confirmation_gate_pending DROP CONSTRAINT IF EXISTS confirmation_gate_pending_pkey;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_confirmation_gate_scope
      ON confirmation_gate_pending(scope_key);
    CREATE INDEX IF NOT EXISTS idx_confirmation_gate_session
      ON confirmation_gate_pending(user_phone, session_id, created_at DESC);
  `);
};

exports.down = async (pgm) => {
  // Collapse any duplicate per-session rows before restoring the legacy
  // phone-only key. The newest pending draft wins, matching prior behavior.
  await pgm.db.query(`
    WITH ranked AS (
      SELECT ctid,
             ROW_NUMBER() OVER (
               PARTITION BY user_phone
               ORDER BY created_at DESC, scope_key DESC
             ) AS row_number
        FROM confirmation_gate_pending
    )
    DELETE FROM confirmation_gate_pending
     WHERE ctid IN (SELECT ctid FROM ranked WHERE row_number > 1);
    DROP INDEX IF EXISTS idx_confirmation_gate_session;
    DROP INDEX IF EXISTS uq_confirmation_gate_scope;
    ALTER TABLE confirmation_gate_pending ADD PRIMARY KEY (user_phone);
    ALTER TABLE confirmation_gate_pending DROP COLUMN IF EXISTS session_id;
    ALTER TABLE confirmation_gate_pending DROP COLUMN IF EXISTS scope_key;
  `);
};
