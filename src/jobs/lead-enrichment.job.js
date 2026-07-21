'use strict';

const cron = require('node-cron');
const logger = require('../utils/logger');
const enrichmentService = require('../services/lead-enrichment.service');

class LeadEnrichmentJob {
  constructor() { this.task = null; this.running = false; }
  start() {
    if (process.env.LEAD_ENRICHMENT_ENABLED !== 'true') {
      logger.info('[LeadEnrichment] Disabled');
      return;
    }
    this.task = cron.schedule('*/10 * * * * *', () => this.runOnce().catch(error => logger.error(`[LeadEnrichment] ${error.message}`)));
    logger.info('[LeadEnrichment] Worker started');
  }
  async runOnce() {
    if (this.running) return;
    this.running = true;
    try { await Promise.all([enrichmentService.processNext(), enrichmentService.processNext()]); }
    finally { this.running = false; }
  }
  stop() { this.task?.stop(); this.task = null; }
}

module.exports = new LeadEnrichmentJob();
