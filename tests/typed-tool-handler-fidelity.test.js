'use strict';

process.env.LOG_TO_FILES = 'false';
process.env.LOG_LEVEL = 'silent';

const assert = require('node:assert/strict');
const test = require('node:test');

const controller = require('../src/controllers/webhook.controller');
const accountLinkService = require('../src/services/account-link.service');
const aiService = require('../src/services/ai.service');
const calendarService = require('../src/services/calendar.service');
const confirmationGate = require('../src/services/confirmation-gate.service');
const database = require('../src/config/database');
const followUpService = require('../src/services/follow-up.service');
const googleAuthService = require('../src/services/google-auth.service');
const googleDocsService = require('../src/services/google-docs.service');
const googleDriveService = require('../src/services/google-drive.service');
const googleSheetsService = require('../src/services/google-sheets.service');
const googleSlidesService = require('../src/services/google-slides.service');
const imageService = require('../src/services/image.service');
const listService = require('../src/services/list.service');
const listPositionCache = require('../src/utils/list-position-cache');
const reminderService = require('../src/services/reminder.service');
const messagingService = require('../src/services/messaging.service');
const salesService = require('../src/services/sales.service');
const standupService = require('../src/services/standup.service');
const taskService = require('../src/services/task.service');
const handlerRegistry = require('../src/handlers');

const PHONE = '919000000001';

function patch(t, object, name, replacement) {
  const original = object[name];
  object[name] = replacement;
  t.after(() => { object[name] = original; });
}

function message(text) {
  return { from: PHONE, text, source: 'dashboard' };
}

function context(intentParams = {}) {
  return {
    userTimezone: 'Asia/Kolkata',
    intentParams,
    agentExecution: { runtime: 'test', toolCallId: 'call-1' },
  };
}

test('save_image consumes typed action and title without reparsing synthesized prose', async (t) => {
  controller.imageContext.set(PHONE, { timestamp: Date.now(), title: null, url: 'https://example.test/image.png' });
  t.after(() => controller.imageContext.delete(PHONE));
  let saved = false;
  patch(t, controller, 'saveImageFromContext', async () => { saved = true; return 'saved'; });

  const result = await controller.executeIntent(
    'image_save', { action: 'save_with_title', title: 'Launch receipt' },
    message('anything at all'), context(),
  );

  assert.equal(result, 'saved');
  assert.equal(saved, true);
  assert.equal(controller.imageContext.get(PHONE).title, 'Launch receipt');
});

test('manage_images search consumes the typed search_query without phrase-gating or reparsing message text', async (t) => {
  controller.imageListContext.delete(PHONE);
  t.after(() => controller.imageListContext.delete(PHONE));
  const image = {
    id: 41,
    image_url: 'https://example.test/launch-receipt.png',
    title: 'Launch receipt',
    created_at: new Date().toISOString(),
  };
  let searchedFor;
  let sent;
  patch(t, imageService, 'searchImages', async (_phone, query) => {
    searchedFor = query;
    return [image];
  });
  patch(t, imageService, 'formatImageSummary', () => 'Launch receipt');
  patch(t, messagingService, 'sendImage', async (phone, url, caption) => {
    sent = { phone, url, caption };
  });
  patch(t, controller, 'handleImageRetrieval', async () => {
    throw new Error('typed image search must not use the legacy phrase-gated parser');
  });

  const result = await controller.executeIntent(
    'image_manage', { action: 'search', search_query: 'launch receipt from March' },
    message('this sentence intentionally contains no image-recall phrasing'), context(),
  );

  assert.equal(result, true);
  assert.equal(searchedFor, 'launch receipt from March');
  assert.deepEqual(sent, {
    phone: PHONE,
    url: image.image_url,
    caption: 'Launch receipt',
  });
  assert.equal(controller.imageListContext.get(PHONE).originalQuery, 'launch receipt from March');
});

test('handle_standup_setup without active context waits for input and never starts a workflow', async (t) => {
  controller.standupSetupContext.delete(PHONE);
  t.after(() => controller.standupSetupContext.delete(PHONE));

  const result = await controller.executeIntent(
    'standup_setup', { response: 'Daily Design Sync' }, message('Daily Design Sync'), context(),
  );

  assert.equal(result.status, 'waiting_input');
  assert.equal(result.data.pending, false);
  assert.match(result.user_summary, /no active standup setup/i);
  assert.equal(controller.standupSetupContext.has(PHONE), false);
});

test('help distinguishes cross-provider calendar viewing from Google-only mutations', () => {
  const help = controller.getHelpMessage();

  assert.match(help, /view connected calendars across Google, Outlook, and Apple/i);
  assert.match(help, /creat(?:e|ing).*(?:cancel|cancell|reschedul).*Google Calendar/i);
  assert.doesNotMatch(help, /Book, cancel, and reschedule across Google, Outlook, and Apple/i);
});

