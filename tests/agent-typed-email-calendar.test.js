'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.LOG_TO_FILES = 'false';
process.env.LOG_LEVEL = 'silent';

const controller = require('../src/controllers/webhook.controller');
const googleAuthService = require('../src/services/google-auth.service');
const gmailService = require('../src/services/gmail.service');
const calendarService = require('../src/services/calendar.service');
const calendarNLPService = require('../src/services/calendar-nlp.service');
const timezoneService = require('../src/services/timezone.service');
const scheduledEmailJob = require('../src/jobs/scheduled-email.job');
const entityContextService = require('../src/services/entity-context.service');
const {
  confirmationModeForTool,
  getAgentToolContract,
  validateAgentToolArguments,
} = require('../src/services/agent-tool-contracts.service');

function installTypedStubs(t) {
  const originals = {
    connected: googleAuthService.isConnected,
    draft: gmailService.draftEmailWithAI,
    bulkDraft: gmailService.draftSharedBulkEmail,
    revise: gmailService.reviseEmailWithAI,
    send: gmailService.sendEmail,
    findEvents: calendarService.findEvents,
    parseCreate: calendarNLPService.parseEventRequest,
    parseCancel: calendarNLPService.parseCancelRequest,
    parseMove: calendarNLPService.parseRescheduleRequest,
    parseView: calendarNLPService.parseAvailabilityRequest,
    parseEmail: calendarNLPService.parseEmailRequest,
    timezone: timezoneService.getUserTimezone,
    schedule: scheduledEmailJob.scheduleEmail,
    identities: entityContextService.resolveIdentities,
    typedEventById: controller._getTypedCalendarEventById,
  };
  t.after(() => {
    googleAuthService.isConnected = originals.connected;
    gmailService.draftEmailWithAI = originals.draft;
    gmailService.draftSharedBulkEmail = originals.bulkDraft;
    gmailService.reviseEmailWithAI = originals.revise;
    gmailService.sendEmail = originals.send;
    calendarService.findEvents = originals.findEvents;
    calendarNLPService.parseEventRequest = originals.parseCreate;
    calendarNLPService.parseCancelRequest = originals.parseCancel;
    calendarNLPService.parseRescheduleRequest = originals.parseMove;
    calendarNLPService.parseAvailabilityRequest = originals.parseView;
    calendarNLPService.parseEmailRequest = originals.parseEmail;
    timezoneService.getUserTimezone = originals.timezone;
    scheduledEmailJob.scheduleEmail = originals.schedule;
    entityContextService.resolveIdentities = originals.identities;
    if (originals.typedEventById) controller._getTypedCalendarEventById = originals.typedEventById;
    else delete controller._getTypedCalendarEventById;
  });
  googleAuthService.isConnected = async () => true;
  timezoneService.getUserTimezone = async () => 'UTC';
  entityContextService.resolveIdentities = async () => ({ contacts: [], leads: [] });
  controller._getTypedCalendarEventById = async () => null;
}

function failIfCalled(label) {
  return async () => { throw new Error(`${label} must not run for typed agent calls`); };
}

test('typed send_email uses exact recipient, subject, and body without AI redrafting', async (t) => {
  installTypedStubs(t);
  const phone = 'typed-email-send';
  gmailService.draftEmailWithAI = failIfCalled('email AI drafter');
  t.after(() => {
    controller.calendarConfirmContext.delete(phone);
    controller.recentEmailContext.delete(phone);
  });

  const preview = await controller.handleEmailSend({
    from: phone, text: 'garbled legacy text that says tomorrow', agentRunId: 'run-email-1',
  }, { userTimezone: 'UTC' }, {
    recipients: ['Owner@Example.com'],
    subject: 'Exact Subject',
    body: 'Exact body. Do not rewrite this.',
  });

  const pending = controller.calendarConfirmContext.get(phone);
  assert.equal(pending.draft.to, 'owner@example.com');
  assert.equal(pending.draft.subject, 'Exact Subject');
  assert.equal(pending.draft.body, 'Exact body. Do not rewrite this.');
  assert.match(preview, /Exact Subject/);
});

