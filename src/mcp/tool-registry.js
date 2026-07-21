'use strict';

/**
 * Ari MCP tool registry — the platform surface of the context layer.
 *
 * One clean registry (name / description / JSON Schema / execute) consumed
 * by the /mcp endpoint. Read-mostly by design: external agents (Claude,
 * Cursor, partner tools) get the user's cross-feature context — leads,
 * meetings, tasks, reminders, remembered facts — but the only write is
 * note-grade fact memory. Sends, CRM mutations, and anything irreversible
 * stay inside Ari's own confirmation-gated flows.
 *
 * Every execute() is scoped to the authenticated user's phone (from the
 * bearer token) — there is no cross-tenant surface. All tools fail open:
 * errors return { error } instead of throwing.
 */

const { query } = require('../config/database');

const VALID_STAGES = ['new', 'contacted', 'replied', 'meeting', 'proposal', 'negotiation', 'closed_won', 'closed_lost'];

const TOOLS = [
  {
    name: 'ari_search_leads',
    description: "Search the user's CRM leads by name/company text and/or pipeline stage. Read-only.",
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Substring of the lead name or company' },
        stage: { type: 'string', enum: VALID_STAGES },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 8 },
      },
    },
    async execute(userPhone, { text, stage, limit } = {}) {
      const clauses = ['user_phone = $1'];
      const params = [userPhone];
      if (text) {
        params.push(`%${String(text).toLowerCase()}%`);
        clauses.push(`(LOWER(name) LIKE $${params.length} OR LOWER(COALESCE(company,'')) LIKE $${params.length})`);
      }
      if (stage && VALID_STAGES.includes(stage)) {
        params.push(stage);
        clauses.push(`stage = $${params.length}`);
      }
      params.push(Math.min(Math.max(parseInt(limit, 10) || 8, 1), 20));
      const result = await query(
        `SELECT id, name, company, email, stage, deal_value, next_followup_at
           FROM sales_leads WHERE ${clauses.join(' AND ')}
          ORDER BY updated_at DESC NULLS LAST LIMIT $${params.length}`,
        params
      );
      return { leads: result.rows };
    },
  },

  {
    name: 'ari_lead_timeline',
    description: 'Full timeline for one lead: CRM fields, remembered facts, linked meetings/emails. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { lead_id: { type: 'integer' } },
      required: ['lead_id'],
    },
    async execute(userPhone, { lead_id } = {}) {
      const lead = await query(
        `SELECT id, name, company, email, stage, deal_value, notes,
                last_contacted_at, next_followup_at
           FROM sales_leads WHERE id = $1 AND user_phone = $2`,
        [lead_id, userPhone]
      );
      if (!lead.rows[0]) return { error: 'lead not found' };
      const entityContext = require('../services/entity-context.service');
      const [facts, links] = await Promise.all([
        entityContext.getActiveFacts(userPhone, { type: 'lead', id: lead_id }, 8),
        entityContext.getLinksFor(userPhone, { type: 'lead', id: lead_id }, 12),
      ]);
      return { lead: lead.rows[0], facts, links };
    },
  },

  {
    name: 'ari_search_meetings',
    description: "Search the user's meeting notes by text (title/summary). Read-only.",
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 2 },
        limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
      },
      required: ['text'],
    },
    async execute(userPhone, { text, limit } = {}) {
      const result = await query(
        `SELECT id, title, created_at, LEFT(COALESCE(summary, ''), 240) AS summary_preview
           FROM meeting_recordings
          WHERE user_phone = $1 AND status = 'completed'
            AND (LOWER(COALESCE(title,'')) LIKE $2 OR LOWER(COALESCE(summary,'')) LIKE $2)
          ORDER BY created_at DESC LIMIT $3`,
        [userPhone, `%${String(text || '').toLowerCase()}%`, Math.min(Math.max(parseInt(limit, 10) || 5, 1), 10)]
      );
      return { meetings: result.rows };
    },
  },

  {
    name: 'ari_get_meeting',
    description: "One meeting's full summary, decisions, action items, and attendees by id. Read-only.",
    inputSchema: {
      type: 'object',
      properties: { meeting_id: { type: 'integer' } },
      required: ['meeting_id'],
    },
    async execute(userPhone, { meeting_id } = {}) {
      const result = await query(
        `SELECT id, title, created_at, summary, decisions, action_items, attendees
           FROM meeting_recordings WHERE id = $1 AND user_phone = $2`,
        [meeting_id, userPhone]
      );
      return result.rows[0] ? { meeting: result.rows[0] } : { error: 'meeting not found' };
    },
  },

  {
    name: 'ari_list_tasks',
    description: "The user's pending tasks. Read-only.",
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 } },
    },
    async execute(userPhone, { limit } = {}) {
      const result = await query(
        `SELECT id, COALESCE(title, description) AS task, status, due_date
           FROM tasks
          WHERE user_phone = $1 AND status NOT IN ('completed', 'done', 'cancelled')
          ORDER BY due_date ASC NULLS LAST LIMIT $2`,
        [userPhone, Math.min(Math.max(parseInt(limit, 10) || 10, 1), 20)]
      );
      return { tasks: result.rows };
    },
  },

  {
    name: 'ari_list_reminders',
    description: "The user's pending reminders. Read-only.",
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 } },
    },
    async execute(userPhone, { limit } = {}) {
      const result = await query(
        `SELECT id, message, reminder_time
           FROM reminders
          WHERE user_phone = $1 AND status = 'pending'
          ORDER BY reminder_time ASC LIMIT $2`,
        [userPhone, Math.min(Math.max(parseInt(limit, 10) || 10, 1), 20)]
      );
      return { reminders: result.rows };
    },
  },

  {
    name: 'ari_search_facts',
    description: 'Search remembered business facts across leads/contacts/meetings (extracted from meetings and chats). Read-only.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', minLength: 2 } },
      required: ['text'],
    },
    async execute(userPhone, { text } = {}) {
      const entityContext = require('../services/entity-context.service');
      const facts = await entityContext.searchFacts(userPhone, text, 10);
      return { facts };
    },
  },

  {
    name: 'ari_entity_card',
    description: 'Compact cross-feature context card (CRM state + facts + last meeting + last email) for a person or company named in the text.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', minLength: 3, description: 'A message or name to detect entities in' } },
      required: ['text'],
    },
    async execute(userPhone, { text } = {}) {
      const entityContext = require('../services/entity-context.service');
      const card = await entityContext.buildEntityCards(userPhone, String(text || '').toLowerCase());
      return { card: card || '(no matching lead or contact)' };
    },
  },

  {
    name: 'ari_add_fact',
    description: 'Remember a durable business fact about a lead or contact (budget, timeline, objection). The ONLY write this server allows — note-grade memory, nothing irreversible.',
    inputSchema: {
      type: 'object',
      properties: {
        entity_type: { type: 'string', enum: ['lead', 'contact'] },
        entity_id: { type: 'integer' },
        fact: { type: 'string', minLength: 8, maxLength: 400 },
        fact_key: { type: 'string', maxLength: 120, description: 'Optional slot like budget|timeline|objection — newer values supersede older' },
      },
      required: ['entity_type', 'entity_id', 'fact'],
    },
    async execute(userPhone, { entity_type, entity_id, fact, fact_key } = {}) {
      if (!['lead', 'contact'].includes(entity_type)) return { error: 'entity_type must be lead or contact' };
      const entityContext = require('../services/entity-context.service');
      const saved = await entityContext.addFact(
        userPhone,
        { type: entity_type, id: entity_id },
        fact,
        { factKey: fact_key || null, sourceType: 'mcp', sourceId: null }
      );
      return { saved };
    },
  },
];

function listTools() {
  return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

async function callTool(userPhone, name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { error: `unknown tool: ${name}` };
  try {
    return await tool.execute(userPhone, args || {});
  } catch (error) {
    return { error: `tool failed: ${error.message}` };
  }
}

module.exports = { TOOLS, listTools, callTool };
