'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectCompound, sanitizePlan, planWaves, planSubtasks } = require('../src/services/compound-planner.service');

test('detectCompound flags multi-instruction requests and ignores simple ones', () => {
  assert.equal(detectCompound('add a task to review the PR and set a reminder for 6pm'), true);
  assert.equal(detectCompound('send the report to Priya and then schedule a meeting tomorrow'), true);
  assert.equal(detectCompound('show my crm groups'), false);
  assert.equal(detectCompound('what tasks do I have'), false);
  assert.equal(detectCompound('remind me to call mom and dad'), false, 'a single instruction with "and" inside is not compound');
});

test('sanitizePlan accepts a valid 2-subtask plan and rejects junk', () => {
  const original = 'add a note about the launch and set a reminder for 6pm';
  const good = sanitizePlan(JSON.stringify({
    subtasks: [
      { text: 'add a note about the launch', depends_on: [] },
      { text: 'set a reminder for 6pm', depends_on: [] },
    ],
  }), original);
  assert.equal(good.length, 2);
  assert.deepEqual(good.map((task) => task.id), [1, 2]);

  assert.equal(sanitizePlan('{"subtasks":[]}', original), null, 'planner declined → fall back');
  assert.equal(sanitizePlan('{"subtasks":[{"text":"x"}]}', original), null, 'single subtask → fall back');
  assert.equal(sanitizePlan('not json at all', original), null);
  assert.equal(sanitizePlan(JSON.stringify({
    subtasks: [{ text: 'a b' }, { text: 'c d' }],
  }), original), null, 'a plan that dropped most of the request is rejected');
});

test('planWaves orders dependencies and refuses cycles', () => {
  const waves = planWaves([
    { id: 1, text: 'a', dependsOn: [] },
    { id: 2, text: 'b', dependsOn: [] },
    { id: 3, text: 'c', dependsOn: [1, 2] },
  ]);
  assert.equal(waves.length, 2);
  assert.deepEqual(waves[0].map((task) => task.id), [1, 2]);
  assert.deepEqual(waves[1].map((task) => task.id), [3]);
});

test('planSubtasks never throws — planner failure falls back to null', async () => {
  const result = await planSubtasks('do X and do Y', {
    chatCompletion: async () => { throw new Error('provider down'); },
  });
  assert.equal(result, null);
});