test('typed email recipients resolve an unambiguous saved CRM name and reject ambiguity', async (t) => {
  installTypedStubs(t);
  const phone = 'typed-email-name';
  gmailService.draftEmailWithAI = failIfCalled('email AI drafter');
  entityContextService.resolveIdentities = async (_phone, input) => {
    assert.deepEqual(input.names, ['Alice']);
    return { contacts: [{ name: 'Alice', email: 'alice@acme.test' }], leads: [] };
  };
  t.after(() => {
    controller.calendarConfirmContext.delete(phone);
    controller.recentEmailContext.delete(phone);
  });

  await controller.handleEmailSend({ from: phone, text: 'email Alice', agentRunId: 'run-email-2' }, {}, {
    recipients: ['Alice'], body: 'Hello Alice.', subject: 'Hello',
  });
  assert.equal(controller.calendarConfirmContext.get(phone).draft.to, 'alice@acme.test');

  controller.calendarConfirmContext.delete(phone);
  entityContextService.resolveIdentities = async () => ({
    contacts: [{ name: 'Alex', email: 'alex.one@test.com' }],
    leads: [{ name: 'Alex', email: 'alex.two@test.com' }],
  });
  const ambiguous = await controller.handleEmailSend({ from: phone, text: 'email Alex', agentRunId: 'run-email-3' }, {}, {
    recipients: ['Alex'], body: 'Hello.',
  });
  assert.equal(ambiguous.status, 'waiting_input');
  assert.match(ambiguous.user_summary, /more than one email/i);
});

test('typed schedule_email keeps exact content, recipients, timezone, and send_at through confirmation', async (t) => {
  installTypedStubs(t);
  const phone = 'typed-email-schedule';
  gmailService.draftEmailWithAI = failIfCalled('email AI drafter');
  let scheduled;
  scheduledEmailJob.scheduleEmail = async (_phone, input) => {
    scheduled = input;
    return { success: true, scheduled: { id: 71 } };
  };
  t.after(() => {
    controller.scheduledEmailContext.delete(phone);
    controller.recentEmailContext.delete(phone);
  });

  await controller.handleEmailSchedule({
    from: phone, text: 'unusable prose', agentRunId: 'run-email-4',
  }, { userTimezone: 'Asia/Kolkata' }, {
    recipients: ['first@example.com', 'second@example.com'],
    subject: 'Exact Schedule', body: 'Send exactly this body.',
    send_at: '2035-01-02T09:30:00.000Z', timezone: 'UTC',
  });
  const pending = controller.scheduledEmailContext.get(phone);
  assert.deepEqual(pending.recipients, ['first@example.com', 'second@example.com']);
  assert.equal(pending.draft.subject, 'Exact Schedule');
  assert.equal(pending.draft.body, 'Send exactly this body.');
  assert.equal(pending.sendAt.toISOString(), '2035-01-02T09:30:00.000Z');
  assert.equal(pending.timezone, 'UTC');

  await controller.handleScheduledEmailConfirm({ from: phone, text: 'yes' });
  assert.deepEqual(scheduled.recipients, ['first@example.com', 'second@example.com']);
  assert.equal(scheduled.subject, 'Exact Schedule');
  assert.equal(scheduled.body, 'Send exactly this body.');
});

