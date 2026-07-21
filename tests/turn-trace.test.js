'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createTurnTraceService } = require('../src/services/turn-trace.service');
const { runWithChatSession } = require('../src/services/chat-session-context');

function tempLogPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-trace-'));
  return path.join(dir, 'agent-turns.jsonl');
}

async function readRecords(logPath) {
  // appendFile is async fire-and-forget — give the write a beat to land.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const raw = fs.readFileSync(logPath, 'utf8').trim();
  return raw ? raw.split('\n').map((line) => JSON.parse(line)) : [];
}

test('turn trace writes one complete JSONL record per turn', async () => {
  const logPath = tempLogPath();
  const trace = createTurnTraceService({ logPath, enabled: true });

  trace.begin('+911234567890', { channel: 'dashboard', text: 'create group in our crm name greencardguide' });
  trace.note('+911234567890', 'intent_detected', { type: null });
  trace.note('+911234567890', 'route', { route: 'chat_fallback' });
  trace.note('+911234567890', 'response_sent', { response: 'Hold on — let me actually run that.' });
  trace.end('+911234567890');

  const records = await readRecords(logPath);
  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(record.userPhone, '+911234567890');
  assert.equal(record.channel, 'dashboard');
  assert.equal(record.route, 'chat_fallback');
  assert.match(record.response, /Hold on/);
  assert.equal(record.outcome, 'completed');
  assert.equal(record.events.length, 3);
  assert.ok(record.turnId, 'every turn gets an id');
  assert.ok(record.totalMs >= 0, 'duration is recorded');
});

test('turn trace records errors and never mixes users', async () => {
  const logPath = tempLogPath();
  const trace = createTurnTraceService({ logPath, enabled: true });

  trace.begin('+911111111111', { channel: 'whatsapp', text: 'remind me at 5' });
  trace.begin('+922222222222', { channel: 'whatsapp', text: 'show tasks' });
  trace.end('+911111111111', { outcome: 'error', error: 'db timeout' });
  trace.end('+922222222222');

  const records = await readRecords(logPath);
  assert.equal(records.length, 2);
  const failed = records.find((record) => record.userPhone === '+911111111111');
  assert.equal(failed.outcome, 'error');
  assert.equal(failed.error, 'db timeout');
  const ok = records.find((record) => record.userPhone === '+922222222222');
  assert.equal(ok.outcome, 'completed');
});

test('an unfinished turn is flushed as superseded when the next begins', async () => {
  const logPath = tempLogPath();
  const trace = createTurnTraceService({ logPath, enabled: true });

  trace.begin('+911234567890', { channel: 'whatsapp', text: 'first message' });
  trace.begin('+911234567890', { channel: 'whatsapp', text: 'second message' });
  trace.end('+911234567890');

  const records = await readRecords(logPath);
  assert.equal(records.length, 2);
  // appendFile calls are async — line order is not guaranteed, so match by content.
  const superseded = records.find((record) => record.text === 'first message');
  const completed = records.find((record) => record.text === 'second message');
  assert.equal(superseded.outcome, 'superseded');
  assert.equal(completed.outcome, 'completed');
});

test('secrets are redacted and long strings truncated', async () => {
  const logPath = tempLogPath();
  const trace = createTurnTraceService({ logPath, enabled: true });

  trace.begin('+911234567890', { channel: 'dashboard', text: 'x'.repeat(5000) });
  trace.note('+911234567890', 'intent_detected', { params: { api_key: 'sk-live-abc', subject: 'hello' } });
  trace.end('+911234567890');

  const [record] = await readRecords(logPath);
  assert.ok(record.text.length < 2000, 'long inbound text is truncated');
  assert.equal(record.events[0].data.params.api_key, '[REDACTED]');
  assert.equal(record.events[0].data.params.subject, 'hello');
});

test('disabled tracing writes nothing and never throws', async () => {
  const logPath = tempLogPath();
  const trace = createTurnTraceService({ logPath, enabled: false });

  trace.begin('+911234567890', { channel: 'whatsapp', text: 'hi' });
  trace.note('+911234567890', 'route', { route: 'chat_fallback' });
  trace.end('+911234567890');

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fs.existsSync(logPath), false);
});

test('note and end on a user with no active turn are safe no-ops', async () => {
  const logPath = tempLogPath();
  const trace = createTurnTraceService({ logPath, enabled: true });

  trace.note('+919999999999', 'route', { route: 'chat_fallback' });
  trace.end('+919999999999');

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fs.existsSync(logPath), false);
});

test('dashboard turns write to an isolated sanitized session JSONL file', async () => {
  const fallbackPath = tempLogPath();
  const sessionLogDir = path.join(path.dirname(fallbackPath), 'sessions');
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const clientMessageId = '22222222-2222-4222-8222-222222222222';
  const trace = createTurnTraceService({ logPath: fallbackPath, sessionLogDir, enabled: true });

  await runWithChatSession({ sessionId, clientMessageId, runId: '33333333-3333-4333-8333-333333333333' }, async () => {
    trace.begin('+911234567890', { channel: 'dashboard', text: 'hello' });
    trace.end('+911234567890', { response: 'hi' });
  });

  const sessionPath = path.join(sessionLogDir, `${sessionId}.jsonl`);
  const [record] = await readRecords(sessionPath);
  assert.equal(record.sessionId, sessionId);
  assert.equal(record.clientMessageId, clientMessageId);
  assert.equal(record.userPhone, '***7890');
  assert.equal(fs.existsSync(fallbackPath), false);
});
