'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAgentRunService } = require('../src/services/agent-run.service');

test('persists a run, lifecycle event, and completed outcome', async () => {
  const calls = [];
  const queryFn = async (sql, params = []) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (/INSERT INTO agent_run_events/i.test(sql)) {
      return { rows: [{ id: 17, created_at: '2026-07-16T10:00:00.000Z' }] };
    }
    return { rows: [] };
  };
  const service = createAgentRunService({
    queryFn,
    idFactory: () => '11111111-1111-4111-8111-111111111111',
    ensureSchema: false,
  });

  const started = await service.startRun({
    userPhone: '919999999999',
    prompt: 'Prepare my day and follow up with Priya',
    source: 'dashboard',
  });
  assert.equal(started.runId, '11111111-1111-4111-8111-111111111111');

  const event = await service.recordEvent({
    runId: started.runId,
    userPhone: '919999999999',
    type: 'tool.started',
    step: 1,
    toolName: 'view_calendar',
    summary: 'Checking your calendar',
    payload: { unsafeToken: 'not-a-secret-field' },
  });
  assert.equal(event.id, 17);

  await service.finishRun({
    runId: started.runId,
    status: 'completed',
    steps: 2,
    model: 'test-model',
  });

  assert.equal(calls.length, 3);
  assert.match(calls[0].sql, /INSERT INTO agent_runs/i);
  assert.match(calls[1].sql, /INSERT INTO agent_run_events/i);
  assert.match(calls[2].sql, /UPDATE agent_runs/i);
  assert.match(calls[2].sql, /status = \$2::varchar/i);
  assert.match(calls[2].sql, /CASE WHEN \$2::varchar/i);
  assert.equal(calls[1].params[2], 'tool.started');
  assert.equal(calls[2].params[1], 'completed');
});

test('redacts sensitive event payload fields before persistence', async () => {
  const calls = [];
  const service = createAgentRunService({
    queryFn: async (sql, params = []) => {
      calls.push({ sql, params });
      return { rows: [{ id: 1, created_at: new Date().toISOString() }] };
    },
    ensureSchema: false,
  });

  await service.recordEvent({
    runId: '11111111-1111-4111-8111-111111111111',
    userPhone: '919999999999',
    type: 'tool.requested',
    payload: {
      recipient: 'person@example.com',
      access_token: 'secret',
      nested: { password: 'hidden', safe: 'visible' },
    },
  });

  const stored = JSON.parse(calls[0].params[6]);
  assert.equal(stored.access_token, '[REDACTED]');
  assert.equal(stored.nested.password, '[REDACTED]');
  assert.equal(stored.nested.safe, 'visible');
  assert.equal(stored.recipient, 'person@example.com');
});

test('persists waiting-for-user instead of coercing clarification to failure', async () => {
  const calls = [];
  const service = createAgentRunService({
    queryFn: async (sql, params = []) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
    ensureSchema: false,
  });

  await service.finishRun({
    runId: '11111111-1111-4111-8111-111111111111',
    status: 'waiting_for_user',
    steps: 1,
  });

  assert.equal(calls[0].params[1], 'waiting_for_user');
});

test('normalizes runtime pause tokens instead of storing them as failed', async () => {
  // agno and the legacy loop emit the short tokens; the ledger is the single
  // normalization boundary so an approval pause never becomes a failure row.
  const cases = [
    ['waiting_approval', 'waiting_for_approval'],
    ['waiting_input', 'waiting_for_user'],
    ['waiting_for_approval', 'waiting_for_approval'],
  ];
  for (const [emitted, stored] of cases) {
    const calls = [];
    const service = createAgentRunService({
      queryFn: async (sql, params = []) => {
        calls.push({ sql, params });
        return { rows: [] };
      },
      ensureSchema: false,
    });
    await service.finishRun({
      runId: '11111111-1111-4111-8111-111111111111',
      status: emitted,
      steps: 1,
    });
    assert.equal(calls[0].params[1], stored, emitted);
    assert.equal(calls[0].params[5], null, `${emitted} must not gain an error code`);
  }
});

test('marks a genuinely unknown status as failed with a diagnosable error code', async () => {
  const calls = [];
  const service = createAgentRunService({
    queryFn: async (sql, params = []) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
    ensureSchema: false,
  });

  await service.finishRun({
    runId: '11111111-1111-4111-8111-111111111111',
    status: 'exploded',
    steps: 0,
  });

  assert.equal(calls[0].params[1], 'failed');
  assert.equal(calls[0].params[5], 'invalid_status_token');
});
