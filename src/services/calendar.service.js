const { google } = require('googleapis');
const crypto = require('crypto');
const { query } = require('../config/database');
const googleAuthService = require('./google-auth.service');
const { withRetry } = require('../utils/retry');
const logger = require('../utils/logger');

class CalendarService {

  constructor() {
    this.tablesCreated = false;
  }

  async ensureTables() {
    if (this.tablesCreated) return;
    try {
      // Safely add missing columns instead of dropping tables
      try {
        await query(`SELECT google_event_id, idempotency_hash, location, attendees, status, updated_at FROM calendar_events LIMIT 0`);
      } catch (e) {
        // Table exists but missing columns — add them safely
        try {
          await query(`ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS google_event_id VARCHAR(255)`);
          await query(`ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS idempotency_hash VARCHAR(64) UNIQUE`);
          await query(`ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS location TEXT`);
          await query(`ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS attendees JSONB DEFAULT '[]'`);
          await query(`ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active'`);
          await query(`ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`);
        } catch (_) {
          // Table doesn't exist at all — will be created below
        }
      }

      await query(`
        CREATE TABLE IF NOT EXISTS calendar_events (
          id SERIAL PRIMARY KEY,
          user_phone VARCHAR(20) NOT NULL,
          google_event_id VARCHAR(255),
          title VARCHAR(500),
          start_time TIMESTAMP NOT NULL,
          end_time TIMESTAMP NOT NULL,
          attendees JSONB DEFAULT '[]',
          location TEXT,
          idempotency_hash VARCHAR(64) UNIQUE,
          status VARCHAR(20) DEFAULT 'active',
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS calendar_reminders (
          id SERIAL PRIMARY KEY,
          user_phone VARCHAR(20) NOT NULL,
          calendar_event_id INTEGER REFERENCES calendar_events(id) ON DELETE CASCADE,
          google_event_id VARCHAR(255),
          event_title VARCHAR(500),
          event_start TIMESTAMP NOT NULL,
          reminder_time TIMESTAMP NOT NULL,
          status VARCHAR(20) DEFAULT 'pending',
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS google_audit_log (
          id SERIAL PRIMARY KEY,
          user_phone VARCHAR(20) NOT NULL,
          action VARCHAR(50) NOT NULL,
          google_event_id VARCHAR(255),
          details JSONB DEFAULT '{}',
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      await query(`CREATE INDEX IF NOT EXISTS idx_cal_events_phone ON calendar_events(user_phone)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_cal_events_hash ON calendar_events(idempotency_hash)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_cal_reminders_time ON calendar_reminders(reminder_time)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_cal_reminders_status ON calendar_reminders(status)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_audit_phone ON google_audit_log(user_phone)`);

      this.tablesCreated = true;
    } catch (error) {
      logger.error('Error creating calendar tables:', error.message);
    }
  }

  _eventIdempotencyFingerprint(title, start, attendees) {
    const attendeeStr = (attendees || []).map(a => a.email || a).sort().join(',');
    return `${title}|${new Date(start).toISOString()}|${attendeeStr}`;
  }

  computeIdempotencyHash(userPhone, title, start, attendees) {
    const data = `${String(userPhone || '').trim()}|${this._eventIdempotencyFingerprint(title, start, attendees)}`;
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  computeLegacyIdempotencyHash(title, start, attendees) {
    return crypto.createHash('sha256')
      .update(this._eventIdempotencyFingerprint(title, start, attendees))
      .digest('hex');
  }

  /**
   * Convert our internal recurrence semantic into a Google Calendar RRULE.
   * @param {string} recurrence - 'daily' | 'weekdays' | 'weekly' | 'weekly_<dow>' | 'monthly'
   * @returns {string|null} RRULE string (without "RRULE:" prefix not required — Google expects RRULE:...)
   */
  _buildRecurrenceRule(recurrence) {
    if (!recurrence || typeof recurrence !== 'string') return null;
    const r = recurrence.toLowerCase();
    if (r === 'daily' || r === 'everyday') return 'RRULE:FREQ=DAILY';
    if (r === 'weekdays') return 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
    if (r === 'weekly') return 'RRULE:FREQ=WEEKLY';
    if (r === 'monthly') return 'RRULE:FREQ=MONTHLY';
    if (r.startsWith('weekly_')) {
      const dow = r.slice(7, 10).toUpperCase(); // MON, TUE, WED, THU, FRI, SAT, SUN
      const valid = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
      const map = { MON: 'MO', TUE: 'TU', WED: 'WE', THU: 'TH', FRI: 'FR', SAT: 'SA', SUN: 'SU' };
      const day = map[dow];
      if (day && valid.includes(day)) return `RRULE:FREQ=WEEKLY;BYDAY=${day}`;
    }
    return null;
  }

  async createEvent(userPhone, eventData) {
    await this.ensureTables();

    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) {
      return { success: false, error: 'Google not connected. Say "connect google" first.' };
    }

    const { title, start, end, attendees, location, description, timezone, recurrence, calendarId: explicitCalendarId } = eventData;
    const calendarId = explicitCalendarId || await this.getDefaultCalendarId(userPhone);

    // Idempotency check
    const hash = this.computeIdempotencyHash(userPhone, title, start, attendees);
    const legacyHash = this.computeLegacyIdempotencyHash(title, start, attendees);
    const existing = await query(
      `SELECT * FROM calendar_events
       WHERE user_phone = $1 AND idempotency_hash IN ($2, $3) AND status = 'active'`,
      [userPhone, hash, legacyHash]
    );
    if (existing.rows.length > 0) {
      return { success: false, error: 'This meeting already exists!' };
    }

    // Skip free/busy check for all-day leave events or explicit force (book anyway)
    if (!eventData.allDay && !eventData.force) {
      const busyCheck = await this.checkFreeBusy(userPhone, start, end);
      if (busyCheck.busy) {
        const alternatives = await this.suggestAlternatives(userPhone, start, (end - start) / 60000);
        return {
          success: false,
          conflict: true,
          busyWith: busyCheck.conflictTitle,
          alternatives
        };
      }
    }

    try {
      const calendar = google.calendar({ version: 'v3', auth: authClient });

      let event;
      if (eventData.allDay) {
        // All-day event: use date format; end date must be day AFTER last day (Google Calendar convention)
        const startDateStr = new Date(start).toISOString().split('T')[0];
        const endDateObj = new Date(end);
        endDateObj.setDate(endDateObj.getDate() + 1);
        const endDateStr = endDateObj.toISOString().split('T')[0];
        event = {
          summary: title,
          start: { date: startDateStr },
          end: { date: endDateStr },
        };
      } else {
        event = {
          summary: title,
          start: { dateTime: new Date(start).toISOString(), timeZone: timezone },
          end: { dateTime: new Date(end).toISOString(), timeZone: timezone },
        };
      }

      if (attendees && attendees.length > 0) {
        event.attendees = attendees;
      }
      if (location) event.location = location;
      if (description) event.description = description;

      // Recurrence: build Google Calendar RRULE from semantic value.
      // Skip for all-day leave events (handled separately).
      if (recurrence && !eventData.allDay) {
        const rrule = this._buildRecurrenceRule(recurrence);
        if (rrule) {
          event.recurrence = [rrule];
        }
      }

      const result = await withRetry(async () => {
        return calendar.events.insert({
          calendarId,
          resource: event,
          sendUpdates: attendees?.length > 0 ? 'all' : 'none'
        });
      });

      const googleEvent = result.data;

      // Store local mapping
      const dbResult = await query(`
        INSERT INTO calendar_events (user_phone, google_event_id, title, start_time, end_time, attendees, location, idempotency_hash, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
        RETURNING id
      `, [
        userPhone, googleEvent.id, title,
        new Date(start).toISOString(), new Date(end).toISOString(),
        JSON.stringify(attendees || []), location, hash
      ]);

      // Create 15-minute reminder
      const reminderTime = new Date(new Date(start).getTime() - 15 * 60 * 1000);
      if (reminderTime > new Date()) {
        await query(`
          INSERT INTO calendar_reminders (user_phone, calendar_event_id, google_event_id, event_title, event_start, reminder_time, status)
          VALUES ($1, $2, $3, $4, $5, $6, 'pending')
        `, [userPhone, dbResult.rows[0].id, googleEvent.id, title, new Date(start).toISOString(), reminderTime.toISOString()]);
      }

      // Audit log
      await this.auditLog(userPhone, 'create_event', googleEvent.id, {
        title, start: new Date(start).toISOString(), end: new Date(end).toISOString(),
        attendees: attendees?.length || 0
      });

      return {
        success: true,
        eventId: googleEvent.id,
        event: googleEvent,
        localId: dbResult.rows[0].id,
        title,
        start: new Date(start),
        end: new Date(end),
        attendees,
        htmlLink: googleEvent.htmlLink
      };

    } catch (error) {
      const tokenResult = await googleAuthService.handleTokenError(userPhone, error);
      if (tokenResult.cleared) return { success: false, error: tokenResult.message };
      logger.error('Calendar create error:', error.message);
      return { success: false, error: 'Failed to create event. Try again.' };
    }
  }

  async checkFreeBusy(userPhone, start, end) {
    try {
      const authClient = await googleAuthService.getAuthClient(userPhone);
      if (!authClient) return { busy: false };

      const calendar = google.calendar({ version: 'v3', auth: authClient });

      const result = await withRetry(async () => {
        return calendar.freebusy.query({
          resource: {
            timeMin: new Date(start).toISOString(),
            timeMax: new Date(end).toISOString(),
            items: [{ id: 'primary' }]
          }
        });
      });

      const busy = result.data.calendars?.primary?.busy || [];
      if (busy.length > 0) {
        // Try to get the conflicting event title
        let conflictTitle = 'another event';
        try {
          const events = await calendar.events.list({
            calendarId: 'primary',
            timeMin: new Date(start).toISOString(),
            timeMax: new Date(end).toISOString(),
            singleEvents: true
          });
          if (events.data.items?.length > 0) {
            conflictTitle = events.data.items[0].summary || 'another event';
          }
        } catch (e) { /* ignore */ }

        return { busy: true, conflictTitle };
      }

      return { busy: false };
    } catch (error) {
      logger.warn('Free/busy check failed:', error.message);
      return { busy: false };
    }
  }

  async suggestAlternatives(userPhone, start, durationMins = 30) {
    try {
      const authClient = await googleAuthService.getAuthClient(userPhone);
      if (!authClient) return [];

      const calendar = google.calendar({ version: 'v3', auth: authClient });
      const startTime = new Date(start);
      const searchStart = new Date(startTime.getTime() - 2 * 60 * 60 * 1000);
      const searchEnd = new Date(startTime.getTime() + 4 * 60 * 60 * 1000);

      const events = await calendar.events.list({
        calendarId: 'primary',
        timeMin: searchStart.toISOString(),
        timeMax: searchEnd.toISOString(),
        singleEvents: true,
        orderBy: 'startTime'
      });

      const busySlots = (events.data.items || []).map(e => ({
        start: new Date(e.start.dateTime || e.start.date),
        end: new Date(e.end.dateTime || e.end.date)
      }));

      const alternatives = [];
      const durationMs = durationMins * 60 * 1000;

      // Find free slots
      let cursor = searchStart;
      for (const slot of busySlots) {
        if (slot.start - cursor >= durationMs && cursor >= new Date()) {
          alternatives.push({ start: new Date(cursor), end: new Date(cursor.getTime() + durationMs) });
          if (alternatives.length >= 3) break;
        }
        cursor = new Date(Math.max(cursor.getTime(), slot.end.getTime()));
      }

      // Check after last busy slot
      if (alternatives.length < 3 && searchEnd - cursor >= durationMs && cursor >= new Date()) {
        alternatives.push({ start: new Date(cursor), end: new Date(cursor.getTime() + durationMs) });
      }

      return alternatives;
    } catch (error) {
      logger.warn('suggestAlternatives error:', error.message);
      return [];
    }
  }

  async findEvents(userPhone, { timeMin, timeMax, queryStr, attendeeEmail, calendarId } = {}) {
    try {
      const authClient = await googleAuthService.getAuthClient(userPhone);
      if (!authClient) return [];

      const calendar = google.calendar({ version: 'v3', auth: authClient });
      const params = {
        calendarId: calendarId || await this.getDefaultCalendarId(userPhone),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 10
      };

      if (timeMin) params.timeMin = new Date(timeMin).toISOString();
      if (timeMax) params.timeMax = new Date(timeMax).toISOString();
      if (queryStr) params.q = queryStr;

      const result = await withRetry(() => calendar.events.list(params));
      let events = result.data.items || [];

      if (attendeeEmail) {
        events = events.filter(e =>
          e.attendees?.some(a => a.email.toLowerCase() === attendeeEmail.toLowerCase())
        );
      }

      return events;
    } catch (error) {
      const tokenResult = await googleAuthService.handleTokenError(userPhone, error);
      if (tokenResult.cleared) return [];
      logger.error('findEvents error:', error.message);
      return [];
    }
  }

  async cancelEvent(userPhone, identifier, notifyAttendees = true) {
    await this.ensureTables();

    try {
      const authClient = await googleAuthService.getAuthClient(userPhone);
      if (!authClient) return { success: false, error: 'Google not connected' };

      const calendar = google.calendar({ version: 'v3', auth: authClient });

      // Find event by title or ID
      let googleEventId = identifier;

      // Check if it's a local event reference (non-blocking — table may not have all columns)
      try {
        const localResult = await query(
          `SELECT google_event_id, title FROM calendar_events WHERE user_phone = $1 AND (google_event_id = $2 OR LOWER(title) LIKE $3) AND status = 'active' ORDER BY start_time DESC LIMIT 1`,
          [userPhone, identifier, `%${identifier.toLowerCase()}%`]
        );

        if (localResult.rows.length > 0) {
          googleEventId = localResult.rows[0].google_event_id;
        }
      } catch (e) {
        // Local lookup failed (e.g. missing column) — use identifier directly as Google event ID
        logger.warn('cancelEvent local lookup failed, using identifier directly:', e.message);
      }

      const calendarId = await this.getDefaultCalendarId(userPhone);
      await withRetry(() =>
        calendar.events.delete({
          calendarId,
          eventId: googleEventId,
          sendUpdates: notifyAttendees ? 'all' : 'none'
        })
      );

      // Update local status (non-blocking — table schema may be outdated)
      try {
        await query(
          `UPDATE calendar_events SET status = 'cancelled', updated_at = NOW() WHERE user_phone = $1 AND google_event_id = $2`,
          [userPhone, googleEventId]
        );
      } catch (e) { logger.warn('cancelEvent local status update failed:', e.message); }

      // Remove pending reminders
      try {
        await query(
          `UPDATE calendar_reminders SET status = 'cancelled' WHERE user_phone = $1 AND google_event_id = $2 AND status = 'pending'`,
          [userPhone, googleEventId]
        );
      } catch (e) { logger.warn('cancelEvent reminder update failed:', e.message); }

      try { await this.auditLog(userPhone, 'cancel_event', googleEventId, { notifyAttendees }); }
      catch (e) { logger.warn('cancelEvent audit log failed:', e.message); }

      return { success: true, eventId: googleEventId };

    } catch (error) {
      const tokenResult = await googleAuthService.handleTokenError(userPhone, error);
      if (tokenResult.cleared) return { success: false, error: tokenResult.message };

      if (error.response?.status === 404 || error.code === 404) {
        return { success: false, error: 'Event not found in Google Calendar' };
      }

      logger.error('cancelEvent error:', error.message);
      return { success: false, error: 'Failed to cancel event' };
    }
  }

  async rescheduleEvent(userPhone, eventId, newStart, newEnd, timezone) {
    try {
      const authClient = await googleAuthService.getAuthClient(userPhone);
      if (!authClient) return { success: false, error: 'Google not connected' };

      const calendar = google.calendar({ version: 'v3', auth: authClient });
      const calendarId = await this.getDefaultCalendarId(userPhone);

      const result = await withRetry(() =>
        calendar.events.patch({
          calendarId,
          eventId,
          resource: {
            start: { dateTime: new Date(newStart).toISOString(), timeZone: timezone },
            end: { dateTime: new Date(newEnd).toISOString(), timeZone: timezone }
          },
          sendUpdates: 'all'
        })
      );

      // Update local DB
      try {
        await query(
          `UPDATE calendar_events SET start_time = $1, end_time = $2, updated_at = NOW() WHERE user_phone = $3 AND google_event_id = $4`,
          [new Date(newStart).toISOString(), new Date(newEnd).toISOString(), userPhone, eventId]
        );
      } catch (e) { logger.warn('rescheduleEvent local update failed:', e.message); }

      // Update reminder
      try {
        const reminderTime = new Date(new Date(newStart).getTime() - 15 * 60 * 1000);
        await query(
          `UPDATE calendar_reminders SET event_start = $1, reminder_time = $2, status = 'pending' WHERE user_phone = $3 AND google_event_id = $4 AND status IN ('pending', 'cancelled')`,
          [new Date(newStart).toISOString(), reminderTime.toISOString(), userPhone, eventId]
        );
      } catch (e) { logger.warn('rescheduleEvent reminder update failed:', e.message); }

      try { await this.auditLog(userPhone, 'reschedule_event', eventId, { newStart, newEnd }); }
      catch (e) { logger.warn('rescheduleEvent audit log failed:', e.message); }

      return { success: true, eventId, event: result.data };
    } catch (error) {
      const tokenResult = await googleAuthService.handleTokenError(userPhone, error);
      if (tokenResult.cleared) return { success: false, error: tokenResult.message };
      if (error.response?.status === 404 || error.code === 404) {
        return { success: false, error: 'Event not found in Google Calendar' };
      }
      logger.error('rescheduleEvent error:', error.message);
      return { success: false, error: 'Failed to reschedule event' };
    }
  }

  async getUpcomingEvents(userPhone, hoursAhead = 24) {
    const now = new Date();
    const end = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);

    return this.findEvents(userPhone, {
      timeMin: now,
      timeMax: end
    });
  }

  /**
   * Compute the timezone offset in minutes (positive = ahead of UTC) for a
   * given IANA timezone at a specific instant. Handles DST correctly because
   * we ask Intl for the actual local time at that instant.
   * Apr 27 2026 (FIX #3) — extracted to avoid duplicate code.
   */
  _tzOffsetMinutes(timezone, instant = new Date()) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
      }).formatToParts(instant);
      const map = {};
      for (const p of parts) map[p.type] = p.value;
      const localMillis = Date.UTC(
        Number(map.year), Number(map.month) - 1, Number(map.day),
        Number(map.hour) === 24 ? 0 : Number(map.hour),
        Number(map.minute), Number(map.second)
      );
      return Math.round((localMillis - instant.getTime()) / 60000);
    } catch (_) {
      return 0;
    }
  }

  async getViewAvailability(userPhone, date, timezone = 'Asia/Kolkata') {
    try {
      // FIX #3 (Apr 27 2026): compute the day-start / day-end in the USER'S
      // timezone, not server local. Otherwise "tomorrow" stored as UTC noon
      // gets clamped to UTC midnight, which is the previous calendar day in
      // negative UTC offsets and stays the same day for +ve offsets but
      // misses early-morning IST events. Using Intl.DateTimeFormat to
      // extract Y/M/D in the user's tz and rebuilding Date with Date.UTC()
      // derives unambiguous bounds.
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(new Date(date));
      const yy = Number(parts.find(p => p.type === 'year').value);
      const mm = Number(parts.find(p => p.type === 'month').value) - 1;
      const dd = Number(parts.find(p => p.type === 'day').value);
      // tz offset in minutes (positive = ahead of UTC)
      const offsetMin = this._tzOffsetMinutes(timezone, new Date(date));
      // dayStart: 00:00 in user's tz = UTC at (00:00 - offset)
      const dayStart = new Date(Date.UTC(yy, mm, dd, 0, 0, 0) - offsetMin * 60 * 1000);
      const dayEnd = new Date(Date.UTC(yy, mm, dd, 23, 59, 59, 999) - offsetMin * 60 * 1000);

      const events = await this.findEvents(userPhone, {
        timeMin: dayStart,
        timeMax: dayEnd
      });

      if (events.length === 0) {
        const dateStr = dayStart.toLocaleDateString('en-IN', {
          timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long'
        });
        return `No events on ${dateStr} -- you're free all day!`;
      }

      const dateStr = dayStart.toLocaleDateString('en-IN', {
        timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long'
      });

      let response = `*${dateStr}*\n\n`;

      events.forEach((e, i) => {
        const startTime = new Date(e.start.dateTime || e.start.date);
        const endTime = new Date(e.end.dateTime || e.end.date);

        const timeStr = `${startTime.toLocaleTimeString('en-IN', { timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true })} - ${endTime.toLocaleTimeString('en-IN', { timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true })}`;

        response += `${i + 1}. *${e.summary || 'No title'}*\n   ${timeStr}`;
        if (e.location) response += `\n   Location: ${e.location}`;
        if (e.attendees?.length > 0) {
          response += `\n   ${e.attendees.length} attendee${e.attendees.length > 1 ? 's' : ''}`;
        }
        response += '\n\n';
      });

      return response.trim();
    } catch (error) {
      logger.error('getViewAvailability error:', error.message);
      return 'Could not load calendar events.';
    }
  }

  async getWeekView(userPhone, date, timezone = 'Asia/Kolkata') {
    try {
      // Find Monday of the week containing `date`
      const d = new Date(date);
      const dayOfWeek = d.getDay(); // 0=Sun, 1=Mon, ...
      const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      const weekStart = new Date(d);
      weekStart.setDate(d.getDate() + mondayOffset);
      weekStart.setHours(0, 0, 0, 0);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 6);
      weekEnd.setHours(23, 59, 59, 999);

      const events = await this.findEvents(userPhone, { timeMin: weekStart, timeMax: weekEnd });

      const weekLabel = `${weekStart.toLocaleDateString('en-IN', { timeZone: timezone, day: 'numeric', month: 'short' })} - ${weekEnd.toLocaleDateString('en-IN', { timeZone: timezone, day: 'numeric', month: 'short' })}`;

      if (events.length === 0) {
        return `No events this week (${weekLabel}) -- you're free all week!`;
      }

      // Group events by day
      const dayMap = {};
      events.forEach(e => {
        const start = new Date(e.start.dateTime || e.start.date);
        const dayKey = start.toLocaleDateString('en-IN', { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short' });
        if (!dayMap[dayKey]) dayMap[dayKey] = [];
        dayMap[dayKey].push(e);
      });

      let response = `*Week: ${weekLabel}* (${events.length} event${events.length > 1 ? 's' : ''})\n\n`;
      for (const [day, dayEvents] of Object.entries(dayMap)) {
        response += `*${day}*\n`;
        dayEvents.forEach(e => {
          const startTime = new Date(e.start.dateTime || e.start.date);
          const endTime = new Date(e.end.dateTime || e.end.date);
          const timeStr = `${startTime.toLocaleTimeString('en-IN', { timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true })} - ${endTime.toLocaleTimeString('en-IN', { timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true })}`;
          response += `  • ${e.summary || 'No title'} (${timeStr})\n`;
        });
        response += '\n';
      }
      return response.trim();
    } catch (error) {
      logger.error('getWeekView error:', error.message);
      return 'Could not load weekly calendar.';
    }
  }

  async getMonthView(userPhone, date, timezone = 'Asia/Kolkata') {
    try {
      const monthStart = new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0);
      const monthEnd = new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);

      const events = await this.findEvents(userPhone, { timeMin: monthStart, timeMax: monthEnd });

      const monthLabel = monthStart.toLocaleDateString('en-IN', { timeZone: timezone, month: 'long', year: 'numeric' });

      if (events.length === 0) {
        return `No events in ${monthLabel} -- your month is clear!`;
      }

      // Group by day
      const dayMap = {};
      events.forEach(e => {
        const start = new Date(e.start.dateTime || e.start.date);
        const dayKey = start.toLocaleDateString('en-IN', { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short' });
        if (!dayMap[dayKey]) dayMap[dayKey] = [];
        dayMap[dayKey].push(e);
      });

      let response = `*${monthLabel}* (${events.length} event${events.length > 1 ? 's' : ''})\n\n`;
      for (const [day, dayEvents] of Object.entries(dayMap)) {
        response += `*${day}*: ${dayEvents.map(e => e.summary || 'No title').join(', ')}\n`;
      }
      return response.trim();
    } catch (error) {
      logger.error('getMonthView error:', error.message);
      return 'Could not load monthly calendar.';
    }
  }

  async getTeamAvailability(requesterPhone, date, timezone = 'Asia/Kolkata', options = {}) {
    try {
      const taskService = require('./task.service');
      let members = await taskService.getTeamMembers(requesterPhone);
      const requestedPeople = Array.isArray(options.people)
        ? options.people.map((value) => String(value || '').trim()).filter(Boolean)
        : [];
      const broadRequest = requestedPeople.length === 0
        || requestedPeople.some((value) => /^(team|all|everyone|everybody)$/i.test(value));
      if (!broadRequest) {
        const allTeams = await taskService.getTeamNames(requesterPhone);
        const selected = new Map();
        for (const requested of requestedPeople) {
          if (/^(me|myself|you)$/i.test(requested)) continue;
          const matchingTeam = allTeams.find((team) => String(team.team_name || '').toLowerCase() === requested.toLowerCase());
          if (matchingTeam) {
            for (const member of await taskService.getTeamMembers(requesterPhone, matchingTeam.team_name)) {
              selected.set(member.member_phone, member);
            }
            continue;
          }
          for (const member of members) {
            if (String(member.member_name || '').toLowerCase().includes(requested.toLowerCase())) {
              selected.set(member.member_phone, member);
            }
          }
        }
        members = [...selected.values()];
      }

      const includeRequester = broadRequest
        || requestedPeople.some((value) => /^(me|myself|you)$/i.test(value));
      if (members.length === 0 && !includeRequester) {
        return 'No team members added yet.\n\nAdd members: "add team member Emily +91XXXXXXXXXX"';
      }

      const dateParts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(new Date(date));
      const year = Number(dateParts.find((part) => part.type === 'year').value);
      const month = Number(dateParts.find((part) => part.type === 'month').value) - 1;
      const day = Number(dateParts.find((part) => part.type === 'day').value);
      const offsetMinutes = this._tzOffsetMinutes(timezone, new Date(date));
      const dayStart = new Date(Date.UTC(year, month, day, 0, 0, 0) - offsetMinutes * 60 * 1000);
      const dayEnd = new Date(Date.UTC(year, month, day, 23, 59, 59, 999) - offsetMinutes * 60 * 1000);

      const dateStr = dayStart.toLocaleDateString('en-IN', {
        timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long'
      });

      let response = `*Team Availability - ${dateStr}*\n\n`;

      // Check requester's calendar first
      const authClient = includeRequester ? await googleAuthService.getAuthClient(requesterPhone) : null;
      if (includeRequester && authClient) {
        const myEvents = await this.findEvents(requesterPhone, { timeMin: dayStart, timeMax: dayEnd });
        response += `*You:*\n`;
        if (myEvents.length === 0) {
          response += `  Free all day\n\n`;
        } else {
          myEvents.forEach(e => {
            const start = new Date(e.start.dateTime || e.start.date);
            const end = new Date(e.end.dateTime || e.end.date);
            const timeStr = `${start.toLocaleTimeString('en-IN', { timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true })} - ${end.toLocaleTimeString('en-IN', { timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true })}`;
            response += `  ${e.summary || 'Busy'} (${timeStr})\n`;
          });
          response += '\n';
        }
      }

      // Check each team member's calendar
      for (const member of members) {
        response += `*${member.member_name}:*\n`;
        try {
          const memberAuth = await googleAuthService.getAuthClient(member.member_phone);
          if (!memberAuth) {
            response += `  _Google not connected_\n\n`;
            continue;
          }

          const events = await this.findEvents(member.member_phone, { timeMin: dayStart, timeMax: dayEnd });
          if (events.length === 0) {
            response += `  Free all day\n\n`;
          } else {
            events.forEach(e => {
              const start = new Date(e.start.dateTime || e.start.date);
              const end = new Date(e.end.dateTime || e.end.date);
              const timeStr = `${start.toLocaleTimeString('en-IN', { timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true })} - ${end.toLocaleTimeString('en-IN', { timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true })}`;
              response += `  ${e.summary || 'Busy'} (${timeStr})\n`;
            });
            response += '\n';
          }
        } catch (error) {
          response += `  _Could not check calendar_\n\n`;
        }
      }

      return response.trim();
    } catch (error) {
      logger.error('getTeamAvailability error:', error.message);
      return 'Could not check team availability.';
    }
  }

  async listCalendars(userPhone) {
    try {
      const authClient = await googleAuthService.getAuthClient(userPhone);
      if (!authClient) return [];

      const calendar = google.calendar({ version: 'v3', auth: authClient });
      const result = await withRetry(() =>
        calendar.calendarList.list({ showHidden: false })
      );

      return (result.data.items || []).map(c => ({
        id: c.id,
        name: c.summary,
        isDefault: c.primary || false,
        accessRole: c.accessRole,
        provider: 'google'
      }));
    } catch (error) {
      logger.error('listCalendars error:', error.message);
      return [];
    }
  }

  async setDefaultCalendar(userPhone, calendarId) {
    try {
      // Ensure user_preferences table has setting_key/setting_value columns
      await query(`
        DO $$ BEGIN
          -- Add setting_key if missing (table may have been created with different schema)
          ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS setting_key VARCHAR(100);
        EXCEPTION WHEN undefined_table THEN
          CREATE TABLE user_preferences (
            id SERIAL PRIMARY KEY,
            user_phone VARCHAR(20) NOT NULL,
            setting_key VARCHAR(100) NOT NULL,
            setting_value TEXT,
            updated_at TIMESTAMP DEFAULT NOW(),
            UNIQUE(user_phone, setting_key)
          );
        WHEN OTHERS THEN NULL;
        END $$
      `);
      await query(`ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS setting_value TEXT`).catch(() => {});
      // Ensure unique constraint exists
      await query(`
        DO $$ BEGIN
          ALTER TABLE user_preferences ADD CONSTRAINT user_preferences_phone_key UNIQUE (user_phone, setting_key);
        EXCEPTION WHEN duplicate_table THEN NULL;
        WHEN duplicate_object THEN NULL;
        END $$
      `).catch(() => {});

      await query(`
        INSERT INTO user_preferences (user_phone, setting_key, setting_value, updated_at)
        VALUES ($1, 'default_calendar_id', $2, NOW())
        ON CONFLICT (user_phone, setting_key) DO UPDATE SET setting_value = $2, updated_at = NOW()
      `, [userPhone, calendarId]);

      return { success: true };
    } catch (error) {
      logger.error('setDefaultCalendar error:', error.message);
      return { success: false, error: 'Failed to set default calendar.' };
    }
  }

  async getDefaultCalendarId(userPhone) {
    try {
      // Check if table and columns exist before querying
      const colCheck = await query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'user_preferences' AND column_name = 'setting_key'
      `);
      if (colCheck.rows.length === 0) {
        // Table exists but with different schema — migrate it
        await query(`ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS setting_key VARCHAR(100)`).catch(() => {});
        await query(`ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS setting_value TEXT`).catch(() => {});
        return 'primary';
      }
      const result = await query(
        `SELECT setting_value FROM user_preferences WHERE user_phone = $1 AND setting_key = 'default_calendar_id'`,
        [userPhone]
      );
      return result.rows[0]?.setting_value || 'primary';
    } catch (error) {
      return 'primary';
    }
  }

  async auditLog(userPhone, action, googleEventId, details = {}) {
    try {
      await query(
        `INSERT INTO google_audit_log (user_phone, action, google_event_id, details) VALUES ($1, $2, $3, $4)`,
        [userPhone, action, googleEventId, JSON.stringify(details)]
      );
    } catch (error) {
      logger.warn('Audit log error:', error.message);
    }
  }
}

module.exports = new CalendarService();
