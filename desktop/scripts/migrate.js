const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const dotenv = require('dotenv');

const repoRoot = path.resolve(__dirname, '..', '..');
const fileEnvironment = dotenv.config({ path: path.join(repoRoot, '.env') }).parsed || {};
const env = { ...fileEnvironment, ...process.env };

if (env.ARI_DESKTOP_USE_DEMO_DB === 'true') {
  console.log('Skipping persistent migrations for the isolated demo database.');
  process.exit(0);
}

if (!env.DATABASE_URL) {
  console.error('DATABASE_URL is required before Ari Desktop can prepare chat sessions.');
  process.exit(1);
}

const migrationNames = [
  '18_agent_run_ledger',
  '19_chat_sessions',
  '20_openrouter_agent_state',
  '21_session_scoped_confirmations',
  '22_openrouter_file_analysis_cache',
  '23_crm_bulk_sync',
  // The canonical identity migration was renumbered in one development line.
  // Select whichever filename is present, without running the same migration twice.
  '23_canonical_phone_identity',
  '24_canonical_phone_identity',
  '25_manual_meeting_recording',
  '26_remove_retired_meeting_provider_tables',
  '27_team_task_ownership',
  '28_meeting_task_links',
  '29_versioned_agent_memory',
  '30_persistent_local_user_files',
  '31_standup_timezone',
  '32_provider_neutral_agent_summaries',
  '33_google_login_identities',
].filter((name) => fs.existsSync(path.join(repoRoot, 'migrations', `${name}.js`)));
const migrationGlob = migrationNames.join(',');

const migrationCli = path.join(repoRoot, 'node_modules', 'node-pg-migrate', 'bin', 'node-pg-migrate.js');
const result = spawnSync(process.execPath, [
  migrationCli,
  'up',
  '--migrations-dir',
  `migrations/{${migrationGlob}}.js`,
  '--use-glob',
  '--migrations-table',
  'pgmigrations',
  '--check-order',
  'false',
  // Supabase transaction poolers do not guarantee that advisory unlocks run
  // on the same server session. Ari Desktop is single-instance, so the CLI's
  // session lock is both unnecessary here and capable of poisoning retries.
  '--lock',
  'false',
], {
  cwd: repoRoot,
  env,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`Could not prepare Ari chat sessions: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
