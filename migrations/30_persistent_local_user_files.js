'use strict';

exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE user_files
      ADD COLUMN IF NOT EXISTS local_path TEXT,
      ADD COLUMN IF NOT EXISTS size_bytes BIGINT,
      ADD COLUMN IF NOT EXISTS content_sha256 CHAR(64);

    CREATE INDEX IF NOT EXISTS idx_user_files_local_path
      ON user_files(local_path)
      WHERE local_path IS NOT NULL;
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    DROP INDEX IF EXISTS idx_user_files_local_path;
    ALTER TABLE user_files
      DROP COLUMN IF EXISTS content_sha256,
      DROP COLUMN IF EXISTS size_bytes,
      DROP COLUMN IF EXISTS local_path;
  `);
};
