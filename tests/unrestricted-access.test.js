'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const access = require('../src/services/subscription.service');
const { getToolDefinitions } = require('../src/services/tool-definitions');
const { getRegisteredTools } = require('../src/services/tool-schemas');
const { CANONICAL_INTENTS } = require('../src/services/intent-fastpath.service');

test('all former plan and quota checks allow access without database lookups', async () => {
  const checks = await Promise.all([
    access.checkFeature('user', 'meeting_bot'),
    access.checkFreeReminderQuotaMonthly('user'),
    access.checkFreeSearchQuotaMonthly('user'),
    access.checkFreeAIChatQuotaMonthly('user'),
    access.checkFreeVoiceQuotaMonthly('user'),
    access.checkAndIncrementFriendReminder('user'),
    access.checkTeamLimit('user', 500),
  ]);

  for (const result of checks) {
    assert.equal(result.allowed, true);
    assert.equal(Object.hasOwn(result, 'upgradeMsg'), false);
  }
  assert.equal(await access.getUserPlan('user'), 'unrestricted');
});

test('subscription-plan routing and tools are removed', () => {
  const toolNames = getToolDefinitions().map((tool) => tool.function?.name).filter(Boolean);
  assert.equal(toolNames.includes('check_subscription'), false);
  assert.equal(getRegisteredTools().includes('check_subscription'), false);
  assert.equal(CANONICAL_INTENTS.some((intent) => intent.toolName === 'check_subscription'), false);
});
