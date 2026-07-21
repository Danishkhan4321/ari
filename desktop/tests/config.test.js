const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { buildRuntimeConfig, firstAdminPhone } = require('../src/config');

test('desktop runtime uses loopback URLs and disables background work', () => {
  const config = buildRuntimeConfig({
    repoRoot: path.resolve('D:/example/ari'),
    env: {
      DATABASE_URL: 'postgres://example',
      INTERNAL_API_SECRET: 'secret',
      ADMIN_PHONES: '919876543210, +14155550123',
      APP_BASE_URL: 'https://legacy.example.test',
      DASHBOARD_BASE_URL: 'https://legacy-dashboard.example.test',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_ANON_KEY: 'remote-key'
    }
  });

  assert.equal(config.backendUrl, 'http://127.0.0.1:43100');
  assert.equal(config.dashboardUrl, 'http://127.0.0.1:43101');
  assert.equal(config.dashboardEntryUrl, 'http://127.0.0.1:43101/chat');
  assert.equal(config.childEnv.DISABLE_BACKGROUND_JOBS, 'true');
  assert.equal(config.childEnv.AGENTIC_MODE_ALL, 'true');
  assert.equal(config.childEnv.APP_BASE_URL, config.backendUrl);
  assert.equal(config.childEnv.BOT_INTERNAL_URL, config.backendUrl);
  assert.equal(config.childEnv.DASHBOARD_BASE_URL, config.dashboardUrl);
  assert.equal(config.childEnv.ARI_DEMO_MODE, 'false');
  assert.equal(config.childEnv.ARI_DESKTOP_AUTH_BYPASS, 'true');
  assert.equal(config.childEnv.ARI_DEMO_USER_PHONE, '+919876543210');
  assert.equal(config.childEnv.ARI_DESKTOP_LOCAL_FILES, 'true');
  assert.equal(config.childEnv.SUPABASE_URL, '');
  assert.equal(config.childEnv.SUPABASE_ANON_KEY, '');
  assert.equal(config.childEnv.SUPABASE_KEY, '');
  assert.equal(Object.values(config.childEnv).some((value) => String(value).includes('example.test')), false);
});

test('desktop authentication bypass can be disabled', () => {
  const config = buildRuntimeConfig({
    repoRoot: path.resolve('D:/example/ari'),
    env: { ADMIN_PHONES: '919876543210', ARI_DESKTOP_AUTH_BYPASS: 'false' }
  });

  assert.equal(config.childEnv.ARI_DEMO_MODE, 'false');
  assert.equal(config.childEnv.ARI_DESKTOP_AUTH_BYPASS, 'false');
  assert.equal(config.childEnv.ARI_DEMO_USER_PHONE, undefined);
});

test('desktop can explicitly use an isolated in-memory database for safe local QA', () => {
  const config = buildRuntimeConfig({
    repoRoot: path.resolve('D:/example/ari'),
    env: { ADMIN_PHONES: '919876543210', ARI_DESKTOP_USE_DEMO_DB: 'true' }
  });

  assert.equal(config.childEnv.ARI_DEMO_MODE, 'true');
  assert.equal(config.useDemoDatabase, true);
});

test('firstAdminPhone normalizes the first configured phone', () => {
  assert.equal(firstAdminPhone('919876543210,+14155550123'), '+919876543210');
  assert.equal(firstAdminPhone(''), null);
});
