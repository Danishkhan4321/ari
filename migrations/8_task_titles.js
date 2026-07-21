exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS title TEXT;
    ALTER TABLE tasks ALTER COLUMN title DROP NOT NULL;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS description TEXT;
    CREATE INDEX IF NOT EXISTS idx_tasks_assigned_status
      ON tasks(assigned_to, status, due_date);
  `);
};

exports.down = async () => {
  throw new Error(
    '8_task_titles is intentionally not reversible because task titles must be preserved.'
  );
};