test('Drive, Docs, Sheets, and Slides dispatch exact typed fields', async (t) => {
  patch(t, controller, '_checkScopeOrPrompt', async () => null);
  const seen = {};
  patch(t, googleDriveService, 'listFiles', async (_phone, query, limit) => {
    seen.drive = { query, limit };
    return { success: true, files: [] };
  });
  patch(t, googleDocsService, 'createDoc', async (_phone, title) => {
    seen.docTitle = title;
    return { success: true, title, link: 'https://docs.test/1' };
  });
  patch(t, googleSheetsService, 'getSheetData', async (_phone, id) => {
    seen.sheetId = id;
    return { success: true, title: 'Forecast', sheetNames: ['Sheet1'], rows: [] };
  });
  patch(t, googleSheetsService, 'formatSheetPreview', () => 'empty');
  patch(t, googleSlidesService, 'searchPresentations', async (_phone, query) => {
    seen.slidesQuery = query;
    return { success: true, presentations: [] };
  });

  await controller.executeIntent('drive_search', { query: 'Roadmap', limit: 7 }, message('ignore this'), context());
  await controller.executeIntent('docs_manage', { action: 'create', title: 'Typed title' }, message('ignore this'), context());
  await controller.executeIntent('sheets_manage', { action: 'read', spreadsheet_id: 'sheet-stable-id' }, message('ignore this'), context());
  await controller.executeIntent('slides_manage', { action: 'search', query: 'Launch deck' }, message('ignore this'), context());

  assert.deepEqual(seen.drive, { query: 'Roadmap', limit: 7 });
  assert.equal(seen.docTitle, 'Typed title');
  assert.equal(seen.sheetId, 'sheet-stable-id');
  assert.equal(seen.slidesQuery, 'Launch deck');
});

test('thread summary and team availability honor typed scope', async (t) => {
  const seen = {};
  patch(t, aiService, 'summarizeRecentMessages', async (_phone, count, focus) => {
    seen.summary = { count, focus };
    return 'summary';
  });
  patch(t, googleAuthService, 'isConnected', async () => true);
  patch(t, calendarService, 'getTeamAvailability', async (_phone, date, timezone, options) => {
    seen.availability = { date, timezone, options };
    return 'availability';
  });

  assert.equal(await controller.handleThreadSummary(message('ignore'), context(), {
    message_count: 37, focus: 'decisions and owners',
  }), 'summary');
  assert.equal(await controller.handleTeamAvailability(message('ignore'), context(), {
    people: ['Design'], date: 'next Monday', timezone: 'Europe/Paris',
  }), 'availability');

  assert.deepEqual(seen.summary, { count: 37, focus: 'decisions and owners' });
  assert.equal(seen.availability.timezone, 'Europe/Paris');
  assert.deepEqual(seen.availability.options.people, ['Design']);
  assert.ok(seen.availability.date instanceof Date);
});

test('quick_note_docs honors destination title and heading directly', async (t) => {
  const seen = {};
  patch(t, googleAuthService, 'isConnected', async () => true);
  patch(t, googleDocsService, 'searchDocs', async (_phone, title) => ({
    success: true, docs: [{ id: 'doc-7', name: title }],
  }));
  patch(t, googleDocsService, 'appendText', async (_phone, id, text) => {
    seen.append = { id, text };
    return { success: true };
  });

  const response = await handlerRegistry.handle('quick_note_docs', message('ignore'), {
    userPhone: PHONE,
    intentParams: { content: 'Ship on Tuesday', document_title: 'Release Notes', heading: 'Decision' },
  });

  assert.match(response, /Release Notes/);
  assert.equal(seen.append.id, 'doc-7');
  assert.match(seen.append.text, /Decision\nShip on Tuesday/);
});

test('stable task IDs never fall back to display positions and typed due/priority are used', async (t) => {
  let completedId;
  patch(t, taskService, 'completeTaskByIdForUser', async (_phone, id) => {
    completedId = id;
    return { success: true, task: { id, description: 'Write report' } };
  });
  patch(t, taskService, 'completeTaskByIndex', async () => { throw new Error('display index must not run'); });
  const completed = await controller.handleTaskManage(message('mark task 1 done'), context({
    action: 'complete', task_id: 73,
  }));
  assert.equal(completedId, 73);
  assert.match(completed, /Write report/);

  let created;
  patch(t, taskService, 'createPersonalTask', async (_phone, title, priority, due) => {
    created = { title, priority, due };
    return { success: true, task: { id: 81, description: title } };
  });
  patch(t, googleAuthService, 'hasScope', async () => false);
  const added = await controller.handleTaskManage(
    message('Add task Write report due tomorrow at 5pm'),
    context({ action: 'add', task_title: 'Write report', priority: 'high', due_time: 'tomorrow at 5pm' }),
  );
  assert.equal(created.title, 'Write report');
  assert.equal(created.priority, 'high');
  assert.ok(created.due instanceof Date);
  assert.match(added, /ID: 81/);
});

