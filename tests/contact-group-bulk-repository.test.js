'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

let repositoryModule = null;
let loadError = null;
try {
  repositoryModule = require('../src/services/contact-group-bulk.repository');
} catch (error) {
  loadError = error;
}

function marker(text) {
  const match = String(text).match(/\/\*\s*(crm-bulk:[a-z-]+)\s*\*\//i);
  return match?.[1] || String(text).trim().toUpperCase();
}

function createScriptedPool(overrides = {}) {
  const clientCalls = [];
  const poolCalls = [];
  let released = false;

  async function responseFor(call, source) {
    const key = marker(call.text);
    const override = overrides[key];
    if (override instanceof Error) throw override;
    if (typeof override === 'function') return override(call, source);
    if (override) return override;

    if (key === 'crm-bulk:group-upsert') {
      return { rows: [{ id: 7, created: true }], rowCount: 1 };
    }
    if (key === 'crm-bulk:completed-item') return { rows: [], rowCount: 0 };
    if (key === 'crm-bulk:match-leads' || key === 'crm-bulk:match-contacts') {
      return { rows: [], rowCount: 0 };
    }
    if (key === 'crm-bulk:insert-leads') return { rows: [], rowCount: 0 };
    if (key === 'crm-bulk:remove-members') return { rows: [], rowCount: 0 };
    if (key === 'crm-bulk:add-members') {
      return { rows: [], rowCount: Array.isArray(call.params?.[1]) ? call.params[1].length : 0 };
    }
    if (key === 'crm-bulk:get-item') return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 1 };
  }

  const client = {
    async query(text, params = []) {
      const call = { text: String(text), params };
      clientCalls.push(call);
      return responseFor(call, 'client');
    },
    release() { released = true; },
  };
  const pool = {
    async connect() { return client; },
    async query(text, params = []) {
      const call = { text: String(text), params };
      poolCalls.push(call);
      return responseFor(call, 'pool');
    },
  };
  return {
    pool,
    clientCalls,
    poolCalls,
    wasReleased: () => released,
  };
}

function syncInput(records) {
  return {
    operationKey: 'a'.repeat(64),
    itemKey: 'b'.repeat(64),
    idempotencyKey: 'b'.repeat(64),
    userPhone: '919000000001',
    userIdentity: '919000000001',
    sourceHash: 'c'.repeat(64),
    sourceName: 'contacts.xlsx',
    totalGroups: 16,
    totalRecords: records.length,
    attempt: 1,
    group: { name: 'Customers', records },
  };
}

test('PostgreSQL bulk repository module is available', () => {
  assert.ifError(loadError);
  assert.equal(typeof repositoryModule?.createContactGroupBulkRepository, 'function');
});

