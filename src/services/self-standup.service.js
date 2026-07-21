const { query } = require('../config/database');
const logger = require('../utils/logger');

class SelfStandupService {

  constructor() {
    this.schemaReady = false;
  }

  // ========== SCHEMA ==========
  async ensureSchema() {
    if (this.schemaReady) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS self_standups (
          id SERIAL PRIMARY KEY,
          user_phone VARCHAR(50) NOT NULL,
          date DATE DEFAULT CURRENT_DATE,
          yesterday_done TEXT,
          today_plan TEXT,
          blockers TEXT,
          mood VARCHAR(20),
          energy_level INTEGER,
          created_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(user_phone, date)
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_self_standups_user ON self_standups(user_phone)`);
      this.schemaReady = true;
    } catch (error) {
      logger.error('Error creating self_standups table:', error.message);
    }
  }

  // ========== LOG STANDUP ==========
  async logStandup(userPhone, yesterdayDone, todayPlan, blockers = null, mood = null, energyLevel = null) {
    await this.ensureSchema();
    try {
      const result = await query(
        `INSERT INTO self_standups (user_phone, date, yesterday_done, today_plan, blockers, mood, energy_level)
         VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6)
         ON CONFLICT (user_phone, date)
         DO UPDATE SET
           yesterday_done = $2,
           today_plan = $3,
           blockers = $4,
           mood = $5,
           energy_level = $6
         RETURNING *`,
        [userPhone, yesterdayDone, todayPlan, blockers, mood, energyLevel]
      );

      return { success: true, standup: result.rows[0] };
    } catch (error) {
      logger.error('Error logging self standup:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ========== GET TODAY ==========
  async getToday(userPhone) {
    await this.ensureSchema();
    try {
      const result = await query(
        `SELECT * FROM self_standups WHERE user_phone = $1 AND date = CURRENT_DATE`,
        [userPhone]
      );
      return result.rows[0] || null;
    } catch (error) {
      logger.error('Error getting today standup:', error.message);
      return null;
    }
  }

  // ========== GET HISTORY ==========
  async getHistory(userPhone, days = 7) {
    await this.ensureSchema();
    try {
      const result = await query(
        `SELECT * FROM self_standups
         WHERE user_phone = $1 AND date >= CURRENT_DATE - $2::INTEGER
         ORDER BY date DESC`,
        [userPhone, days]
      );
      return result.rows;
    } catch (error) {
      logger.error('Error getting standup history:', error.message);
      return [];
    }
  }

  // ========== WEEKLY REFLECTION ==========
  async getWeeklyReflection(userPhone) {
    await this.ensureSchema();
    try {
      // Get this week's standups (Monday to Friday)
      const result = await query(
        `SELECT * FROM self_standups
         WHERE user_phone = $1 AND date >= DATE_TRUNC('week', CURRENT_DATE)
         ORDER BY date ASC`,
        [userPhone]
      );

      const standups = result.rows;

      // Completion rate: how many days logged out of weekdays so far
      const now = new Date();
      const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat
      const weekdaysElapsed = dayOfWeek === 0 ? 5 : dayOfWeek === 6 ? 5 : dayOfWeek;
      const completionRate = weekdaysElapsed > 0
        ? parseFloat(((standups.length / weekdaysElapsed) * 100).toFixed(1))
        : 0;

      // Collect all blockers
      const topBlockers = standups
        .filter(s => s.blockers && s.blockers.trim().length > 0)
        .map(s => s.blockers);

      // Mood trend
      const moodTrend = standups
        .filter(s => s.mood)
        .map(s => ({
          date: s.date,
          mood: s.mood,
          energyLevel: s.energy_level
        }));

      return {
        standups,
        completionRate,
        topBlockers,
        moodTrend
      };
    } catch (error) {
      logger.error('Error getting weekly reflection:', error.message);
      return { standups: [], completionRate: 0, topBlockers: [], moodTrend: [] };
    }
  }

  // ========== PARSE STANDUP FROM TEXT ==========
  parseStandupFromText(text) {
    try {
      const lower = text.toLowerCase().trim();

      let yesterdayDone = null;
      let todayPlan = null;
      let blockers = null;
      let mood = null;

      // Pattern 1: "yesterday: X, today: Y, blockers: Z"
      const yesterdayMatch = text.match(/(?:yesterday|done|completed|did|finished)\s*[:]\s*(.+?)(?=(?:\.|,)?\s*(?:today|plan|blockers?|stuck|impediment)|$)/i);
      if (yesterdayMatch) {
        yesterdayDone = yesterdayMatch[1].trim().replace(/[,.]$/, '').trim();
      }

      const todayMatch = text.match(/(?:today|plan|planning|will do|going to|working on)\s*[:]\s*(.+?)(?=(?:\.|,)?\s*(?:blockers?|stuck|impediment|yesterday|done)|$)/i);
      if (todayMatch) {
        todayPlan = todayMatch[1].trim().replace(/[,.]$/, '').trim();
      }

      const blockerMatch = text.match(/(?:blockers?|stuck|impediment|blocked by|stuck on)\s*[:]\s*(.+?)$/i);
      if (blockerMatch) {
        const blockerText = blockerMatch[1].trim().replace(/[,.]$/, '').trim();
        blockers = /^(none|no|nope|nah|nothing|nil|na|n\/a)$/i.test(blockerText) ? null : blockerText;
      }

      // Pattern 2: "done: A, B, C. plan: X, Y. stuck on: Z"
      if (!yesterdayDone) {
        const doneMatch = text.match(/(?:done)\s*[:]\s*(.+?)(?=(?:\.|,)?\s*(?:plan|today|blockers?|stuck)|$)/i);
        if (doneMatch) {
          yesterdayDone = doneMatch[1].trim().replace(/[,.]$/, '').trim();
        }
      }

      if (!todayPlan) {
        const planMatch = text.match(/(?:plan)\s*[:]\s*(.+?)(?=(?:\.|,)?\s*(?:blockers?|stuck|done|yesterday)|$)/i);
        if (planMatch) {
          todayPlan = planMatch[1].trim().replace(/[,.]$/, '').trim();
        }
      }

      // Detect mood from emoji or words
      const moodPositive = /(?:happy|good|great|awesome|excellent|fantastic|amazing|energized|motivated|pumped)/i;
      const moodOkay = /(?:ok(?:ay)?|fine|alright|decent|normal|so-so|meh)/i;
      const moodLow = /(?:tired|stressed|exhausted|burnt out|burnout|frustrated|overwhelmed|low|bad|rough|tough|struggling)/i;

      if (moodPositive.test(lower)) {
        mood = 'great';
      } else if (moodLow.test(lower)) {
        mood = 'low';
      } else if (moodOkay.test(lower)) {
        mood = 'okay';
      }

      return { yesterdayDone, todayPlan, blockers, mood };
    } catch (error) {
      logger.error('Error parsing standup text:', error.message);
      return { yesterdayDone: null, todayPlan: null, blockers: null, mood: null };
    }
  }
}

module.exports = new SelfStandupService();
