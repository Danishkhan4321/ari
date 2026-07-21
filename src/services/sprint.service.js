const { query } = require('../config/database');
const logger = require('../utils/logger');

class SprintService {

  constructor() {
    this.schemaReady = false;
  }

  async ensureSchema() {
    if (this.schemaReady) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS sprints (
          id SERIAL PRIMARY KEY,
          team_admin_phone VARCHAR(50) NOT NULL,
          name VARCHAR(255) NOT NULL,
          start_date DATE DEFAULT CURRENT_DATE,
          end_date DATE,
          goal TEXT,
          status VARCHAR(20) DEFAULT 'active',
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS sprint_items (
          id SERIAL PRIMARY KEY,
          sprint_id INTEGER REFERENCES sprints(id) ON DELETE CASCADE,
          title VARCHAR(500) NOT NULL,
          description TEXT,
          assigned_to VARCHAR(50),
          assigned_to_name VARCHAR(255),
          story_points INTEGER DEFAULT 1,
          status VARCHAR(20) DEFAULT 'todo',
          created_at TIMESTAMP DEFAULT NOW(),
          completed_at TIMESTAMP
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_sprints_team ON sprints(team_admin_phone)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_sprint_items_sprint ON sprint_items(sprint_id)`);
      this.schemaReady = true;
    } catch (error) {
      logger.error('Error creating sprint tables:', error.message);
    }
  }

  async createSprint(adminPhone, name, endDate, goal) {
    await this.ensureSchema();
    try {
      // Check for existing active sprint
      const existing = await query(
        `SELECT id, name FROM sprints WHERE team_admin_phone = $1 AND status = 'active'`,
        [adminPhone]
      );
      if (existing.rows.length > 0) {
        return { success: false, error: `There is already an active sprint: "${existing.rows[0].name}". End it before starting a new one.` };
      }

      const result = await query(
        `INSERT INTO sprints (team_admin_phone, name, end_date, goal)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [adminPhone, name, endDate || null, goal || null]
      );
      return { success: true, sprint: result.rows[0] };
    } catch (error) {
      logger.error('Error creating sprint:', error.message);
      return { success: false, error: error.message };
    }
  }

  async getActiveSprint(adminPhone) {
    await this.ensureSchema();
    try {
      const sprintResult = await query(
        `SELECT * FROM sprints WHERE team_admin_phone = $1 AND status = 'active' LIMIT 1`,
        [adminPhone]
      );
      if (sprintResult.rows.length === 0) return null;

      const sprint = sprintResult.rows[0];
      const itemsResult = await query(
        `SELECT * FROM sprint_items WHERE sprint_id = $1 ORDER BY created_at ASC`,
        [sprint.id]
      );
      sprint.items = itemsResult.rows;
      return sprint;
    } catch (error) {
      logger.error('Error getting active sprint:', error.message);
      return null;
    }
  }

