'use strict';

/** Tenant/session-scoped parsed-PDF state for annotation reuse on follow-ups. */
exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS ari_file_analysis_cache (
      scope_key VARCHAR(180) NOT NULL,
      file_hash CHAR(64) NOT NULL,
      user_phone VARCHAR(50) NOT NULL,
      session_id UUID REFERENCES ari_chat_sessions(id) ON DELETE CASCADE,
      file_name TEXT,
      provider VARCHAR(40) NOT NULL DEFAULT 'openrouter',
      annotations JSONB NOT NULL DEFAULT '[]'::jsonb,
      state JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (scope_key, file_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_ari_file_analysis_user_updated
      ON ari_file_analysis_cache(user_phone, updated_at DESC);
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query('DROP TABLE IF EXISTS ari_file_analysis_cache');
};
