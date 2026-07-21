'use strict';

/**
 * Materialize all lazily-created feature tables before background jobs start.
 * This keeps a fresh deployment from logging missing-table errors until a user
 * happens to invoke the corresponding feature for the first time.
 */

require('dotenv').config();

const initializers = [
  ['account links', require('../src/services/account-link.service'), 'ensureTable'],
  ['Apple Calendar', require('../src/services/apple-calendar.service'), 'ensureTables'],
  ['app updates', require('../src/services/auto-update.service'), 'ensureTable'],
  ['calendar', require('../src/services/calendar.service'), 'ensureTables'],
  ['email preferences', require('../src/services/email-preferences.service'), 'ensureTable'],
  ['expenses', require('../src/services/expense.service'), 'ensureSchema'],
  ['files', require('../src/services/file.service'), 'ensureFilesSchema'],
  ['focus', require('../src/services/focus.service'), 'ensureSchema'],
  ['follow-ups', require('../src/services/follow-up.service'), 'ensureSchema'],
  ['Google OAuth', require('../src/services/google-auth.service'), 'ensureTable'],
  ['habits', require('../src/services/habit.service'), 'ensureSchema'],
  ['images', require('../src/services/image.service'), 'ensureImagesSchema'],
  ['incidents', require('../src/services/incident.service'), 'ensureSchema'],
  ['knowledge base', require('../src/services/knowledge-base.service'), 'ensureSchema'],
  ['leave', require('../src/services/leave.service'), 'ensureTables'],
  ['lists', require('../src/services/list.service'), 'ensureSchema'],
  ['meeting minutes', require('../src/services/meeting-minutes.service'), 'ensureSchema'],
  ['Microsoft OAuth', require('../src/services/microsoft-auth.service'), 'ensureTable'],
  ['polls', require('../src/services/poll.service'), 'ensureTables'],
  ['reading list', require('../src/services/reading-list.service'), 'ensureSchema'],
  ['reminders', require('../src/services/reminder.service'), 'ensureRemindersSchema'],
  ['reply tracking', require('../src/services/reply-tracker.service'), 'ensureTable'],
  ['sales', require('../src/services/sales.service'), 'ensureTable'],
  ['personal standups', require('../src/services/self-standup.service'), 'ensureSchema'],
  ['shared boards', require('../src/services/shared-board.service'), 'ensureSchema'],
  ['sprints', require('../src/services/sprint.service'), 'ensureSchema'],
  ['standups', require('../src/services/standup.service'), 'ensureTables'],
  ['subscriptions', require('../src/services/subscription.service'), 'ensureTable'],
  ['tasks and teams', require('../src/services/task.service'), 'ensureTables'],
  ['team analytics', require('../src/services/team-analytics.service'), 'ensureSchema'],
  ['team communications', require('../src/services/team-comms.service'), 'ensureTables'],
  ['time tracking', require('../src/services/time-tracking.service'), 'ensureSchema'],
];

async function main() {
  const failures = [];
  for (const [name, service, method] of initializers) {
    try {
      await service[method]();
      console.log(`[schema] ready: ${name}`);
    } catch (error) {
      failures.push({ name, error: error.message });
      console.error(`[schema] failed: ${name}: ${error.message}`);
    }
  }

  if (failures.length) {
    throw new Error(`Schema bootstrap failed for ${failures.map(item => item.name).join(', ')}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error.message);
    process.exit(1);
  });
