'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const migration = require('../migrations/23_crm_bulk_sync');

function recorder() {
  const queries = [];
  return {
    queries,
    pgm: {
      db: {
        async query(sql) {
          queries.push(String(sql));
          return { rows: [], rowCount: 0 };
        },
      },
    },
  };
}

test('CRM bulk migration merges duplicate groups before enforcing normalized ownership uniqueness', async () => {
  const { pgm, queries } = recorder();
  await migration.up(pgm);
  const sql = queries.join('\n');

  assert.match(sql, /CREATE TEMP TABLE ari_contact_group_merge_map/);
  assert.match(sql, /INSERT INTO contact_group_members/);
  assert.match(sql, /UPDATE bulk_email_campaigns/);
  assert.match(sql, /DELETE FROM contact_groups/);
  assert.match(sql, /regexp_replace\(user_phone, '\[\^0-9\]'/);
  assert.match(sql, /lower\(btrim\(name\)\)/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_groups_owner_normalized_name/);

  const mergeIndex = sql.indexOf('INSERT INTO contact_group_members');
  const deleteIndex = sql.indexOf('DELETE FROM contact_groups');
  const uniqueIndex = sql.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_groups_owner_normalized_name');
  assert.ok(mergeIndex >= 0 && mergeIndex < deleteIndex, 'memberships must move before duplicate groups are removed');
  assert.ok(deleteIndex >= 0 && deleteIndex < uniqueIndex, 'duplicates must be removed before uniqueness is enforced');
});

test('CRM bulk migration creates durable per-workbook and per-group checkpoints', async () => {
  const { pgm, queries } = recorder();
  await migration.up(pgm);
  const sql = queries.join('\n');

  assert.match(sql, /CREATE TABLE IF NOT EXISTS ari_crm_bulk_jobs/);
  assert.match(sql, /operation_key CHAR\(64\) PRIMARY KEY/);
  assert.match(sql, /source_hash CHAR\(64\) NOT NULL/);
  assert.match(sql, /last_error JSONB/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ari_crm_bulk_job_items/);
  assert.match(sql, /PRIMARY KEY \(operation_key, item_key\)/);
  assert.match(sql, /REFERENCES ari_crm_bulk_jobs\(operation_key\) ON DELETE CASCADE/);
  assert.match(sql, /attempt_count INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /contacts_created INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /members_added INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /members_removed INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /records_skipped INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /idx_ari_crm_bulk_jobs_user_updated/);
  assert.match(sql, /idx_ari_crm_bulk_items_status/);
});

test('CRM bulk rollback removes only the new checkpoints and uniqueness index', async () => {
  const { pgm, queries } = recorder();
  await migration.down(pgm);
  const sql = queries.join('\n');

  assert.match(sql, /DROP TABLE IF EXISTS ari_crm_bulk_job_items/);
  assert.match(sql, /DROP TABLE IF EXISTS ari_crm_bulk_jobs/);
  assert.match(sql, /DROP INDEX IF EXISTS uq_contact_groups_owner_normalized_name/);
  assert.doesNotMatch(sql, /DROP TABLE IF EXISTS contact_groups/);
  assert.doesNotMatch(sql, /DROP TABLE IF EXISTS contact_group_members/);
});
