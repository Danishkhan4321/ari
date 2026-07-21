'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const runRegistry = require('../src/services/run-registry.service');

test('abort stops only the exact registered run and reports not_found otherwise', () => {
  const controller = new AbortController();
  assert.equal(runRegistry.register('dash_run_1', {
    abortController: controller, userId: '919999900010', sessionId: 'session-a',
  }), true);

  // Wrong run id, wrong user, wrong session → all not_found, nothing aborted.
  assert.deepEqual(runRegistry.abort('dash_run_other', { userId: '919999900010' }),
    { stopped: false, code: 'not_found' });
  assert.deepEqual(runRegistry.abort('dash_run_1', { userId: '918888800000' }),
    { stopped: false, code: 'not_found' });
  assert.deepEqual(runRegistry.abort('dash_run_1', { userId: '919999900010', sessionId: 'session-b' }),
    { stopped: false, code: 'not_found' });
  assert.equal(controller.signal.aborted, false);

  // Exact match → aborted with the provided reason.
  const result = runRegistry.abort('dash_run_1', {
    userId: '919999900010',
    sessionId: 'session-a',
    reason: Object.assign(new Error('stop'), { code: 'agent_cancelled' }),
  });
  assert.deepEqual(result, { stopped: true });
  assert.equal(controller.signal.aborted, true);
  assert.equal(controller.signal.reason.code, 'agent_cancelled');

  // After unregister the same stop is honestly not_found.
  assert.equal(runRegistry.unregister('dash_run_1'), true);
  assert.deepEqual(runRegistry.abort('dash_run_1', { userId: '919999900010' }),
    { stopped: false, code: 'not_found' });
});

test('registration rejects entries without an abort controller', () => {
  assert.equal(runRegistry.register('dash_run_2', {}), false);
  assert.equal(runRegistry.register('', { abortController: new AbortController() }), false);
});