test('list clear empties the list while clear_completed remains explicit', async (t) => {
  let clearAll = 0;
  let clearDone = 0;
  patch(t, listService, 'clearListItems', async () => { clearAll += 1; return { found: true, count: 4 }; });
  patch(t, listService, 'clearCompleted', async () => { clearDone += 1; return 2; });

  const all = await controller.handleList(message('irrelevant'), { action: 'clear', list_name: 'shopping' });
  const done = await controller.handleList(message('irrelevant'), { action: 'clear_completed', list_name: 'shopping' });

  assert.match(all, /all 4 items/);
  assert.match(done, /2 completed/);
  assert.equal(clearAll, 1);
  assert.equal(clearDone, 1);
});

test('standup setup and sales follow-up operations preserve their typed meaning', async (t) => {
  const seen = {};
  patch(t, taskService, 'getTeamMembers', async () => [{ member_phone: '9191', member_name: 'Priya' }]);
  patch(t, standupService, 'createSmartStandup', async (...args) => {
    seen.standup = args;
    return { success: true, groupId: 'group-1' };
  });
  const standup = await controller.handleStandupManage(message('ignore'), context(), {
    action: 'setup', team_name: 'Design', check_in_time: '9:30am', wrap_up_time: '6pm', timezone: 'Asia/Kolkata',
  });
  assert.match(standup, /Smart standup created/);
  assert.equal(seen.standup.at(-1), 'Asia/Kolkata');

  patch(t, salesService, 'addLead', async (_phone, lead) => {
    seen.lead = lead;
    return { success: true, lead: { id: 9, stage: 'new', ...lead } };
  });
  const sales = await controller.handleSalesManage(message('ignore'), context(), {
    action: 'add_lead', lead_name: 'Sam', company: 'Acme', email: 'sam@acme.test', notes: 'Inbound', deal_value: 5000,
  });
  assert.match(sales, /Lead added/);
  assert.deepEqual(seen.lead, {
    name: 'Sam', company: 'Acme', email: 'sam@acme.test', notes: 'Inbound', dealValue: 5000,
  });
  assert.deepEqual(await salesService.parseCommand('ignore', {
    action: 'set_follow_up', lead_name: 'Sam', due_time: 'next Monday',
  }), { action: 'set_followup', target: 'Sam', timeRaw: 'next Monday' });
});

test('link_account and translation expose only implemented typed behavior', async (t) => {
  patch(t, accountLinkService, 'getLinkedAccounts', async () => []);
  patch(t, accountLinkService, 'formatLinkedAccounts', () => 'No linked accounts.');
  assert.equal(await controller.handleAccountLink(message('ignore'), { action: 'list' }), 'No linked accounts.');

  let translationPrompt;
  patch(t, aiService, 'quickAI', async (prompt) => { translationPrompt = prompt; return 'Bonjour'; });
  const translated = await controller.handleTranslate(message('ignore'), {
    text: 'Hello', source_language: 'English', target_language: 'French', preserve_formatting: true,
  });
  assert.equal(translated, 'Bonjour');
  assert.match(translationPrompt, /from English to French/);
  assert.match(translationPrompt, /Hello/);
});

