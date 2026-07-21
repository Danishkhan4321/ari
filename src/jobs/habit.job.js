const cron = require('node-cron');
const habitService = require('../services/habit.service');
const messagingService = require('../services/messaging.service');
const logger = require('../utils/logger');

class HabitJob {

  constructor() {
    this.isRunningReminders = false;
    this.isRunningUnlogged = false;
  }

  start() {
    // Check for habit reminders every minute
    cron.schedule('* * * * *', async () => {
      try {
        await this.checkReminders();
      } catch (error) {
        logger.error('Habit reminder job error:', error.message);
      }
    });

    // Daily check for unlogged habits at 8 PM
    cron.schedule('0 20 * * *', async () => {
      try {
        await this.checkUnloggedHabits();
      } catch (error) {
        logger.error('Habit unlogged check job error:', error.message);
      }
    });

    logger.info('Habit job started - reminders every minute, unlogged check daily at 8 PM');
  }

  async checkReminders() {
    if (this.isRunningReminders) return;
    this.isRunningReminders = true;
    try {
      const habits = await habitService.getHabitsWithReminders();

      if (!habits || habits.length === 0) return;

      const now = new Date();
      const currentHHMM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

      const dueHabits = habits.filter(h => h.reminder_time === currentHHMM);

      if (dueHabits.length === 0) return;

      logger.info(`Found ${dueHabits.length} habit reminder(s) due at ${currentHHMM}`);

      for (const habit of dueHabits) {
        try {
          const message = `Habit Reminder\n\nTime to: ${habit.habit_name}!\nStreak: Keep it going!`;

          await messagingService.send(habit.user_phone, message);

          logger.info(`Habit reminder sent for "${habit.habit_name}" to ${habit.user_phone}`);
        } catch (error) {
          logger.error(`Failed to send habit reminder for "${habit.habit_name}":`, error.message);
        }
      }
    } catch (error) {
      logger.error('checkReminders error:', error.message);
    } finally {
      this.isRunningReminders = false;
    }
  }

  async checkUnloggedHabits() {
    if (this.isRunningUnlogged) return;
    this.isRunningUnlogged = true;
    try {
      // Apr 29 2026: collapsed an N+1 query loop. Old version did
      //   1× SELECT DISTINCT user_phone, then N× SELECT habits per user.
      // New version: one JOIN-style query returns everything, grouped in JS.
      const grouped = await habitService.getAllUnloggedHabitsByUser();

      if (!grouped || grouped.size === 0) return;

      logger.info(`Checking unlogged habits for ${grouped.size} user(s)`);

      for (const [userPhone, unloggedHabits] of grouped) {
        try {
          if (!unloggedHabits || unloggedHabits.length === 0) continue;

          // habit row exposes the user-facing label as `habit_name` in the
          // legacy method and `name` in others; check both for safety.
          const habitList = unloggedHabits
            .map(h => `• ${h.habit_name || h.name}`)
            .join('\n');

          const message = `Daily Habit Check\n\nYou haven't logged these habits today:\n${habitList}\n\nLog them now to keep your streak!`;

          await messagingService.send(userPhone, message);

          logger.info(`Unlogged habits summary sent to ${userPhone} (${unloggedHabits.length} habits)`);
        } catch (error) {
          logger.error(`Failed to send unlogged habits summary to ${userPhone}:`, error.message);
        }
      }
    } catch (error) {
      logger.error('checkUnloggedHabits error:', error.message);
    } finally {
      this.isRunningUnlogged = false;
    }
  }
}

module.exports = new HabitJob();
