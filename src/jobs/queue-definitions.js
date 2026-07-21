/**
 * Central registry of pg-boss queue names and their default options.
 *
 * Why here: having every queue name + retry policy in one file prevents drift
 * (some queues retrying 5 times, others 3, some with backoff, some without).
 *
 * Usage from a producer:
 *   const { QUEUES, sendOptions } = require('./jobs/queue-definitions');
 *   await boss.send(QUEUES.REMINDER_SEND, data, sendOptions.REMINDER_SEND);
 *
 * Usage from a worker:
 *   const { QUEUES } = require('./jobs/queue-definitions');
 *   await boss.work(QUEUES.REMINDER_SEND, workerOptions, handler);
 */

const QUEUES = {
  // Reminders — fires once at reminder_time. Retry aggressively; dropping is bad.
  REMINDER_SEND: 'reminder:send',

  // Recurring reminder trigger — schedules the next occurrence after a send.
  REMINDER_SCHEDULE_NEXT: 'reminder:schedule-next',

  // Scheduled email send — critical, retry with backoff.
  EMAIL_SEND_SCHEDULED: 'email:send-scheduled',

  // Auto-label inbox — polling job, fires every 15 min.
  EMAIL_AUTO_LABEL: 'email:auto-label',

  // Reply tracker — polling job, fires every 30 min.
  EMAIL_REPLY_TRACK: 'email:reply-track',

  // Task reminders — polling.
  TASK_REMINDER: 'task:reminder',

  // Daily task digest.
  TASK_DAILY_DIGEST: 'task:daily-digest',

  // Calendar event reminders.
  CALENDAR_REMINDER: 'calendar:reminder',

  // Standup send.
  STANDUP_SEND: 'standup:send',

  // Focus mode tick (pomodoro).
  FOCUS_TICK: 'focus:tick',

  // Habit reminders.
  HABIT_REMINDER: 'habit:reminder',

  // Follow-up reminders.
  FOLLOW_UP: 'followup:send',

  // Sprint updates.
  SPRINT_UPDATE: 'sprint:update',

  // Incident escalation.
  INCIDENT_ESCALATE: 'incident:escalate',

  // Poll close/result notification.
  POLL_CLOSE: 'poll:close',

};

// Default send/work options per queue.
// - retryLimit: how many retries after first failure
// - retryBackoff: exponential backoff between retries
// - expireInHours: drop the job if not completed in N hours
// - retentionDays: how long to keep completed jobs (for debugging)

const sendOptions = {
  [QUEUES.REMINDER_SEND]: {
    retryLimit: 5,
    retryBackoff: true,
    retryDelay: 30,           // Start with 30s, doubles: 30, 60, 120, 240, 480
    expireInHours: 24,
    retentionDays: 7
  },
  [QUEUES.EMAIL_SEND_SCHEDULED]: {
    retryLimit: 5,
    retryBackoff: true,
    retryDelay: 60,
    expireInHours: 24,
    retentionDays: 14
  },
  [QUEUES.EMAIL_AUTO_LABEL]: {
    retryLimit: 2,            // Polling job — retry lightly
    retryBackoff: true,
    retryDelay: 60,
    expireInHours: 1
  },
  [QUEUES.EMAIL_REPLY_TRACK]: {
    retryLimit: 2,
    retryBackoff: true,
    retryDelay: 60,
    expireInHours: 1
  },
  [QUEUES.TASK_REMINDER]: {
    retryLimit: 3,
    retryBackoff: true,
    retryDelay: 30,
    expireInHours: 12
  },
  [QUEUES.CALENDAR_REMINDER]: {
    retryLimit: 5,
    retryBackoff: true,
    retryDelay: 30,
    expireInHours: 6
  },
  [QUEUES.STANDUP_SEND]: {
    retryLimit: 3,
    retryBackoff: true,
    retryDelay: 60,
    expireInHours: 12
  },
  [QUEUES.FOCUS_TICK]: {
    retryLimit: 1,            // Transient — not worth retrying hard
    expireInHours: 1
  },
  [QUEUES.HABIT_REMINDER]: {
    retryLimit: 3,
    retryBackoff: true,
    retryDelay: 60,
    expireInHours: 12
  },
  [QUEUES.FOLLOW_UP]: {
    retryLimit: 5,
    retryBackoff: true,
    retryDelay: 60,
    expireInHours: 12
  },
  DEFAULT: {
    retryLimit: 3,
    retryBackoff: true,
    retryDelay: 30,
    expireInHours: 24
  }
};

// Work() options per queue — mainly concurrency tuning.
const workOptions = {
  [QUEUES.REMINDER_SEND]: { teamSize: 4, teamConcurrency: 2 },
  [QUEUES.EMAIL_SEND_SCHEDULED]: { teamSize: 3, teamConcurrency: 2 },
  [QUEUES.EMAIL_AUTO_LABEL]: { teamSize: 1, teamConcurrency: 1 },  // Serial
  [QUEUES.EMAIL_REPLY_TRACK]: { teamSize: 1, teamConcurrency: 1 }, // Serial
  [QUEUES.CALENDAR_REMINDER]: { teamSize: 3, teamConcurrency: 1 },
  DEFAULT: { teamSize: 2, teamConcurrency: 1 }
};

function getSendOptions(queueName) {
  return sendOptions[queueName] || sendOptions.DEFAULT;
}

function getWorkOptions(queueName) {
  return workOptions[queueName] || workOptions.DEFAULT;
}

module.exports = { QUEUES, sendOptions, workOptions, getSendOptions, getWorkOptions };
