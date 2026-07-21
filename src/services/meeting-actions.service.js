'use strict';

/**
 * Meeting Actions (Phase 3) — the flagship cross-feature loop.
 *
 * 1. Meeting → Action proposals: after a meeting completes (or on explicit
 *    command), Ari proposes a NUMBERED list of actions derived from the
 *    meeting's extracted action items + its entity links: create tasks, set
 *    a follow-up reminder, draft a follow-up email to the linked lead.
 *    Nothing executes until the user replies with a selection ("do 1 and 3",
 *    "all", "skip") — the numbered reply IS the confirmation, and pending
 *    proposals expire after 15 minutes so a later stray "2" can't create
 *    actions from an unrelated meeting.
 *
 * 2. Meeting prep briefs: "prep me for my meeting with Meera" → a compact
 *    brief assembled from the entity context layer (CRM card + facts),
 *    the last linked meeting's decisions, open tasks mentioning them, and
 *    the last tracked email.
 *
 * Design lineage: the demo meeting-to-action flow (numbered preview →
 * explicit confirmation → expiring context), rebuilt on Ari's own LLM
 * stack with the Phase-1 entity layer instead of AMD infra.
 */

const { query } = require('../config/database');
const { SessionScopedBoundedMap } = require('./chat-session-context');
const logger = require('../utils/logger');

const PENDING_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_PROPOSALS = 6;

// userPhone → { meetingId, meetingTitle, proposals, createdAt }
const pending = new SessionScopedBoundedMap(5000, PENDING_TTL_MS);

function parseJsonArray(raw) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function actionItemLabel(item) {
  if (typeof item === 'string') return item.trim();
  if (item && typeof item === 'object') {
    const title = String(item.text || item.title || item.task || item.item || '').trim();
    const assignee = String(item.assignee || '').trim();
    const deadline = String(item.deadline || item.due || '').trim();
    let label = title;
    if (assignee && !/^(unassigned|none|n\/a)$/i.test(assignee)) label += ` (${assignee})`;
    if (deadline && !/^(none|n\/a|tbd)$/i.test(deadline)) label += ` — by ${deadline}`;
    return label;
  }
  return '';
}

/**
 * Parse a selection reply against a pending proposal list.
 * Returns { kind: 'all' | 'none' | 'some', indices: number[] } or null when
 * the text does not look like a selection at all.
 */
function parseSelection(text, proposalCount) {
  const t = String(text || '').trim().toLowerCase().replace(/[.!]+$/, '');
  if (!t || t.length > 60) return null;

  if (/^(skip|none|no|nah|cancel|nothing|leave it|not now|mat karo|nahi)$/.test(t)) {
    return { kind: 'none', indices: [] };
  }
  if (/^(do |create |run |karo )?(all|everything|sab|sab kuch|all of them)( of them)?$/.test(t)) {
    return { kind: 'all', indices: [] };
  }

  // "do 1 and 3", "create actions 1, 2", "1 & 3", "2"
  const m = t.match(/^(?:do|create|run|karo)?\s*(?:action items?|actions?)?\s*((?:\d{1,2}[\s,&]*(?:and\s+)?)+)$/);
  if (!m) return null;
  const indices = [...new Set((m[1].match(/\d{1,2}/g) || []).map(Number))]
    .filter((n) => n >= 1 && n <= proposalCount);
  if (indices.length === 0) return null;
  return { kind: 'some', indices };
}

class MeetingActionsService {
  // ── Proposal creation ────────────────────────────────────────────────────

  /**
   * Build (and remember) numbered action proposals for a meeting.
   * Returns the proposal message to send, or null when the meeting has
   * nothing actionable.
   */
  async proposeFromMeeting(userPhone, meetingId) {
    try {
      const result = await query(
        `SELECT id, title, summary, action_items, decisions, created_at
           FROM meeting_recordings
          WHERE id = $1 AND user_phone = $2 AND status = 'completed'`,
        [meetingId, userPhone]
      );
      const meeting = result.rows[0];
      if (!meeting) return null;

      const proposals = [];

      // 1. Tasks from extracted action items (already produced by the
      //    meeting analysis — no extra LLM call needed here).
      for (const item of parseJsonArray(meeting.action_items)) {
        const label = actionItemLabel(item);
        if (!label || label.length < 4) continue;
        proposals.push({ kind: 'task', label: label.slice(0, 200) });
        if (proposals.length >= MAX_PROPOSALS - 2) break;
      }

      // 2. Follow-up email draft when the meeting is linked to a lead/contact.
      const linked = await this._primaryLinkedEntity(userPhone, meetingId);
      if (linked) {
        proposals.push({
          kind: 'followup_email',
          label: `Draft a follow-up email to ${linked.name}`,
          entity: linked,
        });
      }

      // 3. Always offer a next-day follow-up reminder.
      proposals.push({
        kind: 'reminder',
        label: `Remind me tomorrow to follow up on this meeting`,
      });

      if (proposals.length === 0) return null;

      pending.set(userPhone, {
        meetingId: meeting.id,
        meetingTitle: meeting.title || 'Meeting',
        meetingSummary: String(meeting.summary || '').slice(0, 2000),
        linked,
        proposals,
        createdAt: Date.now(),
      });

      const lines = proposals.map((p, i) => `${i + 1}. ${p.label}`);
      return (
        `⚡ *Proposed actions from "${meeting.title || 'your meeting'}"*\n\n` +
        `${lines.join('\n')}\n\n` +
        `Reply *"do 1 and 3"*, *"all"*, or *"skip"*. (Expires in 15 min — nothing happens without your go-ahead.)`
      );
    } catch (error) {
      logger.warn(`[MeetingActions] propose failed (non-fatal): ${error.message}`);
      return null;
    }
  }