test('typed bulk_email creates deterministic drafts and schedule without NLP parsing', async (t) => {
  installTypedStubs(t);
  const phone = 'typed-email-bulk';
  gmailService.draftSharedBulkEmail = failIfCalled('bulk AI drafter');
  t.after(() => {
    controller.bulkEmailContext.delete(phone);
    controller.recentEmailContext.delete(phone);
  });

  await controller.handleEmailBulk({ from: phone, text: 'no addresses here', agentRunId: 'run-email-5' }, {}, {
    recipients: ['one@example.com', 'two@example.com'],
    subject: 'Exact Bulk', body: 'Hello [First Name],\nThis is exact.',
    personalize: true, send_at: '2035-01-03T10:00:00.000Z', timezone: 'UTC',
  });
  const pending = controller.bulkEmailContext.get(phone);
  assert.deepEqual(pending.drafts.map((draft) => draft.to), ['one@example.com', 'two@example.com']);
  assert.deepEqual(pending.drafts.map((draft) => draft.subject), ['Exact Bulk', 'Exact Bulk']);
  assert.match(pending.drafts[0].body, /Hello One/);
  assert.match(pending.drafts[1].body, /Hello Two/);
  assert.equal(pending.sendAt.toISOString(), '2035-01-03T10:00:00.000Z');
});

test('typed reuse_recent_email schedule action uses its structured parameters', async (t) => {
  installTypedStubs(t);
  const phone = 'typed-email-reuse';
  controller.storeRecentEmailContext(phone, {
    type: 'single',
    referenceDraft: { to: 'old@example.com', subject: 'Keep Subject', body: 'Keep Body' },
  });
  t.after(() => {
    controller.scheduledEmailContext.delete(phone);
    controller.recentEmailContext.delete(phone);
  });

  await controller.executeIntent('email_reuse', {
    action: 'schedule', send_at: '2035-01-04T11:00:00.000Z', timezone: 'UTC',
  }, { from: phone, text: 'meaningless', agentRunId: 'run-email-6' }, { userTimezone: 'Asia/Kolkata' });

  const pending = controller.scheduledEmailContext.get(phone);
  assert.equal(pending.draft.to, 'old@example.com');
  assert.equal(pending.draft.subject, 'Keep Subject');
  assert.equal(pending.draft.body, 'Keep Body');
  assert.equal(pending.sendAt.toISOString(), '2035-01-04T11:00:00.000Z');
});

test('typed reuse_recent_email can replace a prior bulk recipient set with one recipient', async (t) => {
  installTypedStubs(t);
  const phone = 'typed-email-reuse-single';
  controller.storeRecentEmailContext(phone, {
    type: 'bulk', mode: 'shared',
    drafts: [
      { to: 'one@example.com', subject: 'Keep Subject', body: 'Keep Body' },
      { to: 'two@example.com', subject: 'Keep Subject', body: 'Keep Body' },
    ],
    referenceDraft: { to: 'one@example.com', subject: 'Keep Subject', body: 'Keep Body' },
  });
  t.after(() => {
    controller.calendarConfirmContext.delete(phone);
    controller.bulkEmailContext.delete(phone);
    controller.recentEmailContext.delete(phone);
  });

  await controller.handleRecentEmailReuse({
    from: phone, text: 'wrong prose', agentRunId: 'run-email-reuse-single',
  }, 'UTC', { action: 'change_recipients', recipients: ['solo@example.com'] });

  assert.equal(controller.bulkEmailContext.get(phone), undefined);
  assert.equal(controller.calendarConfirmContext.get(phone).draft.to, 'solo@example.com');
});

test('typed calendar create uses exact fields and bypasses the NLP parser', async (t) => {
  installTypedStubs(t);
  const phone = 'typed-calendar-create';
  calendarNLPService.parseEventRequest = failIfCalled('calendar create NLP parser');
  t.after(() => controller.calendarConfirmContext.delete(phone));

  await controller.handleCalendarCreate({ from: phone, text: 'wrong prose', agentRunId: 'run-cal-1' }, {
    userTimezone: 'Asia/Kolkata',
  }, {
    title: 'Exact Planning Session',
    start_time: '2035-02-01T09:00:00.000Z',
    duration_minutes: 45,
    attendees: ['guest@example.com'],
    location: 'Room 7', description: 'Exact agenda',
    calendar_id: 'team-calendar@example.com', timezone: 'UTC',
  });

  const event = controller.calendarConfirmContext.get(phone).eventData;
  assert.equal(event.title, 'Exact Planning Session');
  assert.equal(event.start.toISOString(), '2035-02-01T09:00:00.000Z');
  assert.equal(event.end.toISOString(), '2035-02-01T09:45:00.000Z');
  assert.deepEqual(event.attendees, [{ email: 'guest@example.com' }]);
  assert.equal(event.location, 'Room 7');
  assert.equal(event.description, 'Exact agenda');
  assert.equal(event.calendarId, 'team-calendar@example.com');
  assert.equal(event.timezone, 'UTC');
});

