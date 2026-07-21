'use strict';

exports.up = async (pgm) => {
  await pgm.db.query(`
    DROP TABLE IF EXISTS meeting_recall_bots;
    DROP TABLE IF EXISTS meeting_aws_instances;
    DROP TABLE IF EXISTS meeting_health_state;
    DROP TABLE IF EXISTS meeting_sessions;
    DROP TABLE IF EXISTS meeting_vexabot;
    DROP TABLE IF EXISTS attendee_meetings;
    DROP TABLE IF EXISTS meeting_bot_flags;
  `);
};

exports.down = async () => {
  throw new Error(
    '26_remove_retired_meeting_provider_tables is intentionally not reversible; the retired provider integration must not be restored by rollback.',
  );
};
