/**
 * Zod schemas for OpenAI tool-call validation.
 *
 * Why this file exists alongside tool-definitions.js (not replacing it):
 * tool-definitions.js is 1630 lines of carefully-tuned JSON Schema. Replacing
 * it wholesale is risky — the LLM's tool-selection behavior is sensitive to
 * description text, parameter order, and enum values. Instead we add Zod as a
 * *validator* for the LLM's tool-call arguments. The JSON Schema sent to OpenAI
 * stays untouched; the Zod schema catches malformed arguments at dispatch time.
 *
 * Migration path:
 *  - Today: validate critical high-traffic tools here (set_reminder, send_email,
 *    create_calendar_event, etc.)
 *  - Future: migrate each tool from hand-written JSON Schema to `zodToJsonSchema`
 *    once the Zod schema is proven in production via logs
 *
 * When a tool is not registered here, validateToolCall returns `{ ok: true }`
 * (pass-through) — no behavioral change for un-migrated tools.
 *
 * INVARIANTS (enforced by keeping this file in lockstep with tool-definitions.js):
 *  - Every key here MUST be an exact tool name from getToolDefinitions().
 *  - Every z.enum() here MUST be exactly the enum set in the tool's JSON Schema
 *    (the LLM follows the JSON Schema, so Zod must accept all of those values).
 *  - Nothing is validated stricter than the JSON Schema — all props optional,
 *    .passthrough() everywhere. The goal is catching malformed args, not
 *    rejecting values the LLM was explicitly told it may emit.
 */

const { z } = require('zod');
const logger = require('../utils/logger');
const { getToolDefinitions } = require('./tool-definitions');

// ── Common primitives ───────────────────────────────────────────────────────
const phoneStr = z.string().min(5).max(20);
const nonEmptyStr = z.string().min(1).max(2000);
const fullText = z.string().max(5000).optional();

// ── Tool schemas ───────────────────────────────────────────────────────────
// Keep descriptions/enums aligned with tool-definitions.js.