  /** Propose from the user's most recent completed meeting. */
  async proposeFromLastMeeting(userPhone) {
    try {
      const result = await query(
        `SELECT id FROM meeting_recordings
          WHERE user_phone = $1 AND status = 'completed'
          ORDER BY created_at DESC LIMIT 1`,
        [userPhone]
      );
      if (!result.rows[0]) {
        return `No completed meetings found yet. Record or upload one first, then say *"turn my last meeting into actions"*.`;
      }
      const proposal = await this.proposeFromMeeting(userPhone, result.rows[0].id);
      return proposal || `Your last meeting had no extractable action items. You can still say *"remind me tomorrow to follow up"*.`;
    } catch (error) {
      logger.warn(`[MeetingActions] proposeFromLastMeeting failed: ${error.message}`);
      return null;
    }
  }

  async _primaryLinkedEntity(userPhone, meetingId) {
    try {
      const entityContext = require('./entity-context.service');
      const links = await entityContext.getLinksFor(userPhone, { type: 'meeting', id: meetingId }, 10);
      const ranked = links
        .filter((l) => l.source_type === 'meeting' && (l.target_type === 'lead' || l.target_type === 'contact'))
        .sort((a, b) => (a.target_type === 'lead' ? -1 : 1) - (b.target_type === 'lead' ? -1 : 1) || b.confidence - a.confidence);
      const top = ranked[0];
      if (!top) return null;
      const table = top.target_type === 'lead' ? 'sales_leads' : 'contacts';
      const row = await query(
        `SELECT id, name, email FROM ${table} WHERE id = $1 AND user_phone = $2`,
        [top.target_id, userPhone]
      );
      if (!row.rows[0]) return null;
      return { type: top.target_type, id: row.rows[0].id, name: row.rows[0].name, email: row.rows[0].email || null };
    } catch (_) {
      return null;
    }
  }

  // ── Selection resolution ─────────────────────────────────────────────────

  hasPending(userPhone) {
    return !!pending.get(userPhone);
  }

