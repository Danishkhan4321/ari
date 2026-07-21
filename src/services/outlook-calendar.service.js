const axios = require('axios');
const microsoftAuthService = require('./microsoft-auth.service');
const { query } = require('../config/database');
const logger = require('../utils/logger');

const GRAPH_URL = 'https://graph.microsoft.com/v1.0';

class OutlookCalendarService {

  async _getClient(userPhone) {
    const token = await microsoftAuthService.getAccessToken(userPhone);
    if (!token) return null;
    return {
      get: (url, config = {}) => axios.get(`${GRAPH_URL}${url}`, {
        ...config,
        headers: { Authorization: `Bearer ${token}`, ...config.headers }
      }),
      post: (url, data, config = {}) => axios.post(`${GRAPH_URL}${url}`, data, {
        ...config,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...config.headers }
      }),
      delete: (url, config = {}) => axios.delete(`${GRAPH_URL}${url}`, {
        ...config,
        headers: { Authorization: `Bearer ${token}`, ...config.headers }
      })
    };
  }

  async createEvent(userPhone, eventData) {
    const client = await this._getClient(userPhone);
    if (!client) {
      return { success: false, error: 'Outlook not connected. Say "connect outlook" first.' };
    }

    const { title, start, end, attendees, location, description, timezone } = eventData;

    try {
      const event = {
        subject: title,
        start: {
          dateTime: new Date(start).toISOString(),
          timeZone: timezone || 'Asia/Kolkata'
        },
        end: {
          dateTime: new Date(end).toISOString(),
          timeZone: timezone || 'Asia/Kolkata'
        },
        body: description ? { contentType: 'text', content: description } : undefined,
        location: location ? { displayName: location } : undefined,
        attendees: (attendees || []).map(a => ({
          emailAddress: { address: a.email || a },
          type: 'required'
        }))
      };

      const result = await client.post('/me/events', event);

      // Store event locally for audit trail and calendar reminders
      try {
        await query(
          `INSERT INTO calendar_events (user_phone, google_event_id, title, start_time, end_time, location, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'active')
           ON CONFLICT DO NOTHING`,
          [userPhone, `outlook:${result.data.id}`, title, new Date(start).toISOString(), new Date(end).toISOString(), location || null]
        );
      } catch (dbErr) {
        logger.warn('Failed to store Outlook event locally:', dbErr.message);
      }

      return {
        success: true,
        event: result.data,
        title,
        start: new Date(start),
        end: new Date(end),
        attendees,
        webLink: result.data.webLink
      };
    } catch (error) {
      const tokenResult = await microsoftAuthService.handleTokenError(userPhone, error);
      if (tokenResult.cleared) return { success: false, error: tokenResult.message };
      logger.error('Outlook create event error:', error.message);
      return { success: false, error: 'Failed to create Outlook event.' };
    }
  }

  async getUpcomingEvents(userPhone, hoursAhead = 24) {
    const client = await this._getClient(userPhone);
    if (!client) return [];

    try {
      const now = new Date();
      const later = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);

      const result = await client.get(
        `/me/calendarview?startDateTime=${now.toISOString()}&endDateTime=${later.toISOString()}&$orderby=start/dateTime&$top=20&$select=subject,start,end,attendees,location,webLink`
      );

      return (result.data.value || []).map(e => ({
        id: e.id,
        summary: e.subject,
        start: { dateTime: e.start?.dateTime },
        end: { dateTime: e.end?.dateTime },
        attendees: (e.attendees || []).map(a => ({ email: a.emailAddress?.address })),
        location: e.location?.displayName,
        webLink: e.webLink,
        provider: 'outlook'
      }));
    } catch (error) {
      const tokenResult = await microsoftAuthService.handleTokenError(userPhone, error);
      if (tokenResult.cleared) logger.warn(tokenResult.message);
      logger.error('Outlook get events error:', error.message);
      return [];
    }
  }

  async cancelEvent(userPhone, eventId) {
    const client = await this._getClient(userPhone);
    if (!client) {
      return { success: false, error: 'Outlook not connected.' };
    }

    try {
      await client.delete(`/me/events/${eventId}`);
      return { success: true };
    } catch (error) {
      const tokenResult = await microsoftAuthService.handleTokenError(userPhone, error);
      if (tokenResult.cleared) return { success: false, error: tokenResult.message };
      logger.error('Outlook cancel event error:', error.message);
      return { success: false, error: 'Failed to cancel Outlook event.' };
    }
  }

  async listCalendars(userPhone) {
    const client = await this._getClient(userPhone);
    if (!client) return [];

    try {
      const result = await client.get('/me/calendars?$select=id,name,color,isDefaultCalendar');
      return (result.data.value || []).map(c => ({
        id: c.id,
        name: c.name,
        isDefault: c.isDefaultCalendar,
        provider: 'outlook'
      }));
    } catch (error) {
      logger.error('Outlook list calendars error:', error.message);
      return [];
    }
  }
}

module.exports = new OutlookCalendarService();
