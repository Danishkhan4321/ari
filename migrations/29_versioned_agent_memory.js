'use strict';

exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE ari_agent_memory_fact_versions (
      id BIGSERIAL PRIMARY KEY,
      user_phone TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      subject TEXT NOT NULL DEFAULT 'user',
      key_name TEXT NOT NULL,
      value TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'explicit_user',
      source_ref TEXT,
      observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      valid_until TIMESTAMPTZ,
      supersedes_id BIGINT REFERENCES ari_agent_memory_fact_versions(id) ON DELETE SET NULL,
      is_current BOOLEAN NOT NULL DEFAULT TRUE,
      superseded_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX ari_agent_memory_one_current_fact
      ON ari_agent_memory_fact_versions(user_phone, subject, key_name)
      WHERE is_current = TRUE;

    CREATE INDEX ari_agent_memory_current_user
      ON ari_agent_memory_fact_versions(user_phone, observed_at DESC)
      WHERE is_current = TRUE;

    CREATE INDEX ari_agent_memory_supersedes
      ON ari_agent_memory_fact_versions(supersedes_id)
      WHERE supersedes_id IS NOT NULL;
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query('DROP TABLE IF EXISTS ari_agent_memory_fact_versions;');
};
