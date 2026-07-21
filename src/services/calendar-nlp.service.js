const chrono = require('chrono-node');
const axios = require('axios');
const logger = require('../utils/logger');
const llm = require('./llm-provider');

const apiKey = llm.apiKey();
const apiUrl = llm.chatUrl();
const model = llm.fastModel();

class CalendarNLPService {

  constructor() {
    // Map of common non-English date/time words to English equivalents for chrono-node
    this.dateWordMap = {
      // Hindi/Hinglish
      'kal': 'tomorrow', 'aaj': 'today', 'parso': 'in 2 days', 'subah': 'morning',
      'dopahar': 'afternoon', 'shaam': 'evening', 'raat': 'night',
      'baje': '', // "10 baje" = "10 o'clock" — chrono handles the number
      'ghante': 'hours', 'minute': 'minutes', 'hafte': 'week', 'mahine': 'month',
      'somvar': 'monday', 'mangalvar': 'tuesday', 'budhvar': 'wednesday',
      'guruvar': 'thursday', 'shukravar': 'friday', 'shanivar': 'saturday', 'ravivar': 'sunday',
      // Spanish
      'manana': 'tomorrow', 'mañana': 'tomorrow', 'hoy': 'today', 'ayer': 'yesterday',
      'semana': 'week', 'mes': 'month', 'hora': 'hour', 'tarde': 'afternoon',
      'noche': 'night', 'mediodia': 'noon',
      'lunes': 'monday', 'martes': 'tuesday', 'miercoles': 'wednesday', 'miércoles': 'wednesday',
      'jueves': 'thursday', 'viernes': 'friday', 'sabado': 'saturday', 'sábado': 'saturday', 'domingo': 'sunday',
      // French
      'demain': 'tomorrow', "aujourd'hui": 'today', 'hier': 'yesterday',
      'matin': 'morning', 'soir': 'evening', 'apres-midi': 'afternoon',
      // German
      'morgen': 'tomorrow', 'heute': 'today', 'gestern': 'yesterday',
      'vormittag': 'morning', 'nachmittag': 'afternoon', 'abend': 'evening',
      // Common English typos
      'tomorow': 'tomorrow', 'tommorow': 'tomorrow', 'tomorro': 'tomorrow', 'tmrw': 'tomorrow', 'tmr': 'tomorrow',
      'todya': 'today', 'tdy': 'today', 'ysterday': 'yesterday',
      'schdule': 'schedule', 'shedule': 'schedule', 'meting': 'meeting', 'meetting': 'meeting',
    };
  }

  /**
   * Normalize non-English date/time words to English for chrono-node parsing.
   */
  normalizeNonEnglishDates(text) {
    let normalized = text;
    for (const [foreign, english] of Object.entries(this.dateWordMap)) {
      const regex = new RegExp(`\\b${foreign}\\b`, 'gi');
      normalized = normalized.replace(regex, english);
    }
    return normalized;
  }

  /**
   * Convert IANA timezone string to numeric offset in minutes for chrono-node.
   * chrono-node v2 ignores IANA strings and only accepts numeric offsets.
   */
  getTimezoneOffsetMinutes(ianaTimezone) {
    try {
      const now = new Date();
      const utcStr = now.toLocaleString('en-US', { timeZone: 'UTC' });
      const tzStr = now.toLocaleString('en-US', { timeZone: ianaTimezone });
      const utcDate = new Date(utcStr);
      const tzDate = new Date(tzStr);
      return Math.round((tzDate - utcDate) / 60000);
    } catch (e) {
      logger.warn('Failed to compute timezone offset for', ianaTimezone, ':', e.message);
      return 330; // default to IST (+5:30) = 330 minutes
    }
  }

