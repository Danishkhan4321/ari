/**
 * Audit log — append-only record of sensitive actions.
 *
 * Until May 19 2026 there was no auditability of:
 *   - admin-bypass grants (ADMIN_PHONES env var)
 *   - plan upgrades / downgrades / cache invalidations
 *   - dashboard chat impersonation attempts
 *   - account-link claims
 *   - meeting EC2 launches & terminations
 *   - failed signature verifications on the meeting callback
 *
 * If something goes wrong (a leaked secret, a billing dispute, a runaway
 * EC2 burn), there's no way to reconstruct who did what when. This module
 * gives every sensitive code path a one-liner to log into a tamper-evident
 * append-only table.
 *
 * Design:
 *   - Single table `audit_log` with (id, ts, actor_phone, action, target,
 *     metadata JSONB, ip). No update or delete; ROW-LEVEL safety is enforced
 *     by convention (we never UPDATE/DELETE here).
 *   - Async fire-and-forget: never blocks the caller's hot path.
 *   - Schema auto-created at first use.
 *
 * Retention is a follow-up — for now it grows. With ~5KB per row and the
 * actions we're logging, ~1M rows/year ≈ 5GB. Acceptable.
 */
const { query } = require('../config/database');
const logger = require('../utils/logger');

let schemaReady = false;
let schemaInFlight = null;

async function ensureSchema() {
  if (schemaReady) return;
  if (schemaInFlight) return schemaInFlight;
  schemaInFlight = (async () => {
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id BIGSERIAL PRIMARY KEY,
          ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          actor_phone VARCHAR(50),
          action VARCHAR(80) NOT NULL,
          target VARCHAR(200),
          metadata JSONB,
          ip VARCHAR(64)
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts DESC)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_phone, ts DESC)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action, ts DESC)`);
      schemaReady = true;
    } catch (e) {
      logger.warn(`[AuditLog] Schema ensure failed: ${e.message}`);
    } finally {
      schemaInFlight = null;
    }
  })();
  return schemaInFlight;
}

/**
 * Record a sensitive action. Fire-and-forget by default — the caller does not
 * await unless they specifically want write confirmation.
 *
 * @param {string} action       Short code, e.g. 'plan_change', 'admin_grant',
 *                              'meeting_launch', 'meeting_callback_unsigned'.
 * @param {object} opts
 * @param {string} [opts.actor] Who did it (phone or 'system'/'cron'/'dashboard').
 * @param {string} [opts.target] What it touched (a phone, an instance id, a meeting id).
 * @param {object} [opts.meta]  Free-form context object — serialized as JSONB.
 * @param {string} [opts.ip]    Source IP if applicable.
 */
function log(action, opts = {}) {
  if (!action) return;
  // Fire-and-forget; capture errors silently — audit log must never break
  // the action it's logging.
  (async () => {
    try {
      await ensureSchema();
      await query(
        `INSERT INTO audit_log (actor_phone, action, target, metadata, ip)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          opts.actor || null,
          action,
          opts.target || null,
          opts.meta ? JSON.stringify(opts.meta) : null,
          opts.ip || null,
        ]
      );
    } catch (e) {
      logger.warn(`[AuditLog] Write failed (${action}): ${e.message}`);
    }
  })();
}

/**
 * Recent audit entries — for /debug or ops dashboards.
 *
 * M5-N hardening (Batch F5): the read API was previously unauth — any
 * caller could enumerate admin grants, plan changes, EC2 launches.
 * Callers MUST now pass `requestor: { phone, isAdmin }` to identify
 * themselves. Non-admins only see rows where they are the actor or
 * target. The ADMIN_TEST_KEY-gated /debug HTTP route is allowed to
 * pass `isAdmin: true` after key verification.
 *
 * @param {object} opts
 * @param {number} [opts.limit=50]
 * @param {string|null} [opts.action]
 * @param {string|null} [opts.actor]
 * @param {{phone?: string, isAdmin?: boolean}} [opts.requestor]
 */
async function recent({ limit = 50, action = null, actor = null, requestor = null } = {}) {
  try {
    await ensureSchema();
    const params = [];
    const where = [];
    if (action) { params.push(action); where.push(`action = $${params.length}`); }
    if (actor)  { params.push(actor);  where.push(`actor_phone = $${params.length}`); }

    // Scope: admins see everything; everyone else sees only their own
    // history. If no requestor is provided at all (legacy callers), we
    // refuse — safer to fail closed than leak.
    if (!requestor) {
      logger.warn('[AuditLog] recent() called without requestor — refusing');
      return [];
    }
    if (!requestor.isAdmin) {
      if (!requestor.phone) {
        logger.warn('[AuditLog] recent() called by non-admin without phone — refusing');
        return [];
      }
      params.push(requestor.phone);
      const idx = params.length;
      where.push(`(actor_phone = $${idx} OR target = $${idx})`);
    }

    params.push(Math.min(500, Math.max(1, parseInt(limit, 10) || 50)));
    const limitClause = `LIMIT $${params.length}`;
    const sql = `SELECT id, ts, actor_phone, action, target, metadata, ip
                   FROM audit_log
                  ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                  ORDER BY ts DESC
                  ${limitClause}`;
    const r = await query(sql, params);
    return r.rows;
  } catch (e) {
    logger.warn(`[AuditLog] recent() failed: ${e.message}`);
    return [];
  }
}

module.exports = { log, recent, ensureSchema };
