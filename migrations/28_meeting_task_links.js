'use strict';

exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS meeting_task_links (
      meeting_id INTEGER NOT NULL REFERENCES meeting_recordings(id) ON DELETE CASCADE,
      suggestion_index INTEGER NOT NULL CHECK (suggestion_index >= 0),
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      created_by_phone TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (meeting_id, suggestion_index)
    );

    CREATE INDEX IF NOT EXISTS idx_meeting_task_links_task_id
      ON meeting_task_links(task_id);
  `);
};

exports.down = async () => {
  throw new Error(
    '28_meeting_task_links is intentionally not reversible because removing confirmed meeting-task links would break idempotency and audit history.',
  );
};
