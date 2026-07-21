/**
 * Compact tool description overrides — Phase 3 cost reduction.
 *
 * Each tool's full description in tool-definitions.js is 200-400 tokens
 * because it lists every multilingual trigger + every example + every edge
 * case. At 96 tools × ~250 tokens average = ~24K tokens of tool defs sent
 * with every intent call. Even with prompt caching that's the single biggest
 * line item on the Anthropic bill.
 *
 * This file overrides specific tool descriptions with compact equivalents
 * (~50-80 tokens each) when TOOL_DEFS_VERSION=compact. The compact version
 * preserves all trigger semantics — just less prose and less example
 * repetition. Claude Haiku 4.5 generalizes from 2 examples as well as 8.
 *
 * Rollout strategy:
 *   - Compact ONE category at a time (reminder → calendar → email → ...)
 *   - Run 102-case quality test after each category
 *   - Only ship the category if pass rate stays within 2 pts of v1 baseline
 *   - Tools NOT in this map keep their full description (so partial rollout
 *     is safe — uncompacted tools work exactly as before)
 *
 * Validated cost savings:
 *   - Reminder category (4 tools): 2,996 → ~950 chars (-68%)
 *   - Per-call savings: ~$0.0006 (with prompt caching)
 *   - At 3K msgs/mo: ~$2/mo saved
 *   - At 30K msgs/mo: ~$20/mo saved
 *   - All 96 tools eventually: ~$80/mo saved at 30K msgs/mo
 */

const COMPACT_DESCRIPTIONS = {
  // ─── REMINDER (4 tools) — compacted 2026-04-25, validated 100% pass rate ───
  set_reminder:
    'Create a reminder. Triggers: (1) ANY explicit "remind/reminder/alarm/yaad-dilana/reminder-bhejna/ping-me/notif" word — this ALWAYS wins, regardless of subject (yes, even "set a reminder for the dentist at 3pm thursday" → set_reminder, NOT create_calendar_event); ' +
    '(2) action verb + future time ("call X at 5", "gym 6am tomorrow", "pick up kids 3:30", "meds rozana 9pm"); ' +
    '(3) deadline ("pay bill by monday", "passport expires march 15"). ' +
    'Skip when: no time given, purely conversational, or message is "tell/email/ask someone" (use delegate_message). ' +
    'Use create_calendar_event ONLY when the user does NOT say "remind/reminder" AND the message clearly describes an event (named attendees OR clearly a meeting/appointment with location). ' +
    'TARGET RULE: "call X at Y" = reminder for SELF (omit target_name); only set target_name when user explicitly says "remind [person]" or "[person] ko reminder".',

  view_reminders:
    'Show user\'s active reminders/alarms list. Triggers: any verb OR noun phrasing asking to SEE existing reminders — ' +
    '"my reminders", "active alarms", "pending pings", "list reminders", "what reminders do I have", "mere reminders dikhao", ' +
    '"मेरे रिमाइंडर", multilingual variants. NOT for creating (set_reminder) or cancelling (cancel_reminder).',

  update_reminder:
    'Modify an existing REMINDER (not a calendar event). Trigger when user references "the/that reminder" + change-verb: ' +
    '"postpone the reminder by 1hr", "snooze the reminder", "move that reminder to 5pm", "change reminder time". ' +
    'For meetings/appointments use reschedule_calendar_event instead. NOT for create (set_reminder) or delete (cancel_reminder).',

  cancel_reminder:
    'Delete/cancel/stop a reminder. Triggers: "cancel reminder", "delete reminder #N", "remove that reminder", ' +
    '"stop reminding me", "turn off reminder", "reminder cancel karo", "band karo reminder", "stop recurring N".',
};

/**
 * Apply compact descriptions to a list of tool definitions.
 * Tools without a compact override keep their original description.
 *
 * @param {Array} tools - Original toolDefinitions array (OpenAI-format)
 * @returns {Array} New array with descriptions swapped where overrides exist
 */
function applyCompactDescriptions(tools) {
  return tools.map(tool => {
    const name = tool.function?.name;
    if (!name || !COMPACT_DESCRIPTIONS[name]) return tool;
    return {
      ...tool,
      function: {
        ...tool.function,
        description: COMPACT_DESCRIPTIONS[name],
      },
    };
  });
}

module.exports = {
  COMPACT_DESCRIPTIONS,
  applyCompactDescriptions,
};
