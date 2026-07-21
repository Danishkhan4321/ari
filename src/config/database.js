const { Pool } = require('pg');
const logger = require('../utils/logger');

const isProduction = process.env.NODE_ENV === 'production';

// ── SSL Configuration ────────────────────────────────────────────────────────
// Production: always require SSL to prevent cleartext credentials on the wire.
// Development: allow non-SSL connections for local Postgres.
function buildSslConfig() {
  const dbUrl = process.env.DATABASE_URL || '';

  if (
    process.env.DATABASE_SSL === 'false' ||
    process.env.PGSSLMODE === 'disable' ||
    dbUrl.includes('sslmode=disable')
  ) {
    return false;
  }

  // Production always uses SSL
  return {
    // Supabase pooler uses certificates not in Node's CA bundle — must be false for pooler connections
    rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true'
  };
}

// ── Connection pool ──────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: buildSslConfig(),
  max: parseInt(process.env.DB_POOL_MAX) || 50,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  // Prevent leaking DB info in stack traces
  application_name: 'ari'
});

// ── Connection events ────────────────────────────────────────────────────────
pool.on('connect', (client) => {
  logger.info('Connected to Supabase PostgreSQL');

  // Log whether the connection is using SSL (one-time check)
  if (isProduction && buildSslConfig() && client.connection && client.connection.stream) {
    const encrypted = client.connection.stream.encrypted === true;
    if (!encrypted) {
      logger.security('db_unencrypted_connection', {
        message: 'Database connection is NOT using SSL in production'
      });
    }
  }
});

pool.on('error', (err) => {
  logger.error('PostgreSQL pool error: ' + err.message);
  logger.security('db_pool_error', { error: err.message });
});

// ── Slow query tracking ──────────────────────────────────────────────────────
const SLOW_QUERY_MS = parseInt(process.env.SLOW_QUERY_MS || '5000', 10);

// ── Schema bootstrap ─────────────────────────────────────────────────────
// Apr 29 2026 — initializeDatabase() body removed. It was never called from
// any startup path (only exported), and the inline CREATE TABLE / CREATE
// INDEX statements had drifted away from the real production schema:
//   • users     — old shape (id SERIAL + phone_number) instead of the
//                 migration shape
//   • reminders — old columns (remind_at, is_completed, is_sent,
//                 recurrence) that no longer exist; one of the indexes
//                 referenced reminder_time / next_occurrence and would
//                 have errored on a fresh DB
// Source of truth for schema:           migrations/*.js
// Source of truth for live ALTER TABLE: per-service ensureSchema() methods
// To bootstrap a fresh DB:              npm run migrate
//
// The function is kept as an exported no-op so any out-of-tree caller
// (e.g. a one-off script) keeps working without crashing.
async function initializeDatabase() {
  return; // intentional no-op — see comment above
}

// Query helper — with slow query logging
async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    logger.debug(`Query executed in ${duration}ms`);

    // Flag slow queries in production
    if (duration > SLOW_QUERY_MS) {
      logger.warn({
        message: 'slow_query',
        duration: `${duration}ms`,
        // Log first 200 chars of query text (no params — they may contain PII)
        query: text.substring(0, 200)
      });
    }

    return result;
  } catch (error) {
    const duration = Date.now() - start;
    logger.error({
      message: 'Database query error',
      error: error.message,
      duration: `${duration}ms`,
      query: text.substring(0, 200)
    });
    throw error;
  }
}

module.exports = {
  pool,
  query,
  initializeDatabase
};
