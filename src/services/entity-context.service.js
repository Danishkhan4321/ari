'use strict';

/**
 * Entity Context Service — the shared substrate of the agentic OS.
 *
 * Connects business objects (contacts, leads, meetings, tasks, emails) that
 * the feature silos create but never link, and attaches time-valid facts to
 * those objects so every LLM turn can see "what Ari knows" about the
 * entities being discussed.
 *
 * Three responsibilities:
 *   1. Associations — polymorphic activity↔object links with identity
 *      resolution (email exact > phone exact > name match as suggestion).
 *   2. Entity memories — bi-temporal facts (supersede, never delete).
 *   3. Entity cards — compact per-turn context blocks for entities detected
 *      in the current message, consumed by context-builder.service.
 *
 * Design principles (match the rest of the codebase):
 *   - FAIL OPEN: any DB/LLM error degrades to "no context", never blocks chat
 *   - Lazy table creation mirrors migrations/16_entity_context_layer.js
 *   - No new infra: plain Postgres, FTS via to_tsvector, no embeddings in v1
 */

const { query } = require('../config/database');
const logger = require('../utils/logger');

const OPEN_LEAD_STAGES = ['new', 'contacted', 'replied', 'meeting', 'proposal', 'negotiation'];
const MAX_CARDS = 2;
const MAX_CARD_BLOCK_CHARS = 1200;
const MIN_NAME_MATCH_LEN = 3;

function normalizeEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

/** Loose phone equality that tolerates country-code differences. */
function phonesMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const tail = 10;
  return a.length >= tail && b.length >= tail && a.slice(-tail) === b.slice(-tail);
}

/**
 * Parse the meeting_recordings.attendees TEXT column, which historically
 * holds either a JSON array (["Asha", "raj@x.com"]) or a comma-separated
 * string. Returns { names: [], emails: [] }.
 */
function parseAttendees(rawAttendees) {
  const names = [];
  const emails = [];
  if (!rawAttendees) return { names, emails };

  let items = [];
  const raw = String(rawAttendees).trim();
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      items = parsed.map((p) => (typeof p === 'string' ? p : (p && (p.email || p.name)) || ''));
    }
  } catch (_) {
    items = raw.split(/[,;\n]/);
  }

  for (const item of items) {
    const value = String(item || '').trim();
    if (!value) continue;
    const email = normalizeEmail(value);
    if (email) {
      emails.push(email);
    } else if (value.length >= MIN_NAME_MATCH_LEN) {
      names.push(value.replace(/\s+/g, ' '));
    }
  }
  return { names: [...new Set(names)], emails: [...new Set(emails)] };
}

class EntityContextService {
  constructor() {
    this.tablesReady = false;
  }

  async _ensureTables() {
    if (this.tablesReady) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS associations (
          id BIGSERIAL PRIMARY KEY,
          user_phone VARCHAR(50) NOT NULL,
          source_type VARCHAR(30) NOT NULL,
          source_id TEXT NOT NULL,
          target_type VARCHAR(30) NOT NULL,
          target_id TEXT NOT NULL,
          relation VARCHAR(40) NOT NULL DEFAULT 'related_to',
          confidence REAL NOT NULL DEFAULT 1.0,
          created_by VARCHAR(20) NOT NULL DEFAULT 'auto',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT uq_associations_edge UNIQUE
            (user_phone, source_type, source_id, target_type, target_id, relation)
        )
      `);
      await query(`
        CREATE INDEX IF NOT EXISTS idx_associations_source
          ON associations(user_phone, source_type, source_id)
      `);
      await query(`
        CREATE INDEX IF NOT EXISTS idx_associations_target
          ON associations(user_phone, target_type, target_id)
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS entity_memories (
          id BIGSERIAL PRIMARY KEY,
          user_phone VARCHAR(50) NOT NULL,
          entity_type VARCHAR(30) NOT NULL,
          entity_id TEXT NOT NULL,
          fact TEXT NOT NULL,
          fact_key VARCHAR(120),
          source_type VARCHAR(30),
          source_id TEXT,
          valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          invalid_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await query(`
        CREATE INDEX IF NOT EXISTS idx_entity_memories_entity
          ON entity_memories(user_phone, entity_type, entity_id)
          WHERE invalid_at IS NULL
      `);
      this.tablesReady = true;
    } catch (error) {
      logger.error(`[EntityContext] ensureTables failed: ${error.message}`);
    }
  }

