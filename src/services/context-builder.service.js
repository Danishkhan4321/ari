'use strict';

/**
 * Context Builder Service
 *
 * Assembles a "what Ari knows right now" block that's prepended to every
 * LLM system prompt. Gives the model proactive awareness of:
 *   - today's calendar events
 *   - pending personal tasks
 *   - relevant current memories (the versioned/trunk source of truth)
 *   - user profile (timezone, name)
 *
 * This is what makes an assistant feel like ChatGPT's "memory" — context the
 * LLM has WITHOUT the user having to spell it out.
 *
 * Design principles:
 *   - FETCH IN PARALLEL (Promise.allSettled) — never bottleneck on one slow source
 *   - FAIL OPEN — any fetch error returns empty, never blocks chat
 *   - TOKEN-BUDGETED — hard cap at ~3 KB (~750 tokens) so context doesn't bloat
 *   - FRESH-AFTER-WRITE — explicit corrections replace older facts immediately
 */

const logger = require('../utils/logger');

const MAX_TASKS = 5;
const MAX_EVENTS = 5;
const MAX_MEMORIES = 5;
const MAX_CHARS = 3000; // ~750 tokens of context max

class ContextBuilderService {
  constructor(dependencies = {}) {
    this.queryFn = dependencies.queryFn || null;
  }

  /**
   * Build the "Background context" block for a user's current turn.
   *
   * @param {string} userPhone - e.g. '919999999999'
   * @param {string} currentMessage - the user's latest message (used for semantic memory search)
   * @returns {Promise<string>} - empty string if nothing useful found, otherwise a formatted block
   */
  async build(userPhone, currentMessage) {
    if (!userPhone) return '';
    const startMs = Date.now();

    try {
      const [events, tasks, memories, profile, entityCards] = await Promise.allSettled([
        this._getTodaysEvents(userPhone),
        this._getPendingTasks(userPhone),
        this._getRelevantMemories(userPhone, currentMessage),
        this._getUserProfile(userPhone),
        this._getEntityCards(userPhone, currentMessage),
      ]);

      const parts = [];

      // Profile first — grounds the assistant in who it's talking to
      if (profile.status === 'fulfilled' && profile.value) {
        parts.push(profile.value);
      }

      // Entity cards — CRM/meeting state for entities named in this message.
      // Placed early: this is the cross-feature context that grounds replies
      // about a specific lead/contact without the user re-explaining.
      if (entityCards.status === 'fulfilled' && entityCards.value) {
        parts.push(`### ${entityCards.value}`);
      }

      // Today's calendar
      if (events.status === 'fulfilled' && Array.isArray(events.value) && events.value.length > 0) {
        const lines = events.value.slice(0, MAX_EVENTS).map(e => {
          const time = this._formatEventTime(e);
          const title = (e.summary || e.title || '(untitled)').slice(0, 80);
          return `- ${time}: ${title}`;
        });
        parts.push(`### Today's calendar\n${lines.join('\n')}`);
      }

      // Pending tasks
      if (tasks.status === 'fulfilled' && Array.isArray(tasks.value) && tasks.value.length > 0) {
        const lines = tasks.value.slice(0, MAX_TASKS).map(t => {
          const desc = (t.description || t.title || '').slice(0, 100);
          const due = t.due_date || t.deadline;
          const priority = t.priority && t.priority !== 'medium' ? ` [${t.priority}]` : '';
          return `- ${desc}${due ? ` (due ${due})` : ''}${priority}`;
        });
        parts.push(`### Pending tasks\n${lines.join('\n')}`);
      }

      // Relevant memories — semantic search on current message
      if (memories.status === 'fulfilled' && Array.isArray(memories.value) && memories.value.length > 0) {
        const lines = memories.value
          .slice(0, MAX_MEMORIES)
          .map(m => m.memory || m.text || '')
          .filter(Boolean)
          .map(m => `- ${m.slice(0, 200)}`);
        if (lines.length > 0) {
          parts.push(`### Relevant memory\n${lines.join('\n')}`);
        }
      }

      if (parts.length === 0) return '';

      let block = '\n\n## Background context\n' + parts.join('\n\n') +
        '\n\nUse this context naturally when helpful. Do NOT list it to the user unless they ask.';

      // Hard cap token bloat
      if (block.length > MAX_CHARS) {
        block = block.slice(0, MAX_CHARS) + '\n…(truncated)';
      }

      const elapsed = Date.now() - startMs;
      logger.info(`[ContextBuilder] ${userPhone}: ${parts.length} sections, ${block.length} chars, ${elapsed}ms`);
      return block;

    } catch (err) {
      logger.warn('[ContextBuilder] build failed: ' + err.message);
      return '';
    }
  }

