/**
 * BriefingService v2 — morning brief, designed for WhatsApp.
 *
 * Design principles (from research: Axios Smart Brevity, Morning Brew, Duolingo
 * streak psychology, Fogg B=MAP, Hook Model, Zeigarnik effect, WhatsApp
 * attention/formatting best practices):
 *
 *   1. ONE hero item — the single most urgent thing in the next 4 hours.
 *   2. Labeled signposts (*Your next 4 hours*, *Today at a glance*) > prose.
 *   3. Hard 200-word cap. ~45 seconds to read.
 *   4. First 40 chars personalized (greeting + name + streak).
 *   5. Streak counter → loss aversion → daily return.
 *   6. Rotating "surprise slot" → variable reward → Hook Model.
 *   7. Reply CTAs (`plan`, `skip`, `more`) → Hook Model Action + Investment.
 *   8. Named sign-off (`— Ari`) → parasocial anchor.
 *   9. News is ALWAYS a separate message (cron sends two; manual sends brief only).
 *   10. No motivational quotes.
 *
 * Public API (backwards-compatible):
 *   - generateDailyBriefing(userPhone, opts?) — v2 brief (for 8am cron ONLY)
 *   - generateTodayAgenda(userPhone) — NEW: plain list format for "what do I have today"
 *   - generateExtendedBriefing(userPhone) — longer v1-ish version for `more` reply
 *   - generateNewsBriefing(userPhone, opts?) — unchanged, separate message
 *   - rememberNewsForUser / getCachedNewsItem — unchanged
 *   - getTodaysReminders(userPhone, tz) — still returns future-only now
 *   - getLastBriefContext(userPhone) — NEW, used by `done` / `more` replies
 *   - pauseBriefingForOneDay(userPhone) — NEW, used by `skip` reply
 */

const { query } = require('../config/database');
const taskService = require('./task.service');
const listService = require('./list.service');
const searchService = require('./search.service');
const timezoneService = require('./timezone.service');
const googleAuthService = require('./google-auth.service');
const calendarService = require('./calendar.service');
const leaveService = require('./leave.service');
const microsoftAuthService = require('./microsoft-auth.service');
const outlookCalendarService = require('./outlook-calendar.service');
const inboxOrganizerService = require('./inbox-organizer.service');
const habitService = require('./habit.service');
const followUpService = require('./follow-up.service');
const expenseService = require('./expense.service');
const readingListService = require('./reading-list.service');
const newsService = require('./news.service');
const memoryService = require('./memory.service');
const logger = require('../utils/logger');
const BoundedMap = require('../utils/bounded-map');

const HERO_LOOKAHEAD_HOURS = 4;
const MAX_GLANCE_LINES = 4;

// Static day-of-week surprise rotation. Keeping these off the LLM keeps briefs
// fast, cheap, and predictable. Variable reward comes from the DATA filling
// these slots, not from the LLM picking them.
const WEDNESDAY_REFLECTIONS = [
  "Quick reflect: what's one thing you'll say yes to today?",
  "Midweek check: what's draining energy that you could drop?",
  "One-liner: who do you want to hear from today?",
  "Reflect: which task on your list is actually important, and which is just loud?",
  "Pick one: rest, ship, or decide. Which does today need?"
];

const SATURDAY_LIGHT_TOUCH = [
  "Saturday mode. No agenda pressure today. Reply `plan` if you want to map anything.",
  "Lower-stakes day. Anything to close out from the week? Reply `status`.",
  "Weekend check-in. If nothing's on fire, I'll be quiet. Reply `plan` if you want to think ahead."
];

class BriefingService {

  constructor() {
    // News cache (for "know more about #N" deep dives).
    this._newsCache = new Map();
    this._newsCacheTtlMs = 18 * 3600 * 1000;

    // Per-user "last brief context" — stores hero ref and top-task/reminder id
    // so the user's reply `done` / `more` / `plan` can resolve without re-querying.
    // 24h TTL — after that we don't know what "done" refers to anymore.
    this._lastBriefContext = new BoundedMap(5000, 24 * 3600 * 1000);
  }

  // ============================================================
  // NEWS CACHE (unchanged)
  // ============================================================

  rememberNewsForUser(userPhone, items) {
    if (!userPhone || !Array.isArray(items) || items.length === 0) return;
    this._newsCache.set(userPhone, { items, storedAt: Date.now() });
    if (this._newsCache.size > 5000) {
      const cutoff = Date.now() - this._newsCacheTtlMs;
      for (const [key, val] of this._newsCache) {
        if (val.storedAt < cutoff) this._newsCache.delete(key);
        if (this._newsCache.size <= 4000) break;
      }
    }
  }

  getCachedNewsItem(userPhone, position) {
    const entry = this._newsCache.get(userPhone);
    if (!entry) return null;
    if (Date.now() - entry.storedAt > this._newsCacheTtlMs) {
      this._newsCache.delete(userPhone);
      return null;
    }
    const idx = Number(position) - 1;
    if (idx < 0 || idx >= entry.items.length) return null;
    return entry.items[idx];
  }

