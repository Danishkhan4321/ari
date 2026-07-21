'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createVersionedMemoryService,
  deriveFactParts,
  normalizeIdentifier,
} = require('../src/services/versioned-memory.service');

test('fact derivation produces a stable subject/key/value for natural corrections', () => {
  assert.deepEqual(deriveFactParts('My favorite color is teal', {}), {
    subject: 'user', key: 'favorite_color', value: 'teal',
  });
  assert.deepEqual(deriveFactParts('I prefer short email replies', { key: 'email style' }), {
    subject: 'user', key: 'email_style', value: 'I prefer short email replies',
  });
  assert.deepEqual(deriveFactParts('Rahul works at Acme', { subject: 'Rahul', key: 'company' }), {
    subject: 'rahul', key: 'company', value: 'Rahul works at Acme',
  });
});

test('explicit memory save supersedes the prior fact and updates the current trunk atomically', async () => {
  const calls = [];
  const client = {
    query: async (sql, params = []) => {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      if (/SELECT id[\s\S]*ari_agent_memory_fact_versions/i.test(sql)) {
        return { rows: [{ id: 41, key_name: 'favorite_color' }], rowCount: 1 };
      }
      if (/INSERT INTO ari_agent_memory_fact_versions/i.test(sql)) {
        return {
          rows: [{ id: 42, user_phone: params[0], category: params[1], subject: params[2], key_name: params[3], value: params[4] }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => calls.push({ sql: 'RELEASE', params: [] }),
  };
  const service = createVersionedMemoryService({
    pool: { connect: async () => client },
    bustContext: () => calls.push({ sql: 'BUST', params: [] }),
  });

  const saved = await service.saveExplicitFact({
    userPhone: '919999999906',
    fact: 'My favorite color is teal',
    category: 'preferences',
    key: 'favorite color',
    supersedes: 'favorite color',
    source: 'agent_tool',
    sourceRef: 'run-42:call-7',
  });

  assert.equal(saved.success, true);
  assert.equal(saved.fact.id, 42);
  assert.equal(saved.fact.key_name, 'favorite_color');
  assert.equal(saved.supersededId, 41);
  assert.equal(calls[0].sql, 'BEGIN');
  assert.ok(calls.some((call) => /SET is_current = FALSE/.test(call.sql)));
  const insert = calls.find((call) => /INSERT INTO ari_agent_memory_fact_versions/.test(call.sql));
  assert.equal(insert.params[8], 41, 'new fact links to the superseded version');
  assert.ok(calls.some((call) => /INSERT INTO memory_trunk/.test(call.sql)));
  assert.ok(calls.some((call) => call.sql === 'COMMIT'));
  assert.ok(calls.some((call) => call.sql === 'BUST'));
  assert.equal(calls.at(-1).sql, 'RELEASE');
});

test('a correction removes every superseded projection using its original category', async () => {
  const calls = [];
  const client = {
    query: async (sql, params = []) => {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      if (/SELECT id[\s\S]*ari_agent_memory_fact_versions/i.test(sql)) {
        return {
          rows: [
            { id: 50, category: 'personal', subject: 'user', key_name: 'city' },
            { id: 51, category: 'preferences', subject: 'user', key_name: 'home_city' },
          ],
          rowCount: 2,
        };
      }
      if (/INSERT INTO ari_agent_memory_fact_versions/i.test(sql)) {
        return {
          rows: [{ id: 52, category: params[1], subject: params[2], key_name: params[3], value: params[4] }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const service = createVersionedMemoryService({
    pool: { connect: async () => client },
    bustContext() {},
  });

  const saved = await service.saveExplicitFact({
    userPhone: '919999999911',
    fact: 'Mumbai',
    category: 'work',
    subject: 'user',
    key: 'home city',
    supersedes: 'city',
  });

  assert.equal(saved.success, true);
  const projectionDeletes = calls.filter((call) => /DELETE FROM memory_trunk/.test(call.sql));
  assert.deepEqual(projectionDeletes.map((call) => call.params), [
    ['919999999911', 'personal', 'city'],
    ['919999999911', 'preferences', 'home_city'],
  ]);
  const supersedeUpdate = calls.find((call) => /SET is_current = FALSE/.test(call.sql));
  assert.deepEqual(supersedeUpdate.params, [[50, 51]]);
});

test('memory identifiers preserve letters from non-Latin natural language', () => {
  assert.equal(normalizeIdentifier('पसंदीदा शहर'), 'पसंदीदा_शहर');
});

test('memory save rejects sensitive secrets before any database write', async () => {
  let connected = false;
  const service = createVersionedMemoryService({
    pool: { connect: async () => { connected = true; throw new Error('must not connect'); } },
  });

  const result = await service.saveExplicitFact({
    userPhone: '919999999907', fact: 'My API key is sk-secret', category: 'general', key: 'api key',
  });
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'sensitive_memory_rejected');
  assert.equal(connected, false);
});

test('transaction failure rolls back and never reports a saved fact', async () => {
  const statements = [];
  const client = {
    query: async (sql) => {
      statements.push(String(sql).trim());
      if (/INSERT INTO ari_agent_memory_fact_versions/.test(sql)) throw new Error('write failed');
      return { rows: [], rowCount: 0 };
    },
    release: () => statements.push('RELEASE'),
  };
  const service = createVersionedMemoryService({ pool: { connect: async () => client } });
  const result = await service.saveExplicitFact({
    userPhone: '919999999908', fact: 'My timezone is Asia/Kolkata', category: 'preferences', key: 'timezone',
  });

  assert.equal(result.success, false);
  assert.ok(statements.some((sql) => sql === 'ROLLBACK'));
  assert.equal(statements.at(-1), 'RELEASE');
});

test('recall reads only current unexpired tenant facts and applies a bounded query', async () => {
  let received;
  const service = createVersionedMemoryService({
    pool: {
      query: async (sql, params) => {
        received = { sql: String(sql).replace(/\s+/g, ' ').trim(), params };
        return { rows: [{ id: 7, subject: 'user', key_name: 'home_city', value: 'Mumbai' }] };
      },
    },
  });

  const result = await service.recallCurrentFacts({
    userPhone: '919999999909', query: 'home city', limit: 500,
  });
  assert.equal(result.success, true);
  assert.equal(result.facts[0].value, 'Mumbai');
  assert.match(received.sql, /is_current = TRUE/i);
  assert.match(received.sql, /valid_until IS NULL OR valid_until > NOW/i);
  assert.equal(received.params[0], '919999999909');
  assert.equal(received.params.at(-1), 100, 'recall limit is bounded');
});

test('forget marks the current fact non-current and removes its projection atomically', async () => {
  const calls = [];
  const client = {
    query: async (sql, params = []) => {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      if (/UPDATE ari_agent_memory_fact_versions[\s\S]*RETURNING/i.test(sql)) {
        return { rows: [{ id: 8, category: 'personal', subject: 'user', key_name: 'home_city' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => calls.push({ sql: 'RELEASE', params: [] }),
  };
  const service = createVersionedMemoryService({
    pool: { connect: async () => client },
    bustContext: () => calls.push({ sql: 'BUST', params: [] }),
  });

  const result = await service.forgetCurrentFact({
    userPhone: '919999999910', key: 'home city', subject: 'user',
  });
  assert.equal(result.success, true);
  assert.equal(result.forgotten, 1);
  assert.ok(calls.some((call) => /SET is_current = FALSE/.test(call.sql)));
  assert.ok(calls.some((call) => /DELETE FROM memory_trunk/.test(call.sql)));
  assert.ok(calls.some((call) => call.sql === 'COMMIT'));
  assert.equal(calls.at(-1).sql, 'RELEASE');
});