  /**
   * Try to resolve `text` as a selection against the user's pending
   * proposals. Returns the reply string when consumed, or null to let the
   * message flow to the normal pipeline.
   */
  async resolveSelection(userPhone, text) {
    const state = pending.get(userPhone);
    if (!state) return null;
    if (Date.now() - state.createdAt > PENDING_TTL_MS) {
      pending.delete(userPhone);
      return null;
    }

    const selection = parseSelection(text, state.proposals.length);
    if (!selection) return null;

    pending.delete(userPhone);

    if (selection.kind === 'none') {
      return `Okay, skipped — no actions created from "${state.meetingTitle}".`;
    }

    const chosen = selection.kind === 'all'
      ? state.proposals.map((p, i) => ({ ...p, index: i + 1 }))
      : selection.indices.map((i) => ({ ...state.proposals[i - 1], index: i }));

    const results = [];
    for (const item of chosen) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await this._executeProposal(userPhone, state, item));
    }
    return `✅ Done with "${state.meetingTitle}":\n\n${results.join('\n\n')}`;
  }

  async _executeProposal(userPhone, state, item) {
    try {
      if (item.kind === 'task') {
        await query(
          `INSERT INTO tasks (user_phone, title, description, status, created_at)
           VALUES ($1, $2, $3, 'pending', NOW())`,
          [userPhone, item.label.slice(0, 150), `From meeting: ${state.meetingTitle}`]
        );
        return `${item.index}. Task created: ${item.label}`;
      }

      if (item.kind === 'reminder') {
        const reminderService = require('./reminder.service');
        const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
        tomorrow.setHours(10, 0, 0, 0);
        await reminderService.createReminder(
          userPhone,
          `Follow up on meeting: ${state.meetingTitle}`,
          tomorrow
        );
        return `${item.index}. Reminder set for tomorrow 10:00 — follow up on "${state.meetingTitle}".`;
      }

      if (item.kind === 'followup_email') {
        const draft = await this._draftFollowupEmail(state, item.entity);
        return `${item.index}. Follow-up draft for ${item.entity.name}${item.entity.email ? ` (${item.entity.email})` : ''}:\n\n${draft}\n\n_Say "send email to ${item.entity.name}" with any edits when ready._`;
      }

      return `${item.index}. Skipped (unknown action type).`;
    } catch (error) {
      logger.warn(`[MeetingActions] execute failed for item ${item.index}: ${error.message}`);
      return `${item.index}. Couldn't complete this one (${item.kind}) — try it manually.`;
    }
  }

  async _draftFollowupEmail(state, entity) {
    try {
      const llm = require('./llm-provider');
      const response = await llm.chatCompletion({
        model: llm.fastModel(),
        temperature: 0.4,
        max_tokens: 350,
        messages: [{
          role: 'user',
          content: `Write a short, warm follow-up email (no subject line needed, 4-7 sentences, plain text) to ${entity.name} after this meeting. Reference concrete points. No placeholders like [Name] — write it ready to send.\n\nMeeting: ${state.meetingTitle}\nNotes:\n${state.meetingSummary || '(no summary)'}`,
        }],
      }, { task: 'followup_email_draft' });
      const draft = response?.data?.choices?.[0]?.message?.content?.trim();
      return draft || `Hi ${entity.name}, great speaking today — following up on our conversation about ${state.meetingTitle}. I'll share the next steps shortly.`;
    } catch (_) {
      return `Hi ${entity.name}, great speaking today — following up on our conversation. I'll share the next steps we discussed shortly.`;
    }
  }

  // ── Meeting prep briefs ──────────────────────────────────────────────────

  isPrepQuery(text) {
    const t = String(text || '').trim().toLowerCase();
    if (t.length > 120) return false;
    return /^(prep|prepare|brief)\b/.test(t)
      && /\b(meeting|call|meet|catch ?up|with|for)\b/.test(t);
  }

  async buildPrepBrief(userPhone, text) {
    try {
      const entityContext = require('./entity-context.service');

      // Who is this about? "prep me for my meeting with Meera" → "Meera".
      const nameMatch = String(text || '').match(/\bwith\s+([a-z][a-z .'-]{1,40})\s*$/i);
      const target = nameMatch ? nameMatch[1].trim() : null;

      const searchText = target || String(text || '');
      const cards = await entityContext.buildEntityCards(userPhone, searchText.toLowerCase());

      const sections = [];
      if (cards) sections.push(cards.replace(/^[^\n]*\n/, '').trim()); // drop the generic header

      // Decisions from the most recent meeting matching the target name.
      if (target) {
        try {
          const lastMeeting = await query(
            `SELECT title, decisions, created_at FROM meeting_recordings
              WHERE user_phone = $1 AND status = 'completed'
                AND (LOWER(COALESCE(title,'')) LIKE $2 OR LOWER(COALESCE(attendees,'')) LIKE $2)
              ORDER BY created_at DESC LIMIT 1`,
            [userPhone, `%${target.toLowerCase()}%`]
          );
          const m = lastMeeting.rows[0];
          if (m) {
            const decisions = parseJsonArray(m.decisions).slice(0, 3).map((d) => `- ${actionItemLabel(d) || d}`);
            if (decisions.length) {
              sections.push(`*Last meeting (“${m.title || 'untitled'}”):*\n${decisions.join('\n')}`);
            }
          }
        } catch (_) { /* fail open */ }

        try {
          const tasks = await query(
            `SELECT COALESCE(title, description) AS task FROM tasks
              WHERE user_phone = $1 AND status NOT IN ('completed','done','cancelled')
                AND LOWER(COALESCE(title, description, '')) LIKE $2
              LIMIT 3`,
            [userPhone, `%${target.toLowerCase()}%`]
          );
          if (tasks.rows.length) {
            sections.push(`*Open tasks:*\n${tasks.rows.map((t) => `- ${t.task}`).join('\n')}`);
          }
        } catch (_) { /* fail open */ }
      }

      if (sections.length === 0) {
        return target
          ? `I don't have context on *${target}* yet — no matching lead, contact, or meeting. Add them to your CRM or record a meeting, and the next brief will be richer.`
          : `Tell me who the meeting is with — e.g. *"prep me for my meeting with Meera"* — and I'll pull their CRM state, last meeting decisions, and open tasks.`;
      }

      return `🗒️ *Prep brief${target ? ` — ${target}` : ''}*\n\n${sections.join('\n\n')}`;
    } catch (error) {
      logger.warn(`[MeetingActions] prep brief failed: ${error.message}`);
      return null;
    }
  }
}

module.exports = new MeetingActionsService();
module.exports._internals = { parseSelection, actionItemLabel, parseJsonArray, PENDING_TTL_MS };
