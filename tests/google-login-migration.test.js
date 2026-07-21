const test = require('node:test');
const assert = require('node:assert/strict');

const migration = require('../migrations/33_google_login_identities');

test('Google login migration creates identities and one-time desktop tickets', async () => {
  const statements = [];
  await migration.up({ db: { query: async (sql) => { statements.push(sql); } } });
  const sql = statements.join('\n');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ari_user_identities/);
  assert.match(sql, /PRIMARY KEY \(provider, provider_subject\)/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ari_desktop_auth_tickets/);
});
