/**
 * WhatsApp message template definitions.
 * Each template has a name (matching Meta Business Manager) and language code.
 * Names are env-var overridable for easy swapping without code changes.
 */
module.exports = {
  // ── Reminders ──────────────────────────────────────────────────────────
  // Each template below has been verified against the approved Meta template
  // catalog on 2026-04-22. Param counts must match what the caller passes.
  //
  // PERSONAL_REMINDER   — self reminder.  1 param: [message]
  // APPOINTMENT_REMINDER — reminder FOR someone else.  2 params: [senderName, message]
  // RECURRING_REMINDER  — alternate style for recurring self reminders. 1 param.
  // TASK_REMINDER       — 3rd party / assigned-task-style reminder.  2 params: [assignerName, taskText]
  TASK_REMINDER: { name: process.env.WA_TPL_TASK_REMINDER || 'task_reminder_3', lang: 'en_US' },
  PERSONAL_REMINDER: { name: process.env.WA_TPL_PERSONAL_REMINDER || 'personal_reminder', lang: 'en' },
  RECURRING_REMINDER: { name: process.env.WA_TPL_RECURRING_REMINDER || 'reminder_2', lang: 'en_US' },
  APPOINTMENT_REMINDER: { name: process.env.WA_TPL_APPOINTMENT_REMINDER || 'appointment_reminder', lang: 'en_US' },

  // Polls
  POLL_BROADCAST: { name: process.env.WA_TPL_POLL_BROADCAST || 'action_required', lang: 'en_US' },
  POLL_REMINDER: { name: process.env.WA_TPL_POLL_REMINDER || 'team_poll_reminder', lang: 'en_US' },
  POLL_RESULTS: { name: process.env.WA_TPL_POLL_RESULTS || 'poll_results_complete', lang: 'en_US' },

  // Standups
  STANDUP_MORNING: { name: process.env.WA_TPL_STANDUP_MORNING || 'standup_morning_checkin', lang: 'en_US' },
  STANDUP_EVENING: { name: process.env.WA_TPL_STANDUP_EVENING || 'standup_evening_wrapup', lang: 'en_US' },
  // Switched from report_delivery -> standup_team_digest on 2026-04-22 per
  // product decision. Template copy is "Team: {{1}} | Responded: {{2}} |
  // Summary: {{3}}" — so the call site now passes a real responded count
  // (e.g. "3/5") instead of a bare date string for the 2nd param.
  STANDUP_DIGEST: { name: process.env.WA_TPL_STANDUP_DIGEST || 'standup_team_digest', lang: 'en_US' },
  STANDUP_ALERT: { name: process.env.WA_TPL_STANDUP_ALERT || 'standup_alignment_alert', lang: 'en_US' },

  // Calendar / Meetings
  MEETING_REMINDER: { name: process.env.WA_TPL_MEETING_REMINDER || 'meeting_reminder_15min', lang: 'en_US' },
  MEETING_TRANSCRIPT: { name: process.env.WA_TPL_MEETING_TRANSCRIPT || 'meeting_transcript_ready', lang: 'en_US' },

  // Tasks
  TASK_FOLLOWUP: { name: process.env.WA_TPL_TASK_FOLLOWUP || 'task_followup', lang: 'en_US' },
  TASK_COMPLETED: { name: process.env.WA_TPL_TASK_COMPLETED || 'task_completed', lang: 'en_US' },

  // Other
  // INCIDENT: alerts admins about new incidents. No incident_escalation template
  // exists in Meta, so reusing follow_up_contact — its "Contact / Subject /
  // Priority" param labels map cleanly onto [incident_id, description, severity].
  INCIDENT: { name: process.env.WA_TPL_INCIDENT || 'follow_up_contact', lang: 'en_US' },
  FOLLOW_UP_CONTACT: { name: process.env.WA_TPL_FOLLOW_UP || 'follow_up_contact', lang: 'en_US' },
  SPRINT_UPDATE: { name: process.env.WA_TPL_SPRINT_UPDATE || 'sprint_daily_update', lang: 'en_US' },
  SCHEDULED_EMAIL: { name: process.env.WA_TPL_SCHEDULED_EMAIL || 'scheduled_email_status', lang: 'en_US' },
  FOCUS_SESSION: { name: process.env.WA_TPL_FOCUS_SESSION || 'focus_session_end', lang: 'en_US' },
  // SCHEDULED_MESSAGE: user schedules a text to another person. No dedicated
  // message_delivery template in Meta — reusing appointment_reminder (2 params
  // [senderName, messageText]) per user decision. Copy reads
  // "Reminder: {{1}} wanted me to remind you of. {{2}}" — not perfect
  // semantically (says "reminder" not "message"), but delivers outside 24h.
  SCHEDULED_MESSAGE: { name: process.env.WA_TPL_SCHEDULED_MESSAGE || 'appointment_reminder', lang: 'en_US' },
};
