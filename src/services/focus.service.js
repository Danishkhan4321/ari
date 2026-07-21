const { query } = require('../config/database');
const logger = require('../utils/logger');

class FocusService {

  constructor() {
    this.tablesCreated = false;
  }

  async ensureSchema() {
    if (this.tablesCreated) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS focus_sessions (
          id SERIAL PRIMARY KEY,
          user_phone VARCHAR(50) NOT NULL,
          start_time TIMESTAMP NOT NULL DEFAULT NOW(),
          end_time TIMESTAMP,
          duration_mins INTEGER NOT NULL DEFAULT 25,
          mode VARCHAR(20) DEFAULT 'focus',
          status VARCHAR(20) DEFAULT 'active',
          label VARCHAR(255),
          tasks_completed TEXT,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_focus_sessions_user ON focus_sessions(user_phone)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_focus_sessions_status ON focus_sessions(status)`);

      this.tablesCreated = true;
    } catch (error) {
      logger.error('Error creating focus_sessions table:', error.message);
    }
  }

  // Lightweight check used by background jobs (daily briefing, auto-update,
  // sprint updates) to skip non-time-critical sends while the user is in
  // focus mode. We INTENTIONALLY do not gate reminders / tasks / calendar
  // alerts — those are user-scheduled and must fire on time. Only the
  // "noise" categories defer. Safe to call without await-ing in a hot path:
  // it's a single indexed query and never throws (errors fail-open to
  // "not in focus" so a brief DB hiccup doesn't suppress every send).
  async isActive(userPhone) {
    if (!userPhone) return false;
    try {
      const result = await query(
        `SELECT 1 FROM focus_sessions
          WHERE user_phone = $1
            AND status = 'active'
            AND (end_time IS NULL OR end_time > NOW())
            AND (start_time + (duration_mins * INTERVAL '1 minute')) > NOW()
          LIMIT 1`,
        [userPhone]
      );
      return result.rows.length > 0;
    } catch (e) {
      // Table may not exist yet on a fresh install — log debug and return false.
      logger.debug(`[Focus] isActive check failed (fail-open): ${e.message}`);
      return false;
    }
  }

  async startSession(userPhone, durationMins = 25, mode = 'focus', label = null) {
    await this.ensureSchema();
    try {
      // Check if user already has an active session
      const active = await this.getActiveSession(userPhone);
      if (active) {
        return { success: false, error: 'You already have an active focus session. End it first with "end focus".' };
      }

      const result = await query(
        `INSERT INTO focus_sessions (user_phone, duration_mins, mode, label, status)
         VALUES ($1, $2, $3, $4, 'active')
         RETURNING *`,
        [userPhone, durationMins, mode, label]
      );

      return { success: true, session: result.rows[0] };
    } catch (error) {
      logger.error('Error starting focus session:', error.message);
      return { success: false, error: error.message };
    }
  }

  async endSession(userPhone) {
    await this.ensureSchema();
    try {
      const active = await this.getActiveSession(userPhone);
      if (!active) {
        return { success: false, error: 'No active focus session found.' };
      }

      const result = await query(
        `UPDATE focus_sessions
         SET status = 'completed', end_time = NOW()
         WHERE id = $1
         RETURNING *`,
        [active.id]
      );

      const session = result.rows[0];
      const startTime = new Date(session.start_time);
      const endTime = new Date(session.end_time);
      const actualDurationMins = Math.round((endTime - startTime) / (1000 * 60));

      return { success: true, session, actualDurationMins };
    } catch (error) {
      logger.error('Error ending focus session:', error.message);
      return { success: false, error: error.message };
    }
  }

  async getActiveSession(userPhone) {
    await this.ensureSchema();
    try {
      const result = await query(
        `SELECT * FROM focus_sessions WHERE status = 'active' AND user_phone = $1`,
        [userPhone]
      );
      return result.rows[0] || null;
    } catch (error) {
      logger.error('Error getting active focus session:', error.message);
      return null;
    }
  }

  async getStats(userPhone, period = 'today') {
    await this.ensureSchema();
    try {
      let dateFilter;
      switch (period) {
        case 'week':
          dateFilter = `AND start_time >= NOW() - INTERVAL '7 days'`;
          break;
        case 'month':
          dateFilter = `AND start_time >= NOW() - INTERVAL '30 days'`;
          break;
        case 'today':
        default:
          dateFilter = `AND start_time >= CURRENT_DATE`;
          break;
      }

      const result = await query(
        `SELECT
           COUNT(*) AS total_sessions,
           COALESCE(SUM(
             EXTRACT(EPOCH FROM (COALESCE(end_time, NOW()) - start_time)) / 60
           ), 0) AS total_minutes,
           COALESCE(AVG(
             EXTRACT(EPOCH FROM (COALESCE(end_time, NOW()) - start_time)) / 60
           ), 0) AS avg_duration,
           COALESCE(MAX(
             EXTRACT(EPOCH FROM (COALESCE(end_time, NOW()) - start_time)) / 60
           ), 0) AS longest_session
         FROM focus_sessions
         WHERE user_phone = $1 AND status = 'completed' ${dateFilter}`,
        [userPhone]
      );

      const row = result.rows[0];
      return {
        totalSessions: parseInt(row.total_sessions),
        totalMinutes: Math.round(parseFloat(row.total_minutes)),
        avgDuration: Math.round(parseFloat(row.avg_duration)),
        longestSession: Math.round(parseFloat(row.longest_session))
      };
    } catch (error) {
      logger.error('Error getting focus stats:', error.message);
      return { totalSessions: 0, totalMinutes: 0, avgDuration: 0, longestSession: 0 };
    }
  }

  async getExpiredSessions() {
    await this.ensureSchema();
    try {
      const result = await query(
        `SELECT * FROM focus_sessions
         WHERE status = 'active'
         AND NOW() > start_time + (duration_mins * INTERVAL '1 minute')`
      );
      return result.rows;
    } catch (error) {
      logger.error('Error getting expired focus sessions:', error.message);
      return [];
    }
  }

  async completeExpiredSession(sessionId) {
    await this.ensureSchema();
    try {
      const result = await query(
        `UPDATE focus_sessions
         SET status = 'completed', end_time = start_time + (duration_mins * INTERVAL '1 minute')
         WHERE id = $1
         RETURNING *`,
        [sessionId]
      );
      return result.rows[0] || null;
    } catch (error) {
      logger.error('Error completing expired focus session:', error.message);
      return null;
    }
  }
}

module.exports = new FocusService();
