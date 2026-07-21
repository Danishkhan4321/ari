'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TRANSITIONS,
  createMeetingRepository,
} = require('../src/services/manual-meetings/meeting-repository');

test('createFromCapture is idempotent by capture session', async () => {
  const calls = [];
  const repo = createMeetingRepository({
    query: async (text, params) => {
      calls.push({ text, params });
      return { rows: [{ id: 4, capture_session_id: params[0] }] };
    },
  });

  const meeting = await repo.createFromCapture({
    captureSessionId: '550e8400-e29b-41d4-a716-446655440000',
    userPhone: 'wa_1',
    title: 'Weekly review',
    capturePlatform: 'win32',
    captureCodec: 'audio/webm;codecs=opus',
  });

  assert.equal(meeting.id, 4);
  assert.match(calls[0].text, /ON CONFLICT \(capture_session_id\)/);
  assert.equal(calls[0].params[1], 'wa_1');
});

test('transition rejects impossible state changes before querying', async () => {
  let called = false;
  const repo = createMeetingRepository({
    query: async () => {
      called = true;
      return { rows: [] };
    },
  });

  await assert.rejects(
    repo.transition(3, 'wa_1', ['captured'], { processingStage: 'completed' }),
    /Invalid meeting transition/,
  );
  assert.equal(called, false);
  assert.deepEqual(TRANSITIONS.captured, ['uploading', 'cancelled']);
});

test('getOwned never returns another user meeting', async () => {
  const repo = createMeetingRepository({ query: async () => ({ rows: [] }) });
  assert.equal(await repo.getOwned(9, 'wa_other'), null);
});

test('renameSpeaker materializes every compatibility column in one transaction', async () => {
  const commands = [];
  const canonical = {
    canonical_transcript_segments: [
      { speakerId: 'A', startMs: 0, endMs: 1000, text: 'I own the follow-up.' },
      { speakerId: 'B', startMs: 1000, endMs: 2000, text: 'Approved.' },
    ],
    canonical_report: {
      summary: 'Speaker A owns the follow-up.',
      decisions: ['Speaker B approved it.'],
      actionItems: [{ text: 'Speaker A sends notes', assigneeSpeakerId: 'A', deadline: null }],
      suggestedTasks: [{ title: 'Send notes', suggestedAssigneeSpeakerId: 'A', reason: 'Speaker A volunteered.' }],
      topics: ['Follow-up'],
      reportMarkdown: 'Speaker A owns it. Speaker B approved it.',
    },
    speaker_names: {},
  };
  const query = async (text, params = []) => {
    const command = text.trim().split(/\s+/)[0].toUpperCase();
    commands.push(command);
    if (command === 'SELECT') return { rows: [canonical] };
    if (command === 'UPDATE') {
      return {
        rows: [{
          ...canonical,
          speaker_names: JSON.parse(params[2]),
          transcript: params[3],
          summary: params[4],
          decisions: params[5],
          action_items: params[6],
          suggested_tasks: JSON.parse(params[7]),
          topics: params[8],
          mom: params[9],
          report_markdown: params[10],
          attendees: params[11],
        }],
      };
    }
    return { rows: [] };
  };
  const repo = createMeetingRepository({ query });

  const updated = await repo.renameSpeaker({
    meetingId: 7,
    userPhone: 'wa_1',
    speakerId: 'A',
    name: 'Danish',
  });

  assert.equal(updated.speaker_names.A, 'Danish');
  assert.match(updated.transcript, /Danish:/);
  assert.match(updated.summary, /Danish/);
  assert.match(updated.decisions, /Speaker B/);
  assert.match(updated.action_items, /Danish/);
  assert.equal(updated.suggested_tasks[0].suggestedAssignee, 'Danish');
  assert.match(updated.report_markdown, /Danish/);
  assert.equal(commands[0], 'BEGIN');
  assert.equal(commands.at(-1), 'COMMIT');
});

test('renameSpeaker rolls back invalid or failed writes', async () => {
  const commands = [];
  const repo = createMeetingRepository({
    query: async (text) => {
      const command = text.trim().split(/\s+/)[0].toUpperCase();
      commands.push(command);
      if (command === 'SELECT') throw new Error('database unavailable');
      return { rows: [] };
    },
  });

  await assert.rejects(
    repo.renameSpeaker({ meetingId: 1, userPhone: 'wa_1', speakerId: 'A', name: 'Danish' }),
    /database unavailable/,
  );
  assert.deepEqual(commands, ['BEGIN', 'SELECT', 'ROLLBACK']);
  await assert.rejects(
    repo.renameSpeaker({ meetingId: 1, userPhone: 'wa_1', speakerId: 'a', name: 'Danish' }),
    /speaker ID/,
  );
});
