'use strict';

exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE IF EXISTS standup_configs
      ADD COLUMN IF NOT EXISTS timezone VARCHAR(100) DEFAULT 'UTC';
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE IF EXISTS standup_configs DROP COLUMN IF EXISTS timezone;
  `);
};