const toolSchemas = {
  set_reminder: z.object({
    full_text: fullText,
    reminder_message: z.string().max(2000).optional(),
    target_name: z.string().max(100).optional(),
    target_phone: phoneStr.optional(),
    is_recurring: z.boolean().optional(),
    recurring_pattern: z.string().max(100).optional()
  }).passthrough(),

  save_memory: z.object({
    full_text: fullText,
    content: z.string().min(1).max(2000).optional(),
    category: z.string().max(50).optional()
  }).passthrough(),

  recall_memory: z.object({
    full_text: fullText,
    action: z.enum(['recall', 'show_all', 'show_category', 'forget', 'clear_all']).optional(),
    category: z.enum([
      'personal', 'work', 'finance', 'health', 'family',
      'friends', 'travel', 'vehicle', 'preferences', 'general'
    ]).optional()
  }).passthrough(),

  save_contact: z.object({
    full_text: fullText,
    name: z.string().min(1).max(100).optional(),
    phone: phoneStr.optional(),
    notes: z.string().max(500).optional()
  }).passthrough(),

  create_calendar_event: z.object({
    full_text: fullText,
    title: z.string().min(1).max(200).optional(),
    start_iso: z.string().optional(),
    end_iso: z.string().optional(),
    attendees: z.array(z.string()).optional(),
    description: z.string().max(2000).optional(),
    location: z.string().max(200).optional()
  }).passthrough(),

  send_email: z.object({
    full_text: fullText,
    to: z.union([z.string(), z.array(z.string())]).optional(),
    subject: z.string().max(500).optional(),
    body: z.string().max(20000).optional(),
    attachments: z.array(z.string()).optional()
  }).passthrough(),

  web_search: z.object({
    full_text: fullText,
    query: z.string().min(1).max(500).optional()
  }).passthrough(),

  delegate_message: z.object({
    full_text: fullText,
    target_name: z.string().max(100).optional(),
    message_content: z.string().max(2000).optional()
  }).passthrough(),

  manage_tasks: z.object({
    full_text: fullText,
    action: z.enum([
      'add', 'list', 'complete', 'assign', 'delete',
      'list_assigned_to_me', 'list_assigned_by_me', 'set_task_followup'
    ]).optional(),
    task_title: z.string().max(500).optional(),
    task_id: z.number().int().optional(),
    assignee_name: z.string().max(200).optional(),
    due_time: z.string().max(200).optional(),
    follow_up_directive: z.string().max(200).optional(),
    priority: z.enum(['high', 'normal', 'low']).optional()
  }).passthrough(),

  view_dashboard: z.object({
    full_text: fullText,
    section: z.string().max(50).optional()
  }).passthrough(),

  cancel_reminder: z.object({
    full_text: fullText,
    reminder_id: z.union([z.number(), z.string()]).optional(),
    position: z.union([z.number(), z.string()]).optional(),
    query: z.string().max(500).optional(),
    reason: z.string().max(500).optional()
  }).passthrough(),

  update_reminder: z.object({
    full_text: fullText,
    reminder_id: z.union([z.number(), z.string()]).optional(),
    position: z.union([z.number(), z.string()]).optional(),
    query: z.string().max(500).optional(),
    use_last_created: z.boolean().optional(),
    new_time: z.string().max(200).optional()
  }).passthrough(),

  manage_email_automation: z.object({
    full_text: fullText,
    action: z.enum([
      'enable_auto_label', 'disable_auto_label',
      'enable_reply_tracking', 'disable_reply_tracking',
      'set_reply_hours', 'view_settings'
    ]).optional(),
    hours: z.number().int().optional()
  }).passthrough(),

  track_email_reply: z.object({
    full_text: fullText,
    action: z.enum(['track', 'list', 'cancel']).optional(),
    recipient: z.string().max(200).optional(),
    hours: z.number().int().optional(),
    tracking_index: z.number().int().optional()
  }).passthrough(),

  // ── Calendar (expanded) ────────────────────────────────────────────────
  cancel_calendar_event: z.object({
    full_text: fullText,
    event_id: z.string().optional(),
    title_query: z.string().max(200).optional(),
    date_iso: z.string().optional()
  }).passthrough(),

  reschedule_calendar_event: z.object({
    full_text: fullText,
    event_id: z.string().optional(),
    title_query: z.string().max(200).optional(),
    new_start_iso: z.string().optional(),
    new_end_iso: z.string().optional()
  }).passthrough(),

  view_calendar: z.object({
    full_text: fullText
  }).passthrough(),

  email_calendar_attendees: z.object({
    full_text: fullText
  }).passthrough(),

  // ── Email (expanded) ───────────────────────────────────────────────────
  schedule_email: z.object({
    full_text: fullText,
    to: z.union([z.string(), z.array(z.string())]).optional(),
    subject: z.string().max(500).optional(),
    body: z.string().max(20000).optional(),
    send_at_iso: z.string().optional()
  }).passthrough(),

  bulk_email: z.object({
    full_text: fullText,
    recipients: z.array(z.string()).optional(),
    subject: z.string().max(500).optional(),
    body: z.string().max(20000).optional()
  }).passthrough(),

  check_inbox: z.object({
    full_text: fullText,
    action: z.enum(['check', 'read']).optional(),
    email_index: z.number().int().optional()
  }).passthrough(),

  search_inbox: z.object({
    full_text: fullText,
    folder: z.enum(['inbox', 'sent', 'all']).optional()
  }).passthrough(),

  // ── Contacts (expanded) ────────────────────────────────────────────────
  manage_contacts: z.object({
    full_text: fullText,
    action: z.enum(['list', 'get', 'delete', 'update']).optional(),
    name: z.string().max(100).optional(),
    phone: phoneStr.optional()
  }).passthrough(),

  bulk_save_contacts: z.object({
    full_text: fullText,
    contacts: z.array(z.object({
      name: z.string().min(1).max(100),
      phone: phoneStr
    })).optional()
  }).passthrough(),

  // ── Notes / Memory (expanded) ──────────────────────────────────────────
  manage_notes: z.object({
    full_text: fullText,
    action: z.enum([
      'save', 'list', 'list_topic', 'search',
      'delete_note', 'delete_topic', 'view'
    ]).optional(),
    note_content: z.string().max(10000).optional(),
    topic: z.string().max(100).optional(),
    note_id: z.number().int().optional(),
    search_query: z.string().max(500).optional()
  }).passthrough(),

  // ── Lists ──────────────────────────────────────────────────────────────
  manage_lists: z.object({
    full_text: fullText,
    action: z.enum([
      'create', 'add_item', 'view', 'view_all',
      'check_item', 'remove_item', 'clear'
    ]).optional(),
    list_name: z.string().max(100).optional(),
    items: z.array(z.string()).optional(),
    item_text: z.string().max(500).optional(),
    priority: z.enum(['high', 'normal', 'low']).optional()
  }).passthrough(),

  // ── Team ──────────────────────────────────────────────────────────────
  manage_team: z.object({
    full_text: fullText
  }).passthrough(),

  manage_leave: z.object({
    full_text: fullText
  }).passthrough(),

  manage_standup: z.object({
    full_text: fullText
  }).passthrough(),

  // ── Polls ──────────────────────────────────────────────────────────────
  manage_polls: z.object({
    full_text: fullText
  }).passthrough(),

  // ── Dashboard / UI ────────────────────────────────────────────────────
  delete_dashboard_item: z.object({
    full_text: fullText,
    item_type: z.enum(['reminder', 'image', 'recurring']).optional(),
    index: z.number().int().optional()
  }).passthrough(),

  // ── Timezone ──────────────────────────────────────────────────────────
  set_timezone: z.object({
    full_text: fullText,
    timezone_input: z.string().max(100).optional()
  }).passthrough(),

  // ── Google / Microsoft connection ─────────────────────────────────────
  connect_google: z.object({ full_text: fullText }).passthrough(),
  disconnect_google: z.object({ full_text: fullText }).passthrough(),
  connect_outlook: z.object({ full_text: fullText }).passthrough(),
  disconnect_outlook: z.object({ full_text: fullText }).passthrough(),

  // ── Meetings ──────────────────────────────────────────────────────────
  meeting_minutes: z.object({
    full_text: fullText,
    action: z.enum(['create', 'search', 'action_items', 'last', 'history']).optional(),
    meeting_title: z.string().max(200).optional(),
    meeting_content: z.string().max(20000).optional(),
    search_query: z.string().max(500).optional()
  }).passthrough(),

  // ── Files / Documents ─────────────────────────────────────────────────
  manage_images: z.object({
    full_text: fullText,
    action: z.enum(['search', 'list', 'delete', 'select_number']).optional(),
    search_query: z.string().max(500).optional(),
    number: z.number().int().optional()
  }).passthrough(),

  save_image: z.object({
    full_text: fullText,
    action: z.enum(['save', 'save_with_title', 'discard']).optional(),
    title: z.string().max(500).optional()
  }).passthrough(),

  search_drive: z.object({
    full_text: fullText,
    query: z.string().max(500).optional()
  }).passthrough(),

  manage_docs: z.object({
    full_text: fullText
  }).passthrough(),

  manage_sheets: z.object({
    full_text: fullText
  }).passthrough(),

  // ── Labels (email) ────────────────────────────────────────────────────
  manage_labels: z.object({
    full_text: fullText,
    action: z.enum([
      'archive', 'mark_read', 'mark_unread',
      'apply_label', 'remove_label', 'list_labels'
    ]).optional(),
    message_ref: z.string().max(500).optional(),
    label_name: z.string().max(100).optional()
  }).passthrough(),

  // ── Follow-ups ────────────────────────────────────────────────────────
  manage_follow_ups: z.object({
    full_text: fullText,
    action: z.enum(['create', 'complete', 'delete', 'list']).optional(),
    follow_up_id: z.number().int().optional(),
    contact_name: z.string().max(100).optional(),
    subject: z.string().max(500).optional(),
    due_time: z.string().max(200).optional(),
    priority: z.enum(['high', 'normal', 'low']).optional()
  }).passthrough(),

  // ── Expenses ──────────────────────────────────────────────────────────
  manage_expenses: z.object({
    full_text: fullText,
    action: z.enum([
      'log', 'update_by_category', 'update_by_id',
      'delete', 'summary', 'list', 'multi_log'
    ]).optional(),
    amount: z.number().optional(),
    new_amount: z.number().optional(),
    category: z.string().max(100).optional(),
    expense_id: z.number().int().optional(),
    period: z.enum(['today', 'week', 'month', 'year', 'all']).optional(),
    currency: z.enum(['INR', 'USD', 'EUR', 'GBP']).optional(),
    description: z.string().max(500).optional(),
    items: z.array(z.object({
      amount: z.number().optional(),
      description: z.string().optional(),
      category: z.string().optional()
    }).passthrough()).optional()
  }).passthrough(),

  // ── Habits ────────────────────────────────────────────────────────────
  manage_habits: z.object({
    full_text: fullText,
    action: z.enum(['create', 'log', 'delete', 'list', 'stats']).optional(),
    habit_name: z.string().max(100).optional(),
    frequency: z.enum(['daily', 'weekly']).optional(),
    target_count: z.number().int().optional(),
    notes: z.string().max(500).optional()
  }).passthrough(),

  // ── Focus mode ────────────────────────────────────────────────────────
  focus_mode: z.object({
    full_text: fullText,
    action: z.enum(['start', 'stop', 'status', 'stats']).optional(),
    duration_minutes: z.number().int().optional(),
    mode: z.enum(['pomodoro', 'deep_work', 'regular']).optional(),
    label: z.string().max(200).optional(),
    period: z.enum(['today', 'week', 'month']).optional()
  }).passthrough(),

  // ── Sales ─────────────────────────────────────────────────────────────
  manage_sales: z.object({
    full_text: fullText,
    action: z.enum([
      'add_lead', 'move_stage', 'list', 'details',
      'delete', 'summary', 'cold_email', 'follow_up'
    ]).optional(),
    lead_name: z.string().max(200).optional(),
    company: z.string().max(200).optional(),
    stage: z.enum([
      'new', 'contacted', 'replied', 'meeting',
      'proposal', 'negotiation', 'won', 'lost'
    ]).optional()
  }).passthrough(),

  // ── Personal standup ──────────────────────────────────────────────────
  personal_standup: z.object({
    full_text: fullText,
    action: z.enum(['log', 'history', 'today', 'weekly_reflection']).optional(),
    yesterday_done: z.string().max(2000).optional(),
    today_plan: z.string().max(2000).optional(),
    blockers: z.string().max(2000).optional(),
    mood: z.enum(['great', 'good', 'okay', 'bad', 'awful']).optional()
  }).passthrough(),

  // ── Reading list ──────────────────────────────────────────────────────
  manage_reading_list: z.object({
    full_text: fullText,
    action: z.enum(['save', 'list', 'delete', 'mark_read', 'stats', 'search']).optional(),
    url: z.string().max(2000).optional(),
    item_id: z.number().int().optional(),
    search_query: z.string().max(500).optional(),
    show_all: z.boolean().optional()
  }).passthrough(),

  // ── Incidents ─────────────────────────────────────────────────────────
  manage_incidents: z.object({
    full_text: fullText,
    action: z.enum(['report', 'resolve', 'assign', 'escalate', 'status', 'list', 'stats']).optional(),
    title: z.string().max(200).optional(),
    severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
    incident_id: z.number().int().optional(),
    assignee_name: z.string().max(100).optional(),
    resolution_notes: z.string().max(2000).optional()
  }).passthrough(),

  // ── Sprints ───────────────────────────────────────────────────────────
  manage_sprints: z.object({
    full_text: fullText,
    action: z.enum([
      'create', 'add_item', 'status', 'end',
      'history', 'velocity', 'complete_item'
    ]).optional(),
    sprint_name: z.string().max(100).optional(),
    sprint_goal: z.string().max(500).optional(),
    item_title: z.string().max(500).optional(),
    story_points: z.number().int().optional(),
    item_id: z.number().int().optional(),
    assignee_name: z.string().max(100).optional()
  }).passthrough(),

  // ── Shared board (kanban) ─────────────────────────────────────────────
  manage_shared_board: z.object({
    full_text: fullText,
    action: z.enum([
      'create_board', 'add_task', 'status', 'assign', 'complete',
      'move', 'start', 'list_boards', 'delete_board', 'delete_task'
    ]).optional(),
    board_name: z.string().max(200).optional(),
    board_description: z.string().max(500).optional(),
    task_title: z.string().max(500).optional(),
    task_id: z.number().int().optional(),
    assignee_name: z.string().max(100).optional(),
    priority: z.enum(['high', 'normal', 'low']).optional(),
    target_column: z.enum(['todo', 'in_progress', 'done']).optional()
  }).passthrough(),

  // ── Team analytics ────────────────────────────────────────────────────
  team_analytics: z.object({
    full_text: fullText,
    action: z.enum([
      'overview', 'comparison', 'workload',
      'blockers', 'availability', 'health'
    ]).optional()
  }).passthrough(),

  // ── Time tracking ─────────────────────────────────────────────────────
  track_time: z.object({
    full_text: fullText,
    action: z.enum(['start', 'stop', 'status', 'summary', 'log']).optional(),
    task_description: z.string().max(500).optional(),
    project: z.string().max(100).optional(),
    period: z.enum(['today', 'yesterday', 'week', 'month']).optional(),
    duration_minutes: z.number().int().optional()
  }).passthrough(),

  // ── Knowledge base ────────────────────────────────────────────────────
  manage_knowledge_base: z.object({
    full_text: fullText,
    action: z.enum(['add', 'search', 'categories', 'show', 'delete', 'list']).optional(),
    title: z.string().max(200).optional(),
    content: z.string().max(50000).optional(),
    article_id: z.number().int().optional(),
    search_query: z.string().max(500).optional()
  }).passthrough(),

  // ── Quick-note docs ───────────────────────────────────────────────────
  quick_note_docs: z.object({
    full_text: fullText
  }).passthrough(),

  // ── Google Tasks ──────────────────────────────────────────────────────
  manage_google_tasks: z.object({
    full_text: fullText,
    action: z.enum(['list', 'create', 'complete']).optional(),
    title: z.string().max(500).optional()
  }).passthrough(),

  // ── Google Contacts ───────────────────────────────────────────────────
  search_google_contacts: z.object({
    full_text: fullText,
    query: z.string().max(200).optional()
  }).passthrough(),

  // ── Translate ─────────────────────────────────────────────────────────
  translate_text: z.object({
    full_text: fullText
  }).passthrough(),

  // ── Briefing ──────────────────────────────────────────────────────────
  daily_briefing: z.object({
    full_text: fullText
  }).passthrough()
};

