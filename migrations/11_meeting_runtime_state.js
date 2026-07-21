/**
 * Meeting background jobs start before any meeting has run, so their state
 * tables must exist at deploy time rather than being created by a callback.
 */

exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS meeting_health_state (
      id INT PRIMARY KEY DEFAULT 1,
      consecutive_broken INT DEFAULT 0,
      last_alert_at TIMESTAMP,
      last_check_at TIMESTAMP DEFAULT NOW(),
      last_instance_id VARCHAR(64),
      CHECK (id = 1)
    );
    INSERT INTO meeting_health_state (id, consecutive_broken)
    VALUES (1, 0)
    ON CONFLICT (id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS meeting_sessions (
      id SERIAL PRIMARY KEY,
      user_phone VARCHAR(50) NOT NULL,
      machine_id VARCHAR(100),
      meeting_url TEXT,
      platform VARCHAR(20),
      status VARCHAR(20) DEFAULT 'joining',
      created_at TIMESTAMP DEFAULT NOW(),
      ended_at TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_meeting_sessions_user ON meeting_sessions(user_phone);
    CREATE INDEX IF NOT EXISTS idx_meeting_sessions_status ON meeting_sessions(status);
    CREATE INDEX IF NOT EXISTS idx_meeting_sessions_machine ON meeting_sessions(machine_id);
  `);
};

exports.down = async () => {
  throw new Error('Meeting runtime state migration is not safely reversible.');
};
