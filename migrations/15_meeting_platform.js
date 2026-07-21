exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE meeting_recordings
      ADD COLUMN IF NOT EXISTS meeting_platform TEXT;
  `);
};

exports.down = async () => {
  throw new Error(
    '15_meeting_platform is intentionally not reversible because meeting metadata must be preserved.'
  );
};
