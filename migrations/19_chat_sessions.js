'use strict';

const { randomUUID } = require('node:crypto');

exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS ari_chat_sessions (
      id UUID PRIMARY KEY,
      user_phone VARCHAR(50) NOT NULL,
      title VARCHAR(120),
      is_legacy BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      archived_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_ari_chat_sessions_user_updated
      ON ari_chat_sessions(user_phone, updated_at DESC);

    ALTER TABLE conversation_history ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES ari_chat_sessions(id);
    ALTER TABLE conversation_history ADD COLUMN IF NOT EXISTS client_message_id UUID;
    CREATE INDEX IF NOT EXISTS idx_conversation_history_session
      ON conversation_history(user_phone, session_id, id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_user_client_message
      ON conversation_history(user_phone, session_id, client_message_id)
      WHERE client_message_id IS NOT NULL AND role = 'user';

    CREATE TABLE IF NOT EXISTS ari_chat_submissions (
      user_phone VARCHAR(50) NOT NULL,
      session_id UUID NOT NULL REFERENCES ari_chat_sessions(id) ON DELETE CASCADE,
      client_message_id UUID NOT NULL,
      run_id VARCHAR(100) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'queued',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_phone, session_id, client_message_id)
    );

    CREATE TABLE IF NOT EXISTS ari_chat_attachments (
      id UUID PRIMARY KEY,
      user_phone VARCHAR(50) NOT NULL,
      session_id UUID NOT NULL REFERENCES ari_chat_sessions(id) ON DELETE CASCADE,
      client_message_id UUID NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      mime_type VARCHAR(150) NOT NULL,
      local_path TEXT NOT NULL,
      size_bytes BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ari_chat_attachments_turn
      ON ari_chat_attachments(user_phone, session_id, client_message_id);

    ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES ari_chat_sessions(id);
    ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS client_message_id UUID;
    CREATE INDEX IF NOT EXISTS idx_agent_runs_session_started
      ON agent_runs(user_phone, session_id, started_at DESC);
  `);

  const users = await pgm.db.query(`
    SELECT DISTINCT user_phone
      FROM conversation_history
     WHERE user_phone IS NOT NULL AND session_id IS NULL
  `);
  for (const row of users.rows) {
    const sessionId = randomUUID();
    await pgm.db.query(
      `INSERT INTO ari_chat_sessions (id, user_phone, title, is_legacy)
       VALUES ($1, $2, 'Previous conversations', TRUE)`,
      [sessionId, row.user_phone],
    );
    await pgm.db.query(
      `UPDATE conversation_history SET session_id = $1
        WHERE user_phone = $2 AND session_id IS NULL`,
      [sessionId, row.user_phone],
    );
  }
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    DROP TABLE IF EXISTS ari_chat_attachments;
    DROP TABLE IF EXISTS ari_chat_submissions;
    DROP INDEX IF EXISTS idx_agent_runs_session_started;
    ALTER TABLE agent_runs DROP COLUMN IF EXISTS client_message_id;
    ALTER TABLE agent_runs DROP COLUMN IF EXISTS session_id;
    DROP INDEX IF EXISTS uq_conversation_user_client_message;
    DROP INDEX IF EXISTS idx_conversation_history_session;
    ALTER TABLE conversation_history DROP COLUMN IF EXISTS client_message_id;
    ALTER TABLE conversation_history DROP COLUMN IF EXISTS session_id;
    DROP TABLE IF EXISTS ari_chat_sessions;
  `);
};
