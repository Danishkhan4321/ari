'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getToolDefinitions } = require('../src/services/tool-definitions');
const {
  getAgentToolContract,
  listAgentToolContracts,
  prepareAgentToolInvocation,
  validateAgentToolArguments,
} = require('../src/services/agent-tool-contracts.service');

test('canonical agent catalog covers every business tool with strict model-facing schemas', () => {
  const legacyNames = getToolDefinitions().map((entry) => entry.function.name).sort();
  const contracts = listAgentToolContracts();

  assert.deepEqual(contracts.map((entry) => entry.name).sort(), legacyNames);
  assert.equal(new Set(contracts.map((entry) => entry.name)).size, contracts.length);

  for (const contract of contracts) {
    assert.match(contract.description, /\S.{30,}/, `${contract.name} needs useful selection guidance`);
    assert.ok(contract.description.length <= 900, `${contract.name} description is too large for tool selection`);
    assert.ok(['read', 'reversible_write', 'external_write', 'destructive', 'mixed'].includes(contract.effect));
    assert.match(contract.domain, /^[a-z][a-z0-9_]*$/);
    assert.equal(contract.inputSchema.type, 'object');
    assert.equal(contract.inputSchema.additionalProperties, false);
    assert.equal(Object.hasOwn(contract.inputSchema.properties || {}, 'full_text'), false,
      `${contract.name} must not ask the model to echo/rewrite the original sentence`);

    for (const [field, schema] of Object.entries(contract.inputSchema.properties || {})) {
      assert.match(schema.description || '', /\S.{8,}/, `${contract.name}.${field} needs a field description`);
    }
    for (const required of contract.inputSchema.required || []) {
      assert.ok(Object.hasOwn(contract.inputSchema.properties || {}, required),
        `${contract.name} requires an undeclared field: ${required}`);
    }
  }
});

test('high-value natural-language tools expose business arguments instead of full_text', () => {
  const reminder = getAgentToolContract('set_reminder');
  assert.deepEqual(reminder.inputSchema.required, ['reminder_message', 'due_time']);
  assert.equal(reminder.inputSchema.properties.due_time.type, 'string');

  const email = getAgentToolContract('send_email');
  assert.deepEqual(email.inputSchema.required, ['recipients', 'body']);
  assert.equal(email.inputSchema.properties.recipients.type, 'array');
  assert.equal(email.effect, 'external_write');

  const calendar = getAgentToolContract('create_calendar_event');
  assert.deepEqual(calendar.inputSchema.required, ['title', 'start_time']);
  assert.equal(calendar.inputSchema.properties.attendees.type, 'array');

  const search = getAgentToolContract('web_search');
  assert.deepEqual(search.inputSchema.required, ['query']);

  const translate = getAgentToolContract('translate_text');
  assert.deepEqual(translate.inputSchema.required, ['text', 'target_language']);

  const recall = getAgentToolContract('recall_memory');
  assert.equal(recall.inputSchema.properties.query.type, 'string');
  assert.equal(recall.inputSchema.properties.key.type, 'string');

  const memory = getAgentToolContract('save_memory');
  assert.match(memory.description, /never store.*password/i);
  assert.doesNotMatch(memory.description, /wifi password is/i);
});