  /**
   * Extract a duration in minutes from phrases like "for 30 minutes",
   * "2 hour meeting", "1.5 hours", "1 hr 30 min". Returns null if no duration
   * is found. This is the deterministic counterpart to the LLM-based extraction
   * and is checked FIRST to avoid LLM non-determinism returning wrong values.
   */
  _extractDurationMinutes(text) {
    if (!text) return null;
    const lower = String(text).toLowerCase();

    // Pattern 1: "1 hour 30 minutes", "2 hr 15 min"
    let m = lower.match(/\b(\d+(?:\.\d+)?)\s*(?:hour|hr)s?\s+(\d+)\s*(?:minute|min)s?\b/);
    if (m) return Math.round(parseFloat(m[1]) * 60 + parseInt(m[2], 10));

    // Pattern 2: "for 30 minutes" / "for 2 hours" / "for 1.5 hours"
    m = lower.match(/\bfor\s+(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?)\b/);
    if (m) {
      const n = parseFloat(m[1]);
      const unit = m[2];
      return unit.startsWith('h') ? Math.round(n * 60) : Math.round(n);
    }

    // Pattern 3: "30 minute meeting", "2 hour call", "15 min sync"
    m = lower.match(/\b(\d+(?:\.\d+)?)\s*(minute|min|hour|hr)s?\s+(?:meeting|call|slot|session|chat|block|sync|standup|discussion|interview|review)\b/);
    if (m) {
      const n = parseFloat(m[1]);
      const unit = m[2];
      return unit.startsWith('h') ? Math.round(n * 60) : Math.round(n);
    }

    // Pattern 4: "a 30-min call", "a 2-hour meeting" (hyphenated)
    m = lower.match(/\b(\d+(?:\.\d+)?)[-\s]+(minute|min|hour|hr)s?\s+(?:meeting|call|slot|session|chat|block|sync)\b/);
    if (m) {
      const n = parseFloat(m[1]);
      const unit = m[2];
      return unit.startsWith('h') ? Math.round(n * 60) : Math.round(n);
    }

    return null;
  }

  /**
   * Remove duration phrases (e.g. "for 30 minutes", "30 minute meeting") from
   * the input text before chrono parsing. chrono-node interprets bare duration
   * strings like "30 minutes" as a relative time ("30 minutes from now") which
   * then competes with the real meeting time and produces wrong events. The
   * durationMinutes is extracted separately via the LLM in extractEventDetailsAI.
   */
  _stripDurationPhrases(text) {
    if (!text) return text;
    const patterns = [
      // "for 30 minutes", "for 2 hours"
      /\bfor\s+\d+\s*(?:minutes?|mins?|hours?|hrs?|seconds?|secs?)\b/gi,
      // "30 minute meeting", "2 hour call", "15 min sync"
      /\b\d+\s*(?:minute|min|hour|hr|sec)s?\s+(?:meeting|call|slot|session|chat|block|sync|standup|discussion|interview|review)\b/gi,
      // Standalone "30 mins", "2hrs" at end of message after a comma
      /,\s*\d+\s*(?:minutes?|mins?|hours?|hrs?)\b/gi
    ];
    let out = text;
    for (const pattern of patterns) {
      out = out.replace(pattern, ' ');
    }
    // Collapse double spaces
    return out.replace(/\s+/g, ' ').trim();
  }

  // Build a context string from recent conversation messages
  buildConversationContext(recentMessages) {
    if (!recentMessages || recentMessages.length === 0) return '';
    return recentMessages
      .slice(-10) // last 10 messages
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n');
  }

