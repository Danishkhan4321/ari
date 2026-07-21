'use strict';

exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS ari_agent_conversation_summaries (
      conversation_key VARCHAR(200) PRIMARY KEY,
      user_phone VARCHAR(50) NOT NULL,
      session_id UUID REFERENCES ari_chat_sessions(id) ON DELETE CASCADE,
      summary TEXT NOT NULL,
      source_message_count INTEGER NOT NULL DEFAULT 0,
      source_last_history_id BIGINT,
      generated_by VARCHAR(80) NOT NULL DEFAULT 'deterministic',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ari_agent_summaries_user_session
      ON ari_agent_conversation_summaries(user_phone, session_id, updated_at DESC);
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query('DROP TABLE IF EXISTS ari_agent_conversation_summaries;');
};
