'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  getToolDefinitions,
  getIntentForTool,
  getExplicitToolHint,
  classifyCategoryFromKeywords,
  getToolsForCategory,
} = require('../src/services/tool-definitions');
const { createContactGroupService, phoneCandidates, canonicalWritePhone } = require('../src/services/contact-group.service');
const { createContactGroupHandler } = require('../src/handlers/contact-group.handler');

test('manage_contact_groups tool is defined and mapped to its intent', () => {
  const tool = getToolDefinitions().find((t) => t.function.name === 'manage_contact_groups');
  assert.ok(tool, 'tool must exist');
  assert.deepEqual(tool.function.parameters.required, ['full_text', 'action']);
  assert.equal(getIntentForTool('manage_contact_groups'), 'contact_group_manage');
  assert.ok(tool.function.parameters.properties.action.enum.includes('sync_from_file'),
    'the agent needs one native bulk call for a complete workbook');
  assert.ok(tool.function.parameters.properties.file_name,
    'the bulk action must identify the attached workbook without passing rows through the model');
});

test('the greencardguide request reaches the tool through category subsetting', () => {
  const category = classifyCategoryFromKeywords('i want you to create a group in our crm named lead for greencardguide');
  assert.equal(category, 'sales');
  const names = getToolsForCategory(category).map((t) => t.function.name);
  assert.ok(names.includes('manage_contact_groups'), `sales subset must include the group tool, got: ${names.join(', ')}`);
});

test('contact-group phrasings classify to the sales category', () => {
  assert.equal(classifyCategoryFromKeywords('show my contact groups'), 'sales');
  assert.equal(classifyCategoryFromKeywords('make a group of leads for the webinar'), 'sales');
});

test('an attached CRM workbook routes straight to one native group sync', () => {
  const hints = { hasDocumentAttachment: true };
  assert.equal(
    getExplicitToolHint('create CRM groups from every tab and add all contacts from this spreadsheet', hints),
    'manage_contact_groups',
  );
});

test('the contact_group_manage handler is registered', () => {
  const registry = require('../src/handlers');
  assert.ok(registry.has('contact_group_manage'));
});

test('createGroup writes the canonical phone and dedupes by name', async () => {
  const queries = [];
  const fake = {
    rows: [],
    async query(sql, params) { queries.push({ sql, params }); return this.next.shift() || { rows: [] }; },
    next: [],
  };
  const service = createContactGroupService({ queryFn: fake.query.bind(fake) });

  // 4 schema statements, then SELECT (no existing), then INSERT.
  fake.next = [
    { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
    { rows: [] },
    { rows: [{ id: 7, name: 'greencardguide', emoji: null }] },
  ];
  const created = await service.createGroup('919035380366', 'greencardguide');
  assert.equal(created.existed, false);
  assert.equal(created.group.id, 7);
  const insert = queries.find((q) => q.sql.includes('INSERT INTO contact_groups'));
  assert.ok(insert, 'must insert the group');
  assert.equal(insert.params[1], 'greencardguide');

  // Existing group with a plus-prefixed row (dashboard-created) is found.
  fake.next = [{ rows: [{ id: 7, name: 'greencardguide', emoji: null }] }];
  const again = await service.createGroup('919035380366', 'GreenCardGuide');
  assert.equal(again.existed, true);
  assert.equal(again.group.id, 7);
  const select = queries.filter((q) => q.sql.includes('SELECT id, name, emoji FROM contact_groups')).pop();
  assert.ok(select.params[0].includes('919035380366'), 'matches bare digits');
  assert.ok(select.params[0].includes('+919035380366'), 'matches plus-prefixed dashboard rows');
});

test('concurrent group creation reuses the normalized winner instead of returning a duplicate', async () => {
  const queries = [];
  const responses = [
    { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [{ id: 8, name: 'Founders', emoji: null }] },
  ];
  const service = createContactGroupService({
    queryFn: async (sql, params) => {
      queries.push({ sql, params });
      return responses.shift() || { rows: [] };
    },
  });

  const result = await service.createGroup('+919035380366', ' founders ');
  assert.equal(result.existed, true);
  assert.equal(result.group.id, 8);
  assert.match(queries.find((query) => query.sql.includes('INSERT INTO contact_groups')).sql,
    /ON CONFLICT DO NOTHING/i);
  assert.equal(queries.filter((query) => query.sql.includes('SELECT id, name, emoji')).length, 2,
    'a uniqueness race must re-read the winning row');
});

test('phone candidates cover both bot and dashboard formats', () => {
  assert.deepEqual(phoneCandidates('919035380366'), ['919035380366', '+919035380366']);
  assert.deepEqual(phoneCandidates('+919035380366'), ['+919035380366', '919035380366']);
});

test('canonicalWritePhone normalizes every identity to digits-only', () => {
  // Digits-only is the single canonical key: the WhatsApp webhook and the
  // dashboard->bot bridge both strip non-digits before writing, and the
  // desktop session now reads digits-only too. Writing a '+'-prefixed form
  // (the previous behavior) made agent-written rows invisible to the UI.
  const previous = process.env.ARI_DESKTOP_USER_PHONE;
  process.env.ARI_DESKTOP_USER_PHONE = '+919035380366';
  try {
    assert.equal(canonicalWritePhone('919035380366'), '919035380366');
    assert.equal(canonicalWritePhone('+919035380366'), '919035380366', 'a formatted key is normalized');
    assert.equal(canonicalWritePhone('918888888888'), '918888888888', 'other users are untouched');
  } finally {
    if (previous === undefined) delete process.env.ARI_DESKTOP_USER_PHONE;
    else process.env.ARI_DESKTOP_USER_PHONE = previous;
  }
});

test('adding members uses exact names and reports inserted, existing, and missing separately', async () => {
  const queries = [];
  const fake = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('CREATE TABLE') || sql.includes('CREATE INDEX')) return { rows: [] };
      if (sql.includes('FROM contact_groups')) return { rows: [{ id: 3, name: 'greencardguide', emoji: null }] };
      if (sql.includes('FROM sales_leads')) {
        return params[1] === 'Priya Shah' ? { rows: [{ id: 21, name: 'Priya Shah' }] } : { rows: [] };
      }
      if (sql.includes('FROM contacts')) return { rows: [] };
      if (sql.includes('INSERT INTO contact_group_members')) return { rows: [{ id: 31 }] };
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
  const service = createContactGroupService({ queryFn: fake.query.bind(fake) });
  const result = await service.addMembersByNames(
    '919035380366',
    'greencardguide',
    ['Priya Shah', 'Priya', 'Nobody Realman'],
  );
  assert.deepEqual(result.added, ['Priya Shah']);
  assert.deepEqual(result.existing, []);
  assert.deepEqual(result.notFound, ['Priya', 'Nobody Realman']);
  assert.ok(queries.filter((query) => query.sql.includes('sales_leads'))
    .every((query) => query.sql.includes('LOWER(BTRIM(name)) = LOWER(BTRIM($2))')));
  assert.ok(queries.every((query) => !query.sql.includes('ILIKE')),
    'partial-name matching must never assign the wrong person');
});

