const { createClient } = require('@supabase/supabase-js');
const logger = require('../utils/logger');

class RealtimeSyncService {

  constructor() {
    this.supabase = null;
    this.channels = new Map();
    this.initialized = false;
  }

  initialize() {
    if (this.initialized) return;

    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY;

    if (!url || !key) {
      logger.warn('Supabase credentials not found, real-time sync disabled');
      return;
    }

    this.supabase = createClient(url, key, {
      realtime: {
        params: { eventsPerSecond: 10 }
      }
    });

    this.subscribeToReminders();
    this.subscribeToLists();
    this.subscribeToCalendarEvents();

    this.initialized = true;
    logger.info('Real-time sync service initialized');
  }

  // Subscribe to reminder changes
  subscribeToReminders() {
    const channel = this.supabase
      .channel('reminders-changes')
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'reminders' },
        (payload) => this.handleReminderInsert(payload)
      )
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'reminders' },
        (payload) => this.handleReminderUpdate(payload)
      )
      .on('postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'reminders' },
        (payload) => this.handleReminderDelete(payload)
      )
      .subscribe((status) => {
        logger.info(`Reminders realtime channel: ${status}`);
      });

    this.channels.set('reminders', channel);
  }

  // Subscribe to list changes
  subscribeToLists() {
    const channel = this.supabase
      .channel('lists-changes')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'lists' },
        (payload) => this.handleListChange(payload)
      )
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'list_items' },
        (payload) => this.handleListItemChange(payload)
      )
      .subscribe((status) => {
        logger.info(`Lists realtime channel: ${status}`);
      });

    this.channels.set('lists', channel);
  }

  // Subscribe to calendar event changes
  subscribeToCalendarEvents() {
    const channel = this.supabase
      .channel('calendar-changes')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'calendar_events' },
        (payload) => this.handleCalendarChange(payload)
      )
      .subscribe((status) => {
        logger.info(`Calendar realtime channel: ${status}`);
      });

    this.channels.set('calendar', channel);
  }

  async handleReminderInsert(payload) {
    try {
      const reminder = payload.new;
      logger.info(`Realtime: New reminder #${reminder.id} for ${reminder.user_phone}`);
      // Notify if reminder was created externally (e.g., by another service)
      if (reminder.target_phone && reminder.target_phone !== reminder.user_phone) {
        const messagingService = require('./messaging.service');
        const accountLinkService = require('./account-link.service');
        const notifyUserId = await accountLinkService.getNotifyUserId(reminder.target_phone);
        await messagingService.send(notifyUserId,
          `Someone set a reminder for you: "${reminder.message}"`
        );
      }
    } catch (error) {
      logger.error('Realtime reminder insert error:', error.message);
    }
  }

  async handleReminderUpdate(payload) {
    try {
      const reminder = payload.new;
      const old = payload.old;
      logger.info(`Realtime: Reminder #${reminder.id} updated: ${old.status} -> ${reminder.status}`);
    } catch (error) {
      logger.error('Realtime reminder update error:', error.message);
    }
  }

  async handleReminderDelete(payload) {
    try {
      const reminder = payload.old;
      logger.info(`Realtime: Reminder #${reminder.id} deleted`);
    } catch (error) {
      logger.error('Realtime reminder delete error:', error.message);
    }
  }

  async handleListChange(payload) {
    try {
      const list = payload.new || payload.old;
      logger.info(`Realtime: List ${payload.eventType} for ${list.user_phone}: ${list.list_name || ''}`);
    } catch (error) {
      logger.error('Realtime list change error:', error.message);
    }
  }

  async handleListItemChange(payload) {
    try {
      const item = payload.new || payload.old;
      logger.info(`Realtime: List item ${payload.eventType}: ${item.item_text || ''}`);
    } catch (error) {
      logger.error('Realtime list item change error:', error.message);
    }
  }

  async handleCalendarChange(payload) {
    try {
      const event = payload.new || payload.old;
      const eventType = payload.eventType;
      logger.info(`Realtime: Calendar ${eventType} for ${event.user_phone}: ${event.title || ''}`);
      // Notify user when an event is cancelled externally
      if (eventType === 'UPDATE' && payload.new?.status === 'cancelled' && payload.old?.status === 'active') {
        const messagingService = require('./messaging.service');
        const accountLinkService = require('./account-link.service');
        const notifyUserId = await accountLinkService.getNotifyUserId(event.user_phone);
        await messagingService.send(notifyUserId,
          `*Meeting Cancelled*\n\n${event.title || 'An event'} has been cancelled.`
        );
      }
    } catch (error) {
      logger.error('Realtime calendar change error:', error.message);
    }
  }

  // Cleanup
  async shutdown() {
    for (const [name, channel] of this.channels) {
      try {
        await this.supabase.removeChannel(channel);
        logger.info(`Unsubscribed from ${name} channel`);
      } catch (e) {
        logger.error(`Error unsubscribing ${name}:`, e.message);
      }
    }
    this.channels.clear();
  }
}

module.exports = new RealtimeSyncService();
