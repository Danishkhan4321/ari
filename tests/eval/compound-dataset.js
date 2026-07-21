'use strict';

/**
 * Compound-request dataset — "do two things at once".
 *
 * Single-tool selection and multi-task execution are different skills. A model
 * can be excellent at picking send_email for "mail Priya the invoice" and still
 * quietly drop half of "mail Priya the invoice AND set a follow-up for
 * Tuesday" — it answers, the user sees a confident reply, and the second task
 * simply never happened. That failure is invisible to the single-prompt
 * scorecard and very visible to a user.
 *
 * Each case lists every tool the request requires. Scoring is set-based and
 * order-independent: `complete` means every required tool was called.
 *
 * Phrasings stay natural — people say "and" and "then", not "execute two
 * operations". A few deliberately put the second task in a subordinate clause
 * ("...and if I'm free, book...") because that is where models most often drop
 * the tail.
 */

const COMPOUND_CASES = [
  { says: 'remind me to call mom at 6 and add milk to the shopping list',
    tools: ['set_reminder', 'manage_lists'] },

  { says: "save Neha's number 9876543210 and put her in the investors group",
    tools: ['save_contact', 'manage_contact_groups'] },

  { says: "mark the report task done and let Rahul know it's finished",
    tools: ['manage_tasks', 'delegate_message'] },

  { says: 'what have I got on friday and what tasks are still pending',
    tools: ['view_calendar', 'manage_tasks'] },

  { says: 'archive the Acme lead and take them out of the investors group',
    tools: ['manage_sales', 'manage_contact_groups'] },

  { says: 'jot down that pricing goes up in march and remind me to tell the team monday',
    tools: ['manage_notes', 'set_reminder'] },

  { says: 'show my reminders and my pending tasks',
    tools: ['view_reminders', 'manage_tasks'] },

  { says: 'email Priya the invoice and set a follow up for tuesday',
    tools: ['send_email', 'manage_follow_ups'] },

  { says: 'I spent 400 on lunch, and nudge me to file expenses on friday',
    tools: ['manage_expenses', 'set_reminder'] },

  { says: 'add a task to fix the login bug and write down what caused it',
    tools: ['manage_tasks', 'manage_notes'] },

  { says: 'look up the latest RBI rules and save what you find as a note',
    tools: ['web_search', 'manage_notes'] },

  { says: "drop the 3pm meeting and tell the team it's off",
    tools: ['cancel_calendar_event', 'delegate_message'] },

  { says: 'my passport expires june 2028, and nudge me about it in may',
    tools: ['save_memory', 'set_reminder'] },

  { says: 'who actually saw what I sent everyone, and what tasks are on me',
    tools: ['manage_team_comms', 'manage_tasks'] },

  { says: 'move Acme to negotiation and set a follow up for next week',
    tools: ['manage_sales', 'manage_follow_ups'] },

  { says: 'show my meeting recordings and what I have on tomorrow',
    tools: ['get_meeting_recordings', 'view_calendar'] },

  // The tail is in a subordinate clause — the classic drop point.
  { says: "check what I have on friday, and if I'm free book a sync with Neha at 3",
    tools: ['view_calendar', 'create_calendar_event'] },

  // Three tasks, not two.
  { says: 'note that the client wants a discount, add a task to prepare the revised quote, and remind me to send it tomorrow',
    tools: ['manage_notes', 'manage_tasks', 'set_reminder'] },
];

module.exports = { COMPOUND_CASES };
