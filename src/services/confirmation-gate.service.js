/**
 * Confirmation Gate — hard safety guard for all outbound-to-others actions.
 *
 * User-defined requirement: Ari must NEVER send anything to another person
 * without explicit confirmation. This includes:
 *   - Emails to external recipients
 *   - WhatsApp/Telegram/Discord messages to other contacts
 *   - Calendar events that invite attendees
 *   - Task assignments (other people get notified)
 *   - Reminders set FOR someone else
 *   - Incident escalations that notify team
 *   - Bulk messages / polls to team
 *   - Delegated messages
 *
 * Design:
 *   1. Before executing an outbound action, the handler calls `pend()`
 *      with action details + an execute callback
 *   2. Ari replies to user with a summary + "Reply 'yes' to send"
 *   3. User's next message is intercepted by `tryResolve()` BEFORE intent detection
 *   4. If they confirm → the callback runs, action is sent
 *   5. If they decline → action dropped, state cleared
 *   6. If timeout (30 min) → silently expired, user must re-ask
 *
 * Why "hard":
 *   - LLM can't bypass the gate by hallucinating a confirmation
 *   - Confirmation phrases are matched against a strict allow-list
 *   - Gate lives outside the LLM tool-call path (pre-intent interception)
 *   - Expired pending actions cannot be re-executed
 *   - Every gate event is logged to audit trail + Sentry breadcrumb
 */

const {
  SessionScopedBoundedMap,
  currentChatSession,
  conversationStateKey,
} = require('./chat-session-context');
const logger = require('../utils/logger');

// Configurable TTL — default 30 minutes
const TTL_MS = parseInt(process.env.CONFIRMATION_GATE_TTL_MS || '1800000', 10);

// Strict positive/negative phrase allowlists. Anything else → not a confirmation.
// Multilingual: English, Hindi (romanized), basic variants + common WhatsApp
// typo shapes (yess, okk, yaa, hanji...).
//
// IMPORTANT: these are ANCHOR patterns, not the whole decision. A message that
// starts with "ok" but contains a negation ("ok, don't send it yet") must NOT
// count as a yes — see the negation/conflict guards in tryResolve. That exact
// prefix-match bug shipped once: the gate sent an email on "ok, don't send it
// yet" and cancelled on "no worries, send it".
const POSITIVE_PATTERNS = [
  /^(yes+|yeah|yep|yup|y|yesss*|ya+|yah)\b/i,
  /^(confirm|confirmed|approve|approved|go ahead|proceed)\b/i,
  /^(send|send it|do it|go|go for it|ship it|fire it|push it)\b/i,
  /^(ok+|okay|okie|k|kk|sure|alright|fine|chalega)\b/i,
  // NOTE: deliberately NO bare "pls"/"plz" — "pls cancel" must never anchor
  // as a yes. Only pls/plz + an explicit send verb count.
  /^(please do|please send|pls send|plz send|pls bhej|plz bhej)\b/i,
  /^(haan+|han|hanji|ha|ji( haan)?|theek hai|thik hai|kar do|kar de|krdo|bhej do|bhej de|bhejo|send kar do)\b/i, // Hinglish
  /^(sí|si|oui|ja|da)\b/i // other languages
];

