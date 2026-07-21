'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

let bulkModule = null;
let loadError = null;
try {
  bulkModule = require('../src/services/contact-group-bulk.service');
} catch (error) {
  loadError = error;
}

function fixtureSheets(groupCount = 16, membersPerGroup = 2) {
  return [
    { name: 'Overview', rows: [['Summary']] },
    { name: 'All Contacts', rows: [['Name', 'Email Address', 'Mobile Number']] },
    ...Array.from({ length: groupCount }, (_, groupIndex) => ({
      name: `CRM Group ${String(groupIndex + 1).padStart(2, '0')}`,
      rows: [
        [`Industry ${groupIndex + 1}`],
        [`${membersPerGroup} contacts`],
        [],
        ['#', 'Name', 'Email Address', 'Mobile Number', 'Job Title / Role / Field (as provided)'],
        ...Array.from({ length: membersPerGroup }, (_, memberIndex) => [
          memberIndex + 1,
          `Person ${groupIndex + 1}-${memberIndex + 1}`,
          ` PERSON-${groupIndex + 1}-${memberIndex + 1}@Example.COM `,
          `+1 (555) ${String(groupIndex).padStart(3, '0')}-${String(memberIndex).padStart(4, '0')}`,
          `Role ${memberIndex + 1}`,
        ]),
      ],
    })),
  ];
}

test('bulk CRM workbook service is available', () => {
  assert.ifError(loadError);
  assert.ok(bulkModule);
});

test('workbook parser returns every one of 16 groups and all stable member identifiers', () => {
  const parsed = bulkModule?.parseContactWorkbookSheets?.(fixtureSheets());
  assert.equal(parsed?.groups.length, 16);
  assert.equal(parsed?.totalRecords, 32);
  assert.equal(parsed?.groups[0].records[0].email, 'person-1-1@example.com');
  assert.equal(parsed?.groups[0].records[0].phone, '15550000000');
  assert.equal(parsed?.skippedSheets.length, 2);
});

test('bulk operation key is deterministic for safe retries and changes across users', () => {
  const first = bulkModule?.contactWorkbookOperationKey?.('919000000001', 'abc123');
  const replay = bulkModule?.contactWorkbookOperationKey?.('+919000000001', 'abc123');
  const otherUser = bulkModule?.contactWorkbookOperationKey?.('919000000002', 'abc123');
  assert.equal(first, replay);
  assert.notEqual(first, otherUser);
  assert.match(first || '', /^[a-f0-9]{64}$/);
});

test('workbook parser dedupes the same person but preserves different people sharing an identifier', () => {
  const parsed = bulkModule?.parseContactWorkbookSheets?.([
    { name: 'Overview', rows: [['summary']] },
    {
      name: 'Customers',
      rows: [
        ['Generated export'],
        [],
        ['Full Name', 'E-mail', 'Phone Number', 'Job Title'],
        ['Ada Lovelace', ' ADA@example.com ', '+44 20 1234 5678', 'Engineer'],
        ['Ada Lovelace', 'ada@EXAMPLE.com', '', 'Mathematician'],
        ['Ada L.', 'ada@EXAMPLE.com', '', ''],
        ['Grace Hopper', '', '+1 (212) 555-0100', 'Admiral'],
        ['Missing Identifier', '', '', 'Unknown'],
      ],
    },
  ]);

  assert.equal(parsed?.groups.length, 1);
  assert.equal(parsed?.groups[0].records.length, 3,
    'a shared email must not collapse two differently named people into one CRM record');
  assert.equal(parsed?.groups[0].records[0].name, 'Ada Lovelace');
  assert.equal(parsed?.groups[0].records[2].phone, '12125550100');
  assert.equal(parsed?.errors.length, 1, 'invalid rows are reported, not silently discarded');
  assert.equal(parsed?.warnings.length, 1, 'shared identifiers are visible in the result report');

  assert.throws(
    () => bulkModule?.parseContactWorkbookSheets?.(fixtureSheets(3, 2), { maxGroups: 2 }),
    /group limit/i
  );
  assert.throws(
    () => bulkModule?.parseContactWorkbookSheets?.(fixtureSheets(2, 2), { maxRecords: 3 }),
    /record limit/i
  );
});

