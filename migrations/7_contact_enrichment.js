exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company TEXT;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS title TEXT;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS linkedin_url TEXT;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS website TEXT;

    ALTER TABLE IF EXISTS sales_leads ADD COLUMN IF NOT EXISTS title TEXT;
    ALTER TABLE IF EXISTS sales_leads ADD COLUMN IF NOT EXISTS linkedin_url TEXT;
    ALTER TABLE IF EXISTS sales_leads ADD COLUMN IF NOT EXISTS website TEXT;

    CREATE TABLE IF NOT EXISTS contact_enrichment_runs (
      id BIGSERIAL PRIMARY KEY,
      user_phone TEXT NOT NULL,
      member_kind TEXT NOT NULL CHECK (member_kind IN ('lead', 'contact')),
      member_id INTEGER NOT NULL,
      fingerprint CHAR(64) NOT NULL,
      status TEXT NOT NULL DEFAULT 'in_progress'
        CHECK (status IN ('in_progress', 'succeeded', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 1,
      result JSONB,
      error_code TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_phone, member_kind, member_id, fingerprint)
    );
    CREATE INDEX IF NOT EXISTS idx_contact_enrichment_member
      ON contact_enrichment_runs(user_phone, member_kind, member_id, updated_at DESC);
  `);
};

exports.down = async () => {
  throw new Error(
    '7_contact_enrichment is intentionally not reversible because enrichment history and user data must be preserved.'
  );
};