test('syncGroup matches exact normalized identifier plus name and checkpoints atomically', async () => {
  const scripted = createScriptedPool({
    'crm-bulk:match-leads': {
      rows: [{ id: 11, name: 'Alice Smith', email: 'shared@example.com', phone: '111' }],
      rowCount: 1,
    },
    'crm-bulk:match-contacts': {
      rows: [{ id: 22, name: 'Bob Jones', email: null, phone: '333' }],
      rowCount: 1,
    },
    'crm-bulk:insert-leads': {
      rows: [
        { id: 31, name: 'Alicia Smith', email: 'shared@example.com', phone: '222' },
        { id: 32, name: 'Carol White', email: 'carol@example.com', phone: '444' },
      ],
      rowCount: 2,
    },
    'crm-bulk:remove-members': { rows: [{ id: 99 }], rowCount: 1 },
  });
  const repository = repositoryModule?.createContactGroupBulkRepository?.({ pool: scripted.pool });
  const input = syncInput([
    { name: ' Alice   Smith ', email: 'SHARED@example.com', phone: '111', title: 'CEO' },
    { name: 'Alicia Smith', email: 'shared@example.com', phone: '222', title: 'CFO' },
    { name: 'Bob Jones', email: '', phone: '+333', title: 'Engineer' },
    { name: 'Carol White', email: 'carol@example.com', phone: '444', title: 'Founder' },
  ]);

  const result = await repository.syncGroup(input);

  assert.equal(result.groupId, 7);
  assert.equal(result.contactsCreated, 2);
  assert.equal(result.contactsMatched, 2);
  assert.equal(result.membersAdded, 4);
  assert.equal(result.membersRemoved, 1);
  assert.equal(result.recordsSkipped, 0);
  assert.equal(scripted.wasReleased(), true);

  const calls = scripted.clientCalls;
  const keys = calls.map((call) => marker(call.text));
  assert.equal(keys[0], 'BEGIN');
  assert.ok(keys.indexOf('crm-bulk:complete-item') > keys.indexOf('crm-bulk:add-members'));
  assert.ok(keys.indexOf('crm-bulk:complete-item') < keys.indexOf('COMMIT'));
  assert.equal(keys.at(-1), 'COMMIT');
  assert.equal(scripted.poolCalls.length, 0, 'all group writes and its completed checkpoint use one client');

  const matchSql = calls
    .filter((call) => ['crm-bulk:match-leads', 'crm-bulk:match-contacts'].includes(marker(call.text)))
    .map((call) => call.text)
    .join('\n');
  assert.match(matchSql, /LOWER\(BTRIM\(email\)\)\s*=\s*ANY/i);
  assert.match(matchSql, /regexp_replace\([^)]*phone[^)]*,\s*'\[\^0-9\]'/i);
  assert.doesNotMatch(matchSql, /\bI?LIKE\b/i, 'fuzzy matching is forbidden');

  const groupUpsert = calls.find((call) => marker(call.text) === 'crm-bulk:group-upsert');
  assert.match(groupUpsert.text, /DO UPDATE SET\s+user_phone\s*=\s*EXCLUDED\.user_phone/i,
    'a normalized group match must use the canonical dashboard owner format');

  for (const updateMarker of ['crm-bulk:update-leads', 'crm-bulk:update-contacts']) {
    const update = calls.find((call) => marker(call.text) === updateMarker);
    assert.match(update.text, /SET\s+user_phone\s*=\s*\$2/i,
      'exactly matched people must be canonicalized for dashboard reads');
    assert.equal(update.params[1], input.userPhone);
  }

  const insert = calls.find((call) => marker(call.text) === 'crm-bulk:insert-leads');
  assert.deepEqual(insert.params[2], ['Alicia Smith', 'Carol White'],
    'same email with a different exact name must create a distinct CRM person');

  const add = calls.find((call) => marker(call.text) === 'crm-bulk:add-members');
  assert.deepEqual(add.params[1], ['lead', 'lead', 'contact', 'lead']);
  assert.deepEqual(add.params[2].map(Number), [11, 31, 22, 32]);
});

test('syncGroup replays an atomically completed item without repeating CRM mutations', async () => {
  const stored = {
    groupId: 7,
    groupName: 'Customers',
    contactsCreated: 4,
    contactsMatched: 0,
    membersAdded: 4,
    membersRemoved: 0,
    recordsSkipped: 0,
  };
  const scripted = createScriptedPool({
    'crm-bulk:completed-item': {
      rows: [{ status: 'completed', result: stored }],
      rowCount: 1,
    },
  });
  const repository = repositoryModule?.createContactGroupBulkRepository?.({ pool: scripted.pool });

  const result = await repository.syncGroup(syncInput([
    { name: 'Alice', email: 'alice@example.com', phone: '', title: '' },
  ]));

  assert.deepEqual(result, { ...stored, replayed: true });
  const keys = scripted.clientCalls.map((call) => marker(call.text));
  assert.equal(keys[0], 'BEGIN');
  assert.equal(keys.at(-1), 'COMMIT');
  assert.equal(keys.includes('crm-bulk:group-upsert'), false);
  assert.equal(keys.includes('crm-bulk:insert-leads'), false);
});