  async parseEventRequest(message, timezone = 'Asia/Kolkata', recentMessages = []) {
    try {
      const conversationContext = this.buildConversationContext(recentMessages);

      // Use chrono-node for date/time parsing
      const refDate = new Date();
      const tzOffsetMinutes = this.getTimezoneOffsetMinutes(timezone);

      // Strip duration phrases BEFORE chrono parsing. Without this, chrono
      // interprets "for 30 minutes" / "30 minute meeting" as a relative time
      // (now + 30 minutes) and the subsequent [last] pick will overwrite the
      // real meeting time. Duration is already extracted separately via the
      // LLM's aiResult.durationMinutes downstream.
      const stripped = this._stripDurationPhrases(message);

      // First, try parsing ONLY the current message (most reliable for follow-ups like "time: 5pm")
      // forwardDate: true biases ambiguous day names ("friday") to the NEXT occurrence
      // — fixes bug where "schedule meeting friday at 4pm" was interpreted as last
      // friday (already past) and rejected with "that meeting time is in the past".
      const currentNormalized = this.normalizeNonEnglishDates(stripped);
      let chronoResults = chrono.parse(currentNormalized, { instant: refDate, timezone: tzOffsetMinutes }, { forwardDate: true });

      // If current message has no dates, try with conversation context
      if (chronoResults.length === 0 && conversationContext) {
        const rawFullText = `${recentMessages.filter(m => m.role === 'user').map(m => m.content).slice(-3).join('. ')}. ${message}`;
        const fullText = this.normalizeNonEnglishDates(this._stripDurationPhrases(rawFullText));
        chronoResults = chrono.parse(fullText, { instant: refDate, timezone: tzOffsetMinutes }, { forwardDate: true });
      }

      let startDate = null;
      let endDate = null;

      if (chronoResults.length > 0) {
        // Prefer a result that has an explicit day marker (tomorrow, Monday,
        // a date, etc.) because those are the ones where the user named a
        // real meeting time. Fall back to the last result otherwise.
        const withDay = chronoResults.filter(r => r.start && r.start.isCertain('day'));
        const parsed = withDay.length > 0
          ? withDay[withDay.length - 1]
          : chronoResults[chronoResults.length - 1];

        startDate = parsed.start ? parsed.start.date() : null;
        endDate = parsed.end ? parsed.end.date() : null;

        // If no explicit time was mentioned, default to 10:00 AM business hours
        // chrono-node defaults to current clock time when only a date is given
        if (startDate && parsed.start && !parsed.start.isCertain('hour')) {
          startDate.setHours(10, 0, 0, 0);
        }

        // Nearest-AM/PM roll-forward: if the user gave only a time (no date),
        // without an AM/PM qualifier, and the resulting datetime is in the
        // past, pick the NEAREST FUTURE occurrence across the 4 candidates
        // (today-AM, today-PM, tomorrow-AM, tomorrow-PM). Without this,
        // "schedule meet at 1:00" at 2pm would book a slot 13 hours ago.
        if (startDate && parsed.start && parsed.start.isCertain('hour')) {
          const userDidNotSayDay = !parsed.start.isCertain('day');
          const lowerMsg = message.toLowerCase();
          const hasAmPmQualifier = /\b(am|pm|a\.m\.|p\.m\.|morning|afternoon|evening|night|tonight|subah|shaam|sham|raat)\b/i.test(lowerMsg);
          const isAlreadyPast = startDate.getTime() <= Date.now();
          const hasExplicitDatePhrase = /\b(tomorrow|today|tonight|\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|kal|parso|next\s+\w+|this\s+\w+|on\s+\w+day)\b/i.test(lowerMsg);

          if (userDidNotSayDay && !hasAmPmQualifier && !hasExplicitDatePhrase && isAlreadyPast) {
            try {
              const { resolveAmbiguousTime } = require('../utils/tool-validation');
              const h24 = startDate.getHours();
              // Only 1-12 (12-hour clock) is ambiguous. 0 and 13-23 are unambiguous.
              const hour12 = h24 === 0 ? 12 : (h24 > 12 ? null : h24);
              if (hour12 !== null) {
                const durationMs = endDate ? (endDate.getTime() - startDate.getTime()) : null;
                // Use the request's timezone (passed in) directly
                const r = await resolveAmbiguousTime({
                  hour12,
                  minute: startDate.getMinutes(),
                  userPhone: null,
                  now: refDate
                });
                // If userPhone null, resolveAmbiguousTime defaults to Asia/Kolkata.
                // We want the request's timezone — recompute using the same-
                // structured candidates but through the timezone we have here.
                // Simple override: use the resolver's picked label to compute
                // the target date relative to the request's timezone.
                const picked = r.picked; // e.g. 'pm-today'
                const baseDate = new Date(refDate);
                const wantTomorrow = picked.endsWith('-tomorrow');
                const wantPm = picked.startsWith('pm-');
                if (wantTomorrow) baseDate.setDate(baseDate.getDate() + 1);
                const resolvedHour = wantPm ? (hour12 === 12 ? 12 : hour12 + 12) : (hour12 === 12 ? 0 : hour12);
                baseDate.setHours(resolvedHour, startDate.getMinutes(), 0, 0);

                logger.info({
                  original: startDate.toISOString(),
                  resolved: baseDate.toISOString(),
                  picked
                }, 'Calendar: ambiguous time rolled to nearest future');

                startDate = baseDate;
                if (durationMs !== null) {
                  endDate = new Date(startDate.getTime() + durationMs);
                }
              }
            } catch (e) {
              logger.warn(`Calendar nearest-AM/PM rollforward failed: ${e.message}`);
            }
          }
        }
      }

      // Use AI to extract title, attendees, location, and duration
      const aiResult = await this.extractEventDetailsAI(message, timezone, conversationContext);

      // If chrono didn't find dates but AI did, use AI dates
      if (!startDate && aiResult.startTime) {
        const chronoFallback = chrono.parseDate(aiResult.startTime, { instant: refDate, timezone: tzOffsetMinutes }, { forwardDate: true });
        if (chronoFallback) startDate = chronoFallback;
      }

      if (!startDate) {
        return { success: false, error: 'Could not parse date/time from your message' };
      }

      // Default duration: 30 minutes if no end time.
      // Prefer regex-extracted duration from the message over the LLM, because
      // the LLM is non-deterministic and has been observed returning
      // durationMinutes=90 for messages like "for 30 minutes".
      if (!endDate) {
        const regexDuration = this._extractDurationMinutes(message);
        const durationMins = regexDuration || aiResult.durationMinutes || 30;
        endDate = new Date(startDate.getTime() + durationMins * 60 * 1000);
      }

      // Parse attendees from AI result. Pass the original message so the
      // placeholder-filter only drops example.com/example.org emails the LLM
      // hallucinated — emails the user actually typed are kept.
      // (Apr 28 2026 — RC0 fix: silent attendee drop for user-typed example.com)
      const attendees = this.parseAttendees(aiResult.attendees || [], message);

      // RECURRENCE (Apr 27 2026 — FIX #5):
      // Run REGEX FIRST. If the user said "every weekday" / "daily" / "every
      // monday" / "weekly" / "monthly", that's an explicit deterministic
      // intent — don't let the LLM (which often picked 'daily' from the
      // phrase "daily standup") override it. LLM is fallback only.
      let recurrence = null;
      const lowerMsg = message.toLowerCase();
      if (/\b(every\s+weekday|on\s+weekdays|each\s+weekday|weekdays\b)/i.test(lowerMsg)) {
        recurrence = 'weekdays';
      } else if (/\b(every\s+(mon|tue|wed|thu|fri|sat|sun)[a-z]*)\b/i.test(lowerMsg)) {
        const m = lowerMsg.match(/\bevery\s+(mon|tue|wed|thu|fri|sat|sun)/i);
        if (m) recurrence = `weekly_${m[1].toLowerCase()}`;
      } else if (/\b(every\s+day|each\s+day|everyday)\b/i.test(lowerMsg)) {
        // Note: bare 'daily' is intentionally NOT here — phrases like "daily
        // standup" are noun-modifiers, not recurrence intents. Use "every day"
        // explicitly for daily recurrence.
        recurrence = 'daily';
      } else if (/\b(every\s+week|weekly)\b/i.test(lowerMsg)) {
        recurrence = 'weekly';
      } else if (/\b(every\s+month|monthly)\b/i.test(lowerMsg)) {
        recurrence = 'monthly';
      }
      // LLM fallback only when regex finds nothing
      if (!recurrence && aiResult.recurrence) {
        recurrence = aiResult.recurrence;
      }

      return {
        success: true,
        title: aiResult.title || 'Meeting',
        start: startDate,
        end: endDate,
        attendees,
        location: aiResult.location || null,
        description: aiResult.description || null,
        recurrence, // 'daily' | 'weekdays' | 'weekly_<dow>' | 'weekly' | 'monthly' | null
        timezone
      };

    } catch (error) {
      logger.error('parseEventRequest error:', error.message);
      return { success: false, error: 'Could not understand the meeting details' };
    }
  }

