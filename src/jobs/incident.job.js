const cron = require('node-cron');
const { query } = require('../config/database');
const incidentService = require('../services/incident.service');
const messagingService = require('../services/messaging.service');
const logger = require('../utils/logger');
const { sendWithTemplateFallback } = require('../utils/whatsapp-24h');
const TEMPLATES = require('../config/whatsapp-templates');

class IncidentJob {

  constructor() {
    this.isRunningCritical = false;
    this.isRunningHigh = false;
  }

  start() {
    // Auto-escalate critical incidents — every 2 minutes
    cron.schedule('*/2 * * * *', async () => {
      try {
        await this.escalateCriticalIncidents();
      } catch (error) {
        logger.error('Critical incident escalation job error:', error.message);
      }
    });

    // Auto-escalate high-severity incidents — every 5 minutes
    cron.schedule('*/5 * * * *', async () => {
      try {
        await this.escalateHighIncidents();
      } catch (error) {
        logger.error('High incident escalation job error:', error.message);
      }
    });

    // Initial check after delay
    setTimeout(() => this.escalateCriticalIncidents(), 10000);

    logger.info('Incident job started - critical escalation every 2 min, high escalation every 5 min');
  }

  async escalateCriticalIncidents() {
    if (this.isRunningCritical) return;
    this.isRunningCritical = true;
    try {
      // 30-minute timeout for critical incidents
      const incidents = await incidentService.getUnresolvedCritical(30);

      if (!incidents || incidents.length === 0) return;

      logger.info(`Found ${incidents.length} unresolved critical incident(s) to escalate`);

      for (const incident of incidents) {
        try {
          await this.processEscalation(incident);
        } catch (error) {
          logger.error(`Failed to escalate incident #${incident.id}:`, error.message);
        }
      }
    } catch (error) {
      logger.error('escalateCriticalIncidents error:', error.message);
    } finally {
      this.isRunningCritical = false;
    }
  }

  async escalateHighIncidents() {
    if (this.isRunningHigh) return;
    this.isRunningHigh = true;
    try {
      // 60-minute timeout for high-severity incidents
      const incidents = await incidentService.getUnresolvedCritical(60);

      if (!incidents || incidents.length === 0) return;

      // Filter to only high-severity (getUnresolvedCritical may return critical too)
      const highIncidents = incidents.filter(i => i.severity === 'high');

      if (highIncidents.length === 0) return;

      logger.info(`Found ${highIncidents.length} unresolved high-severity incident(s) to escalate`);

      for (const incident of highIncidents) {
        try {
          await this.processEscalation(incident);
        } catch (error) {
          logger.error(`Failed to escalate high-severity incident #${incident.id}:`, error.message);
        }
      }
    } catch (error) {
      logger.error('escalateHighIncidents error:', error.message);
    } finally {
      this.isRunningHigh = false;
    }
  }

  async processEscalation(incident) {
    // Escalate the incident
    await incidentService.escalateIncident(incident.id, incident.team_admin_phone);

    // Build escalation message
    const message = `[ESCALATION] Incident #${incident.id} '${incident.title}'\n` +
      `Severity: ${incident.severity}\n` +
      `Open for: ${incident.minutes} minutes\n` +
      `Escalation #${incident.count}\n\n` +
      `Please address urgently!`;

    // Get team admin phone from the incident
    const adminResult = await query(
      `SELECT team_admin_phone FROM incidents WHERE id = $1`,
      [incident.id]
    );

    if (adminResult.rows.length > 0) {
      const adminPhone = adminResult.rows[0].team_admin_phone;

      // Send to team admin
      await sendWithTemplateFallback(adminPhone, message, TEMPLATES.INCIDENT, [String(incident.id), incident.severity || 'High', incident.description || 'See details']);
      logger.info(`Escalation notification sent to admin ${adminPhone} for incident #${incident.id}`);

      // Also send to incident reporter if different from admin
      if (incident.reporter_phone && incident.reporter_phone !== adminPhone) {
        try {
          await sendWithTemplateFallback(incident.reporter_phone, message, TEMPLATES.INCIDENT, [String(incident.id), incident.severity || 'High', incident.description || 'See details']);
          logger.info(`Escalation notification sent to reporter ${incident.reporter_phone} for incident #${incident.id}`);
        } catch (error) {
          logger.error(`Failed to notify reporter ${incident.reporter_phone}:`, error.message);
        }
      }
    }
  }
}

module.exports = new IncidentJob();