test('legacy text-only features now have explicit model-facing fields', () => {
  const expected = {
    cancel_reminder: { fields: ['reminder_id', 'position', 'query', 'reason'], required: [] },
    update_reminder: { fields: ['reminder_id', 'position', 'query', 'use_last_created', 'new_time'], required: ['new_time'] },
    save_memory: { fields: ['fact', 'category'], required: ['fact'] },
    create_calendar_event: { fields: ['title', 'start_time', 'attendees'], required: ['title', 'start_time'] },
    cancel_calendar_event: { fields: ['event'], required: ['event'] },
    reschedule_calendar_event: { fields: ['event', 'new_start_time'], required: ['event', 'new_start_time'] },
    view_calendar: { fields: ['start_time', 'end_time', 'query'], required: [] },
    email_calendar_attendees: { fields: ['event', 'subject', 'body'], required: ['event', 'body'] },
    handle_calendar_confirmation: { fields: ['decision'], required: ['decision'] },
    send_email: { fields: ['recipients', 'subject', 'body'], required: ['recipients', 'body'] },
    // schedule_email gained list/cancel actions (July 2026), so the schema no
    // longer hard-requires the send fields. They are still enforced for the
    // send action — including when `action` is omitted — by
    // OPERATION_REQUIRED_FIELDS; see the send-safety assertions below.
    schedule_email: { fields: ['action', 'recipients', 'body', 'send_at', 'scheduled_email_id'], required: [] },
    bulk_email: { fields: ['recipients', 'body'], required: ['recipients', 'body'] },
    handle_email_confirmation: { fields: ['decision'], required: ['decision'] },
    reuse_recent_email: { fields: ['action', 'recipients'], required: ['action'] },
    manage_leave: { fields: ['action', 'start_date', 'end_date'], required: ['action'] },
    handle_leave_approval: { fields: ['decision'], required: ['decision'] },
    manage_standup: { fields: ['action', 'team_name'], required: ['action'] },
    handle_standup_setup: { fields: ['response'], required: ['response'] },
    handle_standup_response: { fields: ['response'], required: ['response'] },
    manage_polls: { fields: ['action', 'question', 'options'], required: ['action'] },
    handle_poll_vote: { fields: ['choice'], required: ['choice'] },
    check_team_availability: { fields: ['people', 'date', 'timezone'], required: ['people'] },
    thread_summary: { fields: ['message_count', 'focus'], required: [] },
    scheduled_message: { fields: ['recipients', 'message', 'send_at'], required: ['recipients', 'message', 'send_at'] },
    search_drive: { fields: ['query', 'limit'], required: ['query'] },
    manage_docs: { fields: ['action', 'title', 'document_id'], required: ['action'] },
    manage_sheets: { fields: ['action', 'title', 'spreadsheet_id'], required: ['action'] },
    manage_slides: { fields: ['action', 'title', 'presentation_id'], required: ['action'] },
    upload_to_drive: { fields: ['artifact_ids', 'rename_to'], required: ['artifact_ids'] },
    handle_sales_email_confirmation: { fields: ['decision'], required: ['decision'] },
    web_search: { fields: ['query'], required: ['query'] },
    link_account: { fields: ['action'], required: ['action'] },
    translate_text: { fields: ['text', 'target_language'], required: ['text', 'target_language'] },
    quick_note_docs: { fields: ['content', 'document_title'], required: ['content'] },
  };

  for (const [name, expectation] of Object.entries(expected)) {
    const schema = getAgentToolContract(name).inputSchema;
    for (const field of expectation.fields) {
      assert.ok(schema.properties[field], `${name} must expose ${field}`);
    }
    assert.deepEqual(schema.required, expectation.required, `${name} required fields drifted`);
  }
});

test('runtime validation rejects unknown and invalid tool arguments before a handler runs', () => {
  const valid = validateAgentToolArguments('send_email', {
    recipients: ['alice@example.com'],
    subject: 'Launch plan',
    body: 'Please review the attached plan.',
  });
  assert.equal(valid.success, true);

  const unknown = validateAgentToolArguments('send_email', {
    recipients: ['alice@example.com'],
    body: 'Hello',
    made_up_field: true,
  });
  assert.equal(unknown.success, false);
  assert.match(unknown.error.message, /made_up_field|unrecognized|additional/i);

  const invalidAction = validateAgentToolArguments('manage_tasks', {
    action: 'launch_missiles',
  });
  assert.equal(invalidAction.success, false);
  assert.match(invalidAction.error.message, /action|invalid/i);
});

