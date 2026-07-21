'use strict';

const { z } = require('zod');
const { getToolDefinitions } = require('./tool-definitions');

const EFFECTS = new Set(['read', 'reversible_write', 'external_write', 'destructive', 'mixed']);
const ARTIFACT_ID_PATTERN = '^(?:session:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|user_file:[1-9][0-9]{0,9})$';

const READ_TOOLS = new Set([
  'analyze_file', 'check_team_availability', 'daily_briefing', 'export_data',
  'list_calendars', 'news_deep_dive',
  'recall_memory', 'search_drive',
  'request_clarification', 'show_help', 'show_version', 'team_analytics', 'thread_summary',
  'translate_text', 'view_calendar', 'view_dashboard', 'view_reminders',
  'view_timezone', 'web_search',
]);

const EXTERNAL_WRITE_TOOLS = new Set([
  'bulk_email', 'create_calendar_event', 'delegate_message',
  'email_calendar_attendees', 'handle_calendar_confirmation',
  'handle_email_confirmation', 'handle_leave_approval',
  'handle_poll_vote', 'handle_sales_email_confirmation',
  'handle_standup_response', 'reuse_recent_email',
  'reschedule_calendar_event', 'schedule_email', 'scheduled_message', 'send_email', 'share_drive_file',
]);

const WORKFLOW_CONFIRMATION_TOOLS = new Set([
  'bulk_email', 'cancel_calendar_event', 'create_calendar_event',
  'delegate_message', 'email_calendar_attendees', 'reschedule_calendar_event',
  'reuse_recent_email', 'schedule_email', 'scheduled_message', 'send_email',
]);

const CONFIRMATION_RESOLUTION_TOOLS = new Set([
  'handle_calendar_confirmation', 'handle_email_confirmation',
  'handle_leave_approval', 'handle_poll_vote',
  'handle_sales_email_confirmation', 'handle_standup_response',
]);

const DESTRUCTIVE_TOOLS = new Set([
  'cancel_calendar_event', 'cancel_reminder', 'clear_chat_history',
  'delete_dashboard_item', 'disconnect_apple', 'disconnect_google',
  'disconnect_outlook',
]);

const MIXED_TOOLS = new Set([
  'briefing_toggle', 'focus_mode', 'link_account', 'manage_contact_groups',
  'manage_contacts', 'manage_docs', 'manage_expenses', 'manage_follow_ups',
  'get_meeting_recordings', 'manage_google_tasks', 'manage_habits', 'manage_images', 'manage_incidents',
  'manage_campaigns', 'manage_knowledge_base', 'manage_leave', 'manage_lists', 'manage_notes',
  'manage_polls', 'manage_reading_list', 'manage_sales', 'manage_shared_board',
  'manage_sheets', 'manage_slides', 'manage_sprints', 'manage_standup',
  'manage_team_comms',
  'manage_tasks', 'manage_team', 'meeting_minutes', 'personal_standup',
  'save_image', 'track_time',
]);

const DOMAIN_GROUPS = {
  reminders: ['set_reminder', 'view_reminders', 'cancel_reminder', 'complete_reminder', 'update_reminder', 'briefing_toggle'],
  memory: ['save_memory', 'recall_memory'],
  contacts: ['save_contact', 'bulk_save_contacts', 'manage_contacts', 'manage_contact_groups'],
  dashboard: ['view_dashboard', 'delete_dashboard_item'],
  images: ['manage_images', 'save_image'],
  calendar: [
    'create_calendar_event', 'cancel_calendar_event', 'reschedule_calendar_event',
    'view_calendar', 'email_calendar_attendees', 'remind_all_calendar',
    'list_calendars', 'handle_calendar_confirmation',
  ],
  email: [
    'send_email', 'schedule_email', 'bulk_email', 'handle_email_confirmation',
    'reuse_recent_email', 'handle_sales_email_confirmation',
  ],
  tasks: ['manage_tasks', 'manage_google_tasks', 'manage_follow_ups'],
  team: [
    'manage_team', 'manage_leave', 'handle_leave_approval', 'manage_standup',
    'handle_standup_setup', 'handle_standup_response', 'manage_polls',
    'handle_poll_vote', 'check_team_availability', 'delegate_message',
    'scheduled_message', 'personal_standup', 'manage_shared_board',
    'manage_sprints', 'manage_incidents', 'team_analytics', 'manage_team_comms',
  ],
  notes: ['manage_notes', 'manage_lists', 'quick_note_docs', 'manage_knowledge_base'],
  briefing: ['daily_briefing', 'news_deep_dive'],
  conversation: ['thread_summary', 'clear_chat_history', 'request_clarification'],
  drive: [
    'connect_google', 'disconnect_google', 'search_drive', 'create_drive_folder',
    'share_drive_file', 'upload_to_drive',
  ],
  documents: ['manage_docs', 'manage_sheets', 'manage_slides', 'analyze_file'],
  integrations: [
    'connect_outlook', 'disconnect_outlook', 'connect_apple',
    'disconnect_apple', 'link_account',
  ],
  sales: ['manage_sales', 'manage_campaigns'],
  research: ['web_search'],
  settings: ['set_timezone', 'view_timezone', 'export_data', 'show_version', 'show_help'],
  translation: ['translate_text'],
  productivity: ['focus_mode', 'manage_habits', 'manage_expenses', 'track_time', 'manage_reading_list'],
  meetings: ['meeting_minutes', 'get_meeting_recordings'],
  images_and_files: ['manage_images', 'save_image'],
};

const DOMAIN_BY_TOOL = new Map();
for (const [domain, names] of Object.entries(DOMAIN_GROUPS)) {
  for (const name of names) {
    if (!DOMAIN_BY_TOOL.has(name)) DOMAIN_BY_TOOL.set(name, domain);
  }
}

function stringField(description, options = {}) {
  return {
    type: 'string',
    description,
    ...(options.minLength ? { minLength: options.minLength } : {}),
    ...(options.maxLength ? { maxLength: options.maxLength } : {}),
    ...(options.enum ? { enum: options.enum } : {}),
    ...(options.pattern ? { pattern: options.pattern } : {}),
  };
}

function stringArray(description, options = {}) {
  return {
    type: 'array',
    description,
    items: stringField(options.itemDescription || 'One value in the list.', {
      minLength: options.itemMinLength || 1,
      maxLength: options.itemMaxLength,
      pattern: options.itemPattern,
    }),
    ...(options.minItems ? { minItems: options.minItems } : {}),
    ...(options.maxItems ? { maxItems: options.maxItems } : {}),
  };
}

