const test = require('node:test');
const assert = require('node:assert/strict');
const { ChatSubmissionService } = require('../src/services/chat-submission.service');

const sessionId = '11111111-1111-4111-8111-111111111111';
const clientMessageId = '22222222-2222-4222-8222-222222222222';

test('submission claim rejects a session not owned by the user', async () => {
  const service = new ChatSubmissionService(async () => ({ rowCount: 0, rows: [] }));
  const result = await service.claim({ userPhone: '+91000', sessionId, clientMessageId });
  assert.deepEqual(result, { ok: false, reason: 'not_found' });
});

test('submission claim reports duplicate client message IDs without reprocessing', async () => {
  const calls = [];
  const service = new ChatSubmissionService(async (sql) => {
    calls.push(sql);
    return calls.length === 1 ? { rowCount: 1, rows: [{ '?column?': 1 }] } : { rowCount: 0, rows: [] };
  });
  const result = await service.claim({ userPhone: '+91000', sessionId, clientMessageId, runId: 'run-1' });
  assert.deepEqual(result, { ok: true, claimed: false });
  assert.match(calls[1], /ON CONFLICT .* DO NOTHING/i);
});

test('submission claim accepts the first valid client message ID', async () => {
  const service = new ChatSubmissionService(async () => ({ rowCount: 1, rows: [{ id: 1 }] }));
  const result = await service.claim({ userPhone: '+91000', sessionId, clientMessageId, runId: 'run-1' });
  assert.deepEqual(result, { ok: true, claimed: true });
});
