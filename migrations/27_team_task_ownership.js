'use strict';

exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE tasks
      ADD COLUMN IF NOT EXISTS team_admin_phone TEXT,
      ADD COLUMN IF NOT EXISTS team_name TEXT;

    CREATE INDEX IF NOT EXISTS idx_tasks_team_status
      ON tasks(team_admin_phone, LOWER(team_name), status, due_date);
  `);
};

exports.down = async () => {
  throw new Error(
    '27_team_task_ownership is intentionally not reversible because removing team ownership would orphan shared task history.',
  );
};