  /**
   * Today's + next-24h Google Calendar events.
   * Returns [] on any error (Google not connected, API down, etc.).
   */
  async _getTodaysEvents(userPhone) {
    try {
      const calendarService = require('./calendar.service');
      if (typeof calendarService.getUpcomingEvents !== 'function') return [];
      const events = await calendarService.getUpcomingEvents(userPhone, 24);
      return Array.isArray(events) ? events : [];
    } catch { return []; }
  }

  /**
   * Pending personal tasks for the user (all platforms, not just WhatsApp).
   */
  async _getPendingTasks(userPhone) {
    try {
      const taskService = require('./task.service');
      if (typeof taskService.getPersonalTasks !== 'function') return [];
      const all = await taskService.getPersonalTasks(userPhone);
      if (!Array.isArray(all)) return [];
      // getPersonalTasks includes completed ones — filter to pending only
      return all.filter(t => {
        const status = (t.status || '').toLowerCase();
        return !status || status === 'pending' || status === 'open' || status === 'in_progress';
      });
    } catch { return []; }
  }

  /**
   * Top-K current memories relevant to the user's message.
   * The relational store is authoritative because vector indexes can lag
   * after a correction and re-introduce a superseded value.
   */
  async _getRelevantMemories(userPhone, query) {
    if (!query || typeof query !== 'string') return [];
    try {
      const queryDb = this.queryFn || require('../config/database').query;
      const { isSensitiveFact } = require('./versioned-memory.service');
      let versionRows = [];
      let versionTableAvailable = true;

      try {
        const versioned = await queryDb(
          `SELECT category, subject, key_name, value, observed_at,
                  (valid_until IS NOT NULL AND valid_until <= NOW()) AS expired
             FROM ari_agent_memory_fact_versions
            WHERE user_phone = $1 AND is_current = TRUE
            ORDER BY observed_at DESC, id DESC
            LIMIT 100`,
          [userPhone]
        );
        versionRows = Array.isArray(versioned.rows) ? versioned.rows : [];
      } catch {
        // A rolling deploy can briefly run this code before migration 29.
        versionTableAvailable = false;
      }

      const trunk = await queryDb(
        `SELECT category, key_name, value, updated_at
           FROM memory_trunk
          WHERE user_phone = $1
          ORDER BY updated_at DESC
          LIMIT 100`,
        [userPhone]
      );

      const current = new Map();
      for (const row of trunk.rows || []) {
        const key = String(row.key_name || '').trim();
        if (!key || isSensitiveFact({ fact: row.value, key })) continue;
        current.set(key.toLowerCase(), { ...row, displayKey: key, timestamp: row.updated_at });
      }

      if (versionTableAvailable) {
        for (const row of versionRows) {
          const subject = String(row.subject || 'user').trim().toLowerCase();
          const baseKey = String(row.key_name || '').trim();
          const projectedKey = subject === 'user' ? baseKey : `${subject}/${baseKey}`;
          const mapKey = projectedKey.toLowerCase();
          // Delete first: an expired version must suppress its stale trunk projection.
          current.delete(mapKey);
          if (row.expired || !projectedKey || isSensitiveFact({ fact: row.value, key: projectedKey })) continue;
          current.set(mapKey, { ...row, displayKey: projectedKey, timestamp: row.observed_at });
        }
      }

      const stopWords = new Set(['a', 'an', 'and', 'are', 'do', 'i', 'is', 'it', 'me', 'my', 'of', 'the', 'to', 'what', 'where', 'who', 'you']);
      const tokens = String(query).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
      const usefulTokens = [...new Set(tokens.filter((token) => token.length > 1 && !stopWords.has(token)))];
      const normalizedQuery = usefulTokens.join(' ');

      const ranked = [...current.values()].map((row) => {
        const keyText = String(row.displayKey || row.key_name || '').replace(/[_/]+/g, ' ').toLowerCase();
        const valueText = String(row.value || '').toLowerCase();
        const searchable = `${keyText} ${valueText}`;
        let score = usefulTokens.reduce((sum, token) => sum + (searchable.includes(token) ? 2 : 0), 0);
        if (normalizedQuery && keyText.includes(normalizedQuery)) score += 5;
        return { row, score, time: Date.parse(row.timestamp || 0) || 0 };
      }).sort((a, b) => b.score - a.score || b.time - a.time);

      const matching = ranked.filter((entry) => entry.score > 0);
      const selected = (matching.length > 0 ? matching : ranked).slice(0, MAX_MEMORIES);
      return selected.map(({ row }) => ({
        memory: `${String(row.displayKey || row.key_name).replace(/_/g, ' ')}: ${String(row.value || '').slice(0, 500)}`,
        category: row.category,
        source: 'authoritative_memory',
      }));
    } catch { return []; }
  }