test('checkpointed bulk orchestration resumes only failed groups and reports partial failures', async () => {
  const checkpoints = new Map();
  const calls = [];
  let failSecondGroup = true;
  const checkpointStore = {
    async beginOperation() {},
    async getItem(operationKey, itemKey) {
      return checkpoints.get(`${operationKey}:${itemKey}`) || null;
    },
    async saveItem(checkpoint) {
      checkpoints.set(`${checkpoint.operationKey}:${checkpoint.itemKey}`, checkpoint);
    },
    async finishOperation() {},
  };
  const service = bulkModule?.createContactGroupBulkService?.({
    loadDocument: async () => ({ buffer: Buffer.from('same workbook'), fileName: 'contacts.xlsx' }),
    parseWorkbookBuffer: async () => bulkModule.parseContactWorkbookSheets(fixtureSheets(3, 1)),
    checkpointStore,
    syncGroup: async ({ group, itemKey }) => {
      calls.push({ group: group.name, itemKey });
      if (group.name === 'CRM Group 02' && failSecondGroup) {
        const error = new Error('invalid row mapping');
        error.code = 'INVALID_MAPPING';
        throw error;
      }
      return { groupName: group.name, membersAdded: group.records.length };
    },
    retryDelay: async () => {},
  });

  const first = await service.syncFromFile('+919000000001', { fileName: 'contacts.xlsx' });
  assert.equal(first.status, 'partial');
  assert.equal(first.completedGroups, 2);
  assert.equal(first.failedGroups, 1);
  assert.equal(first.errors[0].code, 'INVALID_MAPPING');

  failSecondGroup = false;
  const resumed = await service.syncFromFile('919000000001', { fileName: 'contacts.xlsx' });
  assert.equal(resumed.status, 'success');
  assert.equal(resumed.completedGroups, 3);
  assert.equal(resumed.replayedGroups, 2, 'completed group checkpoints are reused');
  assert.deepEqual(
    calls.map((call) => call.group),
    ['CRM Group 01', 'CRM Group 02', 'CRM Group 03', 'CRM Group 02'],
    'only the failed group is executed again'
  );
  assert.equal(new Set(calls.map((call) => call.itemKey)).size, 3, 'each group has a stable idempotency key');
});

test('checkpointed bulk orchestration retries transient failures with the same idempotency key', async () => {
  const checkpoints = new Map();
  const seenKeys = [];
  let attempts = 0;
  const service = bulkModule?.createContactGroupBulkService?.({
    loadDocument: async () => ({ buffer: Buffer.from('retry workbook'), fileName: 'retry.xlsx' }),
    parseWorkbookBuffer: async () => bulkModule.parseContactWorkbookSheets(fixtureSheets(1, 1)),
    checkpointStore: {
      async getItem(operationKey, itemKey) { return checkpoints.get(`${operationKey}:${itemKey}`) || null; },
      async saveItem(checkpoint) { checkpoints.set(`${checkpoint.operationKey}:${checkpoint.itemKey}`, checkpoint); },
    },
    syncGroup: async ({ itemKey }) => {
      attempts += 1;
      seenKeys.push(itemKey);
      if (attempts < 3) {
        const error = new Error('serialization failure');
        error.code = '40001';
        throw error;
      }
      return { membersAdded: 1 };
    },
    retryDelay: async () => {},
    maxAttempts: 3,
  });

  const result = await service.syncFromFile('919000000001');
  assert.equal(result.status, 'success');
  assert.equal(attempts, 3);
  assert.equal(new Set(seenKeys).size, 1, 'retries must reuse the idempotency key');
});