  async parseCancelRequest(message, timezone = 'Asia/Kolkata', recentMessages = []) {
    try {
      const conversationContext = this.buildConversationContext(recentMessages);
      const normalizedMessage = this.normalizeNonEnglishDates(message);
      const refDate = new Date();
      const tzOffsetMinutes = this.getTimezoneOffsetMinutes(timezone);
      const chronoResults = chrono.parse(normalizedMessage, { instant: refDate, timezone: tzOffsetMinutes }, { forwardDate: true });
      let targetDate = null;

      if (chronoResults.length > 0) {
        targetDate = chronoResults[0].start.date();
      }

      const contextBlock = conversationContext
        ? `\nRecent conversation:\n${conversationContext}\n`
        : '';

      const taskModel = llm.modelFor('calendar_nlp') || model;
      const response = await llm.chatCompletion({
        model: taskModel,
        messages: [
          { role: 'system', content: 'Extract the meeting to cancel from the user message. Use the conversation context to understand references like "it", "that meeting", "the one I just mentioned". Output ONLY valid JSON.' },
          { role: 'user', content: `${contextBlock}Current message: "${message}"\n\nJSON: {"title": "meeting title or keyword"|null, "cancel_all_on_date": false}` }
        ],
        temperature: 0,
        max_tokens: 100,
      }, { task: 'calendar_nlp', timeout: 5000 });
      try { require('./model-usage-tracker.service').log({ task: 'calendar_nlp', model: taskModel, usage: response?.data?.usage }); } catch (_) {}

      const content = response.data.choices[0].message.content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

      return {
        success: true,
        title: parsed.title || null,
        targetDate,
        cancelAll: parsed.cancel_all_on_date || false
      };
    } catch (error) {
      logger.error('parseCancelRequest error:', error.message);
      return { success: true, title: null, targetDate: null, cancelAll: false };
    }
  }

