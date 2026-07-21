const test = require('node:test');
const assert = require('node:assert/strict');

const migration = require('../migrations/14_user_preferences.js');

test('user preferences migration is additive and non-destructive', async () => {
  let sql = '';
  await migration.up({ db: { query: async statement => { sql = statement; } } });
  assert.match(sql, /CREATE TABLE IF NOT EXISTS user_preferences/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS setting_key/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_user_preferences_phone_key/);
  await assert.rejects(() => migration.down({}), /not reversible/);
});
