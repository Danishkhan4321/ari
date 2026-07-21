/** Durable agent run + event ledger for progress UI, audit, replay, and recovery. */

exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id UUID PRIMARY KEY,
      user_phone VARCHAR(50) NOT NULL,
      source VARCHAR(30) NOT NULL DEFAULT 'unknown',
      prompt_preview TEXT,
      status VARCHAR(40) NOT NULL DEFAULT 'received',
      model VARCHAR(150),
      steps INTEGER NOT NULL DEFAULT 0,
      outcome JSONB,
      error_code VARCHAR(100),
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS agent_run_events (
      id BIGSERIAL PRIMARY KEY,
      run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      user_phone VARCHAR(50) NOT NULL,
      event_type VARCHAR(80) NOT NULL,
      step INTEGER,
      tool_name VARCHAR(150),
      summary TEXT,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runs_user_started ON agent_runs(user_phone, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_run_events_user_id ON agent_run_events(user_phone, id);
    CREATE INDEX IF NOT EXISTS idx_agent_run_events_run_id ON agent_run_events(run_id, id);
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query('DROP TABLE IF EXISTS agent_run_events; DROP TABLE IF EXISTS agent_runs;');
};