  async parseRescheduleRequest(message, timezone = 'Asia/Kolkata', recentMessages = []) {
    try {
      const conversationContext = this.buildConversationContext(recentMessages);
      const normalizedMessage = this.normalizeNonEnglishDates(message);
      const refDate = new Date();
      const tzOffsetMinutes = this.getTimezoneOffsetMinutes(timezone);
      const chronoResults = chrono.parse(normalizedMessage, { instant: refDate, timezone: tzOffsetMinutes }, { forwardDate: true });

      let newTime = null;
      if (chronoResults.length > 0) {
        const last = chronoResults[chronoResults.length - 1];
        newTime = last.start.date();
      }

      const contextBlock = conversationContext
        ? `\nRecent conversation:\n${conversationContext}\n`
        : '';

      const taskModel2 = llm.modelFor('calendar_nlp') || model;
      const response = await llm.chatCompletion({
        model: taskModel2,
        messages: [
          { role: 'system', content: 'Extract reschedule details. Use conversation context to understand references. Output ONLY valid JSON.' },
          { role: 'user', content: `${contextBlock}Current message: "${message}"\n\nJSON: {"original_title": "meeting title"|null, "new_time_text": "the new time phrase"|null}` }
        ],
        temperature: 0,
        max_tokens: 100,
      }, { task: 'calendar_nlp', timeout: 5000 });
      try { require('./model-usage-tracker.service').log({ task: 'calendar_nlp', model: taskModel2, usage: response?.data?.usage }); } catch (_) {}

      const content = response.data.choices[0].message.content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

      return {
        success: true,
        originalTitle: parsed.original_title || null,
        newTime,
        newTimeText: parsed.new_time_text || null
      };
    } catch (error) {
      logger.error('parseRescheduleRequest error:', error.message);
      return { success: false, error: 'Could not parse reschedule request' };
    }
  }