test('typed reminder cancellation resolves stable IDs, list positions, and distinctive text without fallback', async (t) => {
  const pending = [
    { id: 41, message: 'Pay the electricity bill' },
    { id: 73, message: 'Submit the tax return' },
  ];
  const updated = [];
  patch(t, confirmationGate, 'pend', async (_phone, request) => request.execute());
  patch(t, database, 'query', async (sql, params) => {
    if (/SELECT id, message FROM reminders WHERE id = \$1/i.test(sql)) {
      const row = pending.find((item) => item.id === Number(params[0]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (/SELECT id, message, reminder_time/i.test(sql)) {
      return { rows: pending.map((item) => ({ ...item, reminder_time: new Date() })) };
    }
    if (/UPDATE reminders SET status = 'cancelled'/i.test(sql)) {
      updated.push({ id: Number(params[0]), phone: params[1] });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected reminder query: ${sql}`);
  });
  patch(t, listPositionCache, 'pick', (_phone, type, position) => {
    assert.equal(type, 'reminders');
    return Number(position) === 2 ? { id: 41, label: 'Pay the electricity bill' } : null;
  });

  await controller.executeIntent('reminder_cancel', { reminder_id: 73 },
    message('cancel reminder 1'), context());
  await controller.executeIntent('reminder_cancel', { position: 2 },
    message('cancel reminder #73'), context());
  await controller.executeIntent('reminder_cancel', { query: 'tax return' },
    message('cancel the electricity reminder'), context());

  assert.deepEqual(updated, [
    { id: 73, phone: PHONE },
    { id: 41, phone: PHONE },
    { id: 73, phone: PHONE },
  ]);

  let queried = false;
  patch(t, listPositionCache, 'pick', () => null);
  patch(t, database, 'query', async () => { queried = true; throw new Error('must not query a fallback'); });
  controller.lastEntityRef.set(PHONE, {
    entityType: 'reminder', entityId: 999, label: 'Wrong reminder',
  });
  t.after(() => controller.lastEntityRef.delete(PHONE));
  const missing = await controller.executeIntent('reminder_cancel', { position: 9 },
    message('cancel whatever'), context());
  assert.match(missing, /show.*reminders|recent.*reminder list/i);
  assert.equal(queried, false);
});

test('typed reminder updates distinguish a stable ID from a list position and never fall back on a miss', async (t) => {
  const rescheduled = [];
  patch(t, reminderService, 'parseReminderTimeAndMessage', async () => ({
    success: true,
    reminderTime: new Date('2030-07-24T09:00:00.000Z'),
  }));
  patch(t, reminderService, 'rescheduleReminder', async (id, time, phone) => {
    rescheduled.push({ id: Number(id), time: time.toISOString(), phone });
  });
  patch(t, confirmationGate, 'pend', async (_phone, request) => request.execute());
  patch(t, listPositionCache, 'pick', (_phone, type, position) => {
    assert.equal(type, 'reminders');
    return Number(position) === 2 ? { id: 41, label: 'Pay the electricity bill' } : null;
  });
  patch(t, database, 'query', async (sql, params) => {
    if (/SELECT id, message FROM reminders WHERE id = \$1/i.test(sql)) {
      assert.equal(params[1], PHONE);
      return { rows: [{ id: Number(params[0]), message: `Reminder ${params[0]}` }] };
    }
    throw new Error(`Unexpected reminder query: ${sql}`);
  });

  await controller.executeIntent('update_reminder', {
    reminder_id: 731, new_time: 'tomorrow at 9am',
  }, message('update reminder 2'), context());
  await controller.executeIntent('update_reminder', {
    position: 2, new_time: 'tomorrow at 9am',
  }, message('update reminder #731'), context());
  assert.deepEqual(rescheduled.map((entry) => entry.id), [731, 41]);

  patch(t, listPositionCache, 'pick', () => null);
  patch(t, database, 'query', async () => { throw new Error('must not query a fallback'); });
  controller.lastEntityRef.set(PHONE, {
    entityType: 'reminder', entityId: 999, label: 'Wrong reminder',
  });
  t.after(() => controller.lastEntityRef.delete(PHONE));
  const missing = await controller.executeIntent('update_reminder', {
    position: 9, new_time: 'tomorrow at 9am',
  }, message('update it'), context());
  assert.match(missing, /show.*reminders|recent.*reminder list/i);
  assert.deepEqual(rescheduled.map((entry) => entry.id), [731, 41]);
});

test('typed follow-up creation parses and persists due_time instead of dropping it', async (t) => {
  let created;
  patch(t, followUpService, 'addFollowUp', async (...args) => {
    created = args;
    return {
      success: true,
      followUp: {
        id: 17,
        contact_name: args[1],
        subject: args[2],
        due_date: args[3],
        priority: args[4],
      },
    };
  });

  const result = await handlerRegistry.handle('follow_up_manage', message('ignore this'), {
    userPhone: PHONE,
    userTimezone: 'Asia/Kolkata',
    intentParams: {
      action: 'create',
      contact_name: 'Rahul',
      subject: 'Proposal',
      due_time: '2030-07-24T14:30:00+05:30',
      priority: 'high',
    },
  });

  assert.equal(created[0], PHONE);
  assert.equal(created[1], 'Rahul');
  assert.equal(created[2], 'Proposal');
  assert.ok(created[3] instanceof Date);
  assert.equal(created[3].toISOString(), '2030-07-24T09:00:00.000Z');
  assert.equal(created[4], 'high');
  assert.match(result, /Due:/);
  assert.doesNotMatch(result, /Not set/);
});

test('follow-up due-time parsing honors a clear phrase in the user timezone', () => {
  const due = followUpService.parseDueTime(
    'tomorrow at 3pm',
    'Asia/Kolkata',
    new Date('2030-07-19T06:30:00.000Z'),
  );
  assert.ok(due instanceof Date);
  assert.equal(due.toISOString(), '2030-07-20T09:30:00.000Z');
});