test('reminder selectors are explicit, mutually exclusive, and never overload IDs as positions', () => {
  for (const args of [
    { reminder_id: 731 },
    { position: 2 },
    { query: 'submit the tax return' },
  ]) {
    assert.equal(validateAgentToolArguments('cancel_reminder', args).success, true,
      `cancel_reminder should accept ${JSON.stringify(args)}`);
  }
  assert.equal(validateAgentToolArguments('cancel_reminder', {}).success, false);
  assert.equal(validateAgentToolArguments('cancel_reminder', {
    reminder_id: 731, position: 2,
  }).success, false);

  for (const args of [
    { reminder_id: 731, new_time: 'tomorrow at 9am' },
    { position: 2, new_time: 'tomorrow at 9am' },
    { query: 'submit the tax return', new_time: 'tomorrow at 9am' },
    { use_last_created: true, new_time: 'tomorrow at 9am' },
  ]) {
    assert.equal(validateAgentToolArguments('update_reminder', args).success, true,
      `update_reminder should accept ${JSON.stringify(args)}`);
  }
  assert.equal(validateAgentToolArguments('update_reminder', {
    new_time: 'tomorrow at 9am',
  }).success, false);
  assert.equal(validateAgentToolArguments('update_reminder', {
    reminder_id: 731, position: 2, new_time: 'tomorrow at 9am',
  }).success, false);
});

test('follow-up creation exposes an optional typed due time', () => {
  const schema = getAgentToolContract('manage_follow_ups').inputSchema;
  assert.equal(schema.properties.due_time.type, 'string');
  assert.match(schema.properties.due_time.description, /date|time/i);
  assert.equal(validateAgentToolArguments('manage_follow_ups', {
    action: 'create', contact_name: 'Rahul', subject: 'Proposal', due_time: 'next Friday at 3pm',
  }).success, true);
});

test('time tracking and note-view schemas advertise only implemented typed behavior', () => {
  const timeTracking = getAgentToolContract('track_time').inputSchema;
  assert.equal(timeTracking.properties.duration_minutes, undefined,
    'track_time must not advertise unsupported manual-duration logging');
  assert.match(timeTracking.properties.action.description, /log=show time entries/i);
  assert.equal(validateAgentToolArguments('track_time', {
    action: 'log', duration_minutes: 30,
  }).success, false);

  const notes = getAgentToolContract('manage_notes').inputSchema;
  assert.match(notes.properties.action.description, /view=.*alias.*list_topic/i);
  assert.match(notes.properties.action.description, /requires topic/i);
  assert.doesNotMatch(notes.properties.action.description, /view=show specific note/i);
  assert.equal(validateAgentToolArguments('manage_notes', { action: 'view' }).success, false);
  assert.equal(validateAgentToolArguments('manage_notes', {
    action: 'view', topic: 'architecture',
  }).success, true);
});

test('numbered selectors and bulk contact inputs are bounded in the model-facing schema', () => {
  const imageNumber = getAgentToolContract('manage_images').inputSchema.properties.number;
  assert.equal(imageNumber.minimum, 1);

  const dashboardIndex = getAgentToolContract('delete_dashboard_item').inputSchema.properties.index;
  assert.equal(dashboardIndex.minimum, 1);

  const contacts = getAgentToolContract('bulk_save_contacts').inputSchema.properties.contacts;
  assert.equal(contacts.minItems, 2);
  assert.equal(contacts.maxItems, 500);
  assert.equal(validateAgentToolArguments('bulk_save_contacts', { contacts: [] }).success, false);
});

test('typed arguments become a deterministic legacy invocation and centralized risk decision', () => {
  const invocation = prepareAgentToolInvocation('send_email', {
    recipients: ['Alice <alice@example.com>'],
    subject: 'Launch plan',
    body: 'Please review by Friday.',
  }, {
    originalText: 'send that plan to Alice',
  });

  assert.equal(invocation.validation.success, true);
  assert.equal(invocation.requiresConfirmation, true);
  assert.equal(invocation.effect, 'external_write');
  assert.deepEqual(invocation.handlerArgs.recipients, ['Alice <alice@example.com>']);
  assert.equal(invocation.handlerArgs.full_text, invocation.messageText);
  assert.match(invocation.messageText, /alice@example\.com/i);
  assert.match(invocation.messageText, /Launch plan/);
  assert.match(invocation.messageText, /Please review by Friday/);

  const read = prepareAgentToolInvocation('view_calendar', {
    start_time: 'tomorrow 09:00',
    end_time: 'tomorrow 18:00',
  }, { originalText: 'am I free tomorrow?' });
  assert.equal(read.validation.success, true);
  assert.equal(read.requiresConfirmation, false);
  assert.equal(read.effect, 'read');

  const assignedTask = prepareAgentToolInvocation('manage_tasks', {
    action: 'assign',
    task_title: 'Review launch plan',
    assignee_name: 'Priya',
  }, { originalText: 'ask Priya to review the launch plan' });
  assert.equal(assignedTask.requiresConfirmation, true);
  assert.equal(assignedTask.effect, 'external_write');

  const listTasks = prepareAgentToolInvocation('manage_tasks', { action: 'list' }, {
    originalText: 'what are my tasks?',
  });
  assert.equal(listTasks.requiresConfirmation, false);
  assert.equal(listTasks.effect, 'read');
});

