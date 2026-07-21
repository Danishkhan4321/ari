'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const meetingActions = require('../src/services/meeting-actions.service');
const { parseSelection, actionItemLabel, parseJsonArray } = meetingActions._internals;

test('parseSelection accepts explicit multi-select phrasing', () => {
  assert.deepEqual(parseSelection('do 1 and 3', 5), { kind: 'some', indices: [1, 3] });
  assert.deepEqual(parseSelection('create actions 1, 2', 5), { kind: 'some', indices: [1, 2] });
  assert.deepEqual(parseSelection('1 & 3', 5), { kind: 'some', indices: [1, 3] });
  assert.deepEqual(parseSelection('2', 5), { kind: 'some', indices: [2] });
  assert.deepEqual(parseSelection('karo 1', 5), { kind: 'some', indices: [1] });
});

test('parseSelection accepts all/skip variants', () => {
  assert.deepEqual(parseSelection('all', 3), { kind: 'all', indices: [] });
  assert.deepEqual(parseSelection('do all', 3), { kind: 'all', indices: [] });
  assert.deepEqual(parseSelection('sab', 3), { kind: 'all', indices: [] });
  assert.deepEqual(parseSelection('skip', 3), { kind: 'none', indices: [] });
  assert.deepEqual(parseSelection('nahi', 3), { kind: 'none', indices: [] });
  assert.deepEqual(parseSelection('not now', 3), { kind: 'none', indices: [] });
});

test('parseSelection rejects out-of-range and non-selection text', () => {
  assert.equal(parseSelection('do 9', 3), null); // out of range → not a selection
  assert.equal(parseSelection('remind me tomorrow at 9', 3), null);
  assert.equal(parseSelection('what about the budget?', 3), null);
  assert.equal(parseSelection('', 3), null);
  assert.equal(parseSelection('call me at 3 and 4 pm today please, also email raj about it', 5), null);
});

test('parseSelection dedupes and filters indices to range', () => {
  assert.deepEqual(parseSelection('do 1, 1 and 2', 2), { kind: 'some', indices: [1, 2] });
  assert.deepEqual(parseSelection('1 2 7', 3), { kind: 'some', indices: [1, 2] });
});

test('actionItemLabel handles strings and structured items', () => {
  assert.equal(actionItemLabel('Send the proposal'), 'Send the proposal');
  assert.equal(actionItemLabel({ text: 'Ship the release', assignee: 'Priya', deadline: 'Friday' }), 'Ship the release (Priya) — by Friday');
  assert.equal(actionItemLabel({ title: 'Send deck', assignee: 'Raj', deadline: 'Friday' }), 'Send deck (Raj) — by Friday');
  assert.equal(actionItemLabel({ title: 'Send deck', assignee: 'unassigned', deadline: 'none' }), 'Send deck');
  assert.equal(actionItemLabel(null), '');
});

test('parseJsonArray tolerates bad input', () => {
  assert.deepEqual(parseJsonArray('["a","b"]'), ['a', 'b']);
  assert.deepEqual(parseJsonArray('not json'), []);
  assert.deepEqual(parseJsonArray(null), []);
  assert.deepEqual(parseJsonArray('{"a":1}'), []);
});

test('resolveSelection returns null when nothing is pending', async () => {
  assert.equal(await meetingActions.resolveSelection('999000000001', 'do 1'), null);
  assert.equal(meetingActions.hasPending('999000000001'), false);
});

test('proposeFromMeeting fails open without a database', async () => {
  const proposal = await meetingActions.proposeFromMeeting('999000000001', 12345);
  assert.equal(proposal, null);
});

test('isPrepQuery matches prep phrasings and rejects noise', () => {
  assert.ok(meetingActions.isPrepQuery('prep me for my meeting with Meera'));
  assert.ok(meetingActions.isPrepQuery('prepare me for the call with Raj'));
  assert.ok(meetingActions.isPrepQuery('brief me for my 3pm meeting'));
  assert.ok(!meetingActions.isPrepQuery('prepare the quarterly report'));
  assert.ok(!meetingActions.isPrepQuery('meeting tomorrow at 5'));
  assert.ok(!meetingActions.isPrepQuery('remind me to prep dinner'));
});

test('buildPrepBrief without DB returns guidance, never throws', async () => {
  const withName = await meetingActions.buildPrepBrief('999000000001', 'prep me for my meeting with Meera');
  assert.ok(typeof withName === 'string' && withName.length > 0);
  const noName = await meetingActions.buildPrepBrief('999000000001', 'prep me for my next call');
  assert.ok(typeof noName === 'string' && noName.length > 0);
});
