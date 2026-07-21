exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE sales_leads
      ADD COLUMN IF NOT EXISTS phone TEXT,
      ADD COLUMN IF NOT EXISTS location TEXT,
      ADD COLUMN IF NOT EXISTS company_domain TEXT,
      ADD COLUMN IF NOT EXISTS company_description TEXT,
      ADD COLUMN IF NOT EXISTS company_industry TEXT,
      ADD COLUMN IF NOT EXISTS company_workforce INTEGER,
      ADD COLUMN IF NOT EXISTS company_headquarters TEXT,
      ADD COLUMN IF NOT EXISTS company_founded_year INTEGER,
      ADD COLUMN IF NOT EXISTS company_funding JSONB,
      ADD COLUMN IF NOT EXISTS social_profiles JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS enrichment_status VARCHAR(24),
      ADD COLUMN IF NOT EXISTS enriched_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS lead_enrichment_jobs (
      id BIGSERIAL PRIMARY KEY,
      user_phone VARCHAR(50) NOT NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'queued',
      requested_fields TEXT[] NOT NULL,
      conflict_policy VARCHAR(24) NOT NULL DEFAULT 'review',
      lead_count INTEGER NOT NULL,
      eligible_count INTEGER NOT NULL DEFAULT 0,
      processed_count INTEGER NOT NULL DEFAULT 0,
      enriched_count INTEGER NOT NULL DEFAULT 0,
      unchanged_count INTEGER NOT NULL DEFAULT 0,
      conflict_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
      actual_cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
      exa_run_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      idempotency_key VARCHAR(96) NOT NULL,
      lease_until TIMESTAMPTZ,
      cancel_requested_at TIMESTAMPTZ,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_phone, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS lead_enrichment_items (
      id BIGSERIAL PRIMARY KEY,
      job_id BIGINT NOT NULL REFERENCES lead_enrichment_jobs(id) ON DELETE CASCADE,
      lead_id BIGINT NOT NULL REFERENCES sales_leads(id) ON DELETE CASCADE,
      status VARCHAR(24) NOT NULL DEFAULT 'queued',
      input_snapshot JSONB NOT NULL,
      normalized_result JSONB,
      source_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
      exa_run_id TEXT,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(job_id, lead_id)
    );

    CREATE TABLE IF NOT EXISTS lead_enrichment_fields (
      id BIGSERIAL PRIMARY KEY,
      job_id BIGINT NOT NULL REFERENCES lead_enrichment_jobs(id) ON DELETE CASCADE,
      item_id BIGINT NOT NULL REFERENCES lead_enrichment_items(id) ON DELETE CASCADE,
      lead_id BIGINT NOT NULL REFERENCES sales_leads(id) ON DELETE CASCADE,
      field_name VARCHAR(64) NOT NULL,
      current_value JSONB,
      proposed_value JSONB NOT NULL,
      decision VARCHAR(24) NOT NULL,
      provider VARCHAR(24) NOT NULL DEFAULT 'exa',
      exa_run_id TEXT,
      source_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
      match_evidence TEXT,
      observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_at TIMESTAMPTZ,
      UNIQUE(item_id, field_name)
    );

    CREATE INDEX IF NOT EXISTS idx_enrichment_jobs_user_created
      ON lead_enrichment_jobs(user_phone, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_enrichment_jobs_worker
      ON lead_enrichment_jobs(status, lease_until, created_at);
    CREATE INDEX IF NOT EXISTS idx_enrichment_items_job
      ON lead_enrichment_items(job_id, status);
    CREATE INDEX IF NOT EXISTS idx_enrichment_fields_job_decision
      ON lead_enrichment_fields(job_id, decision);
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    DROP TABLE IF EXISTS lead_enrichment_fields;
    DROP TABLE IF EXISTS lead_enrichment_items;
    DROP TABLE IF EXISTS lead_enrichment_jobs;
  `);
};