test('external and destructive actions use the hard gate while safe workflow previews remain explicit', () => {
  const sharedFile = prepareAgentToolInvocation('share_drive_file', {
    file_query: 'launch-plan', recipient_email: 'sam@example.com', role: 'reader',
  });
  assert.equal(sharedFile.effect, 'external_write');
  assert.equal(sharedFile.confirmationMode, 'central');

  const attendeeEmail = prepareAgentToolInvocation('email_calendar_attendees', {
    event: 'kickoff tomorrow', body: 'The room changed.',
  });
  assert.equal(attendeeEmail.confirmationMode, 'workflow');

  const selfReminder = prepareAgentToolInvocation('set_reminder', {
    reminder_message: 'call Rahul', due_time: 'tomorrow at 9am',
  });
  assert.equal(selfReminder.effect, 'reversible_write');
  assert.equal(selfReminder.confirmationMode, 'none');

  const delegatedReminder = prepareAgentToolInvocation('set_reminder', {
    reminder_message: 'send the report', due_time: 'tomorrow at 9am', target_name: 'Rahul',
  });
  assert.equal(delegatedReminder.effect, 'external_write');
  assert.equal(delegatedReminder.confirmationMode, 'central');

  const createPoll = prepareAgentToolInvocation('manage_polls', {
    action: 'create', question: 'Lunch?', options: ['Pizza', 'Dosa'], team_name: 'Design',
  });
  assert.equal(createPoll.effect, 'external_write');
  assert.equal(createPoll.confirmationMode, 'workflow');

  const closePoll = prepareAgentToolInvocation('manage_polls', {
    action: 'close', poll_id: 'poll-17',
  });
  assert.equal(closePoll.effect, 'destructive');
  assert.equal(closePoll.confirmationMode, 'central');
});

test('typed confirmation replies are rendered as exact legacy commands', () => {
  assert.equal(prepareAgentToolInvocation('handle_calendar_confirmation', {
    decision: 'confirm',
  }).messageText, 'yes');
  assert.equal(prepareAgentToolInvocation('handle_email_confirmation', {
    decision: 'reject',
  }).messageText, 'no');
  assert.equal(prepareAgentToolInvocation('handle_leave_approval', {
    decision: 'approve',
  }).messageText, 'approve');
  assert.equal(prepareAgentToolInvocation('handle_poll_vote', {
    choice: 'Dosa',
  }).messageText, 'Dosa');
  assert.equal(prepareAgentToolInvocation('handle_standup_response', {
    response: 'Blocked by API access',
  }).messageText, 'Blocked by API access');
});

test('operation-specific validation rejects incomplete broad-tool calls', () => {
  assert.equal(validateAgentToolArguments('set_reminder', {}).success, false);
  assert.equal(validateAgentToolArguments('delegate_message', {}).success, false);
  assert.equal(validateAgentToolArguments('manage_team', {}).success, false);
  assert.equal(validateAgentToolArguments('manage_polls', {
    action: 'create', question: 'Only one?', options: ['Yes'],
  }).success, false);
  assert.equal(validateAgentToolArguments('manage_leave', {
    action: 'apply', start_date: '2026-07-22',
  }).success, false);
  assert.equal(validateAgentToolArguments('recall_memory', {
    action: 'forget',
  }).success, false);
});

