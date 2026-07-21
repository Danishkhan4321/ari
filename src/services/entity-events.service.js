'use strict';

// Product-data invalidation events (smoke-test C-2).
//
// After an agent-side mutation commits, one row lands here; the dashboard's
// /api/events SSE stream turns it into a refetch on any open page that shows
// that entity. Fire-and-forget everywhere: a missed invalidation degrades to
// today's behavior (stale until reload), never to a failed user action.

const logger = require('../utils/logger');
const database = require('../config/database');

// Which product surfaces a tool's successful mutation invalidates. Tools not
// listed here simply emit nothing.
const ENTITIES_BY_TOOL = {
  manage_contacts: ['contacts'],
  save_contact: ['contacts'],
  bulk_save_contacts: ['contacts'],
  manage_sales: ['crm', 'contacts'],
  manage_contact_groups: ['groups', 'contacts'],
  manage_tasks: ['tasks'],
  manage_google_tasks: ['tasks'],
  manage_team: ['team'],
  manage_team_comms: ['team'],
  set_reminder: ['reminders'],
  cancel_reminder: ['reminders'],
  complete_reminder: ['reminders'],
  update_reminder: ['reminders'],
  manage_notes: ['notes'],
  bulk_email: ['campaigns', 'crm'],
  schedule_email: ['campaigns'],
  meeting_minutes: ['meetings'],
  get_meeting_recordings: ['meetings'],
};

let schemaPromise = null;

function ensureTable(queryFn) {
  if (schemaPromise) return schemaPromise;
  schemaPromise = queryFn(`
    CREATE TABLE IF NOT EXISTS entity_change_events (
      id BIGSERIAL PRIMARY KEY,
      user_phone VARCHAR(50) NOT NULL,
      entities TEXT[] NOT NULL,
      tool_name VARCHAR(150),
      run_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_entity_change_user_id ON entity_change_events(user_phone, id);
  `).catch((error) => {
    schemaPromise = null;
    throw error;
  });
  return schemaPromise;
}

function entitiesForTool(toolName) {
  return ENTITIES_BY_TOOL[String(toolName || '')] || [];
}

/**
 * Record that a tool mutated product data. Never throws.
 */
async function record({ userPhone, toolName, runId = null, queryFn = database.query }) {
  const entities = entitiesForTool(toolName);
  if (!userPhone || entities.length === 0) return false;
  try {
    await ensureTable(queryFn);
    await queryFn(
      `INSERT INTO entity_change_events (user_phone, entities, tool_name, run_id)
       VALUES ($1, $2, $3, $4)`,
      [String(userPhone), entities, String(toolName).slice(0, 150), runId || null],
    );
    return true;
  } catch (error) {
    logger.warn({ toolName, err: error.message }, 'entity-change event was not persisted');
    return false;
  }
}

module.exports = { record, entitiesForTool, ENTITIES_BY_TOOL };