test('syncGroup rolls back and releases its connection when any group mutation fails', async () => {
  const failure = new Error('serialization failure');
  failure.code = '40001';
  const scripted = createScriptedPool({ 'crm-bulk:group-upsert': failure });
  const repository = repositoryModule?.createContactGroupBulkRepository?.({ pool: scripted.pool });

  await assert.rejects(
    repository.syncGroup(syncInput([
      { name: 'Alice', email: 'alice@example.com', phone: '', title: '' },
    ])),
    (error) => error === failure
  );

  const keys = scripted.clientCalls.map((call) => marker(call.text));
  assert.equal(keys.includes('ROLLBACK'), true);
  assert.equal(keys.includes('COMMIT'), false);
  assert.equal(scripted.wasReleased(), true);
});

test('long workbook roles fit the live title column without losing the full text', async () => {
  const longRole = `Outreach Care Specialist: ${'population health and advocacy '.repeat(12)}`;
  const scripted = createScriptedPool({
    'crm-bulk:insert-leads': {
      rows: [{ id: 41, name: 'Long Role', email: 'long-role@example.com', phone: '555' }],
      rowCount: 1,
    },
  });
  const repository = repositoryModule?.createContactGroupBulkRepository?.({ pool: scripted.pool });

  const result = await repository.syncGroup(syncInput([
    { name: 'Long Role', email: 'long-role@example.com', phone: '555', title: longRole },
  ]));

  assert.equal(result.contactsCreated, 1);
  const insert = scripted.clientCalls.find((call) => marker(call.text) === 'crm-bulk:insert-leads');
  assert.equal(insert.params[6][0].length, 200, 'sales_leads.title is VARCHAR(200) in the live schema');
  assert.match(insert.params[7][0], /Imported role \/ field:/);
  assert.ok(insert.params[7][0].includes(longRole.trim()), 'the full role text must be retained in notes');
});

test('checkpointStore preserves completed items and records operation lifecycle', async () => {
  const completedResult = { groupId: 7, contactsCreated: 2, membersAdded: 2 };
  const scripted = createScriptedPool({
    'crm-bulk:get-item': {
      rows: [{ status: 'completed', result: completedResult, error: null, attempt_count: 2 }],
      rowCount: 1,
    },
  });
  const repository = repositoryModule?.createContactGroupBulkRepository?.({ pool: scripted.pool });
  const operation = syncInput([]);

  await repository.checkpointStore.beginOperation(operation);
  await repository.checkpointStore.saveItem({
    operationKey: operation.operationKey,
    itemKey: operation.itemKey,
    groupName: operation.group.name,
    status: 'running',
    attempt: 3,
    recordsTotal: 4,
  });
  const item = await repository.checkpointStore.getItem(operation.operationKey, operation.itemKey);
  await repository.checkpointStore.finishOperation({
    operationKey: operation.operationKey,
    status: 'success',
    completedGroups: 16,
    failedGroups: 0,
    totalGroups: 16,
    totalRecords: 100,
    errors: [],
  });

  assert.deepEqual(item, {
    status: 'completed',
    result: completedResult,
    error: null,
    attempt: 2,
  });
  const save = scripted.poolCalls.find((call) => marker(call.text) === 'crm-bulk:save-item');
  assert.match(save.text, /\$4::varchar\(30\)/i,
    'checkpoint status must have one explicit PostgreSQL type everywhere it is reused');
  assert.match(save.text, /WHEN\s+ari_crm_bulk_job_items\.status\s*=\s*'completed'/i,
    'a late running/failed write must not downgrade an atomic completion');
  assert.deepEqual(
    scripted.poolCalls.map((call) => marker(call.text)),
    ['crm-bulk:begin-operation', 'crm-bulk:save-item', 'crm-bulk:get-item', 'crm-bulk:finish-operation']
  );
});
