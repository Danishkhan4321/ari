/**
 * Migration: indexes for slow-query columns identified in production logs.
 *
 * The standalone demo schema may not include every optional feature table
 * that existed in production. Each index is therefore guarded by to_regclass so
 * a fresh deployment can still migrate cleanly.
 */

exports.up = async (pgm) => {
  const optionalIndexes = [
    [
      'standup_configs',
      `
        CREATE INDEX IF NOT EXISTS idx_standup_configs_active
          ON standup_configs(is_active)
          WHERE is_active = TRUE;
      `,
    ],
    [
      'polls',
      `
        CREATE INDEX IF NOT EXISTS idx_polls_active_created
          ON polls(status, created_at)
          WHERE status = 'active';
      `,
    ],
    [
      'follow_ups',
      `
        CREATE INDEX IF NOT EXISTS idx_follow_ups_due
          ON follow_ups(status, reminder_sent, due_date)
          WHERE status = 'pending' AND reminder_sent = FALSE;
      `,
    ],
    [
      'scheduled_emails',
      `
        CREATE INDEX IF NOT EXISTS idx_scheduled_emails_pending
          ON scheduled_emails(status, send_at)
          WHERE status = 'pending';
      `,
    ],
    [
      'incidents',
      `
        CREATE INDEX IF NOT EXISTS idx_incidents_open_severe
          ON incidents(severity, status, created_at)
          WHERE status != 'resolved';
      `,
    ],
    [
      'focus_sessions',
      `
        CREATE INDEX IF NOT EXISTS idx_focus_sessions_active
          ON focus_sessions(status, start_time)
          WHERE status = 'active';
      `,
    ],
    [
      'habits',
      `
        CREATE INDEX IF NOT EXISTS idx_habits_active_reminder
          ON habits(active, reminder_time)
          WHERE active = TRUE AND reminder_time IS NOT NULL;
      `,
    ],
    [
      'meeting_aws_instances',
      `
        CREATE INDEX IF NOT EXISTS idx_meeting_aws_running
          ON meeting_aws_instances(launched_at)
          WHERE ended_at IS NULL;
      `,
    ],
  ];

  for (const [tableName, createIndexSql] of optionalIndexes) {
    const result = await pgm.db.query('SELECT to_regclass($1) AS table_name;', [tableName]);
    if (result.rows?.[0]?.table_name) {
      await pgm.db.query(createIndexSql);
    }
  }
};

exports.down = async (pgm) => {
  await pgm.db.query(`DROP INDEX IF EXISTS idx_standup_configs_active;`);
  await pgm.db.query(`DROP INDEX IF EXISTS idx_polls_active_created;`);
  await pgm.db.query(`DROP INDEX IF EXISTS idx_follow_ups_due;`);
  await pgm.db.query(`DROP INDEX IF EXISTS idx_scheduled_emails_pending;`);
  await pgm.db.query(`DROP INDEX IF EXISTS idx_incidents_open_severe;`);
  await pgm.db.query(`DROP INDEX IF EXISTS idx_focus_sessions_active;`);
  await pgm.db.query(`DROP INDEX IF EXISTS idx_habits_active_reminder;`);
  await pgm.db.query(`DROP INDEX IF EXISTS idx_meeting_aws_running;`);
};