  // ========== ASSOCIATIONS ==========

  /**
   * Upsert a link between an activity and a business object.
   * @returns {Promise<boolean>} true if the edge exists after the call.
   */
  async link(userPhone, source, target, relation = 'related_to', opts = {}) {
    if (!userPhone || !source?.type || !source?.id || !target?.type || !target?.id) return false;
    await this._ensureTables();
    try {
      await query(
        `INSERT INTO associations
           (user_phone, source_type, source_id, target_type, target_id, relation, confidence, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT ON CONSTRAINT uq_associations_edge
         DO UPDATE SET confidence = GREATEST(associations.confidence, EXCLUDED.confidence)`,
        [
          userPhone,
          source.type, String(source.id),
          target.type, String(target.id),
          relation,
          typeof opts.confidence === 'number' ? opts.confidence : 1.0,
          opts.createdBy || 'auto',
        ]
      );
      return true;
    } catch (error) {
      logger.warn(`[EntityContext] link failed (non-fatal): ${error.message}`);
      return false;
    }
  }

  /** All edges touching the given object, in either direction. */
  async getLinksFor(userPhone, entity, limit = 20) {
    await this._ensureTables();
    try {
      const result = await query(
        `SELECT source_type, source_id, target_type, target_id, relation, confidence, created_at
           FROM associations
          WHERE user_phone = $1
            AND ((source_type = $2 AND source_id = $3) OR (target_type = $2 AND target_id = $3))
          ORDER BY created_at DESC
          LIMIT $4`,
        [userPhone, entity.type, String(entity.id), limit]
      );
      return result.rows;
    } catch (error) {
      logger.warn(`[EntityContext] getLinksFor failed (non-fatal): ${error.message}`);
      return [];
    }
  }

  // ========== IDENTITY RESOLUTION ==========

  /**
   * Deterministic-first identity resolution against contacts and sales_leads.
   * Email exact (confidence 1.0) > phone exact/tail (0.95) > name exact (0.6,
   * suggestion-grade — callers should treat sub-0.8 links as tentative).
   *
   * @returns {Promise<{contacts: Array, leads: Array}>} matched rows, each
   *          augmented with `match_confidence`.
   */
  async resolveIdentities(userPhone, { emails = [], phones = [], names = [] } = {}) {
    const out = { contacts: [], leads: [] };
    const cleanEmails = emails.map(normalizeEmail).filter(Boolean);
    const cleanPhones = phones.map(normalizePhone).filter(Boolean);
    const cleanNames = [...new Set(names.map((n) => String(n || '').trim().toLowerCase()).filter((n) => n.length >= MIN_NAME_MATCH_LEN))];
    if (!cleanEmails.length && !cleanPhones.length && !cleanNames.length) return out;

    try {
      const [contactRows, leadRows] = await Promise.all([
        query(
          `SELECT id, name, phone, email, company, title
             FROM contacts WHERE user_phone = $1`,
          [userPhone]
        ).then((r) => r.rows).catch(() => []),
        query(
          `SELECT id, name, email, phone, company, stage
             FROM sales_leads WHERE user_phone = $1`,
          [userPhone]
        ).then((r) => r.rows).catch(() => []),
      ]);

      const score = (row) => {
        const rowEmail = normalizeEmail(row.email);
        if (rowEmail && cleanEmails.includes(rowEmail)) return 1.0;
        const rowPhone = normalizePhone(row.phone);
        if (rowPhone && cleanPhones.some((p) => phonesMatch(p, rowPhone))) return 0.95;
        const rowName = String(row.name || '').trim().toLowerCase();
        if (rowName && cleanNames.includes(rowName)) return 0.6;
        return 0;
      };

      for (const row of contactRows) {
        const confidence = score(row);
        if (confidence > 0) out.contacts.push({ ...row, match_confidence: confidence });
      }
      for (const row of leadRows) {
        const confidence = score(row);
        if (confidence > 0) out.leads.push({ ...row, match_confidence: confidence });
      }
    } catch (error) {
      logger.warn(`[EntityContext] resolveIdentities failed (non-fatal): ${error.message}`);
    }
    return out;
  }

