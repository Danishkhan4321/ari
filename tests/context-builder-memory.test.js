'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const contextBuilderModule = require('../src/services/context-builder.service');
const { ContextBuilderService } = contextBuilderModule;

test('relevant context prefers the current versioned fact over a stale trunk projection', async () => {
  const service = new ContextBuilderService({
    queryFn: async (sql) => {
      if (/ari_agent_memory_fact_versions/.test(sql)) {
        return {
          rows: [{
            category: 'preferences', subject: 'user', key_name: 'favorite_color',
            value: 'teal', observed_at: '2026-07-18T10:00:00Z', expired: false,
          }],
        };
      }
      if (/memory_trunk/.test(sql)) {
        return {
          rows: [
            { category: 'preferences', key_name: 'favorite_color', value: 'blue', updated_at: '2026-07-17T10:00:00Z' },
            { category: 'preferences', key_name: 'timezone', value: 'Asia/Kolkata', updated_at: '2026-07-16T10:00:00Z' },
          ],
        };
      }
      throw new Error('unexpected query');
    },
  });

  const memories = await service._getRelevantMemories('919999999901', 'what is my favorite color?');
  const rendered = memories.map((entry) => entry.memory).join('\n');
  assert.match(rendered, /favorite color: teal/i);
  assert.doesNotMatch(rendered, /blue/i);
});

test('legacy trunk remains available when the version table has not been migrated yet', async () => {
  const service = new ContextBuilderService({
    queryFn: async (sql) => {
      if (/ari_agent_memory_fact_versions/.test(sql)) throw new Error('relation does not exist');
      return { rows: [{ category: 'personal', key_name: 'city', value: 'Pune', updated_at: new Date().toISOString() }] };
    },
  });

  const memories = await service._getRelevantMemories('919999999902', 'where do I live? city');
  assert.equal(memories[0].memory, 'city: Pune');
});
