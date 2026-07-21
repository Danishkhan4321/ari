'use strict';

const logger = require('../utils/logger');

const API_BASE = 'https://api.exa.ai/agent/runs';

function headers() {
  return { 'content-type': 'application/json', 'x-api-key': process.env.EXA_API_KEY || '' };
}

async function request(url, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { ...options, headers: { ...headers(), ...(options.headers || {}) }, signal: AbortSignal.timeout(30_000) });
      const body = await response.json().catch(() => ({}));
      if (response.ok) return body;
      const error = new Error(body?.error?.message || body?.error || body?.message || `Exa returned ${response.status}`);
      error.status = response.status;
      if (response.status !== 429 && response.status < 500) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      if (error.status && error.status !== 429 && error.status < 500) throw error;
    }
    if (attempt < attempts - 1) await new Promise(resolve => setTimeout(resolve, 1000 * (2 ** attempt)));
  }
  throw lastError || new Error('Exa request failed');
}

function isConfigured() {
  return Boolean(process.env.EXA_API_KEY);
}

async function createRun(payload) {
  if (!isConfigured()) throw new Error('EXA_API_KEY is not configured');
  const run = await request(API_BASE, { method: 'POST', body: JSON.stringify(payload) });
  logger.info({ component: 'exa-agent', runId: run.id }, 'Exa enrichment run created');
  return run;
}

async function getRun(runId) {
  return request(`${API_BASE}/${encodeURIComponent(runId)}`);
}

async function cancelRun(runId) {
  return request(`${API_BASE}/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
}

module.exports = { isConfigured, createRun, getRun, cancelRun };
