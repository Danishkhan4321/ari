const cron = require('node-cron');
const taskService = require('../services/task.service');
const messagingService = require('../services/messaging.service');
const accountLinkService = require('../services/account-link.service');
const memoryService = require('../services/memory.service');
const logger = require('../utils/logger');
const { sendWithTemplateFallback } = require('../utils/whatsapp-24h');
const TEMPLATES = require('../config/whatsapp-templates');

class TaskJob {

  constructor() {
    this.isRunning = false;
    this.isReminderRunning = false;
  }

  start() {
    // Run every minute to check for task follow-ups (legacy delegated_tasks)
    cron.schedule('* * * * *', async () => {
      await this.processFollowUps();
    });

    // Run every minute to check for FLEXIBLE follow-ups (Phase 3 — user-set
    // cadence per task via _parseFollowUpDirective). Replaces the hardcoded
    // 24h reminder for any task that has next_followup_at set explicitly.
    cron.schedule('* * * * *', async () => {
      await this.processFlexibleFollowUps();
    });

    // Run every hour to send 24h reminders for tasks WITHOUT a flexible
    // follow-up set (legacy fallback — getAssignedTasksDueReminder now skips
    // tasks where next_followup_at is non-null, so no double-firing).
    cron.schedule('0 * * * *', async () => {
      await this.processAssigneeReminders();
    });

    logger.info('Task jobs started — follow-ups + flexible follow-ups every minute, 24h legacy reminders every hour');
  }

  // ─── PHASE 3: flexible follow-ups (user-set cadence) ────────────────
  async processFlexibleFollowUps() {
    if (this.isFlexibleRunning) return;
    this.isFlexibleRunning = true;
    try {
      const tasks = await taskService.getAssignedTasksDueFollowUp();
      if (tasks.length === 0) return;
      logger.info(`Found ${tasks.length} tasks due for flexible follow-up`);

      for (const task of tasks) {
        try {
          const notifyUserId = await accountLinkService.getNotifyUserId(task.assigned_to);
          const assignerName = await this.resolveAssignerName(task.assigned_by);
          const cadenceLabel = task.followup_cadence_minutes
            ? this._formatCadence(task.followup_cadence_minutes)
            : null;
          const buttons = [
            { id: `task_done_${task.id}`, title: 'Done' },
            { id: `task_notdone_${task.id}`, title: 'Not done' },
          ];
          // For recurring follow-ups, also offer a "stop reminding me" option
          if (task.followup_cadence_minutes) {
            buttons.push({ id: `task_stopfollowup_${task.id}`, title: 'Stop reminders' });
          }
          const body = `*Follow-up:* You have a pending task from ${assignerName}:\n\n"${task.description}"${cadenceLabel ? `\n\n_Reminding ${cadenceLabel}_` : ''}`;

          // Recipient might be outside 24h window — sendButtonMessage doesn't
          // have built-in template fallback, so try free-form first and let
          // the WA status webhook tell us if it failed (we ignore async fails
          // here — recurring follow-ups will retry on the next cycle anyway).
          await messagingService.sendButtonMessage(notifyUserId, body, buttons);

          // Advance the cadence (or clear if one-time)
          await taskService.advanceFollowUp(task.id, task.followup_cadence_minutes);
          logger.info(`Sent flexible follow-up for task ${task.id}, cadence=${task.followup_cadence_minutes || 'one-time'}`);
        } catch (error) {
          logger.error(`Flexible follow-up failed for task ${task.id}:`, error.message);
        }
      }
    } catch (error) {
      logger.error('Flexible follow-up job error:', error);
    } finally {
      this.isFlexibleRunning = false;
    }
  }

  _formatCadence(minutes) {
    if (!minutes || minutes <= 0) return '';
    if (minutes < 60) return `every ${minutes} min`;
    if (minutes < 1440) {
      const h = Math.round(minutes / 60);
      return `every ${h} hour${h === 1 ? '' : 's'}`;
    }
    const d = Math.round(minutes / 1440);
    return `every ${d} day${d === 1 ? '' : 's'}`;
  }

  async processFollowUps() {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      const tasks = await taskService.getTasksPendingFollowUp();
      
      if (tasks.length === 0) return;
      
      logger.info(`Found ${tasks.length} tasks due for follow-up`);

      for (const task of tasks) {
        try {
          // Notify the owner about pending task (resolve preferred notification platform)
          const notifyUserId = await accountLinkService.getNotifyUserId(task.owner_phone);
          const message = `Hey! Following up on your task:\n\n"${task.task_description}"\n\nSent to: ${task.recipient_phone}\nStatus: Still pending`;

          await sendWithTemplateFallback(notifyUserId, message, TEMPLATES.TASK_FOLLOWUP, [task.task_description || task.description, task.recipient_phone || 'team member']);

          // Update follow-up tracking
          await taskService.updateLastFollowUp(task.id);
          
          logger.info(`Sent follow-up for task ${task.id} to ${task.owner_phone}`);
        } catch (error) {
          logger.error(`Failed to send follow-up for task ${task.id}:`, error.message);
        }
      }
    } catch (error) {
      logger.error('Task follow-up job error:', error);
    } finally {
      this.isRunning = false;
    }
  }
  async processAssigneeReminders() {
    if (this.isReminderRunning) return;
    this.isReminderRunning = true;
    try {
      const tasks = await taskService.getAssignedTasksDueReminder();
      if (tasks.length === 0) return;

      logger.info(`Found ${tasks.length} assigned tasks due for 24h reminder`);

      for (const task of tasks) {
        try {
          const notifyUserId = await accountLinkService.getNotifyUserId(task.assigned_to);
          const assignerName = await this.resolveAssignerName(task.assigned_by);

          // Send at 23h30m — still within 24h window, so buttons work (no template needed)
          await messagingService.sendButtonMessage(
            notifyUserId,
            `*Reminder:* You have a pending task from ${assignerName}:\n\n"${task.description}"`,
            [
              { id: `task_done_${task.id}`, title: 'Done' },
              { id: `task_notdone_${task.id}`, title: 'Not done' }
            ]
          );

          await taskService.updateTaskReminderSent(task.id);
          logger.info(`Sent 24h reminder for task ${task.id} to ${task.assigned_to}`);
        } catch (error) {
          logger.error(`Failed to send assignee reminder for task ${task.id}:`, error.message);
        }
      }
    } catch (error) {
      logger.error('Assignee reminder job error:', error);
    } finally {
      this.isReminderRunning = false;
    }
  }

  async resolveAssignerName(phone) {
    try {
      const trunk = await memoryService.getMemoryTrunk(phone);
      if (trunk?.personal) {
        const nameEntry = trunk.personal.find(m => m.key === 'name');
        if (nameEntry) return nameEntry.value;
      }
      return `+${phone}`;
    } catch (e) {
      return `+${phone}`;
    }
  }

}

module.exports = new TaskJob();