test('typed calendar times honor the declared timezone and reject an invalid supplied end', async (t) => {
  installTypedStubs(t);
  const phone = 'typed-calendar-timezone';
  t.after(() => controller.calendarConfirmContext.delete(phone));

  await controller.handleCalendarCreate({ from: phone, text: 'wrong', agentRunId: 'run-cal-tz' }, {
    userTimezone: 'UTC',
  }, {
    title: 'Local wall time', start_time: '2035-02-01T09:00:00',
    duration_minutes: 30, timezone: 'America/New_York',
  });
  assert.equal(
    controller.calendarConfirmContext.get(phone).eventData.start.toISOString(),
    '2035-02-01T14:00:00.000Z',
  );

  controller.calendarConfirmContext.delete(phone);
  const invalid = await controller.handleCalendarCreate({ from: phone, text: 'wrong', agentRunId: 'run-cal-bad-end' }, {
    userTimezone: 'UTC',
  }, {
    title: 'Do not guess', start_time: '2035-02-01T09:00:00Z',
    end_time: 'definitely-not-a-time', duration_minutes: 30, timezone: 'UTC',
  });
  assert.equal(invalid.status, 'waiting_input');
  assert.match(invalid.user_summary, /end time/i);
  assert.equal(controller.calendarConfirmContext.get(phone), undefined);
});

test('typed calendar view honors exact range, query, calendar ID, and limit and returns event IDs', async (t) => {
  installTypedStubs(t);
  const phone = 'typed-calendar-view';
  calendarNLPService.parseAvailabilityRequest = failIfCalled('calendar view NLP parser');
  let filters;
  calendarService.findEvents = async (_phone, input) => {
    filters = input;
    return [
      { id: 'event-1', summary: 'Exact One', start: { dateTime: '2035-02-01T09:00:00Z' }, end: { dateTime: '2035-02-01T09:30:00Z' } },
      { id: 'event-2', summary: 'Exact Two', start: { dateTime: '2035-02-01T10:00:00Z' }, end: { dateTime: '2035-02-01T10:30:00Z' } },
    ];
  };

  const result = await controller.handleCalendarView({ from: phone, text: 'wrong prose', agentRunId: 'run-cal-2' }, {
    userTimezone: 'Asia/Kolkata',
  }, {
    start_time: '2035-02-01T00:00:00Z', end_time: '2035-02-02T00:00:00Z',
    query: 'Exact', calendar_id: 'team-calendar@example.com', limit: 1, timezone: 'UTC',
  });

  assert.equal(filters.timeMin.toISOString(), '2035-02-01T00:00:00.000Z');
  assert.equal(filters.timeMax.toISOString(), '2035-02-02T00:00:00.000Z');
  assert.equal(filters.queryStr, 'Exact');
  assert.equal(filters.calendarId, 'team-calendar@example.com');
  assert.equal(result.status, 'success');
  assert.deepEqual(result.data.events.map((event) => event.id), ['event-1']);
});

