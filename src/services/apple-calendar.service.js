const axios = require('axios');
const { query } = require('../config/database');
const { encrypt, decrypt } = require('../utils/encryption');
const logger = require('../utils/logger');

// CalDAV client for Apple Calendar (iCloud)
class AppleCalendarService {

  constructor() {
    this.caldavBaseUrl = 'https://caldav.icloud.com';
    this.tablesCreated = false;
  }

  async ensureTables() {
    if (this.tablesCreated) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS apple_calendar_auth (
          id SERIAL PRIMARY KEY,
          user_phone VARCHAR(20) UNIQUE NOT NULL,
          apple_id VARCHAR(255) NOT NULL,
          app_specific_password TEXT NOT NULL,
          caldav_principal TEXT,
          calendar_home TEXT,
          default_calendar_url TEXT,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);
      this.tablesCreated = true;
    } catch (error) {
      logger.error('Apple calendar table error:', error.message);
    }
  }

  // Save Apple Calendar credentials (App-Specific Password)
  async saveCredentials(userPhone, appleId, appSpecificPassword) {
    await this.ensureTables();
    try {
      // Test the credentials first
      const testResult = await this.testConnection(appleId, appSpecificPassword);
      if (!testResult.success) {
        return { success: false, error: testResult.error };
      }

      const encData = encrypt(appSpecificPassword);
      const encryptedPassword = JSON.stringify(encData);

      await query(
        `INSERT INTO apple_calendar_auth (user_phone, apple_id, app_specific_password, caldav_principal, calendar_home, default_calendar_url)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_phone) DO UPDATE SET
           apple_id = $2,
           app_specific_password = $3,
           caldav_principal = $4,
           calendar_home = $5,
           default_calendar_url = $6,
           updated_at = NOW()`,
        [userPhone, appleId, encryptedPassword, testResult.principal, testResult.calendarHome, testResult.defaultCalendar]
      );

      return { success: true, calendars: testResult.calendars || [] };
    } catch (error) {
      logger.error('Save Apple credentials error:', error.message);
      return { success: false, error: 'Failed to save Apple Calendar credentials' };
    }
  }

  async getCredentials(userPhone) {
    await this.ensureTables();
    try {
      const result = await query(
        `SELECT * FROM apple_calendar_auth WHERE user_phone = $1`,
        [userPhone]
      );
      if (result.rows.length === 0) return null;

      const row = result.rows[0];
      let password;
      try {
        const encData = JSON.parse(row.app_specific_password);
        password = decrypt(encData.encrypted, encData.iv, encData.authTag);
      } catch (e) {
        logger.error('Failed to decrypt Apple password:', e.message);
        return null;
      }
      return {
        appleId: row.apple_id,
        password,
        principal: row.caldav_principal,
        calendarHome: row.calendar_home,
        defaultCalendarUrl: row.default_calendar_url
      };
    } catch (error) {
      logger.error('Get Apple credentials error:', error.message);
      return null;
    }
  }

  async isConnected(userPhone) {
    const creds = await this.getCredentials(userPhone);
    return !!creds;
  }

  async disconnect(userPhone) {
    await this.ensureTables();
    try {
      await query(`DELETE FROM apple_calendar_auth WHERE user_phone = $1`, [userPhone]);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Test CalDAV connection and discover principal/calendar home
  async testConnection(appleId, password) {
    try {
      // Step 1: Discover principal URL
      const principalResponse = await axios({
        method: 'PROPFIND',
        url: `${this.caldavBaseUrl}/`,
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          'Depth': '0',
          'Authorization': 'Basic ' + Buffer.from(`${appleId}:${password}`).toString('base64')
        },
        data: `<?xml version="1.0" encoding="utf-8" ?>
          <D:propfind xmlns:D="DAV:">
            <D:prop>
              <D:current-user-principal />
            </D:prop>
          </D:propfind>`,
        validateStatus: (s) => s < 500
      });

      if (principalResponse.status === 401) {
        return { success: false, error: 'Invalid Apple ID or App-Specific Password' };
      }

      // Parse principal URL from XML response
      const principalMatch = principalResponse.data.match(/<D:href[^>]*>([^<]+)<\/D:href>/i)
        || principalResponse.data.match(/<href[^>]*>([^<]+)<\/href>/i);

      const principal = principalMatch ? principalMatch[1] : `/${appleId}/`;

      // Step 2: Discover calendar home
      const calendarHomeResponse = await axios({
        method: 'PROPFIND',
        url: `${this.caldavBaseUrl}${principal}`,
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          'Depth': '0',
          'Authorization': 'Basic ' + Buffer.from(`${appleId}:${password}`).toString('base64')
        },
        data: `<?xml version="1.0" encoding="utf-8" ?>
          <D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
            <D:prop>
              <C:calendar-home-set />
            </D:prop>
          </D:propfind>`,
        validateStatus: (s) => s < 500
      });

      const homeMatch = calendarHomeResponse.data.match(/<D:href[^>]*>([^<]*calendar[^<]*)<\/D:href>/i)
        || calendarHomeResponse.data.match(/<href[^>]*>([^<]*calendar[^<]*)<\/href>/i);

      const calendarHome = homeMatch ? homeMatch[1] : `${principal}calendars/`;

      // Step 3: List calendars
      const calendars = await this.listCalendarsRaw(appleId, password, calendarHome);
      const defaultCalendar = calendars.length > 0 ? calendars[0].url : calendarHome;

      return {
        success: true,
        principal,
        calendarHome,
        defaultCalendar,
        calendars
      };

    } catch (error) {
      logger.error('Apple CalDAV test error:', error.message);
      if (error.response?.status === 401) {
        return { success: false, error: 'Invalid credentials. Use an App-Specific Password from appleid.apple.com' };
      }
      return { success: false, error: `Connection failed: ${error.message}` };
    }
  }

  async listCalendarsRaw(appleId, password, calendarHome) {
    try {
      const response = await axios({
        method: 'PROPFIND',
        url: `${this.caldavBaseUrl}${calendarHome}`,
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          'Depth': '1',
          'Authorization': 'Basic ' + Buffer.from(`${appleId}:${password}`).toString('base64')
        },
        data: `<?xml version="1.0" encoding="utf-8" ?>
          <D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">
            <D:prop>
              <D:displayname />
              <D:resourcetype />
              <CS:getctag />
            </D:prop>
          </D:propfind>`,
        validateStatus: (s) => s < 500
      });

      const calendars = [];
      // Parse XML response for calendars
      const responses = response.data.split(/<D:response>/gi).slice(1);

      for (const resp of responses) {
        const hrefMatch = resp.match(/<D:href[^>]*>([^<]+)<\/D:href>/i);
        const nameMatch = resp.match(/<D:displayname[^>]*>([^<]+)<\/D:displayname>/i);
        const isCalendar = /<D:calendar\s*\/>/i.test(resp) || /<C:calendar\s*\/>/i.test(resp);

        if (hrefMatch && isCalendar) {
          calendars.push({
            url: hrefMatch[1],
            name: nameMatch ? nameMatch[1] : 'Calendar',
            provider: 'apple'
          });
        }
      }

      // If no explicit calendar tags found, check for calendar-like URLs
      if (calendars.length === 0) {
        for (const resp of responses) {
          const hrefMatch = resp.match(/<D:href[^>]*>([^<]+)<\/D:href>/i);
          const nameMatch = resp.match(/<D:displayname[^>]*>([^<]+)<\/D:displayname>/i);
          if (hrefMatch && hrefMatch[1] !== calendarHome && !hrefMatch[1].endsWith('inbox/') && !hrefMatch[1].endsWith('outbox/')) {
            calendars.push({
              url: hrefMatch[1],
              name: nameMatch ? nameMatch[1] : 'Calendar',
              provider: 'apple'
            });
          }
        }
      }

      return calendars;
    } catch (error) {
      logger.error('List Apple calendars error:', error.message);
      return [];
    }
  }

  // List calendars for a user
  async listCalendars(userPhone) {
    const creds = await this.getCredentials(userPhone);
    if (!creds) return [];
    return this.listCalendarsRaw(creds.appleId, creds.password, creds.calendarHome);
  }

  // Create a calendar event (iCalendar/VCALENDAR format)
  async createEvent(userPhone, eventData) {
    const creds = await this.getCredentials(userPhone);
    if (!creds) {
      return { success: false, error: 'Apple Calendar not connected. Say "connect apple calendar" first.' };
    }

    const { title, start, end, description, location, timezone } = eventData;
    const uid = this.generateUID();
    const calendarUrl = creds.defaultCalendarUrl || creds.calendarHome;

    const startDate = new Date(start);
    const endDate = new Date(end || new Date(startDate.getTime() + 60 * 60 * 1000));

    const vcalendar = this.buildVCalendar({
      uid,
      title,
      start: startDate,
      end: endDate,
      description,
      location,
      timezone: timezone || 'Asia/Kolkata'
    });

    try {
      await axios({
        method: 'PUT',
        url: `${this.caldavBaseUrl}${calendarUrl}${uid}.ics`,
        headers: {
          'Content-Type': 'text/calendar; charset=utf-8',
          'Authorization': 'Basic ' + Buffer.from(`${creds.appleId}:${creds.password}`).toString('base64'),
          'If-None-Match': '*'
        },
        data: vcalendar,
        validateStatus: (s) => s < 500
      });

      // Store event locally for audit trail and calendar reminders
      try {
        await query(
          `INSERT INTO calendar_events (user_phone, google_event_id, title, start_time, end_time, location, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'active')
           ON CONFLICT DO NOTHING`,
          [userPhone, `apple:${uid}`, title, startDate.toISOString(), endDate.toISOString(), location || null]
        );
      } catch (dbErr) {
        // Non-blocking — event was created in Apple, just log DB failure
        logger.warn('Failed to store Apple event locally:', dbErr.message);
      }

      return {
        success: true,
        event: { uid, title, start: startDate, end: endDate },
        title,
        start: startDate,
        end: endDate,
        provider: 'apple'
      };
    } catch (error) {
      logger.error('Apple create event error:', error.message);
      return { success: false, error: 'Failed to create Apple Calendar event' };
    }
  }

  // Get upcoming events
  async getUpcomingEvents(userPhone, hoursAhead = 24) {
    const creds = await this.getCredentials(userPhone);
    if (!creds) return [];

    const now = new Date();
    const later = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);
    const calendarUrl = creds.defaultCalendarUrl || creds.calendarHome;

    try {
      const response = await axios({
        method: 'REPORT',
        url: `${this.caldavBaseUrl}${calendarUrl}`,
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          'Depth': '1',
          'Authorization': 'Basic ' + Buffer.from(`${creds.appleId}:${creds.password}`).toString('base64')
        },
        data: `<?xml version="1.0" encoding="utf-8" ?>
          <C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
            <D:prop>
              <D:getetag />
              <C:calendar-data />
            </D:prop>
            <C:filter>
              <C:comp-filter name="VCALENDAR">
                <C:comp-filter name="VEVENT">
                  <C:time-range start="${this.formatCalDate(now)}" end="${this.formatCalDate(later)}" />
                </C:comp-filter>
              </C:comp-filter>
            </C:filter>
          </C:calendar-query>`,
        validateStatus: (s) => s < 500
      });

      return this.parseCalendarEvents(response.data);
    } catch (error) {
      logger.error('Apple get events error:', error.message);
      return [];
    }
  }

  // Delete an event
  async deleteEvent(userPhone, eventUid) {
    const creds = await this.getCredentials(userPhone);
    if (!creds) return { success: false, error: 'Not connected' };

    const calendarUrl = creds.defaultCalendarUrl || creds.calendarHome;

    try {
      await axios({
        method: 'DELETE',
        url: `${this.caldavBaseUrl}${calendarUrl}${eventUid}.ics`,
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${creds.appleId}:${creds.password}`).toString('base64')
        },
        validateStatus: (s) => s < 500
      });
      return { success: true };
    } catch (error) {
      logger.error('Apple delete event error:', error.message);
      return { success: false, error: error.message };
    }
  }

  // Build VCALENDAR string
  buildVCalendar({ uid, title, start, end, description, location, timezone }) {
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//WhatsApp Assistant//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${this.formatCalDate(new Date())}`,
      `DTSTART;TZID=${timezone}:${this.formatLocalDate(start, timezone)}`,
      `DTEND;TZID=${timezone}:${this.formatLocalDate(end, timezone)}`,
      `SUMMARY:${this.escapeIcal(title)}`,
    ];

    if (description) lines.push(`DESCRIPTION:${this.escapeIcal(description)}`);
    if (location) lines.push(`LOCATION:${this.escapeIcal(location)}`);

    lines.push('END:VEVENT', 'END:VCALENDAR');
    return lines.join('\r\n');
  }

  formatCalDate(date) {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }

  formatLocalDate(date, timezone) {
    const d = new Date(date);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(d);

    const get = (type) => parts.find(p => p.type === type)?.value || '00';
    return `${get('year')}${get('month')}${get('day')}T${get('hour')}${get('minute')}${get('second')}`;
  }

  escapeIcal(str) {
    return (str || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  }

  generateUID() {
    const chars = 'abcdef0123456789';
    let uid = '';
    for (let i = 0; i < 32; i++) uid += chars[Math.floor(Math.random() * chars.length)];
    return `${uid.slice(0, 8)}-${uid.slice(8, 12)}-${uid.slice(12, 16)}-${uid.slice(16, 20)}-${uid.slice(20)}`;
  }

  // Parse VCALENDAR responses into event objects
  parseCalendarEvents(xmlData) {
    const events = [];
    const calDataBlocks = xmlData.split(/<C:calendar-data[^>]*>/gi).slice(1);

    for (const block of calDataBlocks) {
      const endIdx = block.indexOf('</C:calendar-data>');
      const icalData = endIdx > -1 ? block.substring(0, endIdx) : block;

      // Decode XML entities
      const decoded = icalData
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"');

      const summaryMatch = decoded.match(/SUMMARY[^:]*:(.*?)(?:\r?\n)/);
      const dtStartMatch = decoded.match(/DTSTART[^:]*:(.*?)(?:\r?\n)/);
      const dtEndMatch = decoded.match(/DTEND[^:]*:(.*?)(?:\r?\n)/);
      const locationMatch = decoded.match(/LOCATION[^:]*:(.*?)(?:\r?\n)/);
      const uidMatch = decoded.match(/UID[^:]*:(.*?)(?:\r?\n)/);

      if (summaryMatch && dtStartMatch) {
        const startStr = dtStartMatch[1].trim();
        const endStr = dtEndMatch ? dtEndMatch[1].trim() : null;

        events.push({
          id: uidMatch ? uidMatch[1].trim() : null,
          summary: summaryMatch[1].trim().replace(/\\,/g, ',').replace(/\\n/g, '\n'),
          start: { dateTime: this.parseIcalDate(startStr) },
          end: endStr ? { dateTime: this.parseIcalDate(endStr) } : null,
          location: locationMatch ? locationMatch[1].trim().replace(/\\,/g, ',') : null,
          provider: 'apple'
        });
      }
    }

    return events;
  }

  parseIcalDate(str) {
    // Format: 20240305T143000Z or 20240305T143000
    const cleaned = str.replace(/[^\dTZ]/g, '');
    if (cleaned.length >= 15) {
      const year = cleaned.slice(0, 4);
      const month = cleaned.slice(4, 6);
      const day = cleaned.slice(6, 8);
      const hour = cleaned.slice(9, 11);
      const min = cleaned.slice(11, 13);
      const sec = cleaned.slice(13, 15);
      const isUtc = cleaned.endsWith('Z');
      return `${year}-${month}-${day}T${hour}:${min}:${sec}${isUtc ? 'Z' : ''}`;
    }
    return str;
  }
}

module.exports = new AppleCalendarService();