test('ambiguous exact names are never assigned automatically', async () => {
  let membershipWrites = 0;
  const fake = {
    async query(sql) {
      if (sql.includes('CREATE TABLE') || sql.includes('CREATE INDEX')) return { rows: [] };
      if (sql.includes('FROM contact_groups')) return { rows: [{ id: 3, name: 'Founders', emoji: null }] };
      if (sql.includes('FROM sales_leads')) {
        return { rows: [{ id: 21, name: 'Alex Kim' }, { id: 22, name: 'Alex Kim' }] };
      }
      if (sql.includes('FROM contacts')) return { rows: [] };
      if (sql.includes('INSERT INTO contact_group_members')) {
        membershipWrites += 1;
        return { rows: [{ id: 1 }] };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
  const service = createContactGroupService({ queryFn: fake.query.bind(fake) });
  const result = await service.addMembersByNames('919035380366', 'Founders', ['Alex Kim']);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.ambiguous, ['Alex Kim']);
  assert.equal(membershipWrites, 0);
});

test('bulk workbook action is one typed tool result with explicit checkpoint totals', async () => {
  const calls = [];
  const handler = createContactGroupHandler({
    contactGroupService: {},
    bulkService: {
      async syncFromFile(userPhone, options) {
        calls.push({ userPhone, options });
        return {
          status: 'partial', operationKey: 'a'.repeat(64), sourceName: 'contacts.xlsx',
          totalGroups: 16, completedGroups: 15, failedGroups: 1,
          totalRecords: 320, replayedGroups: 4,
          errors: [{ code: 'INVALID_MAPPING', groupName: 'CRM Group 16', retryable: false }],
          warnings: [], items: [],
        };
      },
    },
  });
  const result = await handler({ text: 'sync the file' }, {
    userPhone: '919000000001',
    agentExecution: { runtime: 'codex' },
    intentParams: {
      action: 'sync_from_file', full_text: 'sync the file', file_name: 'contacts.xlsx', retry_failed: true,
    },
  });

  assert.equal(calls.length, 1, 'the entire workbook must consume one agent tool call');
  assert.deepEqual(calls[0].options, { fileName: 'contacts.xlsx', retryFailed: true });
  assert.equal(result.status, 'partial');
  assert.equal(result.data.completedGroups, 15);
  assert.equal(result.data.failedGroups, 1);
  assert.equal(result.error.code, 'crm_bulk_partial');
  assert.match(result.user_summary, /15 of 16/i);
});

test('mixed manual member results are typed partial instead of success-leading prose', async () => {
  const handler = createContactGroupHandler({
    contactGroupService: {
      async addMembersByNames() {
        return {
          group: { id: 7, name: 'Founders' },
          added: ['Priya Shah'], existing: ['Alex Kim'],
          notFound: ['Nobody'], ambiguous: ['Sam Lee'], rejected: [],
        };
      },
    },
    bulkService: {},
  });
  const result = await handler({ text: 'add members' }, {
    userPhone: '919000000001',
    agentExecution: { runtime: 'openrouter-agent-sdk' },
    intentParams: {
      action: 'add_members', full_text: 'add members', group_name: 'Founders',
      member_names: ['Priya Shah', 'Alex Kim', 'Nobody', 'Sam Lee'],
    },
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.data.added.length, 1);
  assert.equal(result.data.existing.length, 1);
  assert.equal(result.data.ambiguous.length, 1);
  assert.equal(result.error.code, 'contact_group_members_partial');
});