  async generateNewsBriefing(userPhone, opts = {}) {
    const { limit = 10, hours = 24 } = opts;
    try {
      const news = await newsService.getTopNews({ limit, hours });
      if (!news.ok || !news.items || news.items.length === 0) return null;

      let msg = `*🌍 Top ${news.items.length} World News — Last 24h:*\n\n`;
      news.items.forEach((n, i) => {
        msg += `${i + 1}. *${n.title}*\n`;
        if (n.summary) msg += `   _${n.summary}_\n`;
        msg += `\n`;
      });
      msg += `_Reply_ *"know more about 1"* _(or 2, 3...) to open the full story._`;

      this.rememberNewsForUser(userPhone, news.items);
      return msg;
    } catch (e) {
      logger.warn(`generateNewsBriefing failed: ${e.message}`);
      return null;
    }
  }

  // ============================================================
  // V2 — MAIN BRIEFING
  // ============================================================

  async generateDailyBriefing(userPhone, opts = {}) {
    const { includeNews = false, forceExtended = false } = opts;
    try {
      const tz = await timezoneService.getUserTimezone(userPhone);
      const now = new Date();
      const { localHour, localDateStr, weekday } = this._localParts(now, tz);

      // User preference may force the longer extended format.
      const pref = await this._getLengthPreference(userPhone);
      if (forceExtended || pref === 'detailed') {
        const extended = await this.generateExtendedBriefing(userPhone, opts);
        // Record a minimal brief context so the one-word reply CTAs
        // (skip/more/plan/status) work for detailed-preference users too —
        // the reply intercept requires a recent generatedAt. `done` still
        // needs topTaskId and correctly stays disabled for this format.
        this._lastBriefContext.set(userPhone, {
          heroRef: null,
          topTaskId: null,
          topReminderId: null,
          counts: {},
          localDateStr,
          tz,
          generatedAt: Date.now()
        });
        return extended;
      }

      // Gather all sections in parallel — each one handles its own errors.
      const [
        firstName,
        hero,
        glance,
        surprise,
        streakState
      ] = await Promise.all([
        this._getFirstName(userPhone),
        this._getHeroItem(userPhone, tz, now).catch(e => {
          logger.warn(`hero item failed: ${e.message}`);
          return { text: null, ref: null };
        }),
        this._getTodayGlance(userPhone, tz, now).catch(e => {
          logger.warn(`today glance failed: ${e.message}`);
          return { lines: [], topTaskId: null, topReminderId: null, counts: {} };
        }),
        this._getSurpriseSlot(userPhone, tz, weekday, localDateStr).catch(e => {
          logger.warn(`surprise slot failed: ${e.message}`);
          return null;
        }),
        this._updateAndGetStreak(userPhone, localDateStr).catch(e => {
          logger.warn(`streak update failed: ${e.message}`);
          return { count: 0, best: 0, freezeUsed: false };
        })
      ]);

      // Compose the brief — labeled signposts, left-aligned, scan-friendly.
      const greeting = this._getGreeting(localHour);
      const nameToken = firstName ? `, ${firstName}` : '';
      const streakLine = streakState.count >= 2
        ? ` Day ${streakState.count} of your brief.`
        : streakState.count === 1
          ? ` Welcome to your daily brief.`
          : '';
      const freezeNote = streakState.freezeUsed
        ? `\n_(Streak freeze used — you're still at Day ${streakState.count}.)_`
        : '';

      const parts = [];
      parts.push(`☀️ *${greeting}${nameToken}.*${streakLine}${freezeNote}`);

      // Hero — always present (even if just "nothing urgent")
      if (hero.text) {
        parts.push(`\n*Your next ${HERO_LOOKAHEAD_HOURS} hours* 🎯\n${hero.text}`);
      } else {
        parts.push(`\n*Your next ${HERO_LOOKAHEAD_HOURS} hours* 🎯\n_Nothing urgent — space to focus._`);
      }

      // Today at a glance — up to 4 one-line summaries
      const glanceLines = glance.lines.filter(Boolean).slice(0, MAX_GLANCE_LINES);
      if (glanceLines.length > 0) {
        parts.push(`\n*Today at a glance*\n${glanceLines.map(l => ` • ${l}`).join('\n')}`);
      }

      // Surprise slot — rotating novelty (the variable reward)
      if (surprise && surprise.text) {
        parts.push(`\n*${surprise.label}* ✨\n${surprise.text}`);
      }

      // Ritual — CTAs (kept ultra-short; the research said reply prompts train engagement)
      parts.push(`\n*Ritual*\nReply \`plan\` to sequence your day · \`more\` for details · \`skip\` to pause 1 day`);

      // Sign-off
      parts.push(`\n— Ari`);

      const brief = parts.join('\n');

      // Cache context for follow-up replies (`done`, `more`, `plan`)
      this._lastBriefContext.set(userPhone, {
        heroRef: hero.ref,
        topTaskId: glance.topTaskId,
        topReminderId: glance.topReminderId,
        counts: glance.counts,
        localDateStr,
        tz,
        generatedAt: Date.now()
      });

      // Increment lifetime count (best-effort, non-blocking)
      query(
        `UPDATE user_settings SET briefing_last_sent_count = COALESCE(briefing_last_sent_count, 0) + 1 WHERE user_phone = $1`,
        [userPhone]
      ).catch(() => { /* column may not exist yet on first boot */ });

      // includeNews: rarely true — cron calls with false and sends news as second message.
      if (includeNews) {
        const news = await this.generateNewsBriefing(userPhone);
        if (news) return `${brief}\n\n${news}`;
      }

      return brief;
    } catch (error) {
      logger.error('Error generating briefing:', error);
      return "Couldn't generate your briefing right now. Try again later?";
    }
  }