  async addItem(sprintId, title, assignedTo, assignedToName, storyPoints) {
    await this.ensureSchema();
    try {
      const result = await query(
        `INSERT INTO sprint_items (sprint_id, title, assigned_to, assigned_to_name, story_points)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [sprintId, title, assignedTo || null, assignedToName || null, storyPoints || 1]
      );
      return result.rows[0];
    } catch (error) {
      logger.error('Error adding sprint item:', error.message);
      return null;
    }
  }

  async updateItemStatus(itemId, status, callerPhone = null) {
    await this.ensureSchema();
    try {
      // Batch H (May 20 2026): IDOR fix — previously this UPDATE only
      // matched on itemId. Any team member who guessed an item id could
      // mark another team's sprint item done. Now we require the caller
      // be the sprint owner (team_admin_phone) OR a member of that
      // admin's team (teams table join). Legacy callers without a
      // callerPhone fall through with a warn so the unscoped pattern
      // gets noticed in logs.
      if (callerPhone) {
        const permCheck = await query(
          `SELECT s.team_admin_phone
             FROM sprint_items si
             JOIN sprints s ON s.id = si.sprint_id
            WHERE si.id = $1`,
          [itemId]
        );
        if (permCheck.rows.length === 0) {
          return null;
        }
        const adminPhone = permCheck.rows[0].team_admin_phone;
        let allowed = adminPhone === callerPhone;
        if (!allowed) {
          // Caller might be a team member of this admin — check teams table
          const memberCheck = await query(
            `SELECT 1 FROM teams
              WHERE admin_phone = $1 AND member_phone = $2
              LIMIT 1`,
            [adminPhone, callerPhone]
          );
          allowed = memberCheck.rows.length > 0;
        }
        if (!allowed) {
          logger.security('sprint_update_idor_attempt', { caller: callerPhone, itemId, adminPhone });
          return null;
        }
      } else {
        logger.warn(`[Sprint] updateItemStatus called without callerPhone for itemId=${itemId} — legacy unscoped path`);
      }
      const completedAt = status === 'done' ? 'NOW()' : 'NULL';
      const result = await query(
        `UPDATE sprint_items
         SET status = $1, completed_at = ${completedAt}
         WHERE id = $2
         RETURNING *`,
        [status, itemId]
      );
      return result.rows[0] || null;
    } catch (error) {
      logger.error('Error updating sprint item status:', error.message);
      return null;
    }
  }

  async getSprintStatus(adminPhone) {
    await this.ensureSchema();
    try {
      const sprint = await this.getActiveSprint(adminPhone);
      if (!sprint) return null;

      const items = sprint.items || [];
      const totalItems = items.length;
      const totalPoints = items.reduce((sum, item) => sum + (item.story_points || 0), 0);
      const completedItems = items.filter(item => item.status === 'done').length;
      const completedPoints = items.filter(item => item.status === 'done').reduce((sum, item) => sum + (item.story_points || 0), 0);
      const progressPercent = totalPoints > 0 ? Math.round((completedPoints / totalPoints) * 100) : 0;

      // Calculate burndown: remaining points
      const burndown = totalPoints - completedPoints;

      // Velocity: completed points so far in this sprint
      const velocity = completedPoints;

      return {
        sprint,
        items,
        stats: {
          totalItems,
          totalPoints,
          completedItems,
          completedPoints,
          velocity,
          burndown,
          progressPercent
        }
      };
    } catch (error) {
      logger.error('Error getting sprint status:', error.message);
      return null;
    }
  }

  async endSprint(adminPhone) {
    await this.ensureSchema();
    try {
      const status = await this.getSprintStatus(adminPhone);
      if (!status) return { success: false, error: 'No active sprint found.' };

      // Set sprint to completed — verify admin ownership in WHERE
      await query(
        `UPDATE sprints SET status = 'completed' WHERE id = $1 AND team_admin_phone = $2`,
        [status.sprint.id, adminPhone]
      );

      // Move incomplete items to a backlog state instead of leaving them
      // orphaned with a stale sprint_id. Until May 19 2026 incomplete tasks
      // just sat in the DB with the closed sprint's FK and never resurfaced.
      // Now we mark them 'backlog' so they can be picked up by the next
      // sprint (a query on status='backlog' returns the unfinished work).
      const incompleteItems = status.items.filter(item => item.status !== 'done');
      let backlogCount = 0;
      if (incompleteItems.length > 0) {
        try {
          const ids = incompleteItems.map(i => i.id);
          const r = await query(
            `UPDATE sprint_items SET status = 'backlog', updated_at = NOW()
              WHERE id = ANY($1::int[]) AND status != 'done'`,
            [ids]
          );
          backlogCount = r.rowCount || 0;
          logger.info(`[Sprint] Moved ${backlogCount} item(s) to backlog for sprint ${status.sprint.id}`);
        } catch (e) {
          logger.error(`[Sprint] Failed to move items to backlog: ${e.message}`);
        }
      }

      return {
        success: true,
        summary: {
          name: status.sprint.name,
          goal: status.sprint.goal,
          startDate: status.sprint.start_date,
          endDate: status.sprint.end_date,
          totalItems: status.stats.totalItems,
          completedItems: status.stats.completedItems,
          totalPoints: status.stats.totalPoints,
          completedPoints: status.stats.completedPoints,
          velocity: status.stats.completedPoints,
          progressPercent: status.stats.progressPercent,
          incompleteItems,
          backlogCount
        }
      };
    } catch (error) {
      logger.error('Error ending sprint:', error.message);
      return { success: false, error: error.message };
    }
  }

  async getSprintHistory(adminPhone, limit = 5) {
    await this.ensureSchema();
    try {
      const sprintsResult = await query(
        `SELECT s.*,
           COUNT(si.id) AS total_items,
           COALESCE(SUM(si.story_points), 0) AS total_points,
           COUNT(CASE WHEN si.status = 'done' THEN 1 END) AS completed_items,
           COALESCE(SUM(CASE WHEN si.status = 'done' THEN si.story_points ELSE 0 END), 0) AS completed_points
         FROM sprints s
         LEFT JOIN sprint_items si ON si.sprint_id = s.id
         WHERE s.team_admin_phone = $1 AND s.status = 'completed'
         GROUP BY s.id
         ORDER BY s.created_at DESC
         LIMIT $2`,
        [adminPhone, limit]
      );
      return sprintsResult.rows.map(row => ({
        id: row.id,
        name: row.name,
        goal: row.goal,
        startDate: row.start_date,
        endDate: row.end_date,
        totalItems: parseInt(row.total_items) || 0,
        totalPoints: parseInt(row.total_points) || 0,
        completedItems: parseInt(row.completed_items) || 0,
        completedPoints: parseInt(row.completed_points) || 0,
        createdAt: row.created_at
      }));
    } catch (error) {
      logger.error('Error getting sprint history:', error.message);
      return [];
    }
  }

  async getVelocity(adminPhone, sprintCount = 3) {
    await this.ensureSchema();
    try {
      const history = await this.getSprintHistory(adminPhone, sprintCount);
      if (history.length === 0) {
        return { avgVelocity: 0, sprints: [] };
      }

      const sprints = history.map(s => ({ name: s.name, points: s.completedPoints }));
      const totalPoints = sprints.reduce((sum, s) => sum + s.points, 0);
      const avgVelocity = Math.round((totalPoints / sprints.length) * 10) / 10;

      return { avgVelocity, sprints };
    } catch (error) {
      logger.error('Error calculating velocity:', error.message);
      return { avgVelocity: 0, sprints: [] };
    }
  }
}

module.exports = new SprintService();
