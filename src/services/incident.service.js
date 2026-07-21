const { query } = require('../config/database');
const logger = require('../utils/logger');

class IncidentService {

  constructor() {
    this.schemaReady = false;
  }

  async ensureSchema() {
    if (this.schemaReady) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS incidents (
          id SERIAL PRIMARY KEY,
          team_admin_phone VARCHAR(50) NOT NULL,
          title VARCHAR(500) NOT NULL,
          description TEXT,
          severity VARCHAR(20) DEFAULT 'medium',
          status VARCHAR(20) DEFAULT 'open',
          reported_by VARCHAR(50) NOT NULL,
          reported_by_name VARCHAR(255),
          assigned_to VARCHAR(50),
          assigned_to_name VARCHAR(255),
          escalated BOOLEAN DEFAULT false,
          escalation_count INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          resolved_at TIMESTAMP,
          resolution_notes TEXT
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_incidents_team ON incidents(team_admin_phone)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(team_admin_phone, status)`);

      this.schemaReady = true;
    } catch (error) {
      logger.error('Error creating incidents table:', error.message);
    }
  }

  async reportIncident(adminPhone, title, description, severity, reportedBy, reportedByName) {
    await this.ensureSchema();
    try {
      const result = await query(
        `INSERT INTO incidents (team_admin_phone, title, description, severity, reported_by, reported_by_name)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [adminPhone, title, description, severity || 'medium', reportedBy, reportedByName]
      );
      return { success: true, incident: result.rows[0] };
    } catch (error) {
      logger.error('Error reporting incident:', error.message);
      return { success: false, error: error.message };
    }
  }

  async getIncidents(adminPhone, status) {
    await this.ensureSchema();
    try {
      let result;
      if (status) {
        result = await query(
          `SELECT * FROM incidents WHERE team_admin_phone = $1 AND status = $2 ORDER BY created_at DESC`,
          [adminPhone, status]
        );
      } else {
        result = await query(
          `SELECT * FROM incidents WHERE team_admin_phone = $1 AND status = 'open' ORDER BY created_at DESC`,
          [adminPhone]
        );
      }
      return result.rows;
    } catch (error) {
      logger.error('Error getting incidents:', error.message);
      return [];
    }
  }

  async getIncident(adminPhone, incidentId) {
    await this.ensureSchema();
    try {
      const result = await query(
        `SELECT * FROM incidents WHERE team_admin_phone = $1 AND id = $2`,
        [adminPhone, incidentId]
      );
      return result.rows[0] || null;
    } catch (error) {
      logger.error('Error getting incident:', error.message);
      return null;
    }
  }

  async assignIncident(incidentId, assignedTo, assignedToName, adminPhone) {
    await this.ensureSchema();
    try {
      const result = await query(
        `UPDATE incidents SET assigned_to = $2, assigned_to_name = $3, updated_at = NOW()
         WHERE id = $1 AND team_admin_phone = $4
         RETURNING *`,
        [incidentId, assignedTo, assignedToName, adminPhone]
      );
      if (result.rowCount === 0) {
        return { success: false, error: 'Incident not found or access denied.' };
      }
      return { success: true, incident: result.rows[0] };
    } catch (error) {
      logger.error('Error assigning incident:', error.message);
      return { success: false, error: error.message };
    }
  }

  async resolveIncident(incidentId, resolutionNotes, adminPhone) {
    await this.ensureSchema();
    try {
      const result = await query(
        `UPDATE incidents SET status = 'resolved', resolved_at = NOW(), resolution_notes = $2, updated_at = NOW()
         WHERE id = $1 AND team_admin_phone = $3
         RETURNING *`,
        [incidentId, resolutionNotes, adminPhone]
      );
      if (result.rowCount === 0) {
        return { success: false, error: 'Incident not found or access denied.' };
      }
      return { success: true, incident: result.rows[0] };
    } catch (error) {
      logger.error('Error resolving incident:', error.message);
      return { success: false, error: error.message };
    }
  }

  async escalateIncident(incidentId, adminPhone) {
    await this.ensureSchema();
    try {
      const result = await query(
        `UPDATE incidents SET escalated = true, escalation_count = escalation_count + 1, updated_at = NOW()
         WHERE id = $1 AND team_admin_phone = $2
         RETURNING *`,
        [incidentId, adminPhone]
      );
      if (result.rowCount === 0) {
        return { success: false, error: 'Incident not found or access denied.' };
      }
      return { success: true, incident: result.rows[0] };
    } catch (error) {
      logger.error('Error escalating incident:', error.message);
      return { success: false, error: error.message };
    }
  }

  async getUnresolvedCritical(timeoutMinutes) {
    await this.ensureSchema();
    try {
      const result = await query(
        `SELECT * FROM incidents
         WHERE severity IN ('critical', 'high')
           AND status != 'resolved'
           AND created_at < NOW() - INTERVAL '1 minute' * $1
         ORDER BY
           CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 END,
           created_at ASC`,
        [timeoutMinutes]
      );
      return result.rows;
    } catch (error) {
      logger.error('Error getting unresolved critical incidents:', error.message);
      return [];
    }
  }

  async getIncidentStats(adminPhone, days) {
    await this.ensureSchema();
    try {
      const interval = days || 30;

      const totalResult = await query(
        `SELECT COUNT(*) as total FROM incidents
         WHERE team_admin_phone = $1 AND created_at > NOW() - INTERVAL '1 day' * $2`,
        [adminPhone, interval]
      );

      const openResult = await query(
        `SELECT COUNT(*) as open FROM incidents
         WHERE team_admin_phone = $1 AND status = 'open'`,
        [adminPhone]
      );

      const resolvedResult = await query(
        `SELECT COUNT(*) as resolved FROM incidents
         WHERE team_admin_phone = $1 AND status = 'resolved' AND created_at > NOW() - INTERVAL '1 day' * $2`,
        [adminPhone, interval]
      );

      const avgResolutionResult = await query(
        `SELECT AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 60) as avg_minutes
         FROM incidents
         WHERE team_admin_phone = $1 AND status = 'resolved' AND resolved_at IS NOT NULL
           AND created_at > NOW() - INTERVAL '1 day' * $2`,
        [adminPhone, interval]
      );

      const bySeverityResult = await query(
        `SELECT severity, COUNT(*) as count FROM incidents
         WHERE team_admin_phone = $1 AND created_at > NOW() - INTERVAL '1 day' * $2
         GROUP BY severity ORDER BY count DESC`,
        [adminPhone, interval]
      );

      return {
        total: parseInt(totalResult.rows[0].total) || 0,
        open: parseInt(openResult.rows[0].open) || 0,
        resolved: parseInt(resolvedResult.rows[0].resolved) || 0,
        avgResolutionMins: avgResolutionResult.rows[0].avg_minutes
          ? Math.round(parseFloat(avgResolutionResult.rows[0].avg_minutes))
          : null,
        bySeverity: bySeverityResult.rows.map(r => ({ severity: r.severity, count: parseInt(r.count) }))
      };
    } catch (error) {
      logger.error('Error getting incident stats:', error.message);
      return { total: 0, open: 0, resolved: 0, avgResolutionMins: null, bySeverity: [] };
    }
  }
}

module.exports = new IncidentService();
