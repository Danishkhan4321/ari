const { query } = require('../config/database');
const logger = require('../utils/logger');

class TeamAnalyticsService {

  constructor() {
    this.schemaReady = false;
  }

  async ensureSchema() {
    if (this.schemaReady) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS team_analytics_snapshots (
          id SERIAL PRIMARY KEY,
          team_admin_phone VARCHAR(50) NOT NULL,
          date DATE DEFAULT CURRENT_DATE,
          metrics_json JSONB,
          created_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(team_admin_phone, date)
        )
      `);

      this.schemaReady = true;
    } catch (error) {
      logger.error('Error creating team_analytics_snapshots table:', error.message);
    }
  }

  async generateReport(adminPhone) {
    await this.ensureSchema();
    try {
      // 1. Tasks breakdown by status
      let tasks = { total: 0, completed: 0, pending: 0, completionRate: 0 };
      try {
        const taskResult = await query(
          `SELECT COUNT(*) as count, status FROM tasks
           WHERE user_phone = $1 OR assigned_by = $1
           GROUP BY status`,
          [adminPhone]
        );
        let total = 0;
        let completed = 0;
        let pending = 0;
        for (const row of taskResult.rows) {
          const count = parseInt(row.count);
          total += count;
          if (row.status === 'completed') completed = count;
          if (row.status === 'pending') pending = count;
        }
        tasks = {
          total,
          completed,
          pending,
          completionRate: total > 0 ? Math.round((completed / total) * 100) : 0
        };
      } catch (err) {
        logger.error('TeamAnalytics: Error querying tasks:', err.message);
      }

      // 2. Standup participation today
      let standups = { todayRespondents: 0, participationRate: 0 };
      try {
        // Fix May 19 2026: column is `created_at` per standup.service.js
        // schema. Previous `submitted_at` reference always errored and
        // silently returned 0 respondents — the analytics digest looked
        // broken for every paying admin.
        const standupResult = await query(
          `SELECT COUNT(DISTINCT member_phone) as respondents
           FROM standup_responses
           WHERE config_id IN (SELECT id FROM standup_configs WHERE admin_phone = $1)
             AND DATE(created_at) = CURRENT_DATE`,
          [adminPhone]
        );
        const todayRespondents = parseInt(standupResult.rows[0]?.respondents) || 0;

        // Get team size for participation rate
        const teamSizeResult = await query(
          `SELECT COUNT(*) as count FROM teams WHERE admin_phone = $1`,
          [adminPhone]
        );
        const teamSize = parseInt(teamSizeResult.rows[0]?.count) || 0;

        standups = {
          todayRespondents,
          participationRate: teamSize > 0 ? Math.round((todayRespondents / teamSize) * 100) : 0
        };
      } catch (err) {
        logger.error('TeamAnalytics: Error querying standups:', err.message);
      }

      // 3. Team size
      let teamSize = 0;
      try {
        const teamResult = await query(
          `SELECT COUNT(*) as count FROM teams WHERE admin_phone = $1`,
          [adminPhone]
        );
        teamSize = parseInt(teamResult.rows[0]?.count) || 0;
      } catch (err) {
        logger.error('TeamAnalytics: Error querying team size:', err.message);
      }

      // 4. Incidents (if table exists)
      let incidents = { openCount: 0, resolvedThisWeek: 0 };
      try {
        const incidentResult = await query(
          `SELECT COUNT(*) as count, status FROM incidents
           WHERE team_admin_phone = $1 AND created_at > NOW() - INTERVAL '7 days'
           GROUP BY status`,
          [adminPhone]
        );
        for (const row of incidentResult.rows) {
          const count = parseInt(row.count);
          if (row.status === 'open') incidents.openCount = count;
          if (row.status === 'resolved') incidents.resolvedThisWeek = count;
        }
      } catch (err) {
        // Table may not exist yet — that's fine
        logger.debug('TeamAnalytics: Incidents table not available:', err.message);
      }

      // 5. Polls (if table exists)
      let polls = { activeCount: 0 };
      try {
        const pollResult = await query(
          `SELECT COUNT(*) as count FROM polls
           WHERE created_by = $1 AND created_at > NOW() - INTERVAL '7 days'`,
          [adminPhone]
        );
        polls.activeCount = parseInt(pollResult.rows[0]?.count) || 0;
      } catch (err) {
        // Table may not exist yet — that's fine
        logger.debug('TeamAnalytics: Polls table not available:', err.message);
      }

      const report = {
        teamSize,
        tasks,
        standups,
        incidents,
        polls,
        generatedAt: new Date().toISOString()
      };

      return report;
    } catch (error) {
      logger.error('Error generating team analytics report:', error.message);
      return {
        teamSize: 0,
        tasks: { total: 0, completed: 0, pending: 0, completionRate: 0 },
        standups: { todayRespondents: 0, participationRate: 0 },
        incidents: { openCount: 0, resolvedThisWeek: 0 },
        polls: { activeCount: 0 },
        generatedAt: new Date().toISOString()
      };
    }
  }

  async saveSnapshot(adminPhone, metrics) {
    await this.ensureSchema();
    try {
      const result = await query(
        `INSERT INTO team_analytics_snapshots (team_admin_phone, date, metrics_json)
         VALUES ($1, CURRENT_DATE, $2)
         ON CONFLICT (team_admin_phone, date)
         DO UPDATE SET metrics_json = $2, created_at = NOW()
         RETURNING *`,
        [adminPhone, JSON.stringify(metrics)]
      );
      return { success: true, snapshot: result.rows[0] };
    } catch (error) {
      logger.error('Error saving analytics snapshot:', error.message);
      return { success: false, error: error.message };
    }
  }

  async getHistory(adminPhone, days) {
    await this.ensureSchema();
    try {
      const interval = days || 30;
      const result = await query(
        `SELECT * FROM team_analytics_snapshots
         WHERE team_admin_phone = $1 AND date > CURRENT_DATE - INTERVAL '1 day' * $2
         ORDER BY date DESC`,
        [adminPhone, interval]
      );
      return result.rows;
    } catch (error) {
      logger.error('Error getting analytics history:', error.message);
      return [];
    }
  }

  async getWeeklyComparison(adminPhone) {
    await this.ensureSchema();
    try {
      // Get this week's snapshots (last 7 days)
      const thisWeekResult = await query(
        `SELECT metrics_json FROM team_analytics_snapshots
         WHERE team_admin_phone = $1 AND date > CURRENT_DATE - INTERVAL '7 days'
         ORDER BY date DESC LIMIT 1`,
        [adminPhone]
      );

      // Get last week's snapshots (8-14 days ago)
      const lastWeekResult = await query(
        `SELECT metrics_json FROM team_analytics_snapshots
         WHERE team_admin_phone = $1
           AND date > CURRENT_DATE - INTERVAL '14 days'
           AND date <= CURRENT_DATE - INTERVAL '7 days'
         ORDER BY date DESC LIMIT 1`,
        [adminPhone]
      );

      const thisWeek = thisWeekResult.rows[0]?.metrics_json || null;
      const lastWeek = lastWeekResult.rows[0]?.metrics_json || null;

      if (!thisWeek && !lastWeek) {
        return { available: false, message: 'Not enough data for weekly comparison.' };
      }

      const comparison = {
        available: true,
        thisWeek,
        lastWeek,
        changes: {}
      };

      if (thisWeek && lastWeek) {
        // Calculate changes
        if (thisWeek.tasks && lastWeek.tasks) {
          comparison.changes.taskCompletionRate = (thisWeek.tasks.completionRate || 0) - (lastWeek.tasks.completionRate || 0);
          comparison.changes.totalTasks = (thisWeek.tasks.total || 0) - (lastWeek.tasks.total || 0);
        }
        if (thisWeek.standups && lastWeek.standups) {
          comparison.changes.participationRate = (thisWeek.standups.participationRate || 0) - (lastWeek.standups.participationRate || 0);
        }
        if (thisWeek.incidents && lastWeek.incidents) {
          comparison.changes.openIncidents = (thisWeek.incidents.openCount || 0) - (lastWeek.incidents.openCount || 0);
        }
      }

      return comparison;
    } catch (error) {
      logger.error('Error getting weekly comparison:', error.message);
      return { available: false, message: 'Error generating comparison.' };
    }
  }
  async getWorkAssignments(adminPhone) {
    try {
      const result = await query(
        `SELECT t.member_name, tk.description, tk.status, tk.priority
         FROM tasks tk
         JOIN teams t ON tk.assigned_to = t.member_phone AND t.admin_phone = $1
         WHERE tk.status = 'pending'
         ORDER BY t.member_name, tk.created_at DESC`,
        [adminPhone]
      );

      const grouped = {};
      for (const row of result.rows) {
        const name = row.member_name || 'Unknown';
        if (!grouped[name]) grouped[name] = [];
        grouped[name] = [...grouped[name], {
          description: row.description,
          status: row.status,
          priority: row.priority
        }];
      }
      return grouped;
    } catch (error) {
      logger.error('TeamAnalytics: Error getting work assignments:', error.message);
      return {};
    }
  }

  async getBlockedMembers(adminPhone) {
    try {
      const configResult = await query(
        `SELECT id, questions FROM standup_configs WHERE admin_phone = $1 AND is_active = TRUE`,
        [adminPhone]
      );
      if (configResult.rows.length === 0) return [];

      const blocked = [];
      const trivialBlocker = /^(none|no|nothing|n\/a|na|nope|nil|-|\.)+$/i;

      for (const config of configResult.rows) {
        const questions = config.questions || [];
        // Last question is typically blockers
        const blockerIndex = questions.length - 1;
        if (blockerIndex < 0) continue;

        const respResult = await query(
          `SELECT sr.answer, t.member_name
           FROM standup_responses sr
           JOIN teams t ON sr.member_phone = t.member_phone AND t.admin_phone = $1
           WHERE sr.config_id = $2
             AND sr.response_date = CURRENT_DATE
             AND sr.question_index = $3
             AND sr.answer IS NOT NULL`,
          [adminPhone, config.id, blockerIndex]
        );

        for (const row of respResult.rows) {
          const answer = (row.answer || '').trim();
          if (answer && !trivialBlocker.test(answer)) {
            blocked.push({ name: row.member_name, blocker: answer });
          }
        }
      }
      return blocked;
    } catch (error) {
      logger.error('TeamAnalytics: Error getting blocked members:', error.message);
      return [];
    }
  }

  async getWorkloadDistribution(adminPhone) {
    try {
      const result = await query(
        `SELECT t.member_name, t.member_phone, COUNT(tk.id) as pending_count
         FROM teams t
         LEFT JOIN tasks tk ON tk.assigned_to = t.member_phone AND tk.status = 'pending'
         WHERE t.admin_phone = $1
         GROUP BY t.member_name, t.member_phone
         ORDER BY pending_count DESC`,
        [adminPhone]
      );

      return result.rows.map(row => ({
        name: row.member_name,
        phone: row.member_phone,
        pendingCount: parseInt(row.pending_count) || 0,
        overloaded: (parseInt(row.pending_count) || 0) > 5
      }));
    } catch (error) {
      logger.error('TeamAnalytics: Error getting workload distribution:', error.message);
      return [];
    }
  }

  async getTeamAvailability(adminPhone) {
    try {
      const teamResult = await query(
        `SELECT member_name, member_phone FROM teams WHERE admin_phone = $1`,
        [adminPhone]
      );
      const members = teamResult.rows;

      // On leave today
      let onLeave = [];
      try {
        const leaveResult = await query(
          `SELECT t.member_name
           FROM leave_requests lr
           JOIN teams t ON lr.user_phone = t.member_phone AND t.admin_phone = $1
           WHERE lr.status = 'approved'
             AND CURRENT_DATE BETWEEN lr.start_date AND lr.end_date`,
          [adminPhone]
        );
        onLeave = leaveResult.rows.map(r => ({ name: r.member_name }));
      } catch (err) {
        logger.debug('TeamAnalytics: leave_requests query failed:', err.message);
      }

      // In focus session
      let inFocus = [];
      try {
        const focusResult = await query(
          `SELECT t.member_name
           FROM focus_sessions fs
           JOIN teams t ON fs.user_phone = t.member_phone AND t.admin_phone = $1
           WHERE fs.status = 'active'`,
          [adminPhone]
        );
        inFocus = focusResult.rows.map(r => ({ name: r.member_name }));
      } catch (err) {
        logger.debug('TeamAnalytics: focus_sessions query failed:', err.message);
      }

      const unavailableNames = new Set([
        ...onLeave.map(m => m.name),
        ...inFocus.map(m => m.name)
      ]);

      const available = members
        .filter(m => !unavailableNames.has(m.member_name))
        .map(m => ({ name: m.member_name }));

      return { onLeave, inFocus, available };
    } catch (error) {
      logger.error('TeamAnalytics: Error getting team availability:', error.message);
      return { onLeave: [], inFocus: [], available: [] };
    }
  }

  async calculateHealthScore(adminPhone) {
    try {
      const report = await this.generateReport(adminPhone);
      const blocked = await this.getBlockedMembers(adminPhone);
      const availability = await this.getTeamAvailability(adminPhone);

      const teamSize = report.teamSize || 0;
      if (teamSize === 0) {
        return { score: 0, emoji: '---', breakdown: {}, teamSize: 0 };
      }

      const participation = report.standups.participationRate || 0;
      const taskCompletion = report.tasks.completionRate || 0;
      const noBlockersRate = teamSize > 0
        ? Math.round(((teamSize - blocked.length) / teamSize) * 100)
        : 100;
      const attendanceRate = teamSize > 0
        ? Math.round(((teamSize - availability.onLeave.length) / teamSize) * 100)
        : 100;

      const score = Math.round(
        (participation * 0.3) +
        (taskCompletion * 0.3) +
        (noBlockersRate * 0.2) +
        (attendanceRate * 0.2)
      );

      let emoji;
      if (score >= 80) emoji = '\ud83d\udfe2';       // green
      else if (score >= 60) emoji = '\ud83d\udfe1';   // yellow
      else if (score >= 40) emoji = '\ud83d\udfe0';   // orange
      else emoji = '\ud83d\udd34';                     // red

      return {
        score,
        emoji,
        breakdown: {
          participation,
          taskCompletion,
          noBlockersRate,
          attendanceRate
        },
        teamSize
      };
    } catch (error) {
      logger.error('TeamAnalytics: Error calculating health score:', error.message);
      return { score: 0, emoji: '\u2753', breakdown: {}, teamSize: 0 };
    }
  }
}

module.exports = new TeamAnalyticsService();
