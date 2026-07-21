const { query } = require('../config/database');
const logger = require('../utils/logger');

class StandupService {

  constructor() {
    this.tablesCreated = false;
    this.defaultQuestions = [
      'What did you work on yesterday?',
      'What are you working on today?',
      'Any blockers?'
    ];
  }

  async ensureTables() {
    if (this.tablesCreated) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS standup_configs (
          id SERIAL PRIMARY KEY,
          admin_phone VARCHAR(20) NOT NULL,
          name VARCHAR(100) DEFAULT 'Daily Standup',
          questions JSONB DEFAULT '[]',
          members JSONB DEFAULT '[]',
          schedule_time VARCHAR(10) DEFAULT '09:00',
          schedule_days VARCHAR(50) DEFAULT 'mon,tue,wed,thu,fri',
          is_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_standup_admin ON standup_configs(admin_phone)`);

      await query(`
        CREATE TABLE IF NOT EXISTS standup_responses (
          id SERIAL PRIMARY KEY,
          config_id INTEGER REFERENCES standup_configs(id) ON DELETE CASCADE,
          member_phone VARCHAR(20) NOT NULL,
          response_date DATE NOT NULL,
          question_index INTEGER NOT NULL,
          answer TEXT,
          created_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(config_id, member_phone, response_date, question_index)
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_standup_responses_config ON standup_responses(config_id, response_date)`);

      // Add new columns if they don't exist
      await query(`ALTER TABLE standup_configs ADD COLUMN IF NOT EXISTS deadline VARCHAR(10)`);
      await query(`ALTER TABLE standup_configs ADD COLUMN IF NOT EXISTS timeout_hours NUMERIC DEFAULT 4`);
      await query(`ALTER TABLE standup_responses ADD COLUMN IF NOT EXISTS response_streak INTEGER DEFAULT 0`);

      // Smart standup columns
      await query(`ALTER TABLE standup_configs ADD COLUMN IF NOT EXISTS checkpoint_type VARCHAR(10) DEFAULT 'morning'`);
      await query(`ALTER TABLE standup_configs ADD COLUMN IF NOT EXISTS standup_group_id VARCHAR(36)`);
      await query(`ALTER TABLE standup_configs ADD COLUMN IF NOT EXISTS admin_phones JSONB DEFAULT '[]'`);
      await query(`ALTER TABLE standup_configs ADD COLUMN IF NOT EXISTS team_name VARCHAR(100)`);
      await query(`ALTER TABLE standup_configs ADD COLUMN IF NOT EXISTS timezone VARCHAR(100) DEFAULT 'UTC'`);

      // Checkpoint type on responses
      await query(`ALTER TABLE standup_responses ADD COLUMN IF NOT EXISTS checkpoint_type VARCHAR(10) DEFAULT 'morning'`);

      // AI analysis table
      await query(`
        CREATE TABLE IF NOT EXISTS standup_analysis (
          id SERIAL PRIMARY KEY,
          standup_group_id VARCHAR(36) NOT NULL,
          member_phone VARCHAR(20) NOT NULL,
          analysis_date DATE NOT NULL,
          morning_plan TEXT,
          evening_actual TEXT,
          completed JSONB DEFAULT '[]',
          missed JSONB DEFAULT '[]',
          unplanned JSONB DEFAULT '[]',
          alignment_score INTEGER DEFAULT 0,
          ai_summary TEXT,
          created_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(standup_group_id, member_phone, analysis_date)
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_standup_analysis_group ON standup_analysis(standup_group_id, analysis_date)`);

      this.tablesCreated = true;
    } catch (error) {
      logger.error('Error creating standup tables:', error.message);
    }
  }

  async createStandup(adminPhone, name, questions, members, scheduleTime = '09:00', scheduleDays = 'mon,tue,wed,thu,fri', timezone = 'UTC') {
    await this.ensureTables();
    try {
      const result = await query(
        `INSERT INTO standup_configs (admin_phone, name, questions, members, schedule_time, schedule_days, timezone)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [adminPhone, name, JSON.stringify(questions), JSON.stringify(members), scheduleTime, scheduleDays, timezone]
      );
      return { success: true, config: result.rows[0] };
    } catch (error) {
      logger.error('Error creating standup:', error.message);
      return { success: false, error: error.message };
    }
  }

  async getStandupsByAdmin(adminPhone) {
    await this.ensureTables();
    try {
      const result = await query(
        `SELECT * FROM standup_configs WHERE admin_phone = $1 AND is_active = TRUE ORDER BY created_at DESC`,
        [adminPhone]
      );
      return result.rows;
    } catch (error) {
      return [];
    }
  }

  async getStandupById(configId) {
    try {
      const result = await query(`SELECT * FROM standup_configs WHERE id = $1`, [configId]);
      return result.rows[0] || null;
    } catch (error) {
      return null;
    }
  }

  async getDueStandups() {
    await this.ensureTables();
    try {
      const now = new Date();

      const result = await query(
        `SELECT * FROM standup_configs WHERE is_active = TRUE`
      );

      const due = [];
      for (const config of result.rows) {
        let currentTime;
        let currentDay;
        try {
          const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: config.timezone || 'UTC',
            weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
          }).formatToParts(now);
          const value = (type) => parts.find((part) => part.type === type)?.value;
          currentTime = `${value('hour') === '24' ? '00' : value('hour')}:${value('minute')}`;
          currentDay = String(value('weekday') || '').slice(0, 3).toLowerCase();
        } catch (_) {
          currentTime = `${now.getUTCHours().toString().padStart(2, '0')}:${now.getUTCMinutes().toString().padStart(2, '0')}`;
          currentDay = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][now.getUTCDay()];
        }
        const days = config.schedule_days.split(',').map(d => d.trim().toLowerCase());
        if (!days.includes(currentDay)) continue;

        // Check if schedule_time matches current time (within 1 minute window)
        if (config.schedule_time === currentTime) {
          // Check if we already sent questions today
          const today = now.toISOString().split('T')[0];
          const existing = await query(
            `SELECT COUNT(*) as count FROM standup_responses
             WHERE config_id = $1 AND response_date = $2`,
            [config.id, today]
          );
          if (parseInt(existing.rows[0].count) === 0) {
            due.push(config);
          }
        }
      }
      return due;
    } catch (error) {
      logger.error('Error getting due standups:', error.message);
      return [];
    }
  }

  async recordResponse(configId, memberPhone, questionIndex, answer) {
    await this.ensureTables();
    try {
      const config = await this.getStandupById(configId);
      if (!config) {
        logger.warn(`[Standup] recordResponse with unknown configId=${configId} from ${memberPhone}`);
        return { success: false };
      }

      // Hardening (Batch F6): verify the responder is actually listed
      // as a member of this standup. Without this check, anyone holding
      // a valid configId (which only ever comes from the bot's own
      // dispatch, but defense-in-depth) could write responses to it.
      // System markers ('__placeholder__', '__on_leave__') used by the
      // cron itself are exempt — those don't carry a real member.
      const isSystemMarker = answer === '__placeholder__' || answer === '__on_leave__';
      if (!isSystemMarker) {
        const members = Array.isArray(config.members) ? config.members : [];
        const isListedMember = members.some(m => (m.phone || '').replace(/\D/g, '') === (memberPhone || '').replace(/\D/g, ''));
        if (!isListedMember) {
          logger.security('standup_response_unauthorized', { configId, memberPhone, adminPhone: config.admin_phone });
          return { success: false, error: 'not_a_team_member' };
        }
      }

      const checkpointType = config.checkpoint_type || 'morning';
      await query(
        `INSERT INTO standup_responses (config_id, member_phone, response_date, question_index, answer, checkpoint_type)
         VALUES ($1, $2, CURRENT_DATE, $3, $4, $5)
         ON CONFLICT (config_id, member_phone, response_date, question_index)
         DO UPDATE SET answer = $4, checkpoint_type = $5`,
        [configId, memberPhone, questionIndex, answer, checkpointType]
      );
      return { success: true };
    } catch (error) {
      logger.error('Error recording standup response:', error.message);
      return { success: false };
    }
  }

  async getNextQuestion(configId, memberPhone) {
    await this.ensureTables();
    try {
      const config = await this.getStandupById(configId);
      if (!config) return null;

      const questions = config.questions;
      const today = new Date().toISOString().split('T')[0];

      const result = await query(
        `SELECT question_index FROM standup_responses
         WHERE config_id = $1 AND member_phone = $2 AND response_date = $3
         ORDER BY question_index`,
        [configId, memberPhone, today]
      );

      const answeredIndices = result.rows.map(r => r.question_index);
      const nextIndex = answeredIndices.length; // 0-based

      if (nextIndex >= questions.length) {
        return { done: true, questions };
      }

      return {
        done: false,
        questionIndex: nextIndex,
        question: questions[nextIndex],
        totalQuestions: questions.length,
        answeredCount: answeredIndices.length
      };
    } catch (error) {
      logger.error('Error getting next question:', error.message);
      return null;
    }
  }

  async isDigestReady(configId) {
    await this.ensureTables();
    try {
      const config = await this.getStandupById(configId);
      if (!config) return false;

      const members = config.members;
      const questions = config.questions;
      const today = new Date().toISOString().split('T')[0];

      const result = await query(
        `SELECT DISTINCT member_phone FROM standup_responses
         WHERE config_id = $1 AND response_date = $2`,
        [configId, today]
      );

      const respondedMembers = result.rows.map(r => r.member_phone);

      // Ready if all members responded or 4hr timeout
      const allResponded = members.every(m => respondedMembers.includes(m.phone));
      return allResponded;
    } catch (error) {
      return false;
    }
  }

  async compileDigest(configId) {
    await this.ensureTables();
    try {
      const config = await this.getStandupById(configId);
      if (!config) return null;

      const today = new Date().toISOString().split('T')[0];
      const questions = config.questions;
      const members = config.members;

      const result = await query(
        `SELECT * FROM standup_responses
         WHERE config_id = $1 AND response_date = $2
         ORDER BY member_phone, question_index`,
        [configId, today]
      );

      // Group by member
      const responsesByMember = {};
      for (const row of result.rows) {
        if (!responsesByMember[row.member_phone]) {
          responsesByMember[row.member_phone] = [];
        }
        responsesByMember[row.member_phone].push(row);
      }

      let digest = `*${config.name} - ${today}*\n\n`;

      for (const member of members) {
        const memberResponses = responsesByMember[member.phone] || [];
        digest += `*${member.name}:*\n`;

        // Check if member was on leave (indicated by __on_leave__ marker)
        const onLeave = memberResponses.some(r => r.answer === '__on_leave__');
        if (onLeave) {
          digest += `  📋 On leave\n`;
        } else if (memberResponses.length === 0) {
          digest += `  _No response_\n`;
        } else {
          for (const resp of memberResponses) {
            if (resp.question_index < 0 || resp.answer === '__placeholder__') continue;
            const q = questions[resp.question_index] || `Q${resp.question_index + 1}`;
            digest += `  *${q}*\n  ${resp.answer}\n`;
          }
        }
        digest += '\n';
      }

      return digest.trim();
    } catch (error) {
      logger.error('Error compiling digest:', error.message);
      return null;
    }
  }

  async deactivateStandup(configId, adminPhone) {
    try {
      await query(
        `UPDATE standup_configs
            SET is_active = FALSE
          WHERE admin_phone = $2
            AND (id = $1 OR standup_group_id = (
              SELECT standup_group_id FROM standup_configs WHERE id = $1 AND admin_phone = $2
            ))`,
        [configId, adminPhone]
      );
      return true;
    } catch (error) {
      return false;
    }
  }

  async getStandupResults(adminPhone, configId = null) {
    await this.ensureTables();
    try {
      let config;
      if (configId) {
        config = await this.getStandupById(configId);
      } else {
        const configs = await this.getStandupsByAdmin(adminPhone);
        config = configs[0]; // Most recent
      }
      if (!config) return null;

      return this.compileDigest(config.id);
    } catch (error) {
      return null;
    }
  }

  async getActiveStandupForMember(memberPhone) {
    await this.ensureTables();
    try {
      const result = await query(
        `SELECT * FROM standup_configs WHERE is_active = TRUE`
      );

      for (const config of result.rows) {
        const members = config.members;
        if (members.some(m => m.phone === memberPhone)) {
          return config;
        }
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Get consecutive response streaks for each member in a standup config.
   * Counts consecutive days (going backwards from today) where the member submitted at least one response.
   * @param {number} configId - The standup config ID
   * @returns {Promise<Array<{memberPhone: string, memberName: string, streak: number}>>}
   */
  async getResponseStreaks(configId) {
    await this.ensureTables();
    try {
      const config = await this.getStandupById(configId);
      if (!config) return [];

      const members = config.members;
      const streaks = [];

      for (const member of members) {
        // Get all distinct response dates for this member, ordered descending
        const result = await query(
          `SELECT DISTINCT response_date FROM standup_responses
           WHERE config_id = $1 AND member_phone = $2
           ORDER BY response_date DESC`,
          [configId, member.phone]
        );

        let streak = 0;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        let checkDate = new Date(today);

        const responseDates = result.rows.map(r => {
          const d = new Date(r.response_date);
          return d.toISOString().split('T')[0];
        });

        // Count consecutive days going backwards from today
        while (true) {
          const dateStr = checkDate.toISOString().split('T')[0];
          if (responseDates.includes(dateStr)) {
            streak++;
            checkDate.setDate(checkDate.getDate() - 1);
          } else {
            break;
          }
        }

        streaks.push({
          memberPhone: member.phone,
          memberName: member.name,
          streak
        });
      }

      return streaks;
    } catch (error) {
      logger.error('Error getting response streaks:', error.message);
      return [];
    }
  }

  /**
   * Get all responses from the last N days that have non-empty blockers.
   * Assumes the last question (highest question_index) is the blockers question.
   * @param {number} configId - The standup config ID
   * @param {number} days - Number of days to look back (default 7)
   * @returns {Promise<Array<{memberName: string, date: string, blockers: string}>>}
   */
  async getBlockersSummary(configId, days = 7) {
    await this.ensureTables();
    try {
      const config = await this.getStandupById(configId);
      if (!config) return [];

      const members = config.members;
      const questions = config.questions;
      // The blockers question is typically the last one
      const blockerIndex = questions.length - 1;

      const result = await query(
        `SELECT member_phone, response_date, answer FROM standup_responses
         WHERE config_id = $1
           AND question_index = $2
           AND response_date >= CURRENT_DATE - $3::INTEGER
           AND answer IS NOT NULL
           AND TRIM(answer) != ''
           AND LOWER(TRIM(answer)) NOT IN ('no', 'none', 'nope', 'n/a', 'na', 'nil', '-', 'nothing')
         ORDER BY response_date DESC, member_phone`,
        [configId, blockerIndex, days]
      );

      // Map phone to name
      const phoneToName = {};
      for (const m of members) {
        phoneToName[m.phone] = m.name;
      }

      return result.rows.map(row => ({
        memberName: phoneToName[row.member_phone] || row.member_phone,
        date: new Date(row.response_date).toISOString().split('T')[0],
        blockers: row.answer
      }));
    } catch (error) {
      logger.error('Error getting blockers summary:', error.message);
      return [];
    }
  }

  /**
   * Find team members who haven't responded today for a specific standup config.
   * @param {number} configId - The standup config ID
   * @returns {Promise<Array<{memberPhone: string, memberName: string}>>}
   */
  async getMissedResponses(configId) {
    await this.ensureTables();
    try {
      const config = await this.getStandupById(configId);
      if (!config) return [];

      const members = config.members;
      const today = new Date().toISOString().split('T')[0];

      // Get members who have responded today
      const result = await query(
        `SELECT DISTINCT member_phone FROM standup_responses
         WHERE config_id = $1 AND response_date = $2`,
        [configId, today]
      );

      const respondedPhones = new Set(result.rows.map(r => r.member_phone));

      // Filter members who haven't responded
      return members
        .filter(m => !respondedPhones.has(m.phone))
        .map(m => ({
          memberPhone: m.phone,
          memberName: m.name
        }));
    } catch (error) {
      logger.error('Error getting missed responses:', error.message);
      return [];
    }
  }

  async createSmartStandup(adminPhone, name, members, morningTime, eveningTime, scheduleDays = 'mon,tue,wed,thu,fri', teamName = null, additionalAdmins = [], timezone = 'UTC') {
    await this.ensureTables();
    const groupId = `sg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const adminPhones = JSON.stringify(additionalAdmins.map(a => a.phone || a));
    try {
      const morningResult = await query(
        `INSERT INTO standup_configs (admin_phone, name, questions, members, schedule_time, schedule_days, is_active, checkpoint_type, standup_group_id, admin_phones, team_name, timeout_hours, timezone)
         VALUES ($1, $2, $3, $4, $5, $6, true, 'morning', $7, $8, $9, 4, $10)
         RETURNING *`,
        [adminPhone, name, JSON.stringify(['What are you planning to work on today?']),
         JSON.stringify(members), morningTime, scheduleDays, groupId, adminPhones, teamName, timezone]
      );
      const eveningResult = await query(
        `INSERT INTO standup_configs (admin_phone, name, questions, members, schedule_time, schedule_days, is_active, checkpoint_type, standup_group_id, admin_phones, team_name, timeout_hours, timezone)
         VALUES ($1, $2, $3, $4, $5, $6, true, 'evening', $7, $8, $9, 3, $10)
         RETURNING *`,
        [adminPhone, name, JSON.stringify(['What did you actually work on today?']),
         JSON.stringify(members), eveningTime, scheduleDays, groupId, adminPhones, teamName, timezone]
      );
      return { success: true, groupId, morning: morningResult.rows[0], evening: eveningResult.rows[0] };
    } catch (error) {
      logger.error('createSmartStandup error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async getMorningPlan(groupId, memberPhone, date = null) {
    const targetDate = date || new Date().toISOString().split('T')[0];
    try {
      const result = await query(
        `SELECT sr.answer FROM standup_responses sr
         JOIN standup_configs sc ON sr.config_id = sc.id
         WHERE sc.standup_group_id = $1 AND sc.checkpoint_type = 'morning'
           AND sr.member_phone = $2 AND sr.response_date = $3
           AND sr.answer NOT IN ('__placeholder__', '__on_leave__')
         ORDER BY sr.question_index`,
        [groupId, memberPhone, targetDate]
      );
      return result.rows.map(r => r.answer).join('\n') || null;
    } catch (error) {
      return null;
    }
  }

  async storeAnalysis(groupId, memberPhone, date, morningPlan, eveningActual, analysis) {
    await this.ensureTables();
    try {
      await query(
        `INSERT INTO standup_analysis (standup_group_id, member_phone, analysis_date, morning_plan, evening_actual, completed, missed, unplanned, alignment_score, ai_summary)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (standup_group_id, member_phone, analysis_date)
         DO UPDATE SET evening_actual = $5, completed = $6, missed = $7, unplanned = $8, alignment_score = $9, ai_summary = $10`,
        [groupId, memberPhone, date, morningPlan, eveningActual,
         JSON.stringify(analysis.completed || []), JSON.stringify(analysis.missed || []),
         JSON.stringify(analysis.unplanned || []), analysis.alignment_score || 0, analysis.summary || '']
      );
      return { success: true };
    } catch (error) {
      logger.error('storeAnalysis error:', error.message);
      return { success: false };
    }
  }

  async getGroupAdmins(groupId) {
    if (!groupId) return [];
    try {
      const result = await query(
        `SELECT DISTINCT admin_phone, admin_phones FROM standup_configs WHERE standup_group_id = $1 LIMIT 1`,
        [groupId]
      );
      if (!result.rows[0]) return [];
      const row = result.rows[0];
      const admins = [row.admin_phone];
      const extra = Array.isArray(row.admin_phones) ? row.admin_phones : JSON.parse(row.admin_phones || '[]');
      for (const phone of extra) {
        if (phone && !admins.includes(phone)) admins.push(phone);
      }
      return admins;
    } catch (error) {
      return [];
    }
  }

  async getTodayAnalysis(groupId) {
    const today = new Date().toISOString().split('T')[0];
    try {
      const result = await query(
        `SELECT * FROM standup_analysis WHERE standup_group_id = $1 AND analysis_date = $2 ORDER BY member_phone`,
        [groupId, today]
      );
      return result.rows;
    } catch (error) {
      return [];
    }
  }
}

module.exports = new StandupService();
