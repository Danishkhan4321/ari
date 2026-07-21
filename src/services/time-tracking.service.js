const { query } = require('../config/database');
const logger = require('../utils/logger');

class TimeTrackingService {

  constructor() {
    this.schemaReady = false;
  }

  // ========== SCHEMA ==========
  async ensureSchema() {
    if (this.schemaReady) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS time_entries (
          id SERIAL PRIMARY KEY,
          user_phone VARCHAR(50) NOT NULL,
          task_description VARCHAR(500),
          project VARCHAR(255),
          start_time TIMESTAMP NOT NULL DEFAULT NOW(),
          end_time TIMESTAMP,
          duration_mins INTEGER,
          category VARCHAR(50),
          status VARCHAR(20) DEFAULT 'running',
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_time_entries_user ON time_entries(user_phone)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_time_entries_status ON time_entries(user_phone, status)`);
      this.schemaReady = true;
    } catch (error) {
      logger.error('Error creating time_entries table:', error.message);
    }
  }

  // ========== START TIMER ==========
  async startTimer(userPhone, taskDescription, project = null, category = null) {
    await this.ensureSchema();
    try {
      // Check if user already has a running timer
      const existing = await query(
        `SELECT * FROM time_entries WHERE user_phone = $1 AND status = 'running' LIMIT 1`,
        [userPhone]
      );

      if (existing.rows.length > 0) {
        return {
          success: false,
          error: 'You already have a running timer.',
          activeTimer: existing.rows[0]
        };
      }

      const result = await query(
        `INSERT INTO time_entries (user_phone, task_description, project, category, status)
         VALUES ($1, $2, $3, $4, 'running')
         RETURNING *`,
        [userPhone, taskDescription, project, category]
      );

      return { success: true, entry: result.rows[0] };
    } catch (error) {
      logger.error('Error starting timer:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ========== STOP TIMER ==========
  async stopTimer(userPhone) {
    await this.ensureSchema();
    try {
      // Find the running timer
      const running = await query(
        `SELECT * FROM time_entries WHERE user_phone = $1 AND status = 'running' LIMIT 1`,
        [userPhone]
      );

      if (running.rows.length === 0) {
        return { success: false, error: 'No running timer found.' };
      }

      const entry = running.rows[0];

      const result = await query(
        `UPDATE time_entries
         SET end_time = NOW(),
             duration_mins = EXTRACT(EPOCH FROM (NOW() - start_time)) / 60,
             status = 'completed'
         WHERE id = $1
         RETURNING *`,
        [entry.id]
      );

      return { success: true, entry: result.rows[0] };
    } catch (error) {
      logger.error('Error stopping timer:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ========== GET ACTIVE TIMER ==========
  async getActiveTimer(userPhone) {
    await this.ensureSchema();
    try {
      const result = await query(
        `SELECT * FROM time_entries WHERE user_phone = $1 AND status = 'running' LIMIT 1`,
        [userPhone]
      );
      const timer = result.rows[0] || null;
      if (timer) {
        const elapsed = Math.round((Date.now() - new Date(timer.start_time).getTime()) / 60000);
        return { success: true, timer, elapsed };
      }
      return { success: true, timer: null };
    } catch (error) {
      logger.error('Error getting active timer:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ========== GET ENTRIES ==========
  async getEntries(userPhone, period = 'today') {
    await this.ensureSchema();
    try {
      const dateFilter = this._getPeriodFilter(period);
      const result = await query(
        `SELECT * FROM time_entries
         WHERE user_phone = $1 AND start_time >= $2
         ORDER BY start_time DESC`,
        [userPhone, dateFilter]
      );
      return { success: true, entries: result.rows };
    } catch (error) {
      logger.error('Error getting time entries:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ========== GET SUMMARY ==========
  async getSummary(userPhone, period = 'today') {
    await this.ensureSchema();
    try {
      const dateFilter = this._getPeriodFilter(period);

      // Total minutes and entry count
      const totalResult = await query(
        `SELECT
           COALESCE(SUM(duration_mins), 0) AS total_minutes,
           COUNT(*) AS entry_count
         FROM time_entries
         WHERE user_phone = $1 AND start_time >= $2 AND status = 'completed'`,
        [userPhone, dateFilter]
      );

      const totalMinutes = Math.round(parseFloat(totalResult.rows[0].total_minutes));
      const totalHours = parseFloat((totalMinutes / 60).toFixed(2));
      const entryCount = parseInt(totalResult.rows[0].entry_count);

      // Project breakdown
      const projectResult = await query(
        `SELECT
           COALESCE(project, 'No Project') AS project,
           SUM(duration_mins) AS minutes
         FROM time_entries
         WHERE user_phone = $1 AND start_time >= $2 AND status = 'completed'
         GROUP BY project
         ORDER BY minutes DESC`,
        [userPhone, dateFilter]
      );

      const projectBreakdown = projectResult.rows.map(row => {
        const minutes = Math.round(parseFloat(row.minutes));
        return {
          project: row.project,
          minutes,
          percentage: totalMinutes > 0 ? parseFloat(((minutes / totalMinutes) * 100).toFixed(1)) : 0
        };
      });

      // Category breakdown
      const categoryResult = await query(
        `SELECT
           COALESCE(category, 'Uncategorized') AS category,
           SUM(duration_mins) AS minutes
         FROM time_entries
         WHERE user_phone = $1 AND start_time >= $2 AND status = 'completed'
         GROUP BY category
         ORDER BY minutes DESC`,
        [userPhone, dateFilter]
      );

      const categoryBreakdown = categoryResult.rows.map(row => ({
        category: row.category,
        minutes: Math.round(parseFloat(row.minutes))
      }));

      return {
        success: true,
        summary: {
          totalMinutes,
          totalHours,
          byProject: projectBreakdown,
          byCategory: categoryBreakdown,
          entryCount
        }
      };
    } catch (error) {
      logger.error('Error getting time tracking summary:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ========== GET PROJECT SUMMARY ==========
  async getProjectSummary(userPhone, project, period = 'week') {
    await this.ensureSchema();
    try {
      const dateFilter = this._getPeriodFilter(period);

      const totalResult = await query(
        `SELECT
           COALESCE(SUM(duration_mins), 0) AS total_minutes,
           COUNT(*) AS entry_count
         FROM time_entries
         WHERE user_phone = $1 AND LOWER(project) = LOWER($2) AND start_time >= $3 AND status = 'completed'`,
        [userPhone, project, dateFilter]
      );

      const totalMinutes = Math.round(parseFloat(totalResult.rows[0].total_minutes));
      const totalHours = parseFloat((totalMinutes / 60).toFixed(2));
      const entryCount = parseInt(totalResult.rows[0].entry_count);

      // Task breakdown within the project
      const taskResult = await query(
        `SELECT
           task_description,
           SUM(duration_mins) AS minutes
         FROM time_entries
         WHERE user_phone = $1 AND LOWER(project) = LOWER($2) AND start_time >= $3 AND status = 'completed'
         GROUP BY task_description
         ORDER BY minutes DESC`,
        [userPhone, project, dateFilter]
      );

      const taskBreakdown = taskResult.rows.map(row => ({
        task: row.task_description,
        minutes: Math.round(parseFloat(row.minutes))
      }));

      // Category breakdown within the project
      const categoryResult = await query(
        `SELECT
           COALESCE(category, 'Uncategorized') AS category,
           SUM(duration_mins) AS minutes
         FROM time_entries
         WHERE user_phone = $1 AND LOWER(project) = LOWER($2) AND start_time >= $3 AND status = 'completed'
         GROUP BY category
         ORDER BY minutes DESC`,
        [userPhone, project, dateFilter]
      );

      const categoryBreakdown = categoryResult.rows.map(row => ({
        category: row.category,
        minutes: Math.round(parseFloat(row.minutes))
      }));

      return {
        project,
        totalMinutes,
        totalHours,
        entryCount,
        taskBreakdown,
        categoryBreakdown
      };
    } catch (error) {
      logger.error('Error getting project summary:', error.message);
      return { project, totalMinutes: 0, totalHours: 0, entryCount: 0, taskBreakdown: [], categoryBreakdown: [] };
    }
  }

  // ========== HELPERS ==========
  _getPeriodFilter(period) {
    const now = new Date();
    switch (period) {
      case 'today':
        return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      case 'week': {
        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() - now.getDay());
        weekStart.setHours(0, 0, 0, 0);
        return weekStart.toISOString();
      }
      case 'month':
        return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      default:
        return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    }
  }
}

module.exports = new TimeTrackingService();
