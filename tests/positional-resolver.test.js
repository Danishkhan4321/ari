'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const listPositionCache = require('../src/utils/list-position-cache');
const { resolve } = require('../src/services/positional-resolver.service');

test('bare numbers resolve deterministically against the most recent shown list', () => {
  const user = '917777700001';
  listPositionCache.remember(user, 'tasks', [
    { id: 41, title: 'Write launch email' },
    { id: 42, title: 'Fix the login bug' },
  ]);

  assert.deepEqual(resolve(user, '2'), {
    position: 2, listType: 'tasks', id: 42, label: 'Fix the login bug',
  });
  assert.deepEqual(resolve(user, ' #1 '), {
    position: 1, listType: 'tasks', id: 41, label: 'Write launch email',
  });
  assert.equal(resolve(user, 'number 2').id, 42);
  assert.equal(resolve(user, '5'), null, 'out-of-range positions must not guess');
  assert.equal(resolve(user, 'send an email'), null, 'non-numeric text never resolves');
  listPositionCache.forget(user, 'tasks');
});

test('the most recently shown list wins when several list types are cached', async () => {
  const user = '917777700002';
  listPositionCache.remember(user, 'tasks', [{ id: 1, title: 'Task one' }]);
  // shownAt has millisecond resolution — space the two lists apart.
  await new Promise((resolveTimer) => setTimeout(resolveTimer, 5));
  listPositionCache.remember(user, 'reminders', [{ id: 9, message: 'Stand up' }]);

  const resolved = resolve(user, '1');
  assert.equal(resolved.listType, 'reminders', 'latest list must win');
  assert.equal(resolved.id, 9);
  assert.equal(resolved.label, 'Stand up');
  listPositionCache.forget(user, 'tasks');
  listPositionCache.forget(user, 'reminders');
});

test('no cached list means no resolution — the model handles it normally', () => {
  assert.equal(resolve('917777700003', '1'), null);
});