test('typed calendar cancel and reschedule bind exact event IDs and times without NLP', async (t) => {
  installTypedStubs(t);
  const phone = 'typed-calendar-change';
  calendarNLPService.parseCancelRequest = failIfCalled('calendar cancel NLP parser');
  calendarNLPService.parseRescheduleRequest = failIfCalled('calendar reschedule NLP parser');
  const exactEvent = {
    id: 'event-42', summary: 'Launch Review',
    start: { dateTime: '2035-02-05T09:00:00Z' }, end: { dateTime: '2035-02-05T09:30:00Z' },
    attendees: [{ email: 'guest@example.com' }],
  };
  controller._getTypedCalendarEventById = async (_phone, eventId) => eventId === 'event-42' ? exactEvent : null;
  t.after(() => controller.calendarConfirmContext.delete(phone));

  await controller.handleCalendarCancel({ from: phone, text: 'wrong', agentRunId: 'run-cal-3' }, { userTimezone: 'UTC' }, {
    event: 'event-42', reason: 'No longer needed',
  });
  let pending = controller.calendarConfirmContext.get(phone);
  assert.equal(pending.eventId, 'event-42');
  assert.equal(pending.reason, 'No longer needed');

  controller.calendarConfirmContext.delete(phone);
  await controller.handleCalendarReschedule({ from: phone, text: 'wrong', agentRunId: 'run-cal-4' }, { userTimezone: 'UTC' }, {
    event: 'event-42', new_start_time: '2035-02-06T11:00:00Z',
    duration_minutes: 60, timezone: 'UTC',
  });
  pending = controller.calendarConfirmContext.get(phone);
  assert.equal(pending.eventId, 'event-42');
  assert.equal(pending.newStart, '2035-02-06T11:00:00.000Z');
  assert.equal(pending.newEnd, '2035-02-06T12:00:00.000Z');
  assert.equal(pending.timezone, 'UTC');
});

test('typed calendar mutations resolve stable IDs directly and reject invalid or past replacement times', async (t) => {
  installTypedStubs(t);
  const phone = 'typed-calendar-direct-id';
  const event = {
    id: 'stable-google-id', summary: 'Direct ID Event',
    start: { dateTime: '2035-02-05T09:00:00Z' }, end: { dateTime: '2035-02-05T09:30:00Z' },
  };
  controller._getTypedCalendarEventById = async (_phone, eventId) => {
    assert.equal(eventId, 'stable-google-id');
    return event;
  };
  calendarService.findEvents = failIfCalled('calendar free-text search for a stable ID');
  t.after(() => controller.calendarConfirmContext.delete(phone));

  await controller.handleCalendarCancel({ from: phone, text: 'wrong', agentRunId: 'run-cal-id' }, {
    userTimezone: 'UTC',
  }, { event: 'stable-google-id' });
  assert.equal(controller.calendarConfirmContext.get(phone).eventId, 'stable-google-id');

  controller.calendarConfirmContext.delete(phone);
  const invalidEnd = await controller.handleCalendarReschedule({ from: phone, text: 'wrong', agentRunId: 'run-cal-invalid-end' }, {
    userTimezone: 'UTC',
  }, {
    event: 'stable-google-id', new_start_time: '2035-02-06T11:00:00Z',
    new_end_time: 'not-a-time', duration_minutes: 60, timezone: 'UTC',
  });
  assert.equal(invalidEnd.status, 'waiting_input');
  assert.match(invalidEnd.user_summary, /end time/i);

  const past = await controller.handleCalendarReschedule({ from: phone, text: 'wrong', agentRunId: 'run-cal-past' }, {
    userTimezone: 'UTC',
  }, {
    event: 'stable-google-id', new_start_time: '2020-01-01T11:00:00Z', timezone: 'UTC',
  });
  assert.equal(past.status, 'waiting_input');
  assert.match(past.user_summary, /future/i);
});

test('typed calendar exact-ID lookup fails closed when Google credentials cannot be loaded', async (t) => {
  const original = googleAuthService.getAuthClient;
  t.after(() => { googleAuthService.getAuthClient = original; });
  googleAuthService.getAuthClient = async () => { throw new Error('credential store unavailable'); };

  const event = await controller._getTypedCalendarEventById('typed-calendar-auth-error', 'event-id');
  assert.equal(event, null);
});

test('calendar idempotency fingerprints are stable within a tenant and distinct across tenants', () => {
  const event = ['Shared title', '2035-02-08T09:00:00Z', [{ email: 'guest@example.com' }]];
  const first = calendarService.computeIdempotencyHash('tenant-a', ...event);
  const repeated = calendarService.computeIdempotencyHash('tenant-a', ...event);
  const otherTenant = calendarService.computeIdempotencyHash('tenant-b', ...event);
  assert.equal(first, repeated);
  assert.notEqual(first, otherTenant);
});