test('structured arguments lead the private legacy text bridge even when original wording conflicts', () => {
  const invocation = prepareAgentToolInvocation('manage_sales', {
    action: 'delete', lead_name: 'Acme',
  }, { originalText: 'show me my pipeline' });

  assert.equal(invocation.validation.success, true);
  assert.match(invocation.messageText, /^manage sales\./i);
  assert.match(invocation.messageText, /action: delete/i);
  assert.match(invocation.messageText, /lead name: Acme/i);
  assert.match(invocation.messageText, /original request: show me my pipeline/i);
});

test('document and Google Tasks contracts advertise only actions their handlers execute', () => {
  const expectedActions = {
    manage_docs: ['create', 'read', 'summarize', 'search'],
    manage_sheets: ['create', 'read', 'summarize', 'search'],
    manage_slides: ['create', 'read', 'summarize', 'search'],
    // 'complete' re-enabled July 2026: handleGoogleTasksManage now executes it
    // (position via list-position-cache, or distinctive title match).
    manage_google_tasks: ['list', 'create', 'complete'],
  };

  for (const [name, actions] of Object.entries(expectedActions)) {
    assert.deepEqual(getAgentToolContract(name).inputSchema.properties.action.enum, actions, name);
  }
});

test('broad management tools enforce the fields required by each concrete operation', () => {
  const cases = [
    ['manage_docs', { action: 'read', document_id: 'doc-1' }, { action: 'read' }, 'document_id'],
    ['manage_docs', { action: 'search', query: 'launch' }, { action: 'search' }, 'query'],
    ['manage_sheets', { action: 'summarize', spreadsheet_id: 'sheet-1' }, { action: 'summarize' }, 'spreadsheet_id'],
    ['manage_sheets', { action: 'create', title: 'Forecast' }, { action: 'create' }, 'title'],
    ['manage_slides', { action: 'read', presentation_id: 'deck-1' }, { action: 'read' }, 'presentation_id'],
    ['manage_slides', { action: 'search', query: 'roadmap' }, { action: 'search' }, 'query'],
    ['manage_google_tasks', { action: 'create', title: 'Review PR' }, { action: 'create' }, 'title'],
    ['manage_contacts', { action: 'get', name: 'Priya' }, { action: 'get' }, 'name'],
    ['manage_contacts', { action: 'update', name: 'Priya', phone: '+919876543210' }, { action: 'update', name: 'Priya' }, 'phone'],
    ['manage_images', { action: 'search', search_query: 'receipt' }, { action: 'search' }, 'search_query'],
    ['manage_images', { action: 'select_number', number: 2 }, { action: 'select_number' }, 'number'],
    ['manage_tasks', { action: 'add', task_title: 'Review PR' }, { action: 'add' }, 'task_title'],
    ['manage_tasks', { action: 'complete', task_id: 7 }, { action: 'complete' }, 'task_id'],
    ['manage_tasks', { action: 'set_task_followup', task_id: 7, follow_up_directive: 'every day at 9am' }, { action: 'set_task_followup', task_id: 7 }, 'follow_up_directive'],
    ['manage_notes', { action: 'save', note_content: 'Cache the lookup' }, { action: 'save' }, 'note_content'],
    ['manage_notes', { action: 'view', topic: 'architecture' }, { action: 'view' }, 'topic'],
    ['manage_notes', { action: 'delete_note', note_id: 3 }, { action: 'delete_note' }, 'note_id'],
    ['manage_lists', { action: 'create', list_name: 'groceries' }, { action: 'create' }, 'list_name'],
    ['manage_lists', { action: 'add_item', list_name: 'groceries', items: ['milk'] }, { action: 'add_item', list_name: 'groceries' }, 'items'],
    ['manage_lists', { action: 'remove_item', list_name: 'groceries', item_text: 'milk' }, { action: 'remove_item', list_name: 'groceries' }, 'item_text'],
    ['manage_sales', { action: 'add_lead', lead_name: 'Asha' }, { action: 'add_lead' }, 'lead_name'],
    ['manage_sales', { action: 'move_stage', lead_name: 'Asha', stage: 'proposal' }, { action: 'move_stage', lead_name: 'Asha' }, 'stage'],
    ['manage_sales', { action: 'details', lead_name: 'Asha' }, { action: 'details' }, 'lead_name'],
    ['manage_contact_groups', { action: 'create', group_name: 'Founders' }, { action: 'create' }, 'group_name'],
    ['manage_contact_groups', { action: 'add_members', group_name: 'Founders', member_names: ['Asha'] }, { action: 'add_members', group_name: 'Founders' }, 'member_names'],
    ['manage_contact_groups', { action: 'delete', delete_all: true }, { action: 'delete' }, 'group_name or delete_all'],
    ['manage_habits', { action: 'log', habit_name: 'Meditation' }, { action: 'log' }, 'habit_name'],
    ['manage_expenses', { action: 'log', amount: 250 }, { action: 'log', amount: 0 }, 'amount'],
    ['manage_expenses', { action: 'update_by_category', category: 'food', new_amount: 300 }, { action: 'update_by_category', category: 'food' }, 'new_amount'],
    ['manage_expenses', { action: 'delete', expense_id: 4 }, { action: 'delete' }, 'expense_id'],
    ['manage_expenses', { action: 'multi_log', items: [{ amount: 100 }, { amount: 200 }] }, { action: 'multi_log', items: [{ amount: 100 }] }, 'at least two'],
    ['manage_follow_ups', { action: 'create', subject: 'Proposal' }, { action: 'create' }, 'subject'],
    ['manage_follow_ups', { action: 'complete', follow_up_id: 5 }, { action: 'complete' }, 'follow_up_id'],
    ['manage_reading_list', { action: 'save', url: 'https://example.com/article' }, { action: 'save' }, 'url'],
    ['manage_reading_list', { action: 'mark_read', item_id: 5 }, { action: 'mark_read' }, 'item_id'],
    ['manage_reading_list', { action: 'search', search_query: 'agents' }, { action: 'search' }, 'search_query'],
    ['manage_shared_board', { action: 'create_board', board_name: 'Launch' }, { action: 'create_board' }, 'board_name'],
    ['manage_shared_board', { action: 'add_task', board_name: 'Launch', task_title: 'QA' }, { action: 'add_task', board_name: 'Launch' }, 'task_title'],
    ['manage_shared_board', { action: 'assign', task_id: 9, assignee_name: 'Asha' }, { action: 'assign', task_id: 9 }, 'assignee_name'],
    ['manage_shared_board', { action: 'move', task_id: 9, target_column: 'done' }, { action: 'move', task_id: 9 }, 'target_column'],
    ['manage_knowledge_base', { action: 'add', title: 'Deploy', content: 'Run the release workflow.' }, { action: 'add', title: 'Deploy' }, 'content'],
    ['manage_knowledge_base', { action: 'show', title: 'Deploy' }, { action: 'show' }, 'article_id or title'],
    ['manage_knowledge_base', { action: 'delete', article_id: 6 }, { action: 'delete' }, 'article_id'],
    ['manage_sprints', { action: 'create', sprint_name: 'July' }, { action: 'create' }, 'sprint_name'],
    ['manage_sprints', { action: 'add_item', item_title: 'Ship agent' }, { action: 'add_item' }, 'item_title'],
    ['manage_sprints', { action: 'complete_item', item_id: 8 }, { action: 'complete_item' }, 'item_id'],
    ['manage_incidents', { action: 'report', title: 'API unavailable' }, { action: 'report' }, 'title'],
    ['manage_incidents', { action: 'resolve', incident_id: 12 }, { action: 'resolve' }, 'incident_id'],
    ['manage_incidents', { action: 'assign', incident_id: 12, assignee_name: 'Asha' }, { action: 'assign', incident_id: 12 }, 'assignee_name'],
  ];

  for (const [name, validArgs, invalidArgs, expectedIssue] of cases) {
    assert.equal(validateAgentToolArguments(name, validArgs).success, true,
      `${name} should accept ${JSON.stringify(validArgs)}`);
    const invalid = validateAgentToolArguments(name, invalidArgs);
    assert.equal(invalid.success, false, `${name} should reject ${JSON.stringify(invalidArgs)}`);
    assert.match(invalid.error.message, new RegExp(expectedIssue.replace(/ /g, '\\s+'), 'i'), name);
  }
});