// Keep the validator registry aligned with the active model tool catalog.
// Legacy schemas for disabled Gmail-history tools must not be callable.
const activeToolNames = new Set(getToolDefinitions().map(tool => tool.function.name));
for (const name of Object.keys(toolSchemas)) {
  if (!activeToolNames.has(name)) delete toolSchemas[name];
}

/**
 * Validate the tool-call extracted from an OpenAI response.
 *
 * Expects the axios-shaped response (data.choices[0].message.tool_calls[0]).
 * Returns { ok: true } for unregistered tools (no validation applied),
 * { ok: true, data } for validated ones, or
 * { ok: false, issues } on validation failure.
 *
 * @param {object} openaiResponse
 * @returns {{ ok: boolean, data?: object, issues?: Array, toolName?: string }}
 */
function validateToolCall(openaiResponse) {
  try {
    const choice = openaiResponse?.data?.choices?.[0];
    const toolCall = choice?.message?.tool_calls?.[0];
    if (!toolCall) return { ok: true }; // No tool called → nothing to validate

    const toolName = toolCall.function?.name;
    if (!toolName || !toolSchemas[toolName]) {
      // Tool not registered for Zod validation — pass through.
      return { ok: true, toolName };
    }

    let params;
    try {
      params = JSON.parse(toolCall.function.arguments || '{}');
    } catch (e) {
      return {
        ok: false,
        toolName,
        issues: [{ path: [], message: 'Invalid JSON in tool arguments' }]
      };
    }

    const schema = toolSchemas[toolName];
    const parsed = schema.safeParse(params);

    if (parsed.success) {
      return { ok: true, toolName, data: parsed.data };
    }

    return {
      ok: false,
      toolName,
      issues: parsed.error.issues.map(i => ({
        path: i.path,
        code: i.code,
        message: i.message
      }))
    };
  } catch (e) {
    logger.debug(`Zod validator internal error: ${e.message}`);
    return { ok: true }; // Fail open — don't block calls on validator bugs
  }
}

/**
 * Registry accessor — tests / future migration can iterate over known schemas.
 */
function getRegisteredTools() {
  return Object.keys(toolSchemas);
}

module.exports = { toolSchemas, validateToolCall, getRegisteredTools };
