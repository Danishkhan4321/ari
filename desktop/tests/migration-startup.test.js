const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '..');

test('desktop development applies the agent and chat migrations before Electron starts', () => {
  const desktopPackage = require('../package.json');
  const migrationScript = path.join(desktopRoot, 'scripts', 'migrate.js');

  assert.equal(desktopPackage.scripts.predev, 'node scripts/migrate.js');
  assert.equal(fs.existsSync(migrationScript), true);

  const source = fs.readFileSync(migrationScript, 'utf8');
  assert.match(source, /18_agent_run_ledger/);
  assert.match(source, /19_chat_sessions/);
  assert.match(source, /20_openrouter_agent_state/);
  assert.match(source, /21_session_scoped_confirmations/);
  assert.match(source, /22_openrouter_file_analysis_cache/);
  assert.match(source, /23_crm_bulk_sync/);
  assert.match(source, /23_canonical_phone_identity/);
  assert.match(source, /24_canonical_phone_identity/);
  assert.match(source, /25_manual_meeting_recording/);
  assert.match(source, /26_remove_retired_meeting_provider_tables/);
  assert.match(source, /27_team_task_ownership/);
  assert.match(source, /28_meeting_task_links/);
  assert.ok(source.indexOf('27_team_task_ownership') < source.indexOf('28_meeting_task_links'));
  assert.match(source, /node-pg-migrate/);
  assert.match(source, /migrations-table/);
  assert.match(source, /pgmigrations/);
  assert.match(source, /'--lock',[\s\S]*'false'/);
  assert.equal(path.dirname(desktopRoot), repoRoot);
});

test('desktop chat migrations are safe to retry after an interrupted migration run', () => {
  const fileAnalysisSource = fs.readFileSync(path.join(repoRoot, 'migrations', '22_openrouter_file_analysis_cache.js'), 'utf8');
  const crmBulkSource = fs.readFileSync(path.join(repoRoot, 'migrations', '23_crm_bulk_sync.js'), 'utf8');

  assert.match(fileAnalysisSource, /CREATE TABLE IF NOT EXISTS ari_file_analysis_cache/);
  assert.match(fileAnalysisSource, /CREATE INDEX IF NOT EXISTS idx_ari_file_analysis_user_updated/);
  assert.match(crmBulkSource, /CREATE TABLE IF NOT EXISTS ari_crm_bulk_jobs/);
  assert.match(crmBulkSource, /CREATE TABLE IF NOT EXISTS ari_crm_bulk_job_items/);
  assert.match(crmBulkSource, /CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_groups_owner_normalized_name/);
});

test('desktop dashboard uses a cache isolated from production builds', () => {
  const desktopMainSource = fs.readFileSync(path.join(desktopRoot, 'src', 'main.js'), 'utf8');
  const nextConfigSource = fs.readFileSync(path.join(repoRoot, 'dashboard', 'next.config.mjs'), 'utf8');

  assert.match(desktopMainSource, /ARI_NEXT_DIST_DIR:\s*'\.next-desktop'/);
  assert.match(nextConfigSource, /distDir:\s*process\.env\.ARI_NEXT_DIST_DIR\s*\|\|\s*'\.next'/);
});
