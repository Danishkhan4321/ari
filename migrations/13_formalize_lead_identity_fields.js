exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE sales_leads
      ADD COLUMN IF NOT EXISTS title TEXT,
      ADD COLUMN IF NOT EXISTS linkedin_url TEXT,
      ADD COLUMN IF NOT EXISTS website TEXT;

    CREATE INDEX IF NOT EXISTS idx_sales_leads_linkedin
      ON sales_leads(user_phone, LOWER(linkedin_url))
      WHERE linkedin_url IS NOT NULL;
  `);
};

exports.down = async () => {
  // These columns may contain user data and are intentionally retained on rollback.
};
