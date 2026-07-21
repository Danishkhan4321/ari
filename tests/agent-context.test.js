'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDynamicContext } = require('../src/services/agent-loop.service');

test('agent loop dynamic context includes the background block when provided', () => {
  const block = '## Background context\n### Known entities in this conversation:\n• LEAD Meera Kapoor — stage: proposal, company: BlueFin';
  const out = buildDynamicContext({
    userTimezone: 'Asia/Kolkata',
    contextHints: null,
    nowIso: '2026-07-14T10:00:00.000Z',
    backgroundBlock: block,
  });
  assert.ok(out.includes('Meera Kapoor'), 'entity card should reach the agent prompt');
  assert.ok(out.includes('Asia/Kolkata'));
});

test('agent loop dynamic context omits empty background blocks', () => {
  for (const empty of ['', '   ', null, undefined]) {
    const out = buildDynamicContext({
      userTimezone: 'Asia/Kolkata',
      contextHints: null,
      nowIso: '2026-07-14T10:00:00.000Z',
      backgroundBlock: empty,
    });
    assert.ok(!out.includes('Background context'));
    assert.ok(out.includes('Current time'));
  }
});

test('agent loop dynamic context keeps workflow hints alongside background', () => {
  const out = buildDynamicContext({
    userTimezone: 'Asia/Kolkata',
    contextHints: { activeBulkEmail: true, bulkEmailRecipientCount: 4 },
    nowIso: '2026-07-14T10:00:00.000Z',
    backgroundBlock: '### Known entities in this conversation:\n• LEAD X — stage: new',
  });
  assert.ok(out.includes('ACTIVE CONTEXT'));
  assert.ok(out.includes('bulk-email draft (4 recipients)'));
  assert.ok(out.includes('Known entities'));
});