  // ============================================================
  // TODAY AGENDA — flat list for on-demand "what do I have today"
  //
  // Distinct from generateDailyBriefing (v2, fancy format reserved for
  // the 8am cron). This is what the user wants when they explicitly ask
  // "what do I have today" / "what's on my plate" — a straightforward
  // enumeration of commitments, no streak, no surprise, no ritual.
  // ============================================================

  async generateTodayAgenda(userPhone) {
    try {
      const tz = await timezoneService.getUserTimezone(userPhone);
      const now = new Date();
      const dateStr = now.toLocaleDateString('en-IN', {
        timeZone: tz, weekday: 'long', day: 'numeric', month: 'long'
      });

      const [reminders, googleEvents, outlookEvents, tasks] = await Promise.all([
        this.getTodaysReminders(userPhone, tz).catch(() => []),
        (async () => {
          try {
            if (await googleAuthService.isConnected(userPhone)) {
              return await this._getCalendarEventsToday(userPhone, tz, now);
            }
          } catch (_) {}
          return [];
        })(),
        (async () => {
          try {
            if (await microsoftAuthService.isConnected(userPhone)) {
              return await outlookCalendarService.getUpcomingEvents(
                userPhone,
                Math.max(0.5, this._hoursUntilEndOfLocalDay(tz, now))
              );
            }
          } catch (_) {}
          return [];
        })(),
        taskService.getAllMyTasks(userPhone).catch(() => ({ personal: [], assignedToMe: [], assignedByMe: [] })),
      ]);

      const allEvents = [...googleEvents, ...outlookEvents].sort((a, b) => {
        const sa = new Date(a.start?.dateTime || a.start?.date).getTime();
        const sb = new Date(b.start?.dateTime || b.start?.date).getTime();
        return sa - sb;
      });

      const fmtTime = (d) => d.toLocaleTimeString('en-IN', {
        timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true
      }).replace(/\s/g, '').toLowerCase();

      let out = `*Your plate — ${dateStr}*\n`;

      // ── Meetings today ─────────────────────────────────────
      if (allEvents.length > 0) {
        out += `\n📅 *Meetings (${allEvents.length})*\n`;
        allEvents.slice(0, 6).forEach(e => {
          const start = new Date(e.start?.dateTime || e.start?.date);
          const title = (e.summary || 'No title').slice(0, 60);
          out += `  • ${fmtTime(start)} — ${title}\n`;
        });
        if (allEvents.length > 6) out += `  …and ${allEvents.length - 6} more\n`;
      }

      // ── Personal + assigned-to-me tasks ────────────────────
      const myTasks = [...(tasks.personal || []), ...(tasks.assignedToMe || [])];
      if (myTasks.length > 0) {
        out += `\n✅ *Tasks (${myTasks.length})*\n`;
        myTasks.slice(0, 8).forEach((t, i) => {
          const by = t.assigned_by && t.assigned_by !== userPhone
            ? ` _(from ${t.assigned_by.slice(-4)})_`
            : ` _(personal)_`;
          const desc = (t.description || '').replace(/\s+/g, ' ').slice(0, 60);
          out += `  ${i + 1}. ${desc}${by}\n`;
        });
        if (myTasks.length > 8) out += `  …and ${myTasks.length - 8} more\n`;
      }

      // ── Reminders ahead today ──────────────────────────────
      if (reminders.length > 0) {
        out += `\n⏰ *Reminders ahead (${reminders.length})*\n`;
        reminders.slice(0, 6).forEach(r => {
          const time = new Date(r.reminder_time);
          const msg = (r.message || '').replace(/\s+/g, ' ').slice(0, 50);
          out += `  • ${fmtTime(time)} — ${msg}\n`;
        });
      }

      // ── Delegations awaiting ───────────────────────────────
      const delegated = tasks.assignedByMe || [];
      if (delegated.length > 0) {
        out += `\n💬 *Delegations awaiting (${delegated.length})*\n`;
        delegated.slice(0, 5).forEach(t => {
          const ageDays = Math.floor((Date.now() - new Date(t.created_at).getTime()) / (24 * 3600 * 1000));
          const age = ageDays === 0 ? 'today' : ageDays === 1 ? '1d ago' : `${ageDays}d ago`;
          const desc = (t.description || '').replace(/\s+/g, ' ').slice(0, 50);
          out += `  • ${desc} → ${t.assigned_to} _(${age})_\n`;
        });
      }

      // ── Empty state ────────────────────────────────────────
      const isEmpty = allEvents.length === 0 && myTasks.length === 0
                   && reminders.length === 0 && delegated.length === 0;
      if (isEmpty) {
        out += `\n_Nothing on your plate today. Enjoy the open calendar._`;
      }

      return out.trim();
    } catch (error) {
      logger.error('Error generating today agenda:', error);
      return "Couldn't fetch your agenda right now. Try again in a moment.";
    }
  }

  // ============================================================
  // EXTENDED BRIEFING (triggered by `more` reply or `detailed` pref)
  // ============================================================