test('operation effects distinguish reads from reversible writes and destructive transitions', () => {
  for (const name of ['manage_docs', 'manage_sheets', 'manage_slides', 'manage_google_tasks', 'manage_images']) {
    assert.equal(getAgentToolContract(name).effect, 'mixed', `${name} exposes both reads and writes`);
  }

  const cases = [
    ['manage_contacts', { action: 'get', name: 'Priya' }, 'read'],
    ['manage_images', { action: 'select_number', number: 1 }, 'read'],
    ['manage_notes', { action: 'list_topic', topic: 'work' }, 'read'],
    ['manage_docs', { action: 'read', document_id: 'doc-1' }, 'read'],
    ['manage_google_tasks', { action: 'list' }, 'read'],
    ['manage_google_tasks', { action: 'create', title: 'Review PR' }, 'reversible_write'],
    ['reschedule_calendar_event', { event: 'evt-1', new_start_time: 'tomorrow 10am' }, 'external_write'],
    ['request_clarification', { question: 'Which account?' }, 'read'],
    ['manage_sprints', { action: 'end' }, 'destructive'],
    ['manage_incidents', { action: 'report', title: 'API unavailable' }, 'reversible_write'],
  ];

  for (const [name, args, effect] of cases) {
    assert.equal(prepareAgentToolInvocation(name, args).effect, effect, `${name}:${args.action}`);
  }
});

