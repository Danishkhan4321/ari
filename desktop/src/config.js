const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

// Desktop sessions use the dashboard-visible E.164 form. Backend services that
// also consume WhatsApp's digits-only identifier explicitly compare both forms.
function firstAdminPhone(raw) {
  const first = String(raw || '').split(',').map((value) => value.trim()).find(Boolean);
  if (!first) return null;
  const digits = first.replace(/[^0-9]/g, '');
  return digits ? `+${digits}` : null;
}

function loadLocalEnvironment(repoRoot, baseEnv = process.env) {
  const parsed = dotenv.config({ path: path.join(repoRoot, '.env') }).parsed || {};
  return { ...parsed, ...baseEnv };
}

function normalizedHostedUrl(raw) {
  if (!raw) return null;
  let url;
  try { url = new URL(String(raw)); } catch { throw new TypeError('ARI_DESKTOP_DASHBOARD_URL must be a valid URL'); }
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new TypeError('ARI_DESKTOP_DASHBOARD_URL must use HTTPS');
  }
  return url.origin;
}

function loadPackagedConfig(configPath) {
  if (!configPath) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`Could not read Ari desktop configuration: ${error.message}`);
  }
}

function buildRuntimeConfig({ repoRoot, env, packagedConfig = {} }) {
  const backendPort = Number(env.ARI_DESKTOP_BACKEND_PORT || 43100);
  const dashboardPort = Number(env.ARI_DESKTOP_DASHBOARD_PORT || 43101);
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  const hostedDashboardUrl = normalizedHostedUrl(
    env.ARI_DESKTOP_DASHBOARD_URL || packagedConfig.dashboardUrl
  );
  const hosted = Boolean(hostedDashboardUrl);
  const dashboardUrl = hostedDashboardUrl || `http://127.0.0.1:${dashboardPort}`;
  const requestedEntryPath = String(env.ARI_DESKTOP_ENTRY_PATH || '/chat').trim();
  const dashboardEntryPath = requestedEntryPath.startsWith('/') && !requestedEntryPath.startsWith('//')
    ? requestedEntryPath
    : '/chat';
  const dashboardEntryUrl = `${dashboardUrl}${dashboardEntryPath}`;
  const desktopPhone = firstAdminPhone(env.ARI_DESKTOP_USER_PHONE) || firstAdminPhone(env.ADMIN_PHONES);
  // Public builds must always show real authentication. The phone bypass is
  // now an explicit local-QA opt-in instead of being enabled by ADMIN_PHONES.
  const bypassAuth = env.ARI_DESKTOP_AUTH_BYPASS === 'true' && Boolean(desktopPhone);
  const useDemoDatabase = env.ARI_DESKTOP_USE_DEMO_DB === 'true';
  const captureDirectory = env.ARI_DESKTOP_CAPTURE_DIR
    ? path.resolve(env.ARI_DESKTOP_CAPTURE_DIR)
    : path.join(repoRoot, '.ari', 'meeting-recordings');

  const {
    SUPABASE_URL: _supabaseUrl,
    SUPABASE_KEY: _supabaseKey,
    SUPABASE_ANON_KEY: _supabaseAnonKey,
    ...localEnv
  } = env;

  const childEnv = {
    ...localEnv,
    // dotenv will reload repository values when a key is absent. Keep these
    // explicit empty strings so desktop development cannot initialize remote
    // Supabase database/storage clients from the checked-out .env file.
    SUPABASE_URL: '',
    SUPABASE_KEY: '',
    SUPABASE_ANON_KEY: '',
    DESKTOP_MODE: 'true',
    ARI_DESKTOP_LOCAL_FILES: 'true',
    AGENTIC_MODE_ALL: 'true',
    DISABLE_BACKGROUND_JOBS: 'true',
    HEARTBEAT_ENABLED: 'false',
    PORT: String(backendPort),
    APP_BASE_URL: backendUrl,
    BOT_BASE_URL: backendUrl,
    BOT_INTERNAL_URL: backendUrl,
    DASHBOARD_BASE_URL: dashboardUrl,
    HOSTNAME: '127.0.0.1',
    // Keep desktop login local without switching the dashboard to its
    // isolated in-memory demo database. The dashboard and bot must share
    // the same conversation history for live chat to work.
    ARI_DEMO_MODE: useDemoDatabase ? 'true' : 'false',
    ARI_DESKTOP_AUTH_BYPASS: bypassAuth ? 'true' : 'false',
    ...(bypassAuth ? {
      ARI_DESKTOP_USER_PHONE: desktopPhone,
      ARI_DEMO_USER_PHONE: desktopPhone,
    } : {})
  };

  return {
    repoRoot,
    dashboardRoot: path.join(repoRoot, 'dashboard'),
    backendEntry: path.join(repoRoot, 'src', 'index.js'),
    dashboardEntry: path.join(repoRoot, 'dashboard', 'node_modules', 'next', 'dist', 'bin', 'next'),
    backendUrl,
    dashboardUrl,
    dashboardEntryUrl,
    hosted,
    desktopPhone,
    captureDirectory,
    internalTokenAvailable: Boolean(childEnv.ARI_DESKTOP_INTERNAL_TOKEN),
    useDemoDatabase,
    childEnv
  };
}

function createRuntimeConfig(repoRoot, options = {}) {
  const packagedConfig = options.packagedConfig || loadPackagedConfig(options.packagedConfigPath);
  return buildRuntimeConfig({ repoRoot, env: loadLocalEnvironment(repoRoot), packagedConfig });
}

module.exports = {
  buildRuntimeConfig,
  createRuntimeConfig,
  firstAdminPhone,
  loadLocalEnvironment,
  loadPackagedConfig,
  normalizedHostedUrl,
};
