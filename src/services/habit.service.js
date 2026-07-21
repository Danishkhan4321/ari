const { query } = require('../config/database');
const logger = require('../utils/logger');

class HabitService {

  constructor() {
    this.tablesCreated = false;
  }

  async ensureSchema() {
    if (this.tablesCreated) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS habits (
          id SERIAL PRIMARY KEY,
          user_phone VARCHAR(50) NOT NULL,
          name VARCHAR(255) NOT NULL,
          frequency VARCHAR(20) DEFAULT 'daily',
          target_count INTEGER DEFAULT 1,
          reminder_time VARCHAR(10),
          active BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_habits_user ON habits(user_phone)`);

      await query(`
        CREATE TABLE IF NOT EXISTS habit_logs (
          id SERIAL PRIMARY KEY,
          habit_id INTEGER REFERENCES habits(id) ON DELETE CASCADE,
          user_phone VARCHAR(50) NOT NULL,
          completed_at TIMESTAMP DEFAULT NOW(),
          notes TEXT
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_habit_logs_habit ON habit_logs(habit_id)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_habit_logs_user ON habit_logs(user_phone)`);

      this.tablesCreated = true;
    } catch (error) {
      logger.error('Error creating habit tables:', error.message);
    }
  }

  async addHabit(userPhone, name, frequency = 'daily', targetCount = 1, reminderTime = null) {
    await this.ensureSchema();
    try {
      const result = await query(
        `INSERT INTO habits (user_phone, name, frequency, target_count, reminder_time)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [userPhone, name, frequency, targetCount, reminderTime]
      );
      return { success: true, habit: result.rows[0] };
    } catch (error) {
      logger.error('Error adding habit:', error.message);
      return { success: false, error: error.message };
    }
  }