const NEGATIVE_PATTERNS = [
  /^(no+|nope|n|nah|na+)\b/i,
  /^(cancel|abort|stop|don't|dont|do not)\b/i,
  /^(skip|forget it|nevermind|never mind|nvm|leave it|drop it)\b/i,
  /^(nahi+|nhi|mat|reh jane do|rehne do|rehne de|cancel kar|ruk|ruko)\b/i // Hinglish
];

const EDIT_PATTERNS = [
  /^(edit|change|modify|update|tweak|adjust|rewrite|revise)\b/i,
  /^(make it|write it|say)\b/i,
  /^(badlo|change karo|edit karo)\b/i
];

// Words that flip or muddy a yes/no when they appear ANYWHERE in the message.
// "ok, don't send yet" / "no worries, send it" / "haan par abhi nahi".
const NEGATION_WORDS = /\b(don'?t|do\s+not|not\s+(yet|now)|hold(\s+on)?|wait|later|baad\s+m[ei]i?n|abhi\s+n[ae]hi|mat\b|nahi+|nhi|ruk(o|\s|$)|never)\b/i;
const POSITIVE_WORDS = /\b(send( it)?|go ahead|do it|bhej(o| do| de)?|kar(o| do| de)|approve|confirm|yes|haan)\b/i;
// Explicit refusal verbs ANYWHERE in the message override affirmative anchors:
// "ok cancel that", "pls cancel", "yes but skip it" must never fire a send.
// Worst case for a double negation ("don't cancel") is a cancel — nothing is
// sent, which is the direction this gate must fail in.
const REFUSAL_WORDS = /\b(cancel|abort|stop|skip|nvm|never\s*mind|nevermind|forget\s*it|leave\s*it|drop\s*it|rehne\s*d[eo]|mat\s*bhej\w*)\b/i;

// Vocabulary that suggests an ambiguous short reply is still ABOUT the
// pending confirmation ("hmm ok go ahead i guess", "no worries, send it",
// "on second thought…") rather than a brand-new topic ("whats the weather in
// dubai"). Drives the deterministic ambiguous policy in tryResolve: related →
// remind once; unrelated → fall straight through to normal routing.
const CONFIRMATION_TOPIC_WORDS = /\b(ok+|okay|okie|hmm+|umm+|sure|fine|done|great|perfect|go|ahead|send|sent|it|that|this|draft|email|mail|message|invite|yes+|yeah|no+|wait|hold|second|thought|maybe|actually|guess|instead|change|subject|body|first|though|worries|bhej\w*|kar\w*|haan+|han|accha|acha|thik|theek|chal\w*|abhi|baad)\b/i;

class ConfirmationGate {
  constructor() {
    // userPhone → { actionType, summary, execute, ctx, timestamp }
    this._pending = new SessionScopedBoundedMap(10000, TTL_MS);
    // A boolean cannot distinguish an unchanged pending action from a tool
    // replacing it with a new confirmation. Agent adapters compare this
    // monotonic identity before and after every handler invocation.
    this._pendingRevision = 0;
    this._tableEnsured = null; // promise, lazily resolved
  }

  // ── Restart-safety persistence (metadata only) ──────────────────────────
  //
  // The in-memory map holds the execute() CLOSURE, which cannot be
  // serialized — so a PM2 restart loses the pending action itself. What we
  // CAN persist is the metadata (who / what / when). After a restart, when
  // the user replies "yes" to a confirmation the process no longer knows
  // about, we find the orphaned row and tell them honestly that the draft
  // was lost and nothing was sent — instead of silently routing their "yes"
  // into general chat.
  //
  // All DB work is best-effort: any failure degrades to pre-persistence
  // behavior, never breaks the gate.

  async _ensureTable() {
    if (this._tableEnsured) return this._tableEnsured;
    this._tableEnsured = (async () => {
      const { query } = require('../config/database');
      await query(`
        CREATE TABLE IF NOT EXISTS confirmation_gate_pending (
          scope_key TEXT PRIMARY KEY,
          user_phone TEXT NOT NULL,
          session_id UUID,
          action_type TEXT NOT NULL,
          summary TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        ALTER TABLE confirmation_gate_pending ADD COLUMN IF NOT EXISTS scope_key TEXT;
        ALTER TABLE confirmation_gate_pending ADD COLUMN IF NOT EXISTS session_id UUID;
        UPDATE confirmation_gate_pending SET scope_key = user_phone WHERE scope_key IS NULL;
        ALTER TABLE confirmation_gate_pending ALTER COLUMN scope_key SET NOT NULL;
        ALTER TABLE confirmation_gate_pending DROP CONSTRAINT IF EXISTS confirmation_gate_pending_pkey;
        CREATE UNIQUE INDEX IF NOT EXISTS uq_confirmation_gate_scope
          ON confirmation_gate_pending(scope_key)
      `);
    })().catch(e => {
      logger.warn(`confirmation-gate: pending table init failed (persistence disabled): ${e.message}`);
      this._tableEnsured = null; // allow retry later
      throw e;
    });
    return this._tableEnsured;
  }

  async _dbUpsertPending(userPhone, actionType, summary) {
    await this._ensureTable();
    const { query } = require('../config/database');
    const scopeKey = String(conversationStateKey(userPhone));
    const sessionId = currentChatSession()?.sessionId || null;
    await query(
      `INSERT INTO confirmation_gate_pending (scope_key, user_phone, session_id, action_type, summary, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (scope_key) DO UPDATE
         SET action_type = EXCLUDED.action_type,
             summary = EXCLUDED.summary,
             session_id = EXCLUDED.session_id,
             created_at = NOW()`,
      [scopeKey, userPhone, sessionId, actionType, String(summary || '').slice(0, 500)]
    );
  }

  async _dbDeletePending(userPhone) {
    await this._ensureTable();
    const { query } = require('../config/database');
    await query(`DELETE FROM confirmation_gate_pending WHERE scope_key = $1`, [String(conversationStateKey(userPhone))]);
  }

  async _dbFetchPending(userPhone) {
    await this._ensureTable();
    const { query } = require('../config/database');
    const res = await query(
      `SELECT action_type, summary, created_at FROM confirmation_gate_pending WHERE scope_key = $1`,
      [String(conversationStateKey(userPhone))]
    );
    return res.rows[0] || null;
  }

  /**
   * Register a pending outbound action. Returns the message to show the user.
   *
   * @param {string} userPhone
   * @param {object} opts
   * @param {string} opts.actionType - e.g. 'email', 'message_to_contact', 'calendar_event'
   * @param {string} opts.summary - What-the-user-will-see preview (short, clear)
   * @param {function} opts.execute - async () => result of the action when confirmed
   * @param {object} [opts.ctx] - additional audit context
   * @returns {string} the confirmation prompt to send the user
   */
  async pend(userPhone, { actionType, summary, execute, ctx }) {
    if (!userPhone || !actionType || typeof execute !== 'function') {
      throw new Error('confirmation-gate: invalid pend() args');
    }

    // Replace any existing pending action for this user. Most recent wins.
    const existing = this._pending.get(userPhone);
    if (existing) {
      logger.info('confirmation-gate: replacing pending', {
        userPhone,
        oldType: existing.actionType,
        newType: actionType
      });
    }

    this._pending.set(userPhone, {
      actionType,
      summary,
      execute,
      ctx: ctx || {},
      timestamp: Date.now(),
      revision: ++this._pendingRevision
    });

    // Restart-safety metadata (fire-and-forget — see _ensureTable notes).
    this._dbUpsertPending(userPhone, actionType, summary).catch(e =>
      logger.warn(`confirmation-gate: pending persist failed (non-fatal): ${e.message}`)
    );

    logger.info('confirmation-gate: action pended', {
      userPhone,
      actionType,
      ttlMs: TTL_MS
    });

    return this._renderConfirmation(actionType, summary);
  }

  /** Deterministic decision for security-sensitive confirmation replies. */
  classifyExplicitReply(messageText) {
    const trimmed = String(messageText || '').trim();
    if (!trimmed || trimmed.length > 80) return 'unknown';
    const anchorYes = POSITIVE_PATTERNS.some(re => re.test(trimmed));
    const anchorNo = NEGATIVE_PATTERNS.some(re => re.test(trimmed));
    const anchorEdit = EDIT_PATTERNS.some(re => re.test(trimmed));
    const hasNegation = NEGATION_WORDS.test(trimmed);
    const hasPositive = POSITIVE_WORDS.test(trimmed);
    const hasRefusal = REFUSAL_WORDS.test(trimmed);
    const negatedAction = /(don'?t|do\s+not|mat|never|nahi|nhi|cancel|stop)\s+(\w+\s+)?(send|bhej\w*|kar\w*|do\b|go\b|approve|confirm|book|share)/i.test(trimmed);

    if (hasRefusal || negatedAction || (anchorNo && !hasPositive)) return 'cancel';
    if (anchorYes && !hasNegation) return 'confirm';
    if (anchorEdit && !hasNegation) return 'edit';
    return 'unknown';
  }

  /**
   * Called at the TOP of the message handler BEFORE intent detection.
   * If the user has a pending action and their message is a confirmation,
   * executes the action and returns the result text.
   *
   * Returns `null` if no pending action OR the message isn't a confirmation —
   * caller should proceed with normal flow.
   *
   * @param {string} userPhone
   * @param {string} messageText - the raw user message
   * @returns {Promise<string|null>}
   */
  async tryResolve(userPhone, messageText) {
    if (!userPhone || typeof messageText !== 'string') return null;

    const pending = this._pending.get(userPhone);
    if (!pending) {
      // No in-memory pending — but if the user is clearly REPLYING to a
      // confirmation ("yes", "send it", "no"...) there may be an orphaned
      // pending action lost to a process restart. Check the persisted
      // metadata and tell them honestly instead of letting their "yes"
      // fall into general chat.
      const t = String(messageText).trim();
      const confirmish = t.length <= 40 && (
        POSITIVE_PATTERNS.some(re => re.test(t)) || NEGATIVE_PATTERNS.some(re => re.test(t))
      );
      if (confirmish) {
        try {
          const row = await this._dbFetchPending(userPhone);
          if (row) {
            this._dbDeletePending(userPhone).catch(() => {});
            const ageMs = Date.now() - new Date(row.created_at).getTime();
            if (ageMs < TTL_MS) {
              logger.info('confirmation-gate: orphaned pending found after restart', {
                userPhone, actionType: row.action_type
              });
              return `⚠️ I lost track of that pending ${this._friendlyName(row.action_type)} (the service restarted) — *nothing was sent*. Please make the request again if you still want it.`;
            }
          }
        } catch (e) {
          logger.warn(`confirmation-gate: orphan check failed (non-fatal): ${e.message}`);
        }
      }
      return null;
    }

    // Expired? (BoundedMap should evict but double-check)
    if (Date.now() - pending.timestamp > TTL_MS) {
      this._pending.delete(userPhone);
      this._dbDeletePending(userPhone).catch(() => {});
      logger.info('confirmation-gate: pending expired', { userPhone, actionType: pending.actionType });
      return null;
    }

    const trimmed = String(messageText).trim();
    if (!trimmed) return null;

    // Long messages are almost certainly new requests — let them fall through
    // to normal routing untouched. (They deliberately do NOT count as
    // deflections: long edit instructions about the pending draft are common,
    // and burning the pending action on them would silently lose a send the
    // user still wants.)
    if (trimmed.length > 80) return null;

    const anchorYes = POSITIVE_PATTERNS.some(re => re.test(trimmed));
    const anchorNo = NEGATIVE_PATTERNS.some(re => re.test(trimmed));
    const anchorEdit = EDIT_PATTERNS.some(re => re.test(trimmed));
    const hasNegation = NEGATION_WORDS.test(trimmed);
    const hasPositive = POSITIVE_WORDS.test(trimmed);
    const hasRefusal = REFUSAL_WORDS.test(trimmed);
    // "don't send" / "mat bhejo" / "cancel kar do" — a positive verb inside a
    // negation/refusal scope is a refusal, not an approval.
    const negatedAction = /(don'?t|do\s+not|mat|never|nahi|nhi|cancel|stop)\s+(\w+\s+)?(send|bhej\w*|kar\w*|do\b|go\b|approve|confirm|book|share)/i.test(trimmed);

    // Decision matrix — only act on UNAMBIGUOUS replies; everything mixed goes
    // to the LLM classifier below instead of prefix-match guessing:
    //   "yes pls" → yes | "ok, don't send it yet" → no (negated action)
    //   "pls cancel" / "ok cancel that" → no (refusal word wins over anchors)
    //   "no worries, send it" → ambiguous → LLM | "yess" / "han bhej de" → yes
    const isNo = hasRefusal || negatedAction || (anchorNo && !hasPositive);
    const isYes = !isNo && anchorYes && !hasNegation;
    const isEdit = !isYes && !isNo && anchorEdit && !hasNegation;

    if (isYes) return this._confirm(userPhone, pending);
    if (isNo) return this._cancel(userPhone, pending);
    if (isEdit) return this._edit(userPhone, pending);

    // Ambiguous — the strict allowlists couldn't call it. The LLM classifier
    // that used to run here was removed (smoke-test H-2: malformed Gemini
    // JSON silently discarded active approval flows, and even a valid
    // "confirm" was only allowed to re-prompt). Deterministic policy instead:
    //   - reply clearly about ANOTHER topic → fall through to normal routing
    //     immediately and count the deflection (2 deflections drop the
    //     pending action);
    //   - confirmation-adjacent but unclear ("hmm ok go ahead i guess") →
    //     remind once; a second unclear reply falls through as a deflection
    //     so the pending action can never swallow the conversation.
    // HARD-GATE INVARIANT unchanged: only the strict allowlist above can
    // EXECUTE the pended action.
    if (!CONFIRMATION_TOPIC_WORDS.test(trimmed)) {
      this._countDeflection(userPhone, pending);
      return null;
    }
    pending.ambiguousCount = (pending.ambiguousCount || 0) + 1;
    if (pending.ambiguousCount >= 2) {
      this._countDeflection(userPhone, pending);
      return null;
    }
    return `You have a pending ${this._friendlyName(pending.actionType)} waiting for confirmation:\n\n${pending.summary}\n\nReply *yes* to send, *no* to cancel, or *edit* to change it.`;
  }

  // ── resolution actions (shared by regex + LLM paths) ────────────────────

  async _confirm(userPhone, pending) {
    this._pending.delete(userPhone);
    this._dbDeletePending(userPhone).catch(() => {});
    logger.info('confirmation-gate: CONFIRMED', {
      userPhone,
      actionType: pending.actionType,
      ctx: pending.ctx
    });
    try {
      // Add Sentry breadcrumb for audit trail
      try {
        const { Sentry } = require('../utils/sentry');
        Sentry?.addBreadcrumb?.({
          category: 'confirmation-gate',
          message: `${pending.actionType} CONFIRMED by ${userPhone}`,
          level: 'info',
          data: pending.ctx
        });
      } catch (e) { /* noop */ }

      const result = await pending.execute();
      // Confirmed destructive actions complete outside both agent loops —
      // emit the product-data invalidation from here (C-2). Fire-and-forget.
      if (pending.ctx?.toolName && (!result || typeof result !== 'object' || result.status === 'success')) {
        try {
          require('./entity-events.service')
            .record({
              userPhone,
              toolName: pending.ctx.toolName,
              runId: pending.ctx.runId || null,
            })
            .catch(() => {});
        } catch (_) { /* invalidation is best-effort */ }
      }
      if (result && typeof result === 'object') {
        // Agent-tool closures resolve with the typed {status, user_summary,
        // data} envelope. tryResolve's contract is a user-facing string —
        // returning the object verbatim renders as "[object Object]".
        try {
          const { normalizeToolResult } = require('./tool-result.service');
          const normalized = normalizeToolResult(result, {
            toolName: String(pending.ctx?.toolName || pending.actionType || 'action'),
          });
          return String(normalized.user_summary || '').trim() || '✓ Done.';
        } catch (_) {
          return String(result.user_summary || result.summary || '').trim() || '✓ Done.';
        }
      }
      return result || '✓ Done.';
    } catch (err) {
      logger.error('confirmation-gate: execute failed', err);
      return `Tried to send but hit an error: ${err.message}. Nothing was sent.`;
    }
  }

  _cancel(userPhone, pending) {
    this._pending.delete(userPhone);
    this._dbDeletePending(userPhone).catch(() => {});
    logger.info('confirmation-gate: CANCELLED', {
      userPhone,
      actionType: pending.actionType
    });
    return '✓ Cancelled. Nothing sent.';
  }

  _edit(userPhone, pending) {
    // Clear the pending action — user wants to redo it. Next message builds a fresh one.
    this._pending.delete(userPhone);
    this._dbDeletePending(userPhone).catch(() => {});

    // RC #3 fix: also wipe ALL OTHER draft/pending state across the
    // ~24 separate workflow context maps. Without this, a stale reminder
    // draft (or email draft, sales draft, etc.) from minutes earlier can
    // leak its content into the next response template, producing
    // hallucinated text like "Remind Danish: kainsl vn en too at 2:00 pm".
    try {
      const webhookController = require('../controllers/webhook.controller');
      if (typeof webhookController.clearAllPendingState === 'function') {
        webhookController.clearAllPendingState(userPhone);
      }
    } catch (clearErr) {
      logger.warn(`confirmation-gate: clearAllPendingState failed: ${clearErr.message}`);
    }

    logger.info('confirmation-gate: EDIT REQUESTED', {
      userPhone,
      actionType: pending.actionType
    });
    return 'Okay, cancelled that draft. Tell me what to change and I\'ll prepare a new one.';
  }

  /**
   * Count a topic-change while an action is pending. After 2 deflections the
   * pending action is dropped: the user has moved on, and keeping it armed
   * only risks a stale send when they say "yes" to something else later.
   */
  _countDeflection(userPhone, pending) {
    pending.deflections = (pending.deflections || 0) + 1;
    if (pending.deflections >= 2) {
      this._pending.delete(userPhone);
      this._dbDeletePending(userPhone).catch(() => {});
      logger.info('confirmation-gate: expired after topic changes', {
        userPhone,
        actionType: pending.actionType
      });
    }
  }

  /**
   * True if this user has a live pending confirmation. Used by short-reply
   * intercepts (delegated-task/briefing keywords) to yield to the gate.
   */
  hasPending(userPhone) {
    const pending = this._pending.get(userPhone);
    if (!pending) return false;
    if (Date.now() - pending.timestamp > TTL_MS) {
      this._pending.delete(userPhone);
      return false;
    }
    return true;
  }

  /** Return an opaque identity for the live pending action, if any. */
  pendingIdentity(userPhone) {
    const pending = this._pending.get(userPhone);
    if (!pending) return null;
    if (Date.now() - pending.timestamp > TTL_MS) {
      this._pending.delete(userPhone);
      return null;
    }
    // Identity carries the actionType so concurrent executors can attribute
    // a new pend to the tool that actually created it (parallel branches).
    // Callers that only compare identities for inequality are unaffected.
    return String(`${pending.revision || pending.timestamp}:${pending.actionType}`);
  }

  /**
   * Explicitly clear a pending action (e.g. when user switches topic).
   */
  clear(userPhone) {
    this._dbDeletePending(userPhone).catch(() => {});
    if (this._pending.has(userPhone)) {
      this._pending.delete(userPhone);
      return true;
    }
    return false;
  }

  /**
   * For /health and debugging — how many pending gates are live?
   */
  stats() {
    return {
      pendingCount: this._pending.size,
      ttlMs: TTL_MS
    };
  }

  // ── internal ──────────────────────────────────────────────────────────

  _renderConfirmation(actionType, summary) {
    const friendly = this._friendlyName(actionType);
    if (String(actionType).startsWith('agent_tool:')) {
      return `⚠️ *Confirm this action*\n\n${summary}\n\n—\nReply *yes* to continue with this ${friendly}, *no* to cancel, or *edit* to change it.`;
    }
    return `⚠️ *Confirm before I send*\n\n${summary}\n\n—\nReply *yes* to send this ${friendly}, *no* to cancel, or *edit* to change it.`;
  }

  _friendlyName(actionType) {
    if (String(actionType).startsWith('agent_tool:')) {
      return String(actionType).slice('agent_tool:'.length).replace(/_/g, ' ');
    }
    const map = {
      email: 'email',
      email_reply: 'email reply',
      bulk_email: 'bulk email',
      scheduled_email: 'scheduled email',
      message_to_contact: 'WhatsApp message',
      delegate_message: 'message',
      calendar_event: 'calendar invite',
      calendar_reschedule: 'calendar update',
      calendar_cancel: 'calendar cancellation',
      task_assign: 'task assignment',
      reminder_for_other: 'reminder (for someone else)',
      poll_send: 'poll',
      incident_escalate: 'incident escalation',
      follow_up: 'follow-up'
    };
    return map[actionType] || 'action';
  }
}

module.exports = new ConfirmationGate();