// ── checkpoint reuse must be validated against reality ──────────────────
// From a real desktop session (ed0dd6d7): the user re-uploaded a workbook and
// was told "Synchronized all 15 CRM groups and 2939 unique people ... 15
// completed checkpoint(s) were safely reused" while `show my groups` answered
// "No groups yet". An earlier import had completed, its groups were later gone,
// and the checkpoint replayed the success forever — so the file could never be
// imported again and the user was never told why.
test('a completed checkpoint whose group no longer exists is redone, not replayed', async () => {
  const checkpoints = new Map();
  const synced = [];
  // Every group is checkpointed complete from a previous run...
  const checkpointStore = {
    async beginOperation() {},
    async getItem(operationKey, itemKey) {
      return checkpoints.get(`${operationKey}:${itemKey}`)
        || { status: 'completed', operationKey, itemKey, result: { groupName: 'stale' } };
    },
    async saveItem(checkpoint) {
      checkpoints.set(`${checkpoint.operationKey}:${checkpoint.itemKey}`, checkpoint);
    },
    async finishOperation() {},
  };
  const service = bulkModule?.createContactGroupBulkService?.({
    loadDocument: async () => ({ buffer: Buffer.from('same workbook'), fileName: 'contacts.xlsx' }),
    parseWorkbookBuffer: async () => bulkModule.parseContactWorkbookSheets(fixtureSheets(3, 1)),
    checkpointStore,
    // ...but none of those groups survive in the database.
    groupExists: async () => false,
    syncGroup: async ({ group }) => {
      synced.push(group.name);
      return { groupName: group.name, membersAdded: group.records.length };
    },
    retryDelay: async () => {},
  });

  const result = await service.syncFromFile('+919000000001', { fileName: 'contacts.xlsx' });
  assert.equal(synced.length, 3, 'every vanished group must actually be re-synced');
  assert.equal(result.replayedGroups, 0, 'nothing may be reported as safely reused');
  assert.equal(result.completedGroups, 3);
  assert.equal(result.status, 'success');
});

test('a completed checkpoint whose group still exists is replayed without redoing work', async () => {
  const synced = [];
  const service = bulkModule?.createContactGroupBulkService?.({
    loadDocument: async () => ({ buffer: Buffer.from('same workbook'), fileName: 'contacts.xlsx' }),
    parseWorkbookBuffer: async () => bulkModule.parseContactWorkbookSheets(fixtureSheets(3, 1)),
    checkpointStore: {
      async beginOperation() {},
      async getItem(operationKey, itemKey) {
        return { status: 'completed', operationKey, itemKey, result: { groupName: 'kept' } };
      },
      async saveItem() {},
      async finishOperation() {},
    },
    groupExists: async () => true,
    syncGroup: async ({ group }) => { synced.push(group.name); return { groupName: group.name }; },
    retryDelay: async () => {},
  });

  const result = await service.syncFromFile('+919000000001', { fileName: 'contacts.xlsx' });
  assert.equal(synced.length, 0, 'work that is still present must not be repeated');
  assert.equal(result.replayedGroups, 3);
});

test('when the existence check itself fails the work is redone rather than assumed done', async () => {
  const synced = [];
  const service = bulkModule?.createContactGroupBulkService?.({
    loadDocument: async () => ({ buffer: Buffer.from('same workbook'), fileName: 'contacts.xlsx' }),
    parseWorkbookBuffer: async () => bulkModule.parseContactWorkbookSheets(fixtureSheets(2, 1)),
    checkpointStore: {
      async beginOperation() {},
      async getItem(operationKey, itemKey) {
        return { status: 'completed', operationKey, itemKey, result: {} };
      },
      async saveItem() {},
      async finishOperation() {},
    },
    groupExists: async () => { throw new Error('database unreachable'); },
    syncGroup: async ({ group }) => { synced.push(group.name); return { groupName: group.name }; },
    retryDelay: async () => {},
  });

  const result = await service.syncFromFile('+919000000001', { fileName: 'contacts.xlsx' });
  assert.equal(synced.length, 2, 'syncing is idempotent by name, so repeating is the safe direction');
  assert.equal(result.replayedGroups, 0);
});
