const googleAuthService = require('./google-auth.service');
const microsoftAuthService = require('./microsoft-auth.service');
const calendarService = require('./calendar.service');
const outlookCalendarService = require('./outlook-calendar.service');
const appleCalendarService = require('./apple-calendar.service');
const logger = require('../utils/logger');

class UnifiedCalendarService {

  async getConnectedProviders(userPhone) {
    const providers = [];
    try {
      if (await googleAuthService.isConnected(userPhone)) {
        providers.push('google');
      }
    } catch (e) { /* ignore */ }
    try {
      if (await microsoftAuthService.isConnected(userPhone)) {
        providers.push('outlook');
      }
    } catch (e) { /* ignore */ }
    try {
      if (await appleCalendarService.isConnected(userPhone)) {
        providers.push('apple');
      }
    } catch (e) { /* ignore */ }
    return providers;
  }

  async getAllUpcomingEvents(userPhone, hoursAhead = 24) {
    const events = [];

    try {
      if (await googleAuthService.isConnected(userPhone)) {
        const googleEvents = await calendarService.getUpcomingEvents(userPhone, hoursAhead);
        events.push(...googleEvents.map(e => ({
          ...e,
          provider: 'google'
        })));
      }
    } catch (error) {
      logger.warn('Failed to get Google calendar events:', error.message);
    }

    try {
      if (await microsoftAuthService.isConnected(userPhone)) {
        const outlookEvents = await outlookCalendarService.getUpcomingEvents(userPhone, hoursAhead);
        events.push(...outlookEvents);
      }
    } catch (error) {
      logger.warn('Failed to get Outlook calendar events:', error.message);
    }

    try {
      if (await appleCalendarService.isConnected(userPhone)) {
        const appleEvents = await appleCalendarService.getUpcomingEvents(userPhone, hoursAhead);
        events.push(...appleEvents);
      }
    } catch (error) {
      logger.warn('Failed to get Apple calendar events:', error.message);
    }

    // Sort all events by start time
    events.sort((a, b) => {
      const timeA = new Date(a.start?.dateTime || a.start?.date || 0);
      const timeB = new Date(b.start?.dateTime || b.start?.date || 0);
      return timeA - timeB;
    });

    return events;
  }

  async listAllCalendars(userPhone) {
    const calendars = [];

    try {
      if (await googleAuthService.isConnected(userPhone)) {
        const googleCalendars = await calendarService.listCalendars(userPhone);
        calendars.push(...googleCalendars);
      }
    } catch (error) {
      logger.warn('Failed to list Google calendars:', error.message);
    }

    try {
      if (await microsoftAuthService.isConnected(userPhone)) {
        const outlookCalendars = await outlookCalendarService.listCalendars(userPhone);
        calendars.push(...outlookCalendars);
      }
    } catch (error) {
      logger.warn('Failed to list Outlook calendars:', error.message);
    }

    try {
      if (await appleCalendarService.isConnected(userPhone)) {
        const appleCalendars = await appleCalendarService.listCalendars(userPhone);
        calendars.push(...appleCalendars);
      }
    } catch (error) {
      logger.warn('Failed to list Apple calendars:', error.message);
    }

    return calendars;
  }

  async createEvent(userPhone, eventData, provider = 'google') {
    if (provider === 'outlook') {
      return outlookCalendarService.createEvent(userPhone, eventData);
    }
    if (provider === 'apple') {
      return appleCalendarService.createEvent(userPhone, eventData);
    }
    return calendarService.createEvent(userPhone, eventData);
  }

  formatCalendarList(calendars) {
    if (!calendars || calendars.length === 0) {
      return 'No calendars found. Connect Google, Outlook, or Apple Calendar first.';
    }

    let response = '*Your Calendars:*\n\n';

    const google = calendars.filter(c => c.provider === 'google');
    const outlook = calendars.filter(c => c.provider === 'outlook');
    const apple = calendars.filter(c => c.provider === 'apple');

    if (google.length > 0) {
      response += '*Google Calendar:*\n';
      google.forEach((c, i) => {
        const defaultTag = c.isDefault ? ' (default)' : '';
        response += `${i + 1}. ${c.name}${defaultTag}\n`;
      });
      response += '\n';
    }

    if (outlook.length > 0) {
      response += '*Outlook Calendar:*\n';
      outlook.forEach((c, i) => {
        const defaultTag = c.isDefault ? ' (default)' : '';
        response += `${i + 1}. ${c.name}${defaultTag}\n`;
      });
      response += '\n';
    }

    if (apple.length > 0) {
      response += '*Apple Calendar (iCloud):*\n';
      apple.forEach((c, i) => {
        response += `${i + 1}. ${c.name}\n`;
      });
      response += '\n';
    }

    return response;
  }

  formatUnifiedEvents(events, timezone = 'Asia/Kolkata') {
    if (!events || events.length === 0) {
      return 'No upcoming events.';
    }

    return events.map((e, i) => {
      const start = new Date(e.start?.dateTime || e.start?.date);
      const end = new Date(e.end?.dateTime || e.end?.date);
      const timeStr = `${start.toLocaleTimeString('en-IN', {
        timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true
      })} - ${end.toLocaleTimeString('en-IN', {
        timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true
      })}`;
      const providerTags = { outlook: ' [Outlook]', apple: ' [Apple]', google: '' };
      const providerTag = providerTags[e.provider] || '';
      return `${i + 1}. *${e.summary || 'No title'}* (${timeStr})${providerTag}`;
    }).join('\n');
  }
}

module.exports = new UnifiedCalendarService();
