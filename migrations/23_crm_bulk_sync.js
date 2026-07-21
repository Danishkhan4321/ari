'use strict';

/**
 * Make CRM group creation idempotent across the two phone formats Ari uses
 * (bare digits and +digits), and add durable checkpoints for workbook imports.
 *
 * Duplicate groups can already exist in production, so the unique index is
 * deliberately created only after their memberships and campaign references
 * have been moved to the oldest group. node-pg-migrate runs this migration in
 * a transaction: a failed merge leaves the original groups untouched.
 */
exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS contact_groups (
      id SERIAL PRIMARY KEY,
      user_phone VARCHAR(50) NOT NULL,
      name VARCHAR(120) NOT NULL,
      emoji VARCHAR(8),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE contact_groups ADD COLUMN IF NOT EXISTS emoji VARCHAR(8);
    ALTER TABLE contact_groups ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
    ALTER TABLE contact_groups ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
    CREATE INDEX IF NOT EXISTS idx_contact_groups_user ON contact_groups(user_phone);

    CREATE TABLE IF NOT EXISTS contact_group_members (
      id SERIAL PRIMARY KEY,
      group_id INTEGER NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
      member_kind VARCHAR(10) NOT NULL,
      member_id INTEGER NOT NULL,
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (group_id, member_kind, member_id)
    );
    ALTER TABLE contact_group_members ADD COLUMN IF NOT EXISTS id BIGSERIAL;
    ALTER TABLE contact_group_members ADD COLUMN IF NOT EXISTS added_at TIMESTAMPTZ DEFAULT NOW();
    CREATE INDEX IF NOT EXISTS idx_cgm_group ON contact_group_members(group_id);

    CREATE TEMP TABLE ari_contact_group_merge_map ON COMMIT DROP AS
      SELECT id AS duplicate_id,
             MIN(id) OVER (
               PARTITION BY
                 CASE
                   WHEN regexp_replace(user_phone, '[^0-9]', '', 'g') <> ''
                     THEN regexp_replace(user_phone, '[^0-9]', '', 'g')
                   ELSE lower(btrim(user_phone))
                 END,
                 lower(btrim(name))
             ) AS keeper_id
        FROM contact_groups
       WHERE user_phone IS NOT NULL
         AND name IS NOT NULL;

    DELETE FROM ari_contact_group_merge_map
     WHERE duplicate_id = keeper_id;

    WITH source_members AS (
      SELECT DISTINCT ON (merge.keeper_id, member.member_kind, member.member_id)
             merge.keeper_id AS group_id,
             member.member_kind,
             member.member_id,
             member.added_at
        FROM ari_contact_group_merge_map merge
        JOIN contact_group_members member
          ON member.group_id = merge.duplicate_id
       ORDER BY merge.keeper_id,
                member.member_kind,
                member.member_id,
                member.added_at ASC NULLS LAST
    )
    INSERT INTO contact_group_members (group_id, member_kind, member_id, added_at)
      SELECT source.group_id,
             source.member_kind,
             source.member_id,
             COALESCE(source.added_at, NOW())
        FROM source_members source
       WHERE NOT EXISTS (
         SELECT 1
           FROM contact_group_members existing
          WHERE existing.group_id = source.group_id
            AND existing.member_kind = source.member_kind
            AND existing.member_id = source.member_id
       );

    WITH duplicate_metadata AS (
      SELECT DISTINCT ON (merge.keeper_id)
             merge.keeper_id,
             duplicate.emoji,
             duplicate.updated_at
        FROM ari_contact_group_merge_map merge
        JOIN contact_groups duplicate ON duplicate.id = merge.duplicate_id
       WHERE duplicate.emoji IS NOT NULL
         AND btrim(duplicate.emoji) <> ''
       ORDER BY merge.keeper_id, duplicate.id
    )
    UPDATE contact_groups keeper
       SET emoji = COALESCE(keeper.emoji, metadata.emoji),
           updated_at = GREATEST(
             COALESCE(keeper.updated_at, '-infinity'::timestamptz),
             COALESCE(metadata.updated_at, '-infinity'::timestamptz)
           )
      FROM duplicate_metadata metadata
     WHERE keeper.id = metadata.keeper_id;

    DO $migration$
    BEGIN
      IF to_regclass('bulk_email_campaigns') IS NOT NULL
         AND EXISTS (
           SELECT 1
             FROM pg_attribute
            WHERE attrelid = to_regclass('bulk_email_campaigns')
              AND attname = 'group_id'
              AND NOT attisdropped
         ) THEN
        EXECUTE '
          UPDATE bulk_email_campaigns campaign
             SET group_id = merge.keeper_id
            FROM ari_contact_group_merge_map merge
           WHERE campaign.group_id = merge.duplicate_id
        ';
      END IF;
    END
    $migration$;

    DELETE FROM contact_groups duplicate
      USING ari_contact_group_merge_map merge
     WHERE duplicate.id = merge.duplicate_id;

    DELETE FROM contact_group_members duplicate
      USING contact_group_members keeper
     WHERE duplicate.ctid > keeper.ctid
       AND duplicate.group_id = keeper.group_id
       AND duplicate.member_kind = keeper.member_kind
       AND duplicate.member_id = keeper.member_id;

    CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_group_members_group_kind_member
      ON contact_group_members(group_id, member_kind, member_id);

    CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_groups_owner_normalized_name
      ON contact_groups (
        (
          CASE
            WHEN regexp_replace(user_phone, '[^0-9]', '', 'g') <> ''
              THEN regexp_replace(user_phone, '[^0-9]', '', 'g')
            ELSE lower(btrim(user_phone))
          END
        ),
        (lower(btrim(name)))
      );

    CREATE TABLE IF NOT EXISTS ari_crm_bulk_jobs (
      operation_key CHAR(64) PRIMARY KEY,
      user_phone VARCHAR(50) NOT NULL,
      source_hash CHAR(64) NOT NULL,
      source_name TEXT NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      total_groups INTEGER NOT NULL DEFAULT 0,
      completed_groups INTEGER NOT NULL DEFAULT 0,
      total_records INTEGER NOT NULL DEFAULT 0,
      result JSONB,
      last_error JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_ari_crm_bulk_jobs_user_updated
      ON ari_crm_bulk_jobs(user_phone, updated_at DESC);

    CREATE TABLE IF NOT EXISTS ari_crm_bulk_job_items (
      operation_key CHAR(64) NOT NULL
        REFERENCES ari_crm_bulk_jobs(operation_key) ON DELETE CASCADE,
      item_key VARCHAR(180) NOT NULL,
      group_name TEXT NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      records_total INTEGER NOT NULL DEFAULT 0,
      contacts_created INTEGER NOT NULL DEFAULT 0,
      contacts_matched INTEGER NOT NULL DEFAULT 0,
      members_added INTEGER NOT NULL DEFAULT 0,
      members_removed INTEGER NOT NULL DEFAULT 0,
      records_skipped INTEGER NOT NULL DEFAULT 0,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      error JSONB,
      result JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      PRIMARY KEY (operation_key, item_key)
    );
    CREATE INDEX IF NOT EXISTS idx_ari_crm_bulk_items_status
      ON ari_crm_bulk_job_items(operation_key, status, updated_at);
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    DROP TABLE IF EXISTS ari_crm_bulk_job_items;
    DROP TABLE IF EXISTS ari_crm_bulk_jobs;
    DROP INDEX IF EXISTS uq_contact_groups_owner_normalized_name;
    DROP INDEX IF EXISTS uq_contact_group_members_group_kind_member;
  `);
};