test('calendar creation records the returned Google event ID for deterministic follow-ups', async (t) => {
  const originalCreate = calendarService.createEvent;
  const originalRecord = controller.recordLastAction;
  t.after(() => {
    calendarService.createEvent = originalCreate;
    controller.recordLastAction = originalRecord;
  });
  calendarService.createEvent = async () => ({
    success: true,
    event: { id: 'google-event-99' },
    title: 'Created event',
    start: new Date('2035-02-08T09:00:00Z'),
    end: new Date('2035-02-08T09:30:00Z'),
    attendees: [],
  });
  let recorded;
  controller.recordLastAction = (_phone, action) => { recorded = action; };

  await controller.executeCalendarCreate('typed-calendar-create-id', {
    title: 'Created event',
    start: new Date('2035-02-08T09:00:00Z'),
    end: new Date('2035-02-08T09:30:00Z'),
    timezone: 'UTC',
  }, 'UTC');
  assert.equal(recorded.entityId, 'google-event-99');
});

test('typed email_calendar_attendees previews resolved addresses and sends exact content after workflow approval', async (t) => {
  installTypedStubs(t);
  calendarNLPService.parseEmailRequest = failIfCalled('calendar attendee email NLP parser');
  const exactEvent = {
    id: 'event-7', summary: 'Planning',
    start: { dateTime: '2035-02-07T09:00:00Z' }, end: { dateTime: '2035-02-07T09:30:00Z' },
    attendees: [{ email: 'self@example.com', self: true }, { email: 'guest@example.com' }],
  };
  controller._getTypedCalendarEventById = async (_phone, eventId) => eventId === 'event-7' ? exactEvent : null;
  let sent;
  gmailService.sendEmail = async (_phone, input) => { sent = input; return { success: true }; };

  const preview = await controller.handleCalendarEmail({
    from: 'typed-calendar-email', text: 'wrong prose', agentRunId: 'run-cal-5',
  }, { userTimezone: 'UTC' }, {
    event: 'event-7', subject: 'Exact attendee subject', body: 'Exact attendee body.',
  });

  assert.equal(sent, undefined);
  assert.match(preview, /guest@example\.com/);
  const pending = controller.calendarConfirmContext.get('typed-calendar-email');
  assert.deepEqual(pending.recipients, ['guest@example.com']);

  const result = await controller.handleCalendarConfirmation({
    from: 'typed-calendar-email', text: 'yes', agentRunId: 'run-cal-5-confirm',
  }, pending);
  assert.deepEqual(sent.to, ['guest@example.com']);
  assert.equal(sent.subject, 'Exact attendee subject');
  assert.match(sent.htmlBody, /Exact attendee body\./);
  assert.match(result, /guest@example.com/);
});

test('typed email and calendar contracts reject incomplete operation-specific calls', () => {
  assert.equal(validateAgentToolArguments('reuse_recent_email', { action: 'schedule' }).success, false);
  assert.equal(validateAgentToolArguments('reuse_recent_email', { action: 'edit' }).success, false);
  assert.equal(validateAgentToolArguments('reuse_recent_email', { action: 'change_recipients' }).success, false);
  assert.equal(validateAgentToolArguments('reuse_recent_email', {
    action: 'schedule', send_at: '2035-01-04T11:00:00Z', timezone: 'UTC',
  }).success, true);

  const view = getAgentToolContract('view_calendar').inputSchema.properties;
  assert.ok(view.timezone);
  assert.equal(view.limit.maximum, 10);
  assert.match(view.calendar_id.description, /default calendar/i);
  const create = getAgentToolContract('create_calendar_event').inputSchema.properties;
  assert.match(create.calendar_id.description, /configured default calendar/i);
  assert.equal(confirmationModeForTool('email_calendar_attendees', {}), 'workflow');
});