  /**
   * Link a finished meeting to the contacts/leads its attendees resolve to,
   * then auto-link the meeting to each matched contact's open leads
   * (HubSpot-style auto-association). Deterministic — no LLM involved.
   *
   * @returns {Promise<{contacts: number, leads: number}>} counts of linked objects.
   */
  async linkMeeting(userPhone, meetingId, { attendees, title } = {}) {
    const linked = { contacts: 0, leads: 0 };
    if (!userPhone || !meetingId) return linked;

    const { names, emails } = parseAttendees(attendees);
    if (!names.length && !emails.length) return linked;

    const matches = await this.resolveIdentities(userPhone, { emails, names });
    const meeting = { type: 'meeting', id: meetingId };

    for (const contact of matches.contacts) {
      const ok = await this.link(userPhone, meeting, { type: 'contact', id: contact.id }, 'attended', {
        confidence: contact.match_confidence,
      });
      if (ok) linked.contacts += 1;

      // Auto-rule: meeting ↔ contact ⇒ meeting ↔ that contact's open leads.
      const contactEmail = normalizeEmail(contact.email);
      const contactName = String(contact.name || '').trim().toLowerCase();
      try {
        const leadResult = await query(
          `SELECT id FROM sales_leads
            WHERE user_phone = $1
              AND stage = ANY($2)
              AND (LOWER(COALESCE(email, '')) = $3 OR LOWER(name) = $4)
            LIMIT 5`,
          [userPhone, OPEN_LEAD_STAGES, contactEmail || '', contactName]
        );
        for (const lead of leadResult.rows) {
          const linkedLead = await this.link(userPhone, meeting, { type: 'lead', id: lead.id }, 'discussed', {
            confidence: Math.min(contact.match_confidence, 0.9),
          });
          if (linkedLead) linked.leads += 1;
        }
      } catch (_) { /* fail open */ }
    }

    for (const lead of matches.leads) {
      const ok = await this.link(userPhone, meeting, { type: 'lead', id: lead.id }, 'discussed', {
        confidence: lead.match_confidence,
      });
      if (ok) linked.leads += 1;
    }

    if (linked.contacts || linked.leads) {
      logger.info(`[EntityContext] Meeting ${meetingId} linked → ${linked.contacts} contact(s), ${linked.leads} lead(s)${title ? ` ("${String(title).slice(0, 60)}")` : ''}`);
    }
    return linked;
  }

  // ========== ENTITY MEMORIES ==========

