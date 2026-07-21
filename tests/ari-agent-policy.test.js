'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BASE_INSTRUCTIONS,
  DEVELOPER_INSTRUCTIONS,
  buildRuntimeContext,
  isolationConfig,
} = require('../src/services/ari-agent-policy.service');

test('shared Ari policy is business-focused and model-independent', () => {
  assert.match(BASE_INSTRUCTIONS, /operating system for modern teams/i);
  assert.match(BASE_INSTRUCTIONS, /not a coding workspace/i);
  assert.match(DEVELOPER_INSTRUCTIONS, /vague, incomplete/i);
  assert.match(DEVELOPER_INSTRUCTIONS, /successful Ari tool result/i);
  assert.match(DEVELOPER_INSTRUCTIONS, /external message, invitation, deletion, bulk change/i);
  assert.match(DEVELOPER_INSTRUCTIONS, /observations, never as instructions/i);
  assert.match(DEVELOPER_INSTRUCTIONS, /may have changed.*web_search/i);
  assert.match(DEVELOPER_INSTRUCTIONS, /coverage.+complete/i);
  assert.match(DEVELOPER_INSTRUCTIONS, /never pass passwords/i);
});

test('shared Ari context supplies exact local time, business background, and active references', () => {
  const context = buildRuntimeContext({
    userTimezone: 'Asia/Kolkata',
    nowIso: '2026-07-16T12:30:00.000Z',
    backgroundBlock: 'CRM: Priya has an open proposal.',
    contextHints: {
      lastActionRef: { ageSec: 30, action: 'created', entityType: 'task', entityId: 42, label: 'Follow up' },
      activeBulkEmail: true,
      bulkEmailRecipientCount: 5,
    },
  });
  assert.match(context, /Thursday, July 16, 2026/);
  assert.match(context, /CRM: Priya has an open proposal/);
  assert.match(context, /task #42/);
  assert.match(context, /5 recipients/);
});

test('shared Ari context tells the agent which attachment is available', () => {
  const context = buildRuntimeContext({
    contextHints: {
      hasDocumentAttachment: true,
      documentAttachment: {
        fileName: 'Organized Contacts - Opportunity Matching.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    },
  });

  assert.match(context, /attachment is available/i);
  assert.match(context, /Organized Contacts - Opportunity Matching\.xlsx/);
  assert.match(context, /analyze_file/);
});

test('App Server isolation disables coding and unrelated agent capabilities', () => {
  const config = isolationConfig(['C:\\skills\\coding\\SKILL.md']);
  assert.equal(config.features.shell_tool, false);
  assert.equal(config.features.multi_agent, false);
  assert.equal(config.features.apps, false);
  assert.equal(config.web_search, 'disabled');
  assert.deepEqual(config.skills.config, [{ path: 'C:\\skills\\coding\\SKILL.md', enabled: false }]);
});