  async parseAvailabilityRequest(message, timezone = 'Asia/Kolkata') {
    try {
      const normalizedMessage = this.normalizeNonEnglishDates(message);
      const refDate = new Date();
      const tzOffsetMinutes = this.getTimezoneOffsetMinutes(timezone);
      const lowerForRel = (message || '').toLowerCase();

      // FIX #3 (Apr 27 2026 — Bucket C03/G08 calendar-list date bug):
      // Compute today's local date in the user's timezone using year/month/day
      // string parts (NOT toLocaleString which is fragile). This avoids the
      // EC2-UTC vs IST drift that was making "tomorrow" resolve to today.
      const localParts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(refDate);
      const y = Number(localParts.find(p => p.type === 'year').value);
      const mo = Number(localParts.find(p => p.type === 'month').value) - 1;
      const d = Number(localParts.find(p => p.type === 'day').value);
      const todayLocalAtNoon = new Date(Date.UTC(y, mo, d, 12, 0, 0));

      // Explicit relative-day override (BEFORE chrono). Use the deterministic
      // todayLocalAtNoon computed above to bypass server-vs-user timezone drift.
      let relativeOverride = null;
      if (/\b(today|aaj|aj|hoy|aujourd['’]hui|heute)\b/i.test(lowerForRel)) {
        relativeOverride = new Date(todayLocalAtNoon);
      } else if (/\b(tomorrow|tmrw|tmr|kal|mañana|demain|morgen)\b/i.test(lowerForRel)) {
        relativeOverride = new Date(todayLocalAtNoon);
        relativeOverride.setUTCDate(relativeOverride.getUTCDate() + 1);
      } else if (/\b(yesterday|kal\s+(?=tha|thi)|ayer|hier|gestern)\b/i.test(lowerForRel)) {
        relativeOverride = new Date(todayLocalAtNoon);
        relativeOverride.setUTCDate(relativeOverride.getUTCDate() - 1);
      }

      const chronoResults = chrono.parse(normalizedMessage, { instant: refDate, timezone: tzOffsetMinutes }, { forwardDate: true });

      let targetDate = null;
      if (relativeOverride) {
        targetDate = relativeOverride;
      } else if (chronoResults.length > 0) {
        // Mirror parseEventRequest: prefer results with an explicit day marker
        // ("tomorrow", "monday", "may 5") over time-only fragments. Without
        // this, "what's on my calendar tomorrow" was returning today's events
        // because chronoResults[0] was a time-only fragment that resolved to
        // current clock-day.
        const withDay = chronoResults.filter(r => r.start && r.start.isCertain && r.start.isCertain('day'));
        const parsed = withDay.length > 0
          ? withDay[withDay.length - 1]
          : chronoResults[chronoResults.length - 1];
        targetDate = parsed.start.date();
      } else {
        targetDate = new Date();
      }

      // Detect week/month range requests
      const lowerMsg = message.toLowerCase();
      let rangeType = 'day'; // default: single day
      if (/\b(this\s+week|next\s+week|coming\s+week|hele\s+week|is\s+hafte|esta\s+semana|cette\s+semaine|diese\s+woche)\b/i.test(lowerMsg)) {
        rangeType = 'week';
      } else if (/\b(this\s+month|next\s+month|is\s+mahine|este\s+mes|ce\s+mois|diesen\s+monat)\b/i.test(lowerMsg)) {
        rangeType = 'month';
      }

      // For "this week"/"this month", use today's date to avoid chrono offsetting to wrong week
      if (rangeType !== 'day' && /\bthis\s+(week|month)\b/i.test(lowerMsg)) {
        targetDate = new Date();
      }

      return { success: true, targetDate, timezone, rangeType };
    } catch (error) {
      return { success: true, targetDate: new Date(), timezone, rangeType: 'day' };
    }
  }

  async parseEmailRequest(message, recentMessages = []) {
    try {
      const conversationContext = this.buildConversationContext(recentMessages);
      const contextBlock = conversationContext
        ? `\nRecent conversation:\n${conversationContext}\n`
        : '';

      const taskModel3 = llm.modelFor('calendar_nlp') || model;
      const response = await llm.chatCompletion({
        model: taskModel3,
        messages: [
          { role: 'system', content: 'Extract email action from user message about a calendar event. Use conversation context to understand references. Output ONLY valid JSON.' },
          { role: 'user', content: `${contextBlock}Current message: "${message}"\n\nJSON: {"action": "confirmation"|"cancellation"|"reschedule"|"custom", "event_title": "meeting title"|null, "custom_message": "any custom message"|null}` }
        ],
        temperature: 0,
        max_tokens: 150,
      }, { task: 'calendar_nlp', timeout: 5000 });
      try { require('./model-usage-tracker.service').log({ task: 'calendar_nlp', model: taskModel3, usage: response?.data?.usage }); } catch (_) {}

      const content = response.data.choices[0].message.content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

      return {
        success: true,
        action: parsed.action || 'confirmation',
        eventTitle: parsed.event_title || null,
        customMessage: parsed.custom_message || null
      };
    } catch (error) {
      logger.error('parseEmailRequest error:', error.message);
      return { success: true, action: 'confirmation', eventTitle: null, customMessage: null };
    }
  }

  async extractEventDetailsAI(message, timezone, conversationContext = '') {
    try {
      const now = new Date().toLocaleString('en-IN', { timeZone: timezone });

      const contextBlock = conversationContext
        ? `\nRecent conversation:\n${conversationContext}\n`
        : '';

      const taskModel4 = llm.modelFor('calendar_nlp') || model;
      const response = await llm.chatCompletion({
        model: taskModel4,
        messages: [
          { role: 'system', content: 'Extract meeting/event details from the user message. Use the recent conversation to understand context and references like "it", "that", "the meeting we discussed". If details were mentioned in earlier messages, use them. If the user gives a vague time like "sometime next week" without a specific hour, set startTime to include "10am" as the default business hour. RECURRENCE: if the message says "every day"/"daily"/"every weekday"/"weekdays"/"every monday"/"every week"/"weekly"/"every month"/"monthly", set `recurrence` to one of: "daily" | "weekdays" | "weekly_<dow>" (e.g. weekly_mon) | "weekly" | "monthly". Otherwise set null. Output ONLY valid JSON.' },
          { role: 'user', content: `Current time: ${now} (${timezone})${contextBlock}\nCurrent message: "${message}"\n\nJSON: {"title": "meeting title", "attendees": ["email1@example.com"], "location": "location"|null, "description": "description"|null, "durationMinutes": 30, "startTime": "time phrase from message"|null, "recurrence": "daily"|"weekdays"|"weekly"|"weekly_mon"|"weekly_tue"|"weekly_wed"|"weekly_thu"|"weekly_fri"|"weekly_sat"|"weekly_sun"|"monthly"|null}` }
        ],
        temperature: 0,
        max_tokens: 220,
      }, { task: 'calendar_nlp', timeout: 5000 });
      try { require('./model-usage-tracker.service').log({ task: 'calendar_nlp', model: taskModel4, usage: response?.data?.usage }); } catch (_) {}

      const content = response.data.choices[0].message.content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    } catch (error) {
      logger.warn('AI event extraction failed:', error.message);
      return {};
    }
  }

  /**
   * Filter attendees so we don't add LLM-hallucinated placeholder emails to
   * real calendar invites, but DO keep emails the user actually typed.
   *
   * Before Apr 28 2026 this stripped any email containing "example.com" /
   * "example.org" unconditionally, which silently destroyed user-provided
   * attendees during real testing and any production call where the user
   * legitimately invited an example.com mailbox.
   *
   * @param {Array<string>} attendees - emails returned by the secondary LLM
   * @param {string} [originalMessage] - user's original raw message; if provided,
   *   placeholder-looking emails are kept when the user actually typed them
   */
  parseAttendees(attendees, originalMessage = '') {
    if (!Array.isArray(attendees)) return [];
    const lowerMessage = String(originalMessage || '').toLowerCase();
    const looksLikePlaceholder = (email) =>
      email.includes('example.com') ||
      email.includes('example.org') ||
      /^(email\d*@|user@|test@|placeholder@)/.test(email);

    return attendees
      .filter(a => typeof a === 'string' && a.includes('@'))
      .map(email => ({ email: email.trim().toLowerCase() }))
      .filter(a => {
        if (!looksLikePlaceholder(a.email)) return true;
        // Placeholder pattern — only keep if the user explicitly typed this
        // exact email in their original message.
        return lowerMessage.includes(a.email);
      });
  }
}

module.exports = new CalendarNLPService();