  /**
   * Entity cards — CRM/meeting/fact context for leads and contacts detected
   * in the current message. Delegates to entity-context.service; returns ''
   * on any failure so a broken card never blocks chat.
   */
  async _getEntityCards(userPhone, currentMessage) {
    try {
      const entityContext = require('./entity-context.service');
      return await entityContext.buildEntityCards(userPhone, currentMessage);
    } catch (err) {
      logger.warn('[ContextBuilder] entity cards failed: ' + err.message);
      return '';
    }
  }

  /**
   * User profile block — name/timezone from auth `users` plus inferred profile
   * from `user_profiles` (weekly cron, Phase 3). The inferred fields make Ari
   * feel like it "knows" the user: work context, key people, ongoing projects,
   * communication style.
   */
  async _getUserProfile(userPhone) {
    try {
      const { query } = require('../config/database');
      const bits = [];

      // Base auth fields
      try {
        const baseRes = await query(
          `SELECT name, timezone FROM users WHERE phone_number = $1 LIMIT 1`,
          [userPhone]
        );
        if (baseRes.rows.length > 0) {
          const { name, timezone } = baseRes.rows[0];
          if (name) bits.push(`Name: ${name}`);
          if (timezone) bits.push(`Timezone: ${timezone}`);
        }
      } catch { /* users table optional */ }

      // Inferred profile (from weekly user-profile.job)
      try {
        const profRes = await query(
          `SELECT profile FROM user_profiles WHERE phone_number = $1 LIMIT 1`,
          [userPhone]
        );
        const profile = profRes.rows?.[0]?.profile;
        if (profile && typeof profile === 'object') {
          if (profile.preferred_name && !bits.find(b => b.startsWith('Name:'))) {
            bits.push(`Name: ${profile.preferred_name}`);
          }
          if (profile.primary_language) bits.push(`Language: ${profile.primary_language}`);
          if (profile.communication_style) bits.push(`Communication style: ${profile.communication_style}`);
          if (profile.work_context) bits.push(`Work context: ${profile.work_context}`);
          if (Array.isArray(profile.key_people) && profile.key_people.length > 0) {
            bits.push(`Key people: ${profile.key_people.slice(0, 6).join(', ')}`);
          }
          if (Array.isArray(profile.ongoing_projects) && profile.ongoing_projects.length > 0) {
            bits.push(`Ongoing projects: ${profile.ongoing_projects.slice(0, 3).join(', ')}`);
          }
          if (Array.isArray(profile.preferences) && profile.preferences.length > 0) {
            bits.push(`Preferences: ${profile.preferences.slice(0, 3).join('; ')}`);
          }
        }
      } catch { /* user_profiles table optional (populated by weekly job) */ }

      if (bits.length === 0) return '';
      return `### User profile\n${bits.map(b => `- ${b}`).join('\n')}`;
    } catch { return ''; }
  }

  /**
   * Format a Google Calendar event time in the user's local time.
   */
  _formatEventTime(event) {
    try {
      const startStr = event.start?.dateTime || event.start?.date || event.startTime;
      if (!startStr) return '?';
      const d = new Date(startStr);
      if (isNaN(d.getTime())) return '?';
      // Return HH:MM only if there's a specific time (dateTime); just "today" if all-day
      if (event.start?.date && !event.start?.dateTime) return 'all-day';
      return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    } catch { return '?'; }
  }
}

module.exports = new ContextBuilderService();
module.exports.ContextBuilderService = ContextBuilderService;
