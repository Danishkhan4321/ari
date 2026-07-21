/**
 * Ensure Meta webhook dedup storage exists in fresh demo/staging DBs.
 *
 * Older Ari deployments created this table during app boot. Demo
 * builds can disable background startup work, so relying on boot-time schema
 * creation leaves the first real WhatsApp message on in-memory dedup only.
 */

exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS processed_messages (
      message_id VARCHAR(255) PRIMARY KEY,
      user_phone VARCHAR(50),
      processed_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_processed_messages_at
      ON processed_messages(processed_at DESC);
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`DROP INDEX IF EXISTS idx_processed_messages_at;`);
  await pgm.db.query(`DROP TABLE IF EXISTS processed_messages;`);
};
