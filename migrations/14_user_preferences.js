exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      id SERIAL PRIMARY KEY,
      user_phone VARCHAR(20) NOT NULL,
      setting_key VARCHAR(100),
      setting_value TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS setting_key VARCHAR(100);
    ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS setting_value TEXT;
    CREATE INDEX IF NOT EXISTS idx_user_preferences_phone_key
      ON user_preferences(user_phone, setting_key);
  `);
};

exports.down = async () => {
  throw new Error(
    '14_user_preferences is intentionally not reversible because user settings must be preserved.'
  );
};
