'use strict';

/** Durable OpenRouter Responses state and tool-call idempotency journal. */
exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS ari_agent_conversation_state (
      conversation_key VARCHAR(80) PRIMARY KEY,
      user_phone VARCHAR(50) NOT NULL,
      session_id UUID REFERENCES ari_chat_sessions(id) ON DELETE CASCADE,
      state_version INTEGER NOT NULL DEFAULT 1,
      state JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ari_agent_state_user_updated
      ON ari_agent_conversation_state(user_phone, updated_at DESC);

    CREATE TABLE IF NOT EXISTS ari_agent_tool_executions (
      conversation_key VARCHAR(80) NOT NULL,
      tool_call_id VARCHAR(180) NOT NULL,
      tool_name VARCHAR(150) NOT NULL,
      arguments_hash CHAR(64) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'running',
      result JSONB,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (conversation_key, tool_call_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ari_agent_tool_updated
      ON ari_agent_tool_executions(conversation_key, updated_at DESC);
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    DROP TABLE IF EXISTS ari_agent_tool_executions;
    DROP TABLE IF EXISTS ari_agent_conversation_state;
  `);
};