  /**
   * Attach a fact to an entity. Never deletes: an identical active fact is a
   * no-op; a fact with the same fact_key supersedes the previous value
   * (invalid_at stamped) — the Graphiti bi-temporal trick on plain SQL.
   */
  async addFact(userPhone, entity, fact, opts = {}) {
    const text = String(fact || '').trim();
    if (!userPhone || !entity?.type || !entity?.id || !text) return false;
    await this._ensureTables();
    try {
      const dupe = await query(
        `SELECT id FROM entity_memories
          WHERE user_phone = $1 AND entity_type = $2 AND entity_id = $3
            AND invalid_at IS NULL AND LOWER(fact) = LOWER($4)
          LIMIT 1`,
        [userPhone, entity.type, String(entity.id), text]
      );
      if (dupe.rows.length > 0) return true;

      if (opts.factKey) {
        await query(
          `UPDATE entity_memories SET invalid_at = NOW()
            WHERE user_phone = $1 AND entity_type = $2 AND entity_id = $3
              AND fact_key = $4 AND invalid_at IS NULL`,
          [userPhone, entity.type, String(entity.id), opts.factKey]
        );
      }

      await query(
        `INSERT INTO entity_memories
           (user_phone, entity_type, entity_id, fact, fact_key, source_type, source_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          userPhone, entity.type, String(entity.id), text.slice(0, 500),
          opts.factKey || null,
          opts.sourceType || null,
          opts.sourceId != null ? String(opts.sourceId) : null,
        ]
      );
      return true;
    } catch (error) {
      logger.warn(`[EntityContext] addFact failed (non-fatal): ${error.message}`);
      return false;
    }
  }

  async getActiveFacts(userPhone, entity, limit = 5) {
    await this._ensureTables();
    try {
      const result = await query(
        `SELECT fact, fact_key, source_type, source_id, valid_from
           FROM entity_memories
          WHERE user_phone = $1 AND entity_type = $2 AND entity_id = $3
            AND invalid_at IS NULL
          ORDER BY valid_from DESC
          LIMIT $4`,
        [userPhone, entity.type, String(entity.id), limit]
      );
      return result.rows;
    } catch (error) {
      logger.warn(`[EntityContext] getActiveFacts failed (non-fatal): ${error.message}`);
      return [];
    }
  }

  /** Full-text search across active facts (used by the agent's memory tool). */
  async searchFacts(userPhone, text, limit = 8) {
    const needle = String(text || '').trim();
    if (!needle) return [];
    await this._ensureTables();
    try {
      const result = await query(
        `SELECT entity_type, entity_id, fact, valid_from
           FROM entity_memories
          WHERE user_phone = $1 AND invalid_at IS NULL
            AND to_tsvector('english', fact) @@ plainto_tsquery('english', $2)
          ORDER BY valid_from DESC
          LIMIT $3`,
        [userPhone, needle, limit]
      );
      return result.rows;
    } catch (error) {
      logger.warn(`[EntityContext] searchFacts failed (non-fatal): ${error.message}`);
      return [];
    }
  }

  // ========== ENTITY CARDS (per-turn context) ==========

  /**
   * Detect leads/contacts mentioned in the current message and build a
   * compact "entity card" block for the system prompt. Empty string when
   * nothing matches — context-builder treats that as "no section".
   */
  async buildEntityCards(userPhone, messageText) {
    const text = String(messageText || '').toLowerCase();
    if (!userPhone || text.length < MIN_NAME_MATCH_LEN) return '';

    try {
      const [leads, contacts] = await Promise.all([
        query(
          `SELECT id, name, email, company, stage, deal_value, notes,
                  last_contacted_at, next_followup_at
             FROM sales_leads
            WHERE user_phone = $1
              AND LENGTH(name) >= ${MIN_NAME_MATCH_LEN}
              AND POSITION(LOWER(name) IN $2) > 0
            ORDER BY updated_at DESC NULLS LAST
            LIMIT ${MAX_CARDS}`,
          [userPhone, text]
        ).then((r) => r.rows).catch(() => []),
        query(
          `SELECT id, name, phone, email, company, title
             FROM contacts
            WHERE user_phone = $1
              AND LENGTH(name) >= ${MIN_NAME_MATCH_LEN}
              AND POSITION(LOWER(name) IN $2) > 0
            ORDER BY updated_at DESC NULLS LAST
            LIMIT ${MAX_CARDS}`,
          [userPhone, text]
        ).then((r) => r.rows).catch(() => []),
      ]);

      const cards = [];

      for (const lead of leads.slice(0, MAX_CARDS)) {
        cards.push(await this._leadCard(userPhone, lead));
      }
      // Contacts that aren't already covered by a lead card of the same name.
      const leadNames = new Set(leads.map((l) => String(l.name).toLowerCase()));
      for (const contact of contacts) {
        if (cards.length >= MAX_CARDS) break;
        if (leadNames.has(String(contact.name).toLowerCase())) continue;
        cards.push(await this._contactCard(userPhone, contact));
      }

      const block = cards.filter(Boolean).join('\n');
      if (!block) return '';
      const header = 'Known entities in this conversation (from your CRM/meetings — use, don\'t re-ask):';
      return `${header}\n${block}`.slice(0, MAX_CARD_BLOCK_CHARS);
    } catch (error) {
      logger.warn(`[EntityContext] buildEntityCards failed (non-fatal): ${error.message}`);
      return '';
    }
  }

  async _leadCard(userPhone, lead) {
    const bits = [`stage: ${lead.stage}`];
    if (lead.company) bits.push(`company: ${lead.company}`);
    if (lead.deal_value) bits.push(`value: ${lead.deal_value}`);
    if (lead.last_contacted_at) bits.push(`last contacted: ${new Date(lead.last_contacted_at).toISOString().slice(0, 10)}`);
    if (lead.next_followup_at) bits.push(`next follow-up: ${new Date(lead.next_followup_at).toISOString().slice(0, 10)}`);

    const lines = [`• LEAD ${lead.name} — ${bits.join(', ')}`];

    const facts = await this.getActiveFacts(userPhone, { type: 'lead', id: lead.id }, 3);
    for (const f of facts) lines.push(`   - ${f.fact}`);

    const lastMeeting = await this._latestLinkedMeeting(userPhone, { type: 'lead', id: lead.id });
    if (lastMeeting) lines.push(`   - last meeting: "${lastMeeting.title || 'untitled'}" (${new Date(lastMeeting.created_at).toISOString().slice(0, 10)})`);

    const leadEmail = normalizeEmail(lead.email);
    if (leadEmail) {
      try {
        const opens = await query(
          `SELECT subject, status, sent_at FROM tracked_emails
            WHERE user_phone = $1 AND LOWER(recipient_email) = $2
            ORDER BY sent_at DESC LIMIT 1`,
          [userPhone, leadEmail]
        );
        if (opens.rows[0]) {
          const e = opens.rows[0];
          lines.push(`   - last email: "${String(e.subject || '').slice(0, 60)}" (${e.status})`);
        }
      } catch (_) { /* fail open */ }
    }
    return lines.join('\n');
  }

  async _contactCard(userPhone, contact) {
    const bits = [];
    if (contact.title) bits.push(contact.title);
    if (contact.company) bits.push(contact.company);
    if (contact.email) bits.push(contact.email);
    if (contact.phone) bits.push(contact.phone);

    const lines = [`• CONTACT ${contact.name}${bits.length ? ` — ${bits.join(', ')}` : ''}`];

    const facts = await this.getActiveFacts(userPhone, { type: 'contact', id: contact.id }, 3);
    for (const f of facts) lines.push(`   - ${f.fact}`);

    const lastMeeting = await this._latestLinkedMeeting(userPhone, { type: 'contact', id: contact.id });
    if (lastMeeting) lines.push(`   - last meeting: "${lastMeeting.title || 'untitled'}" (${new Date(lastMeeting.created_at).toISOString().slice(0, 10)})`);
    return lines.join('\n');
  }

  async _latestLinkedMeeting(userPhone, entity) {
    try {
      const result = await query(
        `SELECT m.id, m.title, m.created_at
           FROM associations a
           JOIN meeting_recordings m ON m.id::text = a.source_id AND m.user_phone = a.user_phone
          WHERE a.user_phone = $1 AND a.source_type = 'meeting'
            AND a.target_type = $2 AND a.target_id = $3
          ORDER BY m.created_at DESC
          LIMIT 1`,
        [userPhone, entity.type, String(entity.id)]
      );
      return result.rows[0] || null;
    } catch (_) {
      return null;
    }
  }

  // ========== POST-MEETING EXTRACTION HOOK ==========

  /**
   * Fire-and-forget hook called after a meeting record is saved.
   * Step 1 (deterministic): link the meeting to contacts/leads by attendees.
   * Step 2 (optional, env-gated): extract business facts from the meeting's
   * already-generated summary/decisions and attach them to linked entities.
   */
  async processMeeting(userPhone, meetingId) {
    if (!userPhone || !meetingId) return { linked: { contacts: 0, leads: 0 }, facts: 0 };
    try {
      const result = await query(
        `SELECT id, title, attendees, summary, decisions, action_items
           FROM meeting_recordings
          WHERE id = $1 AND user_phone = $2`,
        [meetingId, userPhone]
      );
      const meeting = result.rows[0];
      if (!meeting) return { linked: { contacts: 0, leads: 0 }, facts: 0 };

      const linked = await this.linkMeeting(userPhone, meeting.id, {
        attendees: meeting.attendees,
        title: meeting.title,
      });

      let facts = 0;
      if (process.env.ENTITY_EXTRACTION_ENABLED !== 'false') {
        facts = await this._extractFactsFromMeeting(userPhone, meeting).catch((e) => {
          logger.warn(`[EntityContext] fact extraction failed (non-fatal): ${e.message}`);
          return 0;
        });
      }
      return { linked, facts };
    } catch (error) {
      logger.warn(`[EntityContext] processMeeting failed (non-fatal): ${error.message}`);
      return { linked: { contacts: 0, leads: 0 }, facts: 0 };
    }
  }

  async _extractFactsFromMeeting(userPhone, meeting) {
    const material = [meeting.summary, meeting.decisions, meeting.action_items]
      .filter(Boolean).join('\n').trim();
    if (material.length < 40) return 0;

    // Facts can only attach to entities this meeting is actually linked to —
    // grounding the extraction so hallucinated names have nowhere to land.
    const links = await this.getLinksFor(userPhone, { type: 'meeting', id: meeting.id }, 10);
    const candidates = [];
    for (const edge of links) {
      if (edge.source_type === 'meeting' && (edge.target_type === 'lead' || edge.target_type === 'contact')) {
        candidates.push({ type: edge.target_type, id: edge.target_id });
      }
    }

    const llm = require('./llm-provider');
    const targets = [];
    for (const c of candidates.slice(0, 5)) {
      try {
        const table = c.type === 'lead' ? 'sales_leads' : 'contacts';
        const row = await query(`SELECT name FROM ${table} WHERE id = $1 AND user_phone = $2`, [c.id, userPhone]);
        if (row.rows[0]) targets.push({ ...c, name: row.rows[0].name });
      } catch (_) { /* skip */ }
    }

    const entityList = targets.length
      ? targets.map((t) => `- ${t.type}:${t.id} (${t.name})`).join('\n')
      : `- meeting:${meeting.id} (this meeting itself)`;

    const response = await llm.chatCompletion({
      model: llm.fastModel(),
      temperature: 0,
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Extract at most 5 durable business facts from these meeting notes. Facts must be useful weeks later (budgets, timelines, decisions, objections, commitments) — not small talk. Attach each fact to one entity from this list:\n${entityList}\n\nMeeting notes:\n${material.slice(0, 4000)}\n\nReply with ONLY a JSON array: [{"entity":"<type:id>","fact":"<one sentence>","fact_key":"<optional slot like budget|timeline|objection>"}] — or [] if nothing qualifies.`,
      }],
    }, { task: 'entity_fact_extraction' });

    const content = response?.data?.choices?.[0]?.message?.content || '[]';
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return 0;

    let parsed;
    try { parsed = JSON.parse(jsonMatch[0]); } catch (_) { return 0; }
    if (!Array.isArray(parsed)) return 0;

    const validTargets = new Set([
      ...targets.map((t) => `${t.type}:${t.id}`),
      `meeting:${meeting.id}`,
    ]);

    let saved = 0;
    for (const item of parsed.slice(0, 5)) {
      const ref = String(item?.entity || '').trim();
      const fact = String(item?.fact || '').trim();
      if (!validTargets.has(ref) || fact.length < 8) continue;
      const [type, id] = ref.split(':');
      const ok = await this.addFact(userPhone, { type, id }, fact, {
        factKey: item.fact_key ? String(item.fact_key).slice(0, 120) : null,
        sourceType: 'meeting',
        sourceId: meeting.id,
      });
      if (ok) saved += 1;
    }
    if (saved > 0) logger.info(`[EntityContext] Saved ${saved} fact(s) from meeting ${meeting.id}`);
    return saved;
  }
}

module.exports = new EntityContextService();
module.exports._internals = { normalizeEmail, normalizePhone, phonesMatch, parseAttendees };