  async generateExtendedBriefing(userPhone, opts = {}) {
    try {
      const userTimezone = await timezoneService.getUserTimezone(userPhone);
      const now = new Date();
      const today = now.toLocaleDateString('en-IN', {
        timeZone: userTimezone,
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
      });

      let briefing = `*Good ${this._getGreeting(this._localParts(now, userTimezone).localHour)}!*\n`;
      briefing += `${today}\n\n`;

      // FUTURE reminders today only (not already-fired)
      const reminders = await this.getTodaysReminders(userPhone, userTimezone);
      if (reminders.length > 0) {
        briefing += `*Reminders ahead today:*\n`;
        reminders.forEach((r, i) => {
          const time = new Date(r.reminder_time).toLocaleTimeString('en-IN', {
            timeZone: userTimezone, hour: '2-digit', minute: '2-digit', hour12: true
          });
          briefing += `${i + 1}. ${r.message} — ${time}\n`;
        });
        briefing += '\n';
      }

      // Delegated (from MODERN tasks table — not the dead delegated_tasks one)
      try {
        const { assignedByMe } = await taskService.getAllMyTasks(userPhone);
        if (assignedByMe.length > 0) {
          briefing += `*Delegated (awaiting):*\n`;
          assignedByMe.slice(0, 5).forEach((t, i) => {
            briefing += `${i + 1}. ${t.description} (to ${t.assigned_to})\n`;
          });
          briefing += '\n';
        }
      } catch (e) { /* tasks table optional */ }

      // Personal task digest
      try {
        const taskDigest = await taskService.getTaskDigest(userPhone);
        if (taskDigest) briefing += `*Tasks:* ${taskDigest}\n\n`;
      } catch (e) { /* optional */ }

      // Upcoming leaves
      try {
        const leaves = await leaveService.getUpcomingApprovedLeaves(userPhone);
        if (leaves.length > 0) {
          briefing += `*Upcoming Leave:*\n`;
          leaves.forEach(l => {
            const start = new Date(l.start_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
            const end = new Date(l.end_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
            briefing += `- ${l.leave_type} leave: ${start} - ${end}\n`;
          });
          briefing += '\n';
        }
      } catch (e) { /* optional */ }

      // Lists summary
      try {
        const lists = await listService.getUserLists(userPhone);
        if (lists.length > 0) {
          const pendingItems = lists.reduce((sum, l) => sum + (l.pending_count || l.pending_items || l.item_count || 0), 0);
          if (pendingItems > 0) {
            briefing += `*Lists:* ${pendingItems} pending across ${lists.length} lists\n\n`;
          }
        }
      } catch (e) { /* optional */ }

      // Today's calendar — bounded to end-of-local-day, not "next 24h"
      try {
        const events = await this._getCalendarEventsToday(userPhone, userTimezone, now);
        if (events.length > 0) {
          briefing += `*Today's Calendar:*\n`;
          events.slice(0, 5).forEach((e, i) => {
            const startTime = new Date(e.start?.dateTime || e.start?.date);
            const endTime = new Date(e.end?.dateTime || e.end?.date);
            const timeStr = `${this._fmtTime(startTime, userTimezone)} — ${this._fmtTime(endTime, userTimezone)}`;
            briefing += `${i + 1}. ${e.summary || 'No title'} (${timeStr})\n`;
          });
          if (events.length > 5) briefing += `   ...and ${events.length - 5} more\n`;
          briefing += '\n';
        }
      } catch (e) { /* optional */ }

      // Inbox
      try {
        const hasInboxScope = await googleAuthService.hasScope(userPhone, 'inbox');
        if (hasInboxScope) {
          const inboxResult = await inboxOrganizerService.getInboxSummary(userPhone, 5);
          if (inboxResult.success && inboxResult.emails) {
            const urgent = inboxResult.emails.urgent || [];
            const actionNeeded = inboxResult.emails.action_needed || [];
            const totalUnread = Object.values(inboxResult.emails).flat().length;
            if (totalUnread > 0) {
              briefing += `*Inbox:* ${totalUnread} unread`;
              if (urgent.length > 0) briefing += ` (${urgent.length} urgent)`;
              if (actionNeeded.length > 0) briefing += ` (${actionNeeded.length} need action)`;
              briefing += '\n';
              if (urgent.length > 0) {
                urgent.slice(0, 2).forEach(e => {
                  const from = (e.from || '').replace(/<[^>]+>/, '').trim().slice(0, 25);
                  briefing += `  ! ${from}: ${e.subject || '(no subject)'}\n`;
                });
              }
              briefing += '_Say "check my inbox" for full summary_\n\n';
            }
          }
        }
      } catch (e) { /* optional */ }

      // Habits (compact)
      try {
        const habits = await habitService.getHabits(userPhone);
        if (habits.length > 0) {
          const unlogged = await habitService.getUnloggedHabits(userPhone);
          briefing += `*Habits:* ${habits.length} tracked`;
          if (unlogged.length > 0) briefing += ` (${unlogged.length} pending)`;
          briefing += '\n\n';
        }
      } catch (e) { /* optional */ }

      // Expenses yesterday
      try {
        const summary = await expenseService.getSummary(userPhone, 'today');
        if (summary && summary.count > 0) {
          const symbol = summary.currency === 'USD' ? '$' : summary.currency === 'EUR' ? '€' : '₹';
          briefing += `*Today's Spending:* ${symbol}${Number(summary.totalSpent).toLocaleString()}\n\n`;
        }
      } catch (e) { /* optional */ }

      // Reading list
      try {
        const stats = await readingListService.getStats(userPhone);
        if (stats && stats.unread > 0) {
          briefing += `*Reading List:* ${stats.unread} unread items\n\n`;
        }
      } catch (e) { /* optional */ }

      briefing += `— Ari`;
      return briefing;
    } catch (error) {
      logger.error('Error generating extended briefing:', error);
      return "Couldn't generate your extended briefing right now.";
    }
  }

  // ============================================================
  // HERO ITEM — the single most urgent thing in next 4 hours
  // ============================================================

  async _getHeroItem(userPhone, tz, now) {
    const horizonEnd = new Date(now.getTime() + HERO_LOOKAHEAD_HOURS * 3600 * 1000);
    const candidates = [];

    // Upcoming reminders (future only)
    try {
      const result = await query(
        `SELECT id, message, reminder_time
         FROM reminders
         WHERE user_phone = $1
           AND status = 'pending'
           AND reminder_time >= $2
           AND reminder_time <= $3
         ORDER BY reminder_time ASC
         LIMIT 3`,
        [userPhone, now.toISOString(), horizonEnd.toISOString()]
      );
      for (const r of result.rows) {
        candidates.push({
          type: 'reminder',
          id: r.id,
          title: r.message,
          time: new Date(r.reminder_time)
        });
      }
    } catch (e) { /* reminders table optional */ }

    // Upcoming calendar events (bounded to horizon)
    try {
      const isConnected = await googleAuthService.isConnected(userPhone);
      if (isConnected) {
        // Use small lookahead = HERO_LOOKAHEAD_HOURS, capped at end-of-local-day
        const hoursAhead = Math.min(HERO_LOOKAHEAD_HOURS, this._hoursUntilEndOfLocalDay(tz, now) + 0.5);
        const events = await calendarService.getUpcomingEvents(userPhone, hoursAhead);
        for (const e of events.slice(0, 3)) {
          const start = new Date(e.start?.dateTime || e.start?.date);
          if (start > horizonEnd) continue;
          if (start < now) continue;
          candidates.push({
            type: 'event',
            id: e.id,
            title: e.summary || 'No title',
            time: start
          });
        }
      }
    } catch (e) { /* calendar optional */ }

    // Outlook
    try {
      const msConnected = await microsoftAuthService.isConnected(userPhone);
      if (msConnected) {
        const hoursAhead = Math.min(HERO_LOOKAHEAD_HOURS, this._hoursUntilEndOfLocalDay(tz, now) + 0.5);
        const events = await outlookCalendarService.getUpcomingEvents(userPhone, hoursAhead);
        for (const e of events.slice(0, 3)) {
          const start = new Date(e.start?.dateTime);
          if (start > horizonEnd) continue;
          if (start < now) continue;
          candidates.push({
            type: 'outlook_event',
            id: e.id,
            title: e.summary || 'No title',
            time: start
          });
        }
      }
    } catch (e) { /* optional */ }

    if (candidates.length === 0) return { text: null, ref: null };

    // Pick the earliest
    candidates.sort((a, b) => a.time.getTime() - b.time.getTime());
    const hero = candidates[0];
    const timeStr = this._fmtTime(hero.time, tz);
    const titleClean = this._truncateTitle(hero.title, 80);
    const label = hero.type === 'reminder' ? '' : '';  // no noisy emoji prefix — keep clean

    return {
      text: `${timeStr} — ${titleClean}`,
      ref: { type: hero.type, id: hero.id, title: hero.title }
    };
  }

  // ============================================================
  // TODAY AT A GLANCE — one-line summaries per category
  // ============================================================

  async _getTodayGlance(userPhone, tz, now) {
    const lines = [];
    let topTaskId = null;
    let topReminderId = null;
    const counts = { meetings: 0, tasks: 0, unread: 0, delegations: 0, reminders: 0 };

    // Meetings today (both providers, bounded to end-of-local-day)
    let totalMeetings = 0;
    let firstMeeting = null;
    try {
      const events = await this._getCalendarEventsToday(userPhone, tz, now);
      totalMeetings = events.length;
      for (const e of events) {
        const start = new Date(e.start?.dateTime || e.start?.date);
        if (start > now) {
          if (!firstMeeting || start < firstMeeting.time) {
            firstMeeting = { title: e.summary || 'No title', time: start };
          }
        }
      }
    } catch (e) { /* optional */ }

    if (totalMeetings > 0) {
      counts.meetings = totalMeetings;
      const meetingLine = firstMeeting
        ? `📅 ${totalMeetings} meeting${totalMeetings > 1 ? 's' : ''} · next: ${this._truncateTitle(firstMeeting.title, 28)} ${this._fmtTime(firstMeeting.time, tz)}`
        : `📅 ${totalMeetings} meeting${totalMeetings > 1 ? 's' : ''} today`;
      lines.push(meetingLine);
    }

    // Tasks (modern tasks table) — personal + assigned-to-me
    try {
      const all = await taskService.getAllMyTasks(userPhone);
      const mineOpen = [...(all.personal || []), ...(all.assignedToMe || [])];
      counts.tasks = mineOpen.length;
      counts.delegations = (all.assignedByMe || []).length;
      if (mineOpen.length > 0) {
        const top = mineOpen[0];
        topTaskId = top.id;
        lines.push(`✅ ${mineOpen.length} task${mineOpen.length > 1 ? 's' : ''} · top: ${this._truncateTitle(top.description, 36)}`);
      }
      if (counts.delegations > 0) {
        lines.push(`💬 ${counts.delegations} delegation${counts.delegations > 1 ? 's' : ''} pending — reply \`status\` to check`);
      }
    } catch (e) { /* optional */ }

    // Reminders still ahead today (excluding the hero if it's a reminder)
    try {
      const reminders = await this.getTodaysReminders(userPhone, tz);
      if (reminders.length > 0) {
        counts.reminders = reminders.length;
        topReminderId = reminders[0].id;
        // Only show if the hero didn't already cover it or if >1
        if (reminders.length > 1) {
          lines.push(`⏰ ${reminders.length} reminder${reminders.length > 1 ? 's' : ''} ahead · next ${this._fmtTime(new Date(reminders[0].reminder_time), tz)}`);
        }
      }
    } catch (e) { /* optional */ }

    // Inbox (only if connected)
    try {
      const hasInboxScope = await googleAuthService.hasScope(userPhone, 'inbox');
      if (hasInboxScope) {
        const inbox = await inboxOrganizerService.getInboxSummary(userPhone, 5);
        if (inbox.success && inbox.emails) {
          const totalUnread = Object.values(inbox.emails).flat().length;
          counts.unread = totalUnread;
          const urgent = inbox.emails.urgent || [];
          if (totalUnread > 0) {
            if (urgent.length > 0) {
              const top = urgent[0];
              const from = (top.from || '').replace(/<[^>]+>/, '').trim().slice(0, 20);
              lines.push(`📬 ${totalUnread} unread · urgent: ${from}`);
            } else {
              lines.push(`📬 ${totalUnread} unread`);
            }
          }
        }
      }
    } catch (e) { /* optional */ }

    return { lines, topTaskId, topReminderId, counts };
  }

  // ============================================================
  // SURPRISE SLOT — rotates by day of week (variable reward)
  // ============================================================

  async _getSurpriseSlot(userPhone, tz, weekday, localDateStr) {
    // weekday: 0 = Sunday, 1 = Monday, ..., 6 = Saturday

    switch (weekday) {
      case 0: return await this._sundayWeekPreview(userPhone, tz);
      case 1: return await this._mondayWeekAhead(userPhone, tz);
      case 2: return await this._tuesdayMemoryResurface(userPhone);
      case 3: return this._wednesdayReflection(localDateStr);
      case 4: return await this._thursdayDelegationCheck(userPhone);
      case 5: return await this._fridayWinTally(userPhone);
      case 6: return this._saturdayLightTouch(localDateStr);
      default: return null;
    }
  }

  async _sundayWeekPreview(userPhone, tz) {
    try {
      const now = new Date();
      const weekEnd = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
      let meetings = 0, tasks = 0;
      try {
        const isConnected = await googleAuthService.isConnected(userPhone);
        if (isConnected) {
          const events = await calendarService.getUpcomingEvents(userPhone, 7 * 24);
          meetings = events.length;
        }
      } catch (_) {}
      try {
        const all = await taskService.getAllMyTasks(userPhone);
        tasks = (all.personal || []).length + (all.assignedToMe || []).length;
      } catch (_) {}

      if (meetings === 0 && tasks === 0) return null;
      const bits = [];
      if (meetings > 0) bits.push(`${meetings} meeting${meetings > 1 ? 's' : ''}`);
      if (tasks > 0) bits.push(`${tasks} open task${tasks > 1 ? 's' : ''}`);
      return {
        label: 'Week ahead',
        text: `${bits.join(' · ')} heading into the new week. Reply \`plan\` for a sequence.`
      };
    } catch (e) { return null; }
  }

  async _mondayWeekAhead(userPhone, tz) {
    try {
      const isConnected = await googleAuthService.isConnected(userPhone);
      let bigItems = [];
      if (isConnected) {
        try {
          const events = await calendarService.getUpcomingEvents(userPhone, 7 * 24);
          bigItems = events.slice(0, 3).map(e => {
            const start = new Date(e.start?.dateTime || e.start?.date);
            const day = start.toLocaleDateString('en-IN', { timeZone: tz, weekday: 'short' });
            return `${this._truncateTitle(e.summary || 'Meeting', 24)} ${day}`;
          });
        } catch (_) {}
      }
      if (bigItems.length === 0) return null;
      return {
        label: 'This week',
        text: `${bigItems.length} big thing${bigItems.length > 1 ? 's' : ''}: ${bigItems.join(', ')}.`
      };
    } catch (e) { return null; }
  }

  async _tuesdayMemoryResurface(userPhone) {
    try {
      // Pull the memory trunk and find something > 14 days old worth surfacing.
      const trunk = await memoryService.getMemoryTrunk(userPhone);
      if (!trunk || typeof trunk !== 'object') return null;

      const candidates = [];
      for (const category of Object.values(trunk)) {
        if (!Array.isArray(category)) continue;
        for (const m of category) {
          const createdAt = m.created_at || m.createdAt;
          if (!createdAt) continue;
          const ageDays = (Date.now() - new Date(createdAt).getTime()) / (24 * 3600 * 1000);
          if (ageDays < 14) continue;
          const val = String(m.value || '').trim();
          if (val.length < 10 || val.length > 160) continue;
          candidates.push({ key: m.key, value: val, ageDays: Math.round(ageDays) });
        }
      }
      if (candidates.length === 0) return null;
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      return {
        label: 'Worth remembering',
        text: `${pick.ageDays} days ago you noted "${pick.value}". Still relevant?`
      };
    } catch (e) { return null; }
  }

  _wednesdayReflection(localDateStr) {
    // Deterministic pick based on date — same user gets same prompt same day
    const idx = this._hashString(localDateStr) % WEDNESDAY_REFLECTIONS.length;
    return {
      label: 'Midweek',
      text: WEDNESDAY_REFLECTIONS[idx]
    };
  }

  async _thursdayDelegationCheck(userPhone) {
    try {
      const all = await taskService.getAllMyTasks(userPhone);
      const delegated = all.assignedByMe || [];
      if (delegated.length === 0) return null;
      const recent = delegated.filter(t => {
        const age = (Date.now() - new Date(t.created_at).getTime()) / (24 * 3600 * 1000);
        return age <= 7;
      });
      if (recent.length === 0) return null;
      return {
        label: 'Delegations',
        text: `You delegated ${recent.length} thing${recent.length > 1 ? 's' : ''} this week. Reply \`status\` for their progress.`
      };
    } catch (e) { return null; }
  }

  async _fridayWinTally(userPhone) {
    try {
      const tasksR = await query(
        `SELECT COUNT(*)::int AS c FROM tasks
         WHERE user_phone = $1 AND status = 'completed'
           AND completed_at >= NOW() - INTERVAL '7 days'`,
        [userPhone]
      ).catch(() => null);
      const remindersR = await query(
        `SELECT COUNT(*)::int AS c FROM reminders
         WHERE user_phone = $1 AND status = 'sent'
           AND reminder_time >= NOW() - INTERVAL '7 days'`,
        [userPhone]
      ).catch(() => null);

      const tasksDone = tasksR?.rows?.[0]?.c || 0;
      const remindersDone = remindersR?.rows?.[0]?.c || 0;
      if (tasksDone === 0 && remindersDone === 0) return null;

      const bits = [];
      if (tasksDone > 0) bits.push(`${tasksDone} task${tasksDone > 1 ? 's' : ''} done`);
      if (remindersDone > 0) bits.push(`${remindersDone} reminder${remindersDone > 1 ? 's' : ''} delivered`);
      return {
        label: 'This week',
        text: `${bits.join(' · ')}. Strong week.`
      };
    } catch (e) { return null; }
  }

  _saturdayLightTouch(localDateStr) {
    const idx = this._hashString(localDateStr) % SATURDAY_LIGHT_TOUCH.length;
    return {
      label: 'Weekend',
      text: SATURDAY_LIGHT_TOUCH[idx]
    };
  }

  // ============================================================
  // STREAK — loss-aversion engine
  // ============================================================

  async _updateAndGetStreak(userPhone, localDateStr) {
    try {
      // Cast DATE to TEXT in SQL so we get back a plain YYYY-MM-DD string,
      // bypassing the JS Date tz-interpretation problem (pg parses DATE as
      // local-midnight, so .toISOString() shifts on positive-offset servers).
      const r = await query(
        `SELECT briefing_streak_count, briefing_streak_best,
                TO_CHAR(briefing_last_streak_date, 'YYYY-MM-DD') AS briefing_last_streak_date,
                briefing_streak_freezes,
                briefing_streak_freeze_reset_month
         FROM user_settings
         WHERE user_phone = $1`,
        [userPhone]
      );
      const row = r.rows[0] || {};

      const yesterdayStr = this._yesterdayDateStr(localDateStr);
      const lastDateStr = row.briefing_last_streak_date || null; // already YYYY-MM-DD text

      let count = Number(row.briefing_streak_count) || 0;
      let best = Number(row.briefing_streak_best) || 0;
      let freezes = row.briefing_streak_freezes == null ? 1 : Number(row.briefing_streak_freezes);
      const currentMonth = new Date().getUTCMonth() + 1;  // 1-12
      const resetMonth = row.briefing_streak_freeze_reset_month;

      // Refresh 1 freeze per month
      if (resetMonth !== currentMonth) freezes = 1;

      let freezeUsed = false;
      if (lastDateStr === localDateStr) {
        // Already incremented today — idempotent
      } else if (lastDateStr === yesterdayStr) {
        count += 1;
      } else if (lastDateStr === null) {
        count = 1;
      } else if (freezes > 0) {
        freezes -= 1;
        freezeUsed = true;
        count += 1;
      } else {
        count = 1;
      }
      best = Math.max(best, count);

      await query(
        `UPDATE user_settings
         SET briefing_streak_count = $2,
             briefing_streak_best = $3,
             briefing_last_streak_date = $4,
             briefing_streak_freezes = $5,
             briefing_streak_freeze_reset_month = $6
         WHERE user_phone = $1`,
        [userPhone, count, best, localDateStr, freezes, currentMonth]
      );

      return { count, best, freezes, freezeUsed };
    } catch (e) {
      logger.warn(`streak update failed: ${e.message}`);
      return { count: 0, best: 0, freezes: 0, freezeUsed: false };
    }
  }

  // ============================================================
  // USER-FACING HELPERS (called by webhook handlers)
  // ============================================================

  getLastBriefContext(userPhone) {
    return this._lastBriefContext.get(userPhone) || null;
  }

  async pauseBriefingForOneDay(userPhone) {
    try {
      const tz = await timezoneService.getUserTimezone(userPhone);
      const { localDateStr } = this._localParts(new Date(), tz);
      const tomorrow = this._tomorrowDateStr(localDateStr);
      await query(
        `UPDATE user_settings SET briefing_paused_until = $2, updated_at = NOW() WHERE user_phone = $1`,
        [userPhone, tomorrow]
      );
      return tomorrow;
    } catch (e) {
      logger.error(`pauseBriefingForOneDay failed: ${e.message}`);
      return null;
    }
  }

  async setLengthPreference(userPhone, pref) {
    const allowed = ['short', 'standard', 'detailed'];
    if (!allowed.includes(pref)) return false;
    try {
      await query(
        `UPDATE user_settings SET briefing_length_preference = $2, updated_at = NOW() WHERE user_phone = $1`,
        [userPhone, pref]
      );
      return true;
    } catch (e) {
      logger.error(`setLengthPreference failed: ${e.message}`);
      return false;
    }
  }

  async _getLengthPreference(userPhone) {
    try {
      const r = await query(
        `SELECT briefing_length_preference FROM user_settings WHERE user_phone = $1`,
        [userPhone]
      );
      return r.rows[0]?.briefing_length_preference || 'standard';
    } catch (e) { return 'standard'; }
  }

  // ============================================================
  // DATA FETCHERS
  // ============================================================

  /**
   * Reminders for today, FROM NOW forward (hides already-fired).
   * Also filters out reminders targeted at OTHER people (target_phone != null
   * implies the reminder is a delegated message to someone else — that's
   * not a personal to-do for the owner).
   */
  async getTodaysReminders(userPhone, userTimezone) {
    try {
      const now = new Date();
      const { localDateStr } = this._localParts(now, userTimezone);

      // End of local day — compute via same string-based approach used elsewhere
      const endLocalStr = `${localDateStr}T23:59:59`;
      // Rough end-of-day: parse as if in userTimezone, convert to UTC
      // Simpler: just bound by +24h from now and filter by date in JS
      const maxHorizon = new Date(now.getTime() + 24 * 3600 * 1000);

      const result = await query(
        `SELECT * FROM reminders
         WHERE user_phone = $1
         AND status = 'pending'
         AND reminder_time >= $2
         AND reminder_time <= $3
         AND (target_phone IS NULL OR target_phone = $1)
         ORDER BY reminder_time ASC`,
        [userPhone, now.toISOString(), maxHorizon.toISOString()]
      );

      // Filter to "today" in user's tz — drop any that slipped into tomorrow
      const kept = result.rows.filter(r => {
        const rDateStr = new Date(r.reminder_time).toLocaleDateString('en-CA', { timeZone: userTimezone });
        return rDateStr === localDateStr;
      });

      return kept;
    } catch (error) {
      logger.error('Error getting today reminders:', error);
      return [];
    }
  }

  async _getCalendarEventsToday(userPhone, tz, now = new Date()) {
    const hoursAhead = Math.max(0.5, this._hoursUntilEndOfLocalDay(tz, now));
    const all = [];
    try {
      const isConnected = await googleAuthService.isConnected(userPhone);
      if (isConnected) {
        const events = await calendarService.getUpcomingEvents(userPhone, hoursAhead);
        all.push(...events);
      }
    } catch (_) {}
    try {
      const msConnected = await microsoftAuthService.isConnected(userPhone);
      if (msConnected) {
        const events = await outlookCalendarService.getUpcomingEvents(userPhone, hoursAhead);
        all.push(...events);
      }
    } catch (_) {}
    return all;
  }

  async _getFirstName(userPhone) {
    try {
      const trunk = await memoryService.getMemoryTrunk(userPhone);
      const personal = trunk?.personal;
      if (!Array.isArray(personal)) return null;
      const candidates = ['name', 'first_name', 'firstname', 'nickname'];
      for (const key of candidates) {
        const hit = personal.find(m => String(m.key || '').toLowerCase() === key);
        if (hit && hit.value) {
          // Take the first word only for a friendly greeting
          return String(hit.value).trim().split(/\s+/)[0].slice(0, 20);
        }
      }
    } catch (e) { /* no memory yet */ }
    return null;
  }

  // ============================================================
  // UTILITIES
  // ============================================================

  _localParts(now, tz) {
    const localNowStr = now.toLocaleString('en-US', { timeZone: tz });
    const localNow = new Date(localNowStr);
    const localHour = localNow.getHours();
    const localDateStr = `${localNow.getFullYear()}-${String(localNow.getMonth() + 1).padStart(2, '0')}-${String(localNow.getDate()).padStart(2, '0')}`;
    const weekday = localNow.getDay(); // 0-6, Sunday-Saturday
    return { localHour, localDateStr, weekday };
  }

  _hoursUntilEndOfLocalDay(tz, now = new Date()) {
    const localNowStr = now.toLocaleString('en-US', { timeZone: tz });
    const localNow = new Date(localNowStr);
    const endOfDay = new Date(localNow);
    endOfDay.setHours(23, 59, 59, 999);
    const diffMs = endOfDay.getTime() - localNow.getTime();
    return Math.max(0, diffMs / 3600000);
  }

  _yesterdayDateStr(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10);
  }

  _tomorrowDateStr(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
  }

  _getGreeting(localHour) {
    if (localHour < 5) return 'Late night';
    if (localHour < 12) return 'Morning';
    if (localHour < 17) return 'Afternoon';
    if (localHour < 21) return 'Evening';
    return 'Night';
  }

  _fmtTime(date, tz) {
    return date.toLocaleTimeString('en-IN', {
      timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true
    }).replace(/\s/g, '').toLowerCase();
  }

  _truncateTitle(title, max = 60) {
    if (!title) return '';
    const clean = String(title).replace(/\s+/g, ' ').trim();
    return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
  }

  _hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }
}

module.exports = new BriefingService();
