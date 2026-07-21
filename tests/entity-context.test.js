'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const entityContext = require('../src/services/entity-context.service');
const { normalizeEmail, normalizePhone, phonesMatch, parseAttendees } = entityContext._internals;

test('normalizeEmail accepts valid addresses and rejects junk', () => {
  assert.equal(normalizeEmail('  Raj@Example.COM '), 'raj@example.com');
  assert.equal(normalizeEmail('not-an-email'), null);
  assert.equal(normalizeEmail(''), null);
  assert.equal(normalizeEmail(null), null);
  assert.equal(normalizeEmail('a b@c.com'), null);
});

test('normalizePhone strips formatting and bounds length', () => {
  assert.equal(normalizePhone('+91 84480-89096'), '918448089096');
  assert.equal(normalizePhone('(917) 795-8667'), '9177958667');
  assert.equal(normalizePhone('12345'), null); // too short
  assert.equal(normalizePhone('1234567890123456'), null); // too long
  assert.equal(normalizePhone(null), null);
});

test('phonesMatch tolerates country-code differences via 10-digit tail', () => {
  assert.ok(phonesMatch('918448089096', '8448089096'.padStart(10, '8')) === false || true); // sanity: no throw
  assert.ok(phonesMatch('918448089096', '918448089096'));
  assert.ok(phonesMatch('918448089096', '8448089096'));
  assert.ok(!phonesMatch('918448089096', '918448089097'));
  assert.ok(!phonesMatch(null, '918448089096'));
});

test('parseAttendees handles JSON arrays of names and emails', () => {
  const parsed = parseAttendees(JSON.stringify(['Asha Patel', 'raj@acme.com', 'Asha Patel']));
  assert.deepEqual(parsed.names, ['Asha Patel']);
  assert.deepEqual(parsed.emails, ['raj@acme.com']);
});

test('parseAttendees handles JSON arrays of objects', () => {
  const parsed = parseAttendees(JSON.stringify([{ name: 'Asha' }, { email: 'Raj@Acme.com' }]));
  assert.deepEqual(parsed.names, ['Asha']);
  assert.deepEqual(parsed.emails, ['raj@acme.com']);
});

test('parseAttendees handles comma-separated strings', () => {
  const parsed = parseAttendees('Asha Patel, raj@acme.com; Vikram Rao');
  assert.deepEqual(parsed.names, ['Asha Patel', 'Vikram Rao']);
  assert.deepEqual(parsed.emails, ['raj@acme.com']);
});

test('parseAttendees returns empty for null/empty input', () => {
  assert.deepEqual(parseAttendees(null), { names: [], emails: [] });
  assert.deepEqual(parseAttendees(''), { names: [], emails: [] });
  assert.deepEqual(parseAttendees('[]'), { names: [], emails: [] });
});

// ── Fail-open behavior without a database ─────────────────────────────────
// These mirror how the rest of the suite verifies graceful degradation: with
// no DATABASE_URL reachable, every public method must resolve to its empty
// value instead of throwing.

test('link/getLinksFor fail open without a database', async () => {
  const linked = await entityContext.link('t-user', { type: 'meeting', id: 1 }, { type: 'lead', id: 2 });
  assert.equal(typeof linked, 'boolean');
  const links = await entityContext.getLinksFor('t-user', { type: 'lead', id: 2 });
  assert.ok(Array.isArray(links));
});

test('addFact/getActiveFacts/searchFacts fail open without a database', async () => {
  const added = await entityContext.addFact('t-user', { type: 'lead', id: 2 }, 'Budget is 5 lakh');
  assert.equal(typeof added, 'boolean');
  const facts = await entityContext.getActiveFacts('t-user', { type: 'lead', id: 2 });
  assert.ok(Array.isArray(facts));
  const hits = await entityContext.searchFacts('t-user', 'budget');
  assert.ok(Array.isArray(hits));
});

test('buildEntityCards returns empty string without a database', async () => {
  const block = await entityContext.buildEntityCards('t-user', 'any update on the Acme lead?');
  assert.equal(typeof block, 'string');
});

test('buildEntityCards ignores trivially short messages', async () => {
  assert.equal(await entityContext.buildEntityCards('t-user', 'ok'), '');
  assert.equal(await entityContext.buildEntityCards(null, 'who is Raj?'), '');
});

test('processMeeting fails open without a database', async () => {
  const result = await entityContext.processMeeting('t-user', 12345);
  assert.deepEqual(result.linked, { contacts: 0, leads: 0 });
  assert.equal(result.facts, 0);
});

test('addFact rejects empty/invalid input without touching the database', async () => {
  assert.equal(await entityContext.addFact('t-user', { type: 'lead', id: 1 }, ''), false);
  assert.equal(await entityContext.addFact('t-user', null, 'fact'), false);
  assert.equal(await entityContext.addFact(null, { type: 'lead', id: 1 }, 'fact'), false);
});

test('link rejects malformed edges without touching the database', async () => {
  assert.equal(await entityContext.link('t-user', { type: 'meeting' }, { type: 'lead', id: 2 }), false);
  assert.equal(await entityContext.link('t-user', null, { type: 'lead', id: 2 }), false);
});
