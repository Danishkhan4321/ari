const logger = require('./logger');

/**
 * Validate required and optional environment variables at startup.
 * Logs warnings for missing optional vars, exits for missing critical vars.
 *
 * Apr 29 2026 — WhatsApp-only cleanup: dropped Discord/Telegram/Slack/GChat
 * checks (those adapters were removed). Promoted META_APP_SECRET to a hard
 * requirement in production when META_WHATSAPP_TOKEN is set, so webhook
 * signature verification can no longer be silently disabled on the
 * production box.
 */
function validateEnvironment() {
  const required = [
    { key: 'DATABASE_URL', desc: 'Supabase PostgreSQL connection string' },
    { key: 'META_WHATSAPP_TOKEN', desc: 'WhatsApp Cloud API token' },
    { key: 'META_PHONE_NUMBER_ID', desc: 'WhatsApp phone number ID' },
    { key: 'META_WEBHOOK_VERIFY_TOKEN', desc: 'WhatsApp webhook verify token' }
  ];

  // At least one AI provider must be set
  const aiKeys = ['OPENROUTER_API_KEY', 'FIREWORKS_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY'];

  const requestedProvider = String(process.env.LLM_PROVIDER || 'gemini').toLowerCase();
  const wantsVertexGemma = ['vertex', 'google_vertex', 'vertex_gemma'].includes(requestedProvider);
  const hasVertexGemma = !!(
    process.env.GOOGLE_VERTEX_PROJECT
    || process.env.GOOGLE_CLOUD_PROJECT
    || process.env.GCLOUD_PROJECT
    || process.env.GCP_PROJECT
    || process.env.VERTEX_PROJECT_ID
  );

  const optional = [
    { key: 'META_APP_SECRET', desc: 'WhatsApp webhook X-Hub-Signature-256 verification (REQUIRED in production)' },
    { key: 'GOOGLE_CLIENT_ID', desc: 'Google OAuth client ID' },
    { key: 'GOOGLE_CLIENT_SECRET', desc: 'Google OAuth client secret' },
    { key: 'GOOGLE_REDIRECT_URI', desc: 'Google OAuth redirect URI' },
    { key: 'MICROSOFT_CLIENT_ID', desc: 'Microsoft OAuth client ID' },
    { key: 'MICROSOFT_CLIENT_SECRET', desc: 'Microsoft OAuth client secret' },
    { key: 'MICROSOFT_REDIRECT_URI', desc: 'Microsoft OAuth redirect URI' },
    { key: 'GOOGLE_APPLICATION_CREDENTIALS', desc: 'Vertex AI service account JSON path, unless using ADC or workload identity' },
    { key: 'GOOGLE_VERTEX_CREDENTIALS', desc: 'Vertex AI service account JSON, raw or base64 encoded' },
    { key: 'FIREWORKS_API_KEY', desc: 'Fireworks API key for optional embedding/rerank + LLM fallback' },
    { key: 'ASSEMBLYAI_API_KEY', desc: 'AssemblyAI transcription for manual meeting recordings' },
    { key: 'R2_ENDPOINT', desc: 'Private retained meeting-recording storage endpoint' },
    { key: 'R2_ACCESS_KEY_ID', desc: 'Private retained meeting-recording storage access key' },
    { key: 'R2_SECRET_ACCESS_KEY', desc: 'Private retained meeting-recording storage secret' },
    { key: 'R2_BUCKET_NAME', desc: 'Private retained meeting-recording bucket' },
    { key: 'EXA_API_KEY', desc: 'Exa API key for live web search and lead enrichment' },
    { key: 'ENCRYPTION_KEY', desc: 'Token encryption key (32 hex chars)' },
    { key: 'UPSTASH_REDIS_REST_URL', desc: 'Upstash Redis URL (optional, uses in-memory fallback)' },
    { key: 'UPSTASH_REDIS_REST_TOKEN', desc: 'Upstash Redis token' },
    { key: 'S3_REGION', desc: 'S3-compatible region; use auto for Cloudflare R2' }
  ];

  const isProduction = process.env.NODE_ENV === 'production';
  let errors = 0;

  // Check critical vars
  for (const { key, desc } of required) {
    if (!process.env[key]) {
      logger.error(`MISSING REQUIRED: ${key} - ${desc}`);
      errors++;
    }
  }

  // Check AI provider
  if (wantsVertexGemma && !hasVertexGemma) {
    logger.error('MISSING REQUIRED: LLM_PROVIDER requests Vertex Gemma — set GOOGLE_VERTEX_PROJECT (or GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT / GCP_PROJECT / VERTEX_PROJECT_ID).');
    errors++;
  } else if (!wantsVertexGemma && !aiKeys.some(k => process.env[k]) && !hasVertexGemma) {
    logger.error(`MISSING REQUIRED: Set at least one of: ${aiKeys.join(', ')}`);
    errors++;
  }

  // Webhook signature secret must be present in production. In dev we still
  // allow it so local Meta-webhook simulation doesn't require recomputing
  // signatures, but the bot logs a clear warning either way.
  if (process.env.META_WHATSAPP_TOKEN && !process.env.META_APP_SECRET) {
    if (isProduction) {
      logger.error('MISSING REQUIRED: META_APP_SECRET must be set in production when META_WHATSAPP_TOKEN is configured (otherwise webhook signature verification is silently bypassed).');
      errors++;
    } else {
      logger.warn('META_APP_SECRET not set in dev — WhatsApp webhook X-Hub-Signature-256 verification will be skipped.');
    }
  }

  // ENCRYPTION_KEY guards all OAuth refresh tokens at rest (google_tokens,
  // microsoft_tokens). If those flows are wired up but the key is missing,
  // we'd fall back to a default key — which means an attacker who reads the
  // DB row could decrypt every user's refresh token. Require the key when
  // ANY OAuth provider is configured. (In dev we still allow the default
  // so local OAuth flows don't 500.)
  const oauthEnabled =
    !!process.env.GOOGLE_CLIENT_ID || !!process.env.MICROSOFT_CLIENT_ID;
  if (oauthEnabled && !process.env.ENCRYPTION_KEY) {
    if (isProduction) {
      logger.error('MISSING REQUIRED: ENCRYPTION_KEY must be set in production when Google/Microsoft OAuth is configured. Otherwise stored refresh tokens are encrypted with a hard-coded default key, which is equivalent to no encryption.');
      errors++;
    } else {
      logger.warn('ENCRYPTION_KEY not set in dev — OAuth refresh tokens will use the default key (insecure). Set a 32-byte hex value before going to production.');
    }
  }

  // Validate ENCRYPTION_KEY format when set. AES-256-GCM needs exactly 32
  // bytes = 64 lowercase hex chars. A wrong-length key currently surfaces
  // as a confusing "Invalid key length" error on the first OAuth use,
  // hours after boot. Fail at startup instead.
  if (process.env.ENCRYPTION_KEY) {
    const key = process.env.ENCRYPTION_KEY;
    if (!/^[0-9a-fA-F]{64}$/.test(key)) {
      logger.error(`INVALID ENCRYPTION_KEY: must be 64 hex characters (32 bytes). Got ${key.length} chars. Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`);
      errors++;
    }
  }

  if (errors > 0) {
    logger.error(`${errors} required environment variable(s) missing. Cannot start.`);
    process.exit(1);
  }

  // Warn about optional vars
  const missing = optional.filter(o => !process.env[o.key]);
  if (missing.length > 0) {
    logger.info(`Optional env vars not set (features disabled): ${missing.map(m => m.key).join(', ')}`);
  }

  // Note: the ENCRYPTION_KEY warning is now emitted up-front in the
  // OAuth-required check above, so we don't repeat it here.

  logger.info('Environment validation passed');
}

module.exports = { validateEnvironment };