test('schedule_email still refuses to schedule without recipients, body, and a time', () => {
  // The action field is optional (omitted means "send"), so the send-safety
  // requirements must hold for BOTH the explicit and the implicit form —
  // otherwise relaxing the schema would have let a bodyless send through.
  const complete = { recipients: ['a@b.com'], body: 'hello', send_at: 'tomorrow 9am' };
  assert.equal(validateAgentToolArguments('schedule_email', complete).success, true);
  assert.equal(validateAgentToolArguments('schedule_email', { action: 'send', ...complete }).success, true);

  for (const missing of ['recipients', 'body', 'send_at']) {
    const args = { ...complete };
    delete args[missing];
    assert.equal(validateAgentToolArguments('schedule_email', args).success, false,
      `omitted action must still require ${missing}`);
    assert.equal(validateAgentToolArguments('schedule_email', { action: 'send', ...args }).success, false,
      `explicit send must still require ${missing}`);
  }

  // Read and cancel need no send payload, but cancel needs a target.
  assert.equal(validateAgentToolArguments('schedule_email', { action: 'list' }).success, true);
  assert.equal(validateAgentToolArguments('schedule_email', { action: 'cancel', scheduled_email_id: 4 }).success, true);
  assert.equal(validateAgentToolArguments('schedule_email', { action: 'cancel' }).success, false);
});

test('tool descriptions do not promise actions their contracts reject', () => {
  const contract = getAgentToolContract('link_account');
  assert.deepEqual(contract.inputSchema.properties.action.enum, ['dashboard_link', 'list']);
  // Mentioning unlinking is fine — and useful — as long as it is explicitly
  // disclaimed rather than offered.
  assert.match(contract.description, /unlinking[^.]*not supported/i,
    'link_account must state that unlinking is unsupported, not advertise it');

  // The base definition (used by the legacy keyword router) must not promise
  // it either.
  const { getToolDefinitions: definitions } = require('../src/services/tool-definitions');
  const legacyLink = definitions().find((tool) => tool.function.name === 'link_account').function.description;
  assert.ok(!/link\/unlink|set notification platform/i.test(legacyLink),
    'the legacy link_account description must not advertise unlink or notification routing');

  const sales = getAgentToolContract('manage_sales').inputSchema.properties.action.enum;
  const { getToolDefinitions } = require('../src/services/tool-definitions');
  const legacy = getToolDefinitions().find((tool) => tool.function.name === 'manage_sales')
    .function.parameters.properties.action.enum;
  assert.deepEqual([...legacy].sort(), [...sales].sort(),
    'the legacy definition and the contract must offer the same sales actions');
});