function objectSchema(properties, required = []) {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

const SCHEMA_OVERRIDES = {
  manage_tasks: objectSchema({
    action: stringField('Task operation. edit changes title/priority/due date; reopen returns a completed task to pending.', { enum: ['add', 'list', 'complete', 'edit', 'reopen', 'assign', 'delete', 'list_assigned_to_me', 'list_assigned_by_me', 'set_task_followup'] }),
    task_title: stringField('Exact task title/description for add or assign, or a distinctive title selector for complete, edit, reopen, or delete.', { maxLength: 2000 }),
    new_title: stringField('Replacement title/description when action is edit.', { maxLength: 2000 }),
    task_id: { type: 'integer', minimum: 1, maximum: 2147483647, description: 'Stable task database ID returned by Ari; never use a display-list position.' },
    task_position: { type: 'integer', minimum: 1, maximum: 10000, description: 'One-based position from the most recently displayed task list; never use this as a stable task ID.' },
    assignee_name: stringField('Saved contact or team member name for assignment.', { maxLength: 200 }),
    due_time: stringField('Due date/time as ISO-8601 or a clear local phrase such as tomorrow at 5pm.', { maxLength: 160 }),
    follow_up_directive: stringField('Assignee follow-up cadence, for example every 4 hours, tomorrow at 5pm, or no.', { maxLength: 300 }),
    priority: stringField('Task priority.', { enum: ['high', 'normal', 'low'] }),
  }, ['action']),
  manage_lists: objectSchema({
    action: stringField('List operation. clear removes every item; clear_completed removes only checked items.', {
      enum: ['create', 'add_item', 'view', 'view_all', 'check_item', 'remove_item', 'clear', 'clear_completed'],
    }),
    list_name: stringField('List name, for example shopping or launch checklist.', { maxLength: 200 }),
    items: stringArray('One or more exact items to add.', { maxItems: 100, itemMaxLength: 1000 }),
    item_text: stringField('Exact or distinctive item text for check_item or remove_item.', { maxLength: 1000 }),
  }, ['action']),
  manage_sales: objectSchema({
    action: stringField('Sales operation. follow_up_email drafts a message; set_follow_up records a due time; update edits CRM profile fields on an existing lead.', {
      enum: ['add_lead', 'move_stage', 'list', 'details', 'update', 'delete', 'archive', 'restore', 'mark_contacted', 'summary', 'cold_email', 'follow_up_email', 'set_follow_up'],
    }),
    lead_name: stringField('Lead name or stable lead ID.', { maxLength: 300 }),
    company: stringField('Company for a new or updated lead.', { maxLength: 300 }),
    email: stringField('Email address for a new or updated lead.', { maxLength: 320 }),
    title: stringField('Job title for update.', { maxLength: 300 }),
    source: stringField('Lead source for update.', { maxLength: 300 }),
    phone: stringField('Phone number for update.', { maxLength: 40 }),
    linkedin_url: stringField('LinkedIn URL for update.', { maxLength: 500 }),
    website: stringField('Website URL for update.', { maxLength: 500 }),
    priority: stringField('Lead priority for update.', { enum: ['high', 'medium', 'low'] }),
    location: stringField('Location for update.', { maxLength: 300 }),
    notes: stringField('Relevant lead context or notes.', { maxLength: 5000 }),
    deal_value: { type: 'number', minimum: 0, maximum: 1000000000000, description: 'Optional numeric deal value.' },
    stage: stringField('Pipeline stage.', { enum: ['new', 'contacted', 'replied', 'meeting', 'proposal', 'negotiation', 'won', 'lost', 'closed_won', 'closed_lost'] }),
    due_time: stringField('Follow-up due time for set_follow_up as ISO-8601 or a clear local phrase.', { maxLength: 160 }),
  }, ['action']),
  manage_team_comms: objectSchema({
    action: stringField('Team workspace operation.', {
      enum: [
        'list_broadcasts', 'broadcast_status',
        'list_one_on_ones', 'schedule_one_on_one', 'cancel_one_on_one',
        'list_onboardings', 'start_onboarding', 'complete_onboarding',
        'member_info', 'set_member_info',
        'invite_link', 'list_chats', 'send_chat_message',
      ],
    }),
    team_name: stringField('Team name; omit when the user has exactly one team.', { maxLength: 100 }),
    member_name: stringField('Exact team member name.', { maxLength: 200 }),
    manager_name: stringField('Exact team member name acting as manager; defaults to the requester.', { maxLength: 200 }),
    due_time: stringField('When the 1:1 happens, ISO-8601 or a clear local phrase.', { maxLength: 160 }),
    cadence_days: { type: 'integer', minimum: 1, maximum: 365, description: 'Repeat interval in days for a recurring 1:1.' },
    agenda: stringField('Agenda or talking points for the 1:1.', { maxLength: 2000 }),
    birthday: stringField('Member birthday as YYYY-MM-DD.', { maxLength: 10, pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    start_date: stringField('Member joining date as YYYY-MM-DD.', { maxLength: 10, pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    notes: stringField('Free-text note about the member.', { maxLength: 2000 }),
    broadcast_id: { type: 'integer', minimum: 1, maximum: 2147483647, description: 'Stable broadcast ID.' },
    one_on_one_id: { type: 'integer', minimum: 1, maximum: 2147483647, description: 'Stable 1:1 ID.' },
    onboarding_id: { type: 'integer', minimum: 1, maximum: 2147483647, description: 'Stable onboarding ID.' },
    chat_id: { type: 'integer', minimum: 1, maximum: 2147483647, description: 'Stable chat thread ID.' },
    chat_name: stringField('Chat thread name when no ID is known.', { maxLength: 200 }),
    message: stringField('Text to post in the chat thread.', { maxLength: 4000 }),
    full_text: stringField('Original message text.', { maxLength: 5000 }),
  }, ['action']),
  get_meeting_recordings: objectSchema({
    action: stringField('Recording operation. retry reprocesses a failed or stuck recording; rename_speaker rebuilds the transcript and report under the new name; create_tasks saves the report suggestions as real tasks.', {
      enum: ['list', 'status', 'retry', 'rename_speaker', 'create_tasks'],
    }),
    meeting_id: {
      type: 'integer', minimum: 1, maximum: 2147483647,
      description: 'Stable recording ID Ari previously showed; never a display-list position.',
    },
    meeting_title: stringField('Distinctive recording title text when no stable ID is known.', { maxLength: 300 }),
    speaker_id: stringField('Diarized speaker label to rename; uppercase letters only.', { maxLength: 8, pattern: '^[A-Z]+$' }),
    speaker_name: stringField('Real name to give that speaker.', { maxLength: 80 }),
    full_text: stringField('Original message text.', { maxLength: 5000 }),
  }, ['action']),
  complete_reminder: objectSchema({
    reminder_id: {
      type: 'integer', minimum: 1, maximum: 2147483647,
      description: 'Stable reminder database ID previously shown by Ari; never a display-list position.',
    },
    position: {
      type: 'integer', minimum: 1, maximum: 10000,
      description: 'One-based position from the most recently displayed reminder list; never a stable reminder ID.',
    },
    query: stringField('Distinctive text from the reminder message.', { maxLength: 2000 }),
    full_text: stringField('Original message text.', { maxLength: 5000 }),
  }, []),
  set_reminder: objectSchema({
    reminder_message: stringField('The task or fact the recipient should be reminded about; do not include the scheduling instruction.', { minLength: 2, maxLength: 2000 }),
    due_time: stringField('When the reminder should fire, as ISO-8601 or an explicit local date/time phrase such as tomorrow at 9am.', { minLength: 2, maxLength: 160 }),
    target_name: stringField('Who receives the reminder. Omit for the current user; set only when the user explicitly asks to remind another person or team.', { maxLength: 200 }),
    target_phone: stringField('Explicit recipient phone number when the user supplied one.', { maxLength: 40 }),
    is_recurring: { type: 'boolean', description: 'Whether the reminder repeats.' },
    recurring_pattern: stringField('Recurrence rule including its time when relevant, for example every Monday at 9am.', { maxLength: 200 }),
  }, ['reminder_message', 'due_time']),
  analyze_file: objectSchema({
    artifact_ids: stringArray('Stable Ari artifact IDs to analyze in this exact order. Omit to analyze every attachment from the current turn; never pass a filesystem path or URL.', {
      minItems: 1,
      maxItems: 10,
      itemDescription: 'An Ari artifact ID such as session:<uuid> or user_file:<id>.',
      itemMaxLength: 80,
      itemPattern: '^(?:session:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|user_file:[1-9][0-9]{0,9})$',
    }),
    question: stringField('The specific question to answer or information to extract from the selected artifacts.', { minLength: 2, maxLength: 2000 }),
    mode: stringField('How the bounded file previews will be used.', { enum: ['summarize', 'extract', 'compare'] }),
  }, ['question']),
  cancel_reminder: objectSchema({
    reminder_id: {
      type: 'integer', minimum: 1, maximum: 2147483647,
      description: 'Stable reminder database ID previously shown by Ari. Never put a numbered-list position in this field.',
    },
    position: {
      type: 'integer', minimum: 1, maximum: 10000,
      description: 'One-based position in the most recently displayed reminder list. Never put a stable reminder ID in this field.',
    },
    query: stringField('Distinctive text from the reminder message when no stable ID or displayed-list position was supplied.', { minLength: 2, maxLength: 300 }),
    reason: stringField('Optional user-provided reason to show in the cancellation confirmation preview.', { maxLength: 500 }),
  }),
  update_reminder: objectSchema({
    reminder_id: {
      type: 'integer', minimum: 1, maximum: 2147483647,
      description: 'Stable reminder database ID previously shown by Ari. Never put a numbered-list position in this field.',
    },
    position: {
      type: 'integer', minimum: 1, maximum: 10000,
      description: 'One-based position in the most recently displayed reminder list. Never put a stable reminder ID in this field.',
    },
    query: stringField('Distinctive text from the reminder message when no stable ID or displayed-list position was supplied.', { minLength: 2, maxLength: 300 }),
    use_last_created: { type: 'boolean', description: 'Set true only when the user explicitly refers to the reminder Ari just created, such as "that reminder" or "the one we just set".' },
    new_time: stringField('New reminder time as ISO-8601 or the exact clear local phrase supplied by the user.', { minLength: 2, maxLength: 160 }),
  }, ['new_time']),
  save_memory: objectSchema({
    fact: stringField('Stable user fact or preference to remember across sessions.', { minLength: 2, maxLength: 2000 }),
    category: stringField('Memory category used for later retrieval.', {
      enum: ['personal', 'work', 'finance', 'health', 'family', 'friends', 'travel', 'vehicle', 'preferences', 'general'],
    }),
    subject: stringField('Entity the fact is about, for example user, Rahul, or Acme. Omit for the user.', { maxLength: 160 }),
    key: stringField('Stable semantic key, for example favorite_color, timezone, company, or birthday.', { maxLength: 160 }),
    supersedes: stringField('Optional older semantic key that this explicit correction replaces.', { maxLength: 160 }),
    valid_until: stringField('Optional ISO-8601 date or timestamp after which this fact must not be recalled.', { maxLength: 80 }),
  }, ['fact']),
  recall_memory: objectSchema({
    action: stringField('Memory operation.', { enum: ['recall', 'show_all', 'show_category', 'forget', 'clear_all'] }),
    query: stringField('Specific fact, preference, subject, or question to retrieve when action is recall.', { maxLength: 1000 }),
    key: stringField('Stable memory key or precise fact selector to remove when action is forget.', { maxLength: 300 }),
    category: stringField('Memory category when action is show_category.', {
      enum: ['personal', 'work', 'finance', 'health', 'family', 'friends', 'travel', 'vehicle', 'preferences', 'general'],
    }),
  }, ['action']),
  delegate_message: objectSchema({
    target_name: stringField('Saved contact, team name, or explicit phone number that should receive the message.', { minLength: 1, maxLength: 200 }),
    message_content: stringField('Exact informational message to show in the confirmation preview before sending.', { minLength: 1, maxLength: 5000 }),
  }, ['target_name', 'message_content']),
  manage_team: objectSchema({
    action: stringField('Team operation.', { enum: ['create', 'add', 'remove', 'list', 'list_teams', 'delete_team'] }),
    team_name: stringField('Named team for create, add, remove, list, or delete_team.', { maxLength: 200 }),
    members: {
      type: 'array',
      description: 'Members to add or remove. Resolve pronouns to explicit names from conversation context.',
      minItems: 1,
      maxItems: 50,
      items: objectSchema({
        name: stringField('Member name.', { minLength: 1, maxLength: 200 }),
        phone: stringField('Optional member phone number with country code.', { maxLength: 40 }),
      }, ['name']),
    },
  }, ['action']),
  send_email: objectSchema({
    recipients: stringArray('Contact names or email addresses that should receive the email.', {
      minItems: 1,
      maxItems: 50,
      itemDescription: 'A saved contact name or a complete email address.',
    }),
    subject: stringField('Concise email subject. Omit only when the user explicitly wants no subject.', { maxLength: 240 }),
    body: stringField('Complete email body to show in the confirmation preview before sending.', { minLength: 1, maxLength: 20000 }),
    attachment_ids: stringArray('Optional uploaded artifact IDs to attach. Use IDs returned by file ingestion; never pass a path or URL.', {
      maxItems: 10,
      itemMaxLength: 80,
      itemPattern: ARTIFACT_ID_PATTERN,
    }),
  }, ['recipients', 'body']),
  create_calendar_event: objectSchema({
    title: stringField('Event title visible on the calendar and invitations.', { minLength: 1, maxLength: 240 }),
    start_time: stringField('Event start as an ISO-8601 timestamp or an explicit local date/time phrase.', { minLength: 3, maxLength: 120 }),
    end_time: stringField('Optional event end as an ISO-8601 timestamp or explicit local date/time phrase.', { maxLength: 120 }),
    duration_minutes: { type: 'integer', minimum: 5, maximum: 1440, description: 'Duration in minutes when end_time was not supplied.' },
    attendees: stringArray('Optional saved contact names or email addresses to invite.', { maxItems: 100 }),
    location: stringField('Optional physical location or meeting URL.', { maxLength: 500 }),
    description: stringField('Optional agenda or event notes.', { maxLength: 10000 }),
    calendar_id: stringField('Optional calendar identifier accessible to the connected account. Omit to use the configured default calendar.', { maxLength: 300 }),
    timezone: stringField('IANA timezone for local date/time values, for example Asia/Kolkata.', { maxLength: 100 }),
  }, ['title', 'start_time']),
  cancel_calendar_event: objectSchema({
    event: stringField('Stable event ID or exact upcoming event title on the configured default calendar.', { minLength: 1, maxLength: 500 }),
    reason: stringField('Optional cancellation reason to show in the confirmation preview.', { maxLength: 1000 }),
  }, ['event']),
  reschedule_calendar_event: objectSchema({
    event: stringField('Stable event ID or exact upcoming event title on the configured default calendar.', { minLength: 1, maxLength: 500 }),
    new_start_time: stringField('New start as ISO-8601 or an explicit local date/time phrase.', { minLength: 3, maxLength: 120 }),
    new_end_time: stringField('Optional new end as ISO-8601 or an explicit local date/time phrase.', { maxLength: 120 }),
    duration_minutes: { type: 'integer', minimum: 5, maximum: 1440, description: 'New duration when new_end_time was not supplied.' },
    timezone: stringField('IANA timezone used for local date/time phrases.', { maxLength: 100 }),
  }, ['event', 'new_start_time']),
  view_calendar: objectSchema({
    start_time: stringField('Beginning of the requested range as ISO-8601 or a clear local date/time phrase.', { maxLength: 120 }),
    end_time: stringField('End of the requested range as ISO-8601 or a clear local date/time phrase.', { maxLength: 120 }),
    query: stringField('Optional Google Calendar free-text query over event content.', { maxLength: 300 }),
    calendar_id: stringField('Optional connected calendar identifier. Omit to use the configured default calendar.', { maxLength: 300 }),
    timezone: stringField('IANA timezone used for local range phrases and result formatting.', { maxLength: 100 }),
    limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Maximum number of matching events to return.' },
  }),
  email_calendar_attendees: objectSchema({
    event: stringField('Stable event ID or exact upcoming event title on the configured default calendar whose attendees should receive the email.', { minLength: 1, maxLength: 500 }),
    subject: stringField('Optional email subject. Omit to derive it from the event title.', { maxLength: 240 }),
    body: stringField('Complete message body to show in the confirmation preview.', { minLength: 1, maxLength: 20000 }),
  }, ['event', 'body']),
  handle_calendar_confirmation: objectSchema({
    decision: stringField('Decision for the active calendar confirmation.', { enum: ['confirm', 'reject', 'edit'] }),
    requested_change: stringField('Requested correction when decision is edit.', { maxLength: 2000 }),
  }, ['decision']),
  schedule_email: objectSchema({
    action: stringField('Scheduled-email operation. Omit for send (the default).', { enum: ['send', 'list', 'cancel'] }),
    scheduled_email_id: { type: 'integer', minimum: 1, maximum: 2147483647, description: 'Stable scheduled-email ID to cancel; only use an ID Ari displayed.' },
    recipients: stringArray('Contact names or email addresses that should receive the scheduled email.', { minItems: 1, maxItems: 50 }),
    subject: stringField('Optional email subject.', { maxLength: 240 }),
    body: stringField('Complete scheduled email body to show before approval.', { minLength: 1, maxLength: 20000 }),
    send_at: stringField('Future delivery time as ISO-8601 or an explicit local date/time phrase.', { minLength: 3, maxLength: 120 }),
    timezone: stringField('IANA timezone used for a local send_at value.', { maxLength: 100 }),
    attachment_ids: stringArray('Optional uploaded artifact IDs to attach; never pass a path or URL.', {
      maxItems: 10,
      itemMaxLength: 80,
      itemPattern: ARTIFACT_ID_PATTERN,
    }),
  }, []),
  bulk_email: objectSchema({
    recipients: stringArray('Two or more contact names or email addresses for the bulk email.', { minItems: 2, maxItems: 500 }),
    subject: stringField('Optional shared email subject.', { maxLength: 240 }),
    body: stringField('Complete shared or templated email body to preview before sending.', { minLength: 1, maxLength: 20000 }),
    send_at: stringField('Optional future delivery time. Omit to prepare an immediate send.', { maxLength: 120 }),
    timezone: stringField('IANA timezone used when send_at is a local date/time phrase.', { maxLength: 100 }),
    personalize: { type: 'boolean', description: 'Whether supported recipient placeholders should be personalized.' },
    attachment_ids: stringArray('Optional uploaded artifact IDs to attach; never pass a path or URL.', {
      maxItems: 10,
      itemMaxLength: 80,
      itemPattern: ARTIFACT_ID_PATTERN,
    }),
  }, ['recipients', 'body']),
  handle_email_confirmation: objectSchema({
    decision: stringField('Decision for the active email confirmation.', { enum: ['confirm', 'reject', 'edit'] }),
    requested_change: stringField('Requested correction when decision is edit.', { maxLength: 5000 }),
  }, ['decision']),
  reuse_recent_email: objectSchema({
    action: stringField('How to reuse the most recently discussed email.', { enum: ['send_now', 'schedule', 'edit', 'change_recipients'] }),
    recipients: stringArray('Replacement contact names or email addresses when changing recipients.', { maxItems: 50 }),
    send_at: stringField('Future delivery time when action is schedule.', { maxLength: 120 }),
    timezone: stringField('IANA timezone used when send_at is a local date/time phrase.', { maxLength: 100 }),
    requested_change: stringField('Requested body or subject change when action is edit.', { maxLength: 5000 }),
  }, ['action']),
  manage_leave: objectSchema({
    action: stringField('Leave operation to perform.', { enum: ['apply', 'balance', 'list', 'approve', 'reject'] }),
    start_date: stringField('First leave date as YYYY-MM-DD or an explicit date phrase.', { maxLength: 80 }),
    end_date: stringField('Last leave date as YYYY-MM-DD or an explicit date phrase.', { maxLength: 80 }),
    leave_type: stringField('Leave type, for example annual, sick, or unpaid.', { maxLength: 100 }),
    reason: stringField('Optional leave reason or approval/rejection note.', { maxLength: 2000 }),
    request_id: stringField('Stable leave request ID for cancel, approve, or reject.', { maxLength: 200 }),
    employee: stringField('Employee name when acting on somebody else\'s request.', { maxLength: 200 }),
  }, ['action']),
  handle_leave_approval: objectSchema({
    decision: stringField('Decision for the active leave request.', { enum: ['approve', 'reject'] }),
  }, ['decision']),
  manage_standup: objectSchema({
    action: stringField('Team standup operation.', { enum: ['setup', 'status', 'results', 'disable'] }),
    team_name: stringField('Team whose standup should be managed.', { maxLength: 200 }),
    check_in_time: stringField('Optional daily check-in time.', { maxLength: 80 }),
    wrap_up_time: stringField('Optional daily wrap-up time.', { maxLength: 80 }),
    timezone: stringField('IANA timezone for standup schedules.', { maxLength: 100 }),
  }, ['action']),
  handle_standup_setup: objectSchema({
    response: stringField('User answer to the currently active standup setup question.', { minLength: 1, maxLength: 2000 }),
  }, ['response']),
  handle_standup_response: objectSchema({
    response: stringField('User answer to the currently active standup check-in or wrap-up question.', { minLength: 1, maxLength: 5000 }),
  }, ['response']),
  manage_polls: objectSchema({
    action: stringField('Poll operation.', { enum: ['create', 'list', 'results', 'close'] }),
    question: stringField('Poll question when creating a poll.', { maxLength: 1000 }),
    options: stringArray('Two or more answer choices when creating a poll.', { maxItems: 20 }),
    team_name: stringField('Optional team that should receive the poll.', { maxLength: 200 }),
    poll_id: stringField('Stable poll ID for results or close operations.', { maxLength: 200 }),
  }, ['action']),
  handle_poll_vote: objectSchema({
    choice: stringField('Selected option number or exact option label for the active poll.', { minLength: 1, maxLength: 500 }),
  }, ['choice']),
  check_team_availability: objectSchema({
    people: stringArray('Team name or individual saved team-member names whose day should be checked.', { minItems: 1, maxItems: 50 }),
    date: stringField('Day to inspect as YYYY-MM-DD or a clear local phrase such as next Monday.', { maxLength: 120 }),
    timezone: stringField('IANA timezone used to display the day and busy periods.', { maxLength: 100 }),
  }, ['people']),
  thread_summary: objectSchema({
    message_count: { type: 'integer', minimum: 2, maximum: 200, description: 'Number of recent messages to summarize.' },
    focus: stringField('Optional topic, decision, action-item, or time-range focus for the summary.', { maxLength: 500 }),
  }),
  scheduled_message: objectSchema({
    recipients: stringArray('Contact names or phone numbers that should receive the scheduled message.', { minItems: 1, maxItems: 50 }),
    message: stringField('Complete message body to show in the confirmation preview.', { minLength: 1, maxLength: 5000 }),
    send_at: stringField('Future delivery time as ISO-8601 or an explicit local date/time phrase.', { minLength: 3, maxLength: 120 }),
    timezone: stringField('IANA timezone used for a local send_at value.', { maxLength: 100 }),
  }, ['recipients', 'message', 'send_at']),
  search_drive: objectSchema({
    query: stringField('File name, content phrase, owner, folder, or * to list recent files.', { minLength: 1, maxLength: 1000 }),
    limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum number of matching Drive items.' },
  }, ['query']),
  manage_docs: objectSchema({
    action: stringField('Google Docs operation.', { enum: ['create', 'read', 'summarize', 'search'] }),
    title: stringField('Document title for create.', { maxLength: 300 }),
    document_id: stringField('Stable Google document ID or URL for read or summarize.', { maxLength: 1000 }),
    query: stringField('Search query for finding documents.', { maxLength: 1000 }),
  }, ['action']),
  manage_sheets: objectSchema({
    action: stringField('Google Sheets operation.', { enum: ['create', 'read', 'summarize', 'search'] }),
    title: stringField('Spreadsheet title for create.', { maxLength: 300 }),
    spreadsheet_id: stringField('Stable spreadsheet ID or URL for read or summarize.', { maxLength: 1000 }),
    query: stringField('Search query for finding a spreadsheet.', { maxLength: 1000 }),
  }, ['action']),
  manage_slides: objectSchema({
    action: stringField('Google Slides operation.', { enum: ['create', 'read', 'summarize', 'search'] }),
    title: stringField('Presentation title for create.', { maxLength: 300 }),
    presentation_id: stringField('Stable presentation ID or URL for read or summarize.', { maxLength: 1000 }),
    query: stringField('Search query for finding presentations.', { maxLength: 1000 }),
  }, ['action']),
  manage_google_tasks: objectSchema({
    action: stringField('Google Tasks operation.', { enum: ['list', 'create', 'complete'] }),
    title: stringField('Task title for create, or distinctive title text for complete.', { maxLength: 500 }),
    task_position: {
      type: 'integer', minimum: 1, maximum: 10000,
      description: 'One-based position from the most recently displayed Google Tasks list, for complete.',
    },
  }, ['action']),
  upload_to_drive: objectSchema({
    artifact_ids: stringArray('One or more uploaded artifact IDs returned by Ari file ingestion; never pass a path or URL.', {
      minItems: 1,
      maxItems: 10,
      itemMaxLength: 80,
      itemPattern: ARTIFACT_ID_PATTERN,
    }),
    rename_to: stringField('Optional new file name when uploading exactly one artifact.', { maxLength: 300 }),
  }, ['artifact_ids']),
  handle_sales_email_confirmation: objectSchema({
    decision: stringField('Decision for the active sales-email confirmation.', { enum: ['confirm', 'reject', 'edit'] }),
    requested_change: stringField('Requested correction when decision is edit.', { maxLength: 5000 }),
  }, ['decision']),
  web_search: objectSchema({
    query: stringField('Specific current-information question or web search query.', { minLength: 2, maxLength: 1000 }),
  }, ['query']),
  link_account: objectSchema({
    action: stringField('Supported account view operation.', { enum: ['dashboard_link', 'list'] }),
  }, ['action']),
  translate_text: objectSchema({
    text: stringField('Exact source text to translate without adding or removing meaning.', { minLength: 1, maxLength: 10000 }),
    target_language: stringField('Requested target language, such as Hindi, English, or fr.', { minLength: 2, maxLength: 80 }),
    source_language: stringField('Optional source language when known.', { maxLength: 80 }),
    preserve_formatting: { type: 'boolean', description: 'Whether line breaks and simple formatting must be preserved.' },
  }, ['text', 'target_language']),
  quick_note_docs: objectSchema({
    content: stringField('Exact note content to append to the Google document.', { minLength: 1, maxLength: 20000 }),
    document_title: stringField('Destination notes-document title. Omit to use the configured default.', { maxLength: 300 }),
    heading: stringField('Optional heading to insert before the note.', { maxLength: 300 }),
  }, ['content']),
};

const DESCRIPTION_OVERRIDES = {
  analyze_file: 'Analyze one or more tenant-owned Ari artifacts by stable artifact ID, or all files attached in the current turn when artifact_ids is omitted. Results are bounded previews with per-file coverage and completion flags, not a lossless bulk-data stream. Use compare for cross-file questions. Never invent or pass local paths or URLs.',
  save_memory: 'Save a durable, non-sensitive user fact or preference that will be useful in later sessions. Never store passwords, access tokens, API keys, financial authentication data, private keys, recovery codes, or other credentials. Use manage_notes for notebook-style content and save_contact for phone numbers.',
  recall_memory: 'Retrieve or remove durable user facts and preferences. Use recall for a specific question, show_all for a broad memory request, show_category for one category, forget for one precise key, and clear_all only when the user explicitly asks to erase all saved memory.',
  manage_google_tasks: 'List, create, or complete items in the user\'s Google Tasks default list. Use only when the user explicitly names Google Tasks; use manage_tasks for Ari\'s tracked tasks. For complete, use task_position for a numbered item from the most recently shown list, or title for distinctive title text.',
  manage_tasks: 'Create, list, complete, assign, delete, or configure follow-ups for Ari tasks. For a numbered item from the most recently shown list use task_position; use task_id only for a stable database ID Ari actually returned. A distinctive task_title may select a task by name. Assignments notify another person and require confirmation.',
  cancel_reminder: 'Cancel exactly one pending reminder. Use reminder_id only for a stable ID Ari returned, position only for a one-based item in the most recently displayed reminder list, or query for distinctive reminder text. Never guess or reuse one selector type as another.',
  complete_reminder: 'Mark exactly one pending reminder as done because the user already completed it. Use reminder_id only for a stable ID Ari returned, position only for a one-based item in the most recently displayed reminder list, or query for distinctive reminder text. Never guess; this does not cancel a reminder the user no longer wants.',
  update_reminder: 'Change the time of exactly one pending reminder. Use reminder_id only for a stable ID Ari returned, position only for a one-based item in the most recently displayed reminder list, query for distinctive reminder text, or use_last_created=true for an explicit reference to the reminder Ari just created.',
  manage_follow_ups: 'Create, list, complete, or delete personal follow-ups. For create, preserve any supplied date or time in due_time; use follow_up_id only for stable IDs shown by Ari when completing or deleting.',
  link_account: 'Create a one-time login link for the Ari web dashboard, or list the user\'s connected Google, Microsoft, and Apple accounts. Cross-platform messaging links, unlinking, notification routing, and link-code entry are not supported.',
  search_drive: 'Search or list files visible through the connected Google Drive integration. Use query="*" for recent files and limit to bound the result count. Use upload_to_drive for uploaded Ari artifacts; this tool only reads Drive metadata.',
};

const OPERATION_REQUIRED_FIELDS = Object.freeze({
  manage_contacts: {
    get: ['name'], delete: ['name'], update: ['name', 'phone'],
  },
  manage_images: {
    search: ['search_query'], delete: ['search_query'], select_number: ['number'],
  },
  save_image: { save_with_title: ['title'] },
  manage_tasks: {
    add: ['task_title'], assign: ['assignee_name'],
    set_task_followup: ['task_id', 'follow_up_directive'],
  },
  manage_notes: {
    save: ['note_content'], list_topic: ['topic'], search: ['search_query'],
    delete_note: ['note_id'], delete_topic: ['topic'], view: ['topic'],
  },
  manage_lists: {
    create: ['list_name'], add_item: ['list_name'], view: ['list_name'],
    check_item: ['list_name', 'item_text'], remove_item: ['list_name', 'item_text'],
    clear: ['list_name'], clear_completed: ['list_name'],
  },
  manage_docs: {
    create: ['title'], read: ['document_id'], summarize: ['document_id'], search: ['query'],
  },
  manage_sheets: {
    create: ['title'], read: ['spreadsheet_id'], summarize: ['spreadsheet_id'], search: ['query'],
  },
  manage_slides: {
    create: ['title'], read: ['presentation_id'], summarize: ['presentation_id'], search: ['query'],
  },
  manage_google_tasks: { create: ['title'] },
  manage_sales: {
    add_lead: ['lead_name'], move_stage: ['lead_name', 'stage'], details: ['lead_name'],
    update: ['lead_name'], delete: ['lead_name'], cold_email: ['lead_name'],
    archive: ['lead_name'], restore: ['lead_name'], mark_contacted: ['lead_name'],
    follow_up_email: ['lead_name'], set_follow_up: ['lead_name', 'due_time'],
  },
  manage_team_comms: {
    schedule_one_on_one: ['member_name', 'due_time'],
    cancel_one_on_one: ['one_on_one_id'],
    start_onboarding: ['member_name'],
    complete_onboarding: ['onboarding_id'],
    set_member_info: ['member_name'],
    send_chat_message: ['message'],
  },
  get_meeting_recordings: {
    // rename_speaker also needs a recording, but either selector works — that
    // pairing is enforced below alongside retry/create_tasks.
    rename_speaker: ['speaker_id', 'speaker_name'],
  },
  manage_contact_groups: {
    create: ['group_name'], add_members: ['group_name', 'member_names'],
    remove_members: ['group_name', 'member_names'],
    rename: ['group_name', 'new_name'], set_emoji: ['group_name', 'emoji'],
    archive: ['group_name'], restore: ['group_name'],
  },
  schedule_email: {
    // send keeps the original guarantee: nothing is scheduled without a
    // recipient, a body, and an explicit time.
    send: ['recipients', 'body', 'send_at'],
    cancel: ['scheduled_email_id'],
  },
  manage_campaigns: {
    create_draft: ['group_name'], compose: ['purpose'],
    start: ['campaign_id'], pause: ['campaign_id'], resume: ['campaign_id'],
    archive: ['campaign_id'], restore: ['campaign_id'], delete: ['campaign_id'],
  },
  manage_habits: {
    create: ['habit_name'], log: ['habit_name'], delete: ['habit_name'],
  },
  manage_expenses: {
    log: ['amount'], update_by_category: ['category', 'new_amount'],
    update_by_id: ['expense_id', 'new_amount'], delete: ['expense_id'], multi_log: ['items'],
  },
  manage_follow_ups: {
    create: ['subject'], complete: ['follow_up_id'], delete: ['follow_up_id'],
  },
  manage_reading_list: {
    save: ['url'], delete: ['item_id'], mark_read: ['item_id'], search: ['search_query'],
  },
  manage_shared_board: {
    create_board: ['board_name'], add_task: ['board_name', 'task_title'], status: ['board_name'],
    assign: ['task_id', 'assignee_name'], complete: ['task_id'], move: ['task_id', 'target_column'],
    start: ['task_id'], delete_board: ['board_name'], delete_task: ['task_id'],
  },
  manage_knowledge_base: {
    add: ['title', 'content'], search: ['search_query'], delete: ['article_id'],
  },
  manage_sprints: {
    create: ['sprint_name'], add_item: ['item_title'], complete_item: ['item_id'],
  },
  manage_incidents: {
    report: ['title'], resolve: ['incident_id'], assign: ['incident_id', 'assignee_name'],
    escalate: ['incident_id'],
  },
});

const POSITIVE_FIELDS_BY_OPERATION = Object.freeze({
  'manage_images:select_number': ['number'],
  'manage_tasks:set_task_followup': ['task_id'],
  'manage_notes:delete_note': ['note_id'],
  'manage_expenses:log': ['amount'],
  'manage_expenses:update_by_category': ['new_amount'],
  'manage_expenses:update_by_id': ['expense_id', 'new_amount'],
  'manage_expenses:delete': ['expense_id'],
  'manage_follow_ups:complete': ['follow_up_id'],
  'manage_follow_ups:delete': ['follow_up_id'],
  'manage_reading_list:delete': ['item_id'],
  'manage_reading_list:mark_read': ['item_id'],
  'manage_shared_board:assign': ['task_id'],
  'manage_shared_board:complete': ['task_id'],
  'manage_shared_board:move': ['task_id'],
  'manage_shared_board:start': ['task_id'],
  'manage_shared_board:delete_task': ['task_id'],
  'manage_knowledge_base:delete': ['article_id'],
  'manage_sprints:complete_item': ['item_id'],
  'manage_incidents:resolve': ['incident_id'],
  'manage_incidents:assign': ['incident_id'],
  'manage_incidents:escalate': ['incident_id'],
});

function fieldDescription(name) {
  return `Resolved value for ${String(name).replace(/_/g, ' ')}.`;
}

function normalizeSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map((entry) => normalizeSchema(entry));

  const normalized = { ...schema };
  if (normalized.type === 'object' || normalized.properties) {
    normalized.type = 'object';
    normalized.additionalProperties = false;
    normalized.properties = Object.fromEntries(
      Object.entries(normalized.properties || {})
        .filter(([name]) => name !== 'full_text')
        .map(([name, value]) => {
          const property = normalizeSchema(value) || {};
          return [name, property.description
            ? property
            : { ...property, description: fieldDescription(name) }];
        })
    );
    normalized.required = [...new Set((normalized.required || [])
      .filter((name) => name !== 'full_text' && Object.hasOwn(normalized.properties, name)))];
  }
  if (normalized.items) normalized.items = normalizeSchema(normalized.items);
  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    if (Array.isArray(normalized[keyword])) {
      normalized[keyword] = normalized[keyword].map((entry) => normalizeSchema(entry));
    }
  }
  return normalized;
}

function cleanDescription(name, description) {
  let value = String(description || '').replace(/\s+/g, ' ').trim();
  value = value.replace(/★/g, '').replace(/\s{2,}/g, ' ');
  if (value.length > 880) value = `${value.slice(0, 877).trimEnd()}...`;
  if (value.length < 32) {
    value = `${value || name.replace(/_/g, ' ')}. Use this Ari business capability only when it directly matches the user's requested outcome.`;
  }
  return value;
}

function staticEffect(name) {
  if (READ_TOOLS.has(name)) return 'read';
  if (EXTERNAL_WRITE_TOOLS.has(name)) return 'external_write';
  if (DESTRUCTIVE_TOOLS.has(name)) return 'destructive';
  if (MIXED_TOOLS.has(name)) return 'mixed';
  return 'reversible_write';
}

function effectForArgs(name, args = {}) {
  const action = String(args.action || '').toLowerCase();
  const readActions = new Set([
    'availability', 'balance', 'categories', 'comparison', 'details', 'get', 'health', 'history',
    'last', 'list', 'list_assigned_by_me', 'list_assigned_to_me', 'list_boards', 'list_topic',
    'list_teams', 'overview', 'read', 'results', 'search', 'select_number', 'show', 'show_all',
    'show_category', 'stats', 'status', 'summary', 'summarize', 'team_status', 'today',
    'velocity', 'view', 'view_all', 'weekly_reflection', 'workload',
  ]);
  const externalActions = new Set(['assign', 'escalate', 'cold_email', 'follow_up_email']);
  const destructiveActions = new Set([
    'cancel', 'clear', 'clear_all', 'clear_completed', 'close', 'delete', 'delete_board', 'delete_contact',
    'delete_note', 'delete_task', 'delete_team', 'delete_topic', 'disconnect',
    'disable', 'forget', 'remove', 'remove_item', 'unlink',
  ]);

  if (name === 'set_reminder') {
    const target = String(args.target_name || '').trim().toLowerCase();
    if (args.target_phone || (target && !['me', 'myself', 'self', 'user'].includes(target))) {
      return 'external_write';
    }
    return 'reversible_write';
  }
  // Starting a campaign sends real email to every member of a group — it is
  // an external write and must pass the confirmation gate, even though the
  // other campaign actions only touch local rows.
  // The team workspace is mostly local rows, but posting into a chat thread
  // puts words in the user's mouth in front of their team — that gets the same
  // confirmation treatment as any other message sent on their behalf.
  if (name === 'manage_team_comms') {
    if (action === 'send_chat_message') return 'external_write';
    if (['list_broadcasts', 'broadcast_status', 'list_one_on_ones', 'list_onboardings',
      'member_info', 'list_chats'].includes(action)) return 'read';
  }
  if (name === 'manage_campaigns' && action === 'start') return 'external_write';
  if (name === 'manage_polls' && action === 'create') return 'external_write';
  if (name === 'manage_standup' && action === 'setup') return 'external_write';
  if (name === 'manage_leave' && ['apply', 'approve', 'reject'].includes(action)) return 'external_write';
  if (name === 'manage_sprints' && action === 'end') return 'destructive';
  if (readActions.has(action)) return 'read';
  if (externalActions.has(action)) return 'external_write';
  if (destructiveActions.has(action)) return 'destructive';
  const base = staticEffect(name);
  return base === 'mixed' ? 'reversible_write' : base;
}

function confirmationModeForTool(name, args = {}) {
  const effect = effectForArgs(name, args);
  if (!['external_write', 'destructive'].includes(effect)) return 'none';
  if (CONFIRMATION_RESOLUTION_TOOLS.has(name)) return 'none';
  // Let the handler ask for missing task details before presenting a safety
  // preview; a vague assignment cannot be meaningfully approved yet.
  if (name === 'manage_tasks'
    && String(args.action || '').toLowerCase() === 'assign'
    && (!args.task_title || !args.assignee_name)) return 'none';
  if (name === 'manage_polls' && String(args.action || '').toLowerCase() === 'create') return 'workflow';
  if (WORKFLOW_CONFIRMATION_TOOLS.has(name)) return 'workflow';
  if (name === 'manage_sales' && ['cold_email', 'follow_up_email'].includes(String(args.action || '').toLowerCase())) return 'workflow';
  return 'central';
}

function renderConfirmationPreview(name, args = {}) {
  const fields = Object.entries(args)
    .filter(([key, value]) => value !== undefined && value !== null && value !== ''
      && !/(password|token|secret|credential|api[_-]?key)/i.test(key))
    .map(([key, value]) => {
      const rendered = Array.isArray(value) ? value.join(', ')
        : typeof value === 'object' ? JSON.stringify(value) : String(value);
      return `${key.replace(/_/g, ' ')}: ${rendered.slice(0, 320)}`;
    });
  return `${name.replace(/_/g, ' ')}\n${fields.join('\n')}`.trim().slice(0, 1200);
}

function renderEmail(args) {
  const to = args.recipients.join(', ');
  const subject = args.subject ? ` Subject: ${args.subject}.` : '';
  const attachments = args.attachment_ids?.length
    ? ` Attach uploaded artifacts: ${args.attachment_ids.join(', ')}.` : '';
  return `Draft an email to ${to}.${subject} Body: ${args.body}${attachments}`;
}

function renderCalendarCreate(args) {
  const ending = args.end_time
    ? ` until ${args.end_time}`
    : args.duration_minutes ? ` for ${args.duration_minutes} minutes` : '';
  const attendees = args.attendees?.length ? ` Invite ${args.attendees.join(', ')}.` : '';
  const location = args.location ? ` Location: ${args.location}.` : '';
  const details = args.description ? ` Description: ${args.description}.` : '';
  return `Schedule calendar event "${args.title}" at ${args.start_time}${ending}.${attendees}${location}${details}`;
}

function renderCalendarView(args, originalText) {
  const range = args.start_time || args.end_time
    ? ` from ${args.start_time || 'the beginning'} to ${args.end_time || 'the end of the requested period'}`
    : '';
  const query = args.query ? ` matching "${args.query}"` : '';
  return `Show my calendar${range}${query}. ${String(originalText || '').trim()}`.trim();
}

function defaultMessageText(name, args, originalText) {
  const original = String(originalText || '').trim();
  const fields = Object.entries(args || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key.replace(/_/g, ' ')}: ${Array.isArray(value) ? value.join(', ') : value}`);
  const structured = `${name.replace(/_/g, ' ')}${fields.length ? `. ${fields.join('. ')}` : ''}`;
  return original && fields.length > 0
    ? `${structured}. Original request: ${original}`
    : original || structured;
}

function renderMessage(name, args, originalText) {
  if (name === 'set_reminder') {
    const target = args.target_name || args.target_phone;
    const recurrence = args.is_recurring && args.recurring_pattern
      ? `, repeating ${args.recurring_pattern}` : '';
    return `Remind ${target ? `${target} ` : 'me '}at ${args.due_time}${recurrence} to ${args.reminder_message}`;
  }
  if (name === 'send_email') return renderEmail(args);
  if (name === 'create_calendar_event') return renderCalendarCreate(args);
  if (name === 'view_calendar') return renderCalendarView(args, originalText);
  if (name === 'web_search') return `Search the web for: ${args.query}`;
  if (name === 'translate_text') {
    return `Translate the following text${args.source_language ? ` from ${args.source_language}` : ''} to ${args.target_language}: ${args.text}`;
  }
  if (['handle_calendar_confirmation', 'handle_email_confirmation', 'handle_sales_email_confirmation'].includes(name)) {
    if (args.decision === 'confirm') return 'yes';
    if (args.decision === 'reject') return 'no';
    return args.requested_change ? `edit: ${args.requested_change}` : 'edit';
  }
  if (name === 'handle_leave_approval') return args.decision;
  if (name === 'handle_poll_vote') return args.choice;
  if (name === 'handle_standup_setup' || name === 'handle_standup_response') return args.response;
  if (name === 'scheduled_message') {
    return `send message to ${args.recipients.join(', ')} at ${args.send_at}: ${args.message}`;
  }
  return defaultMessageText(name, args, originalText);
}

let cachedContracts = null;

function buildContracts() {
  return getToolDefinitions().map(({ function: definition }) => {
    const inputSchema = normalizeSchema(
      SCHEMA_OVERRIDES[definition.name]
        || definition.parameters
        || objectSchema({})
    );
    const effect = staticEffect(definition.name);
    if (!EFFECTS.has(effect)) throw new Error(`Invalid effect for ${definition.name}: ${effect}`);
    return Object.freeze({
      name: definition.name,
      description: cleanDescription(
        definition.name,
        DESCRIPTION_OVERRIDES[definition.name] || definition.description,
      ),
      inputSchema: Object.freeze(inputSchema),
      domain: DOMAIN_BY_TOOL.get(definition.name) || 'general',
      effect,
    });
  });
}

function listAgentToolContracts() {
  cachedContracts ||= buildContracts();
  return cachedContracts.map((contract) => ({
    ...contract,
    inputSchema: structuredClone(contract.inputSchema),
  }));
}

function getAgentToolContract(name) {
  cachedContracts ||= buildContracts();
  const contract = cachedContracts.find((entry) => entry.name === name);
  if (!contract) return null;
  return { ...contract, inputSchema: structuredClone(contract.inputSchema) };
}

function validationFailure(message, issues = []) {
  const error = new Error(message);
  error.issues = issues;
  return { success: false, error };
}

function validateAgentToolArguments(name, args) {
  const contract = getAgentToolContract(name);
  if (!contract) return validationFailure(`Unknown Ari tool: ${name}`);
  try {
    const schema = z.fromJSONSchema(contract.inputSchema);
    const parsed = schema.safeParse(args || {});
    if (parsed.success) {
      const issue = validateOperationRequirements(name, parsed.data);
      if (issue) return validationFailure(issue, [{ code: 'custom', message: issue }]);
      return parsed;
    }
    return validationFailure(parsed.error.message, parsed.error.issues);
  } catch (error) {
    return validationFailure(`Invalid schema for ${name}: ${error.message}`);
  }
}

function validateOperationRequirements(name, args) {
  const action = String(args?.action || '').toLowerCase();
  const requireFields = (fields, label = action || name) => {
    const missing = fields.filter((field) => {
      const value = args?.[field];
      return value === undefined || value === null
        || (typeof value === 'string' && value.trim() === '')
        || (Array.isArray(value) && value.length === 0);
    });
    return missing.length ? `${name} action ${label} requires: ${missing.join(', ')}` : null;
  };

  // "I called Acme this morning" is an interaction report, not a profile edit.
  // Filing it through update parks the text in notes and leaves
  // last_contacted_at null, so the CRM's "last contact" column never fills in
  // however often the user reports talking to someone. mark_contacted takes
  // notes too, so nothing is lost by redirecting. Scoped to the exact shape of
  // the mistake: an update whose ONLY field is notes that read as a past
  // interaction. "Update Acme's notes: wants a discount" is untouched.
  if (name === 'manage_sales' && action === 'update') {
    const editableFields = ['email', 'company', 'title', 'source', 'phone',
      'linkedin_url', 'website', 'priority', 'location', 'deal_value', 'stage'];
    const onlyNotes = Boolean(String(args?.notes || '').trim())
      && !editableFields.some((field) => args?.[field] !== undefined && args[field] !== null && args[field] !== '');
    const readsAsInteraction = /\b(?:called|spoke|talked|met|emailed|messaged|rang|reached out|caught up|followed up|checked in|had a call|got off)\b/i
      .test(String(args?.notes || ''));
    if (onlyNotes && readsAsInteraction) {
      return 'manage_sales update only edits profile fields and leaves last_contacted_at untouched. '
        + 'This is a report of an interaction that already happened, so use action=mark_contacted '
        + '(it accepts the same notes and stamps the last-contacted date).';
    }
  }

  // "Draft a campaign for the investors" means CREATE a campaign. compose only
  // writes copy and persists nothing, so answering that request with compose
  // leaves the user holding text and no campaign — and they cannot tell from
  // the reply. Sharpening the descriptions did not move the model off compose
  // in three consecutive runs, so make it a rule: naming a group means
  // create_draft. Composing copy for an existing campaign is still allowed.
  if (name === 'manage_campaigns' && action === 'compose'
    && String(args?.group_name || '').trim() && !args?.campaign_id) {
    return 'manage_campaigns compose only writes copy and saves nothing. '
      + 'The user named a recipient group, so use action=create_draft to create the campaign '
      + '(pass group_name, and subject/body if you have them).';
  }

  // Every recording write targets exactly one recording. Without a selector
  // the handler would have to guess, and reprocessing or renaming the wrong
  // meeting rewrites a transcript the user did not ask about.
  if (name === 'get_meeting_recordings'
    && ['retry', 'rename_speaker', 'create_tasks'].includes(action)) {
    const hasId = args?.meeting_id !== undefined && args?.meeting_id !== null;
    const hasTitle = Boolean(String(args?.meeting_title || '').trim());
    if (!hasId && !hasTitle) {
      return `get_meeting_recordings action ${action} requires: meeting_id or meeting_title`;
    }
  }

  if (name === 'cancel_reminder' || name === 'update_reminder' || name === 'complete_reminder') {
    const selectors = [
      args?.reminder_id !== undefined && args?.reminder_id !== null,
      args?.position !== undefined && args?.position !== null,
      Boolean(String(args?.query || '').trim()),
      name === 'update_reminder' && args?.use_last_created === true,
    ].filter(Boolean).length;
    if (selectors !== 1) {
      const allowed = name === 'update_reminder'
        ? 'reminder_id, position, query, or use_last_created=true'
        : 'reminder_id, position, or query';
      return `${name} requires exactly one selector: ${allowed}`;
    }
  }

  // schedule_email's action is optional (omitting it means "send"), so an
  // absent action must still enforce the send requirements — otherwise a call
  // with no recipients or body would slip through unvalidated.
  const effectiveAction = (!action && name === 'schedule_email') ? 'send' : action;
  const operationRequired = OPERATION_REQUIRED_FIELDS[name]?.[effectiveAction];
  if (operationRequired) {
    const missing = requireFields(operationRequired);
    if (missing) return missing;
  }

  const positiveFields = POSITIVE_FIELDS_BY_OPERATION[`${name}:${action}`] || [];
  for (const field of positiveFields) {
    if (!Number.isFinite(Number(args?.[field])) || Number(args[field]) <= 0) {
      return `${name} action ${action} requires positive ${field}`;
    }
  }

  if (name === 'manage_lists' && action === 'add_item'
    && (!Array.isArray(args.items) || args.items.length === 0)
    && !String(args.item_text || '').trim()) {
    return 'manage_lists action add_item requires items or item_text';
  }
  if (name === 'manage_tasks' && ['complete', 'edit', 'reopen', 'delete'].includes(action)) {
    if (args.task_id !== undefined && (!Number.isFinite(Number(args.task_id)) || Number(args.task_id) <= 0)) {
      return `manage_tasks action ${action} requires a positive task_id`;
    }
    if (args.task_position !== undefined && (!Number.isFinite(Number(args.task_position)) || Number(args.task_position) <= 0)) {
      return `manage_tasks action ${action} requires a positive task_position`;
    }
    if (args.task_id === undefined && args.task_position === undefined && !String(args.task_title || '').trim()) {
      return `manage_tasks action ${action} requires task_id, task_position, or task_title`;
    }
  }
  if (name === 'manage_contact_groups' && action === 'delete'
    && !String(args.group_name || '').trim() && args.delete_all !== true) {
    return 'manage_contact_groups action delete requires group_name or delete_all';
  }
  if (name === 'manage_expenses' && action === 'multi_log') {
    if (!Array.isArray(args.items) || args.items.length < 2) {
      return 'manage_expenses action multi_log requires at least two items';
    }
    if (args.items.some((item) => !Number.isFinite(Number(item?.amount)) || Number(item.amount) <= 0)) {
      return 'manage_expenses action multi_log requires a positive amount for every item';
    }
  }
  if (name === 'manage_knowledge_base' && action === 'show'
    && !(Number(args.article_id) > 0) && !String(args.title || '').trim()) {
    return 'manage_knowledge_base action show requires article_id or title';
  }

  if (name === 'recall_memory') {
    if (action === 'recall') return requireFields(['query']);
    if (action === 'show_category') return requireFields(['category']);
    if (action === 'forget') return requireFields(['key']);
  }
  if (name === 'manage_team') {
    if (['create', 'add', 'remove', 'list', 'delete_team'].includes(action)) {
      const missing = requireFields(['team_name']);
      if (missing) return missing;
    }
    if (['add', 'remove'].includes(action)) return requireFields(['members']);
  }
  if (name === 'manage_leave') {
    if (action === 'apply') return requireFields(['start_date', 'end_date', 'leave_type']);
    if (['approve', 'reject'].includes(action) && !args.request_id && !args.employee) {
      return `${name} action ${action} requires request_id or employee`;
    }
  }
  if (name === 'reuse_recent_email') {
    if (action === 'schedule') return requireFields(['send_at']);
    if (action === 'edit') return requireFields(['requested_change']);
    if (action === 'change_recipients') return requireFields(['recipients']);
  }
  if (name === 'manage_polls') {
    if (action === 'create') {
      const missing = requireFields(['question', 'options']);
      if (missing) return missing;
      if (args.options.length < 2) return 'manage_polls action create requires at least two options';
    }
    if (['results', 'close'].includes(action)) return requireFields(['poll_id']);
  }
  return null;
}

function prepareAgentToolInvocation(name, args, options = {}) {
  const contract = getAgentToolContract(name);
  const validation = validateAgentToolArguments(name, args);
  if (!contract || !validation.success) {
    return {
      name,
      validation,
      effect: contract?.effect || null,
      requiresConfirmation: false,
      handlerArgs: null,
      messageText: null,
    };
  }

  const effect = effectForArgs(name, validation.data);
  const confirmationMode = confirmationModeForTool(name, validation.data);
  const messageText = renderMessage(name, validation.data, options.originalText);
  return {
    name,
    validation,
    effect,
    confirmationMode,
    requiresConfirmation: confirmationMode !== 'none',
    handlerArgs: { ...validation.data, full_text: messageText },
    messageText,
  };
}

module.exports = {
  confirmationModeForTool,
  effectForArgs,
  getAgentToolContract,
  listAgentToolContracts,
  prepareAgentToolInvocation,
  renderConfirmationPreview,
  validateAgentToolArguments,
};