  async logHabit(userPhone, habitName, notes = null) {
    await this.ensureSchema();
    try {
      // Find habit by name (case insensitive)
      const habitResult = await query(
        `SELECT * FROM habits WHERE user_phone = $1 AND LOWER(name) = LOWER($2) AND active = true`,
        [userPhone, habitName]
      );

      if (habitResult.rows.length === 0) {
        return { success: false, error: `Habit "${habitName}" not found.` };
      }

      const habit = habitResult.rows[0];

      const logResult = await query(
        `INSERT INTO habit_logs (habit_id, user_phone, notes)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [habit.id, userPhone, notes]
      );

      return { success: true, habit, log: logResult.rows[0] };
    } catch (error) {
      logger.error('Error logging habit:', error.message);
      return { success: false, error: error.message };
    }
  }

  async getHabits(userPhone) {
    await this.ensureSchema();
    try {
      const result = await query(
        `SELECT * FROM habits WHERE user_phone = $1 AND active = true ORDER BY created_at ASC`,
        [userPhone]
      );
      return result.rows;
    } catch (error) {
      logger.error('Error getting habits:', error.message);
      return [];
    }
  }

  async deleteHabit(userPhone, habitName) {
    await this.ensureSchema();
    try {
      const result = await query(
        `UPDATE habits SET active = false WHERE user_phone = $1 AND LOWER(name) = LOWER($2) AND active = true RETURNING *`,
        [userPhone, habitName]
      );

      if (result.rowCount === 0) {
        return { success: false, error: `Habit "${habitName}" not found.` };
      }

      return { success: true, habit: result.rows[0] };
    } catch (error) {
      logger.error('Error deleting habit:', error.message);
      return { success: false, error: error.message };
    }
  }

  async getHabitStats(userPhone, habitName) {
    await this.ensureSchema();
    try {
      // Find the habit
      const habitResult = await query(
        `SELECT * FROM habits WHERE user_phone = $1 AND LOWER(name) = LOWER($2) AND active = true`,
        [userPhone, habitName]
      );

      if (habitResult.rows.length === 0) {
        return { success: false, error: `Habit "${habitName}" not found.` };
      }

      const habit = habitResult.rows[0];

      // Total completions
      const totalResult = await query(
        `SELECT COUNT(*) AS total FROM habit_logs WHERE habit_id = $1`,
        [habit.id]
      );
      const totalCompletions = parseInt(totalResult.rows[0].total);

      // This week count
      const weekResult = await query(
        `SELECT COUNT(*) AS count FROM habit_logs
         WHERE habit_id = $1 AND completed_at >= DATE_TRUNC('week', CURRENT_DATE)`,
        [habit.id]
      );
      const thisWeekCount = parseInt(weekResult.rows[0].count);

      // This month count
      const monthResult = await query(
        `SELECT COUNT(*) AS count FROM habit_logs
         WHERE habit_id = $1 AND completed_at >= DATE_TRUNC('month', CURRENT_DATE)`,
        [habit.id]
      );
      const thisMonthCount = parseInt(monthResult.rows[0].count);

      // Streak: count consecutive days backward from today with at least one log
      const streakResult = await query(
        `SELECT DISTINCT DATE(completed_at) AS log_date
         FROM habit_logs
         WHERE habit_id = $1
         ORDER BY log_date DESC`,
        [habit.id]
      );

      let streak = 0;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      let checkDate = new Date(today);

      for (const row of streakResult.rows) {
        const logDate = new Date(row.log_date);
        logDate.setHours(0, 0, 0, 0);

        if (logDate.getTime() === checkDate.getTime()) {
          streak++;
          checkDate.setDate(checkDate.getDate() - 1);
        } else if (logDate.getTime() < checkDate.getTime()) {
          // Gap found, streak is broken
          break;
        }
      }

      return {
        success: true,
        habit,
        streak,
        totalCompletions,
        thisWeekCount,
        thisMonthCount
      };
    } catch (error) {
      logger.error('Error getting habit stats:', error.message);
      return { success: false, error: error.message };
    }
  }

  async getAllStats(userPhone) {
    await this.ensureSchema();
    try {
      const habits = await this.getHabits(userPhone);
      const stats = [];

      for (const habit of habits) {
        const result = await this.getHabitStats(userPhone, habit.name);
        if (result.success) {
          stats.push({
            name: habit.name,
            frequency: habit.frequency,
            streak: result.streak,
            totalCompletions: result.totalCompletions,
            thisWeekCount: result.thisWeekCount,
            thisMonthCount: result.thisMonthCount
          });
        }
      }

      return stats;
    } catch (error) {
      logger.error('Error getting all habit stats:', error.message);
      return [];
    }
  }

  async getUnloggedHabits(userPhone) {
    await this.ensureSchema();
    try {
      const result = await query(
        `SELECT h.* FROM habits h
         WHERE h.user_phone = $1 AND h.active = true
         AND NOT EXISTS (
           SELECT 1 FROM habit_logs hl
           WHERE hl.habit_id = h.id AND DATE(hl.completed_at) = CURRENT_DATE
         )
         ORDER BY h.name`,
        [userPhone]
      );
      return result.rows;
    } catch (error) {
      logger.error('Error getting unlogged habits:', error.message);
      return [];
    }
  }

  async getAllDistinctUserPhones() {
    await this.ensureSchema();
    try {
      const result = await query(
        `SELECT DISTINCT user_phone FROM habits WHERE active = true`
      );
      return result.rows.map(r => r.user_phone);
    } catch (error) {
      logger.error('Error getting distinct user phones:', error.message);
      return [];
    }
  }

  /**
   * Apr 29 2026 — collapse the cron's N+1 query pattern.
   *
   * The unlogged-habit reminder job used to do:
   *   1× SELECT DISTINCT user_phone   (the method above)
   *   N× per-user "habits without a log today" subquery (getUnloggedHabits)
   *
   * Over the Supabase pooler that's ~30-100ms wasted round-trip per user.
   * This JOIN-style query returns the same data in one round-trip, grouped
   * by user_phone in JS. Returns: Map<user_phone, Array<habit_row>>.
   *
   * The per-user `getUnloggedHabits(userPhone)` method above is preserved
   * for callers (e.g. interactive `/habits today` lookups) that still want
   * a one-user query.
   */
  async getAllUnloggedHabitsByUser() {
    await this.ensureSchema();
    try {
      const result = await query(
        `SELECT h.*
           FROM habits h
          WHERE h.active = true
            AND NOT EXISTS (
              SELECT 1 FROM habit_logs hl
               WHERE hl.habit_id = h.id
                 AND DATE(hl.completed_at) = CURRENT_DATE
            )
          ORDER BY h.user_phone, h.name`
      );
      const grouped = new Map();
      for (const row of result.rows) {
        const list = grouped.get(row.user_phone) || [];
        list.push(row);
        grouped.set(row.user_phone, list);
      }
      return grouped;
    } catch (error) {
      logger.error('Error getting unlogged habits (all users):', error.message);
      return new Map();
    }
  }

  async getHabitsWithReminders() {
    await this.ensureSchema();
    try {
      const result = await query(
        `SELECT h.* FROM habits h
         WHERE h.active = true AND h.reminder_time IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM habit_logs hl
           WHERE hl.habit_id = h.id AND DATE(hl.completed_at) = CURRENT_DATE
         )
         ORDER BY h.user_phone, h.reminder_time`
      );
      return result.rows;
    } catch (error) {
      logger.error('Error getting habits with reminders:', error.message);
      return [];
    }
  }
}

module.exports = new HabitService();
