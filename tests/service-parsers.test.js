/**
 * Pure service-parser tests (offline — no network, no DB, no API keys).
 *
 * Covers the untested pure methods on three services:
 *   1. expense.service parseExpenseFromText — amount extraction ("spent 500",
 *      "₹300", "$25", "add expense 2000"), currency detection (₹/Rs/INR
 *      default, $/USD, €, £), category keyword matching, description
 *      extraction, decimals, thousands separators, and no-amount inputs.
 *   2. timezone.service pure methods — detectTimezoneFromPhone (country
 *      prefixes, US area-code longest-prefix wins, unknown-prefix fallback),
 *      resolveTimezone (city/alias → IANA, partial match, garbage → null),
 *      getFriendlyTimezoneName, isTimezoneQuery, parseTimezoneCommand.
 *      (getUserTimezone/setUserTimezone touch the DB and are NOT called.)
 *   3. follow-up.service parseFollowUpFromText — person/topic/timing
 *      extraction and graceful handling of non-matching input.
 *
 * Run: npm test   (node --test tests/*.test.js)
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

// ── Deterministic env BEFORE any src module loads ─────────────────────────
process.env.NODE_ENV = 'test';

// ── Stub the database via require cache ──
function stubModule(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsObj,
    children: [],
    parent: null,
    paths: [],
  };
  return exportsObj;
}

// All three services require ../config/database at load time. None of the
// methods under test should ever run a query — fail loudly if one does.
stubModule('../src/config/database', {
  query: async (text) => {
    throw new Error(`unexpected DB query in pure-parser test: ${String(text).slice(0, 80)}`);
  },
  pool: null,
});

// ── Modules under test (loaded AFTER the stub is installed) ───────────────
const expenseService = require('../src/services/expense.service');
const timezoneService = require('../src/services/timezone.service');
const followUpService = require('../src/services/follow-up.service');

// ═══════════════════════════════════════════════════════════════════════
// 1. expense.service — parseExpenseFromText
// ═══════════════════════════════════════════════════════════════════════

test('expense: "spent 500 on lunch" — INR default, food category, clean description', () => {
  const result = expenseService.parseExpenseFromText('spent 500 on lunch');
  assert.deepStrictEqual(result, {
    amount: 500,
    category: 'food',
    description: 'lunch',
    currency: 'INR',
  });
});

test('expense: "₹300 coffee" — rupee symbol keeps INR default, coffee → food', () => {
  const result = expenseService.parseExpenseFromText('₹300 coffee');
  assert.deepStrictEqual(result, {
    amount: 300,
    category: 'food',
    description: 'coffee',
    currency: 'INR',
  });
});

test('expense: "$25 uber" — USD detected, uber → transport', () => {
  const result = expenseService.parseExpenseFromText('$25 uber');
  assert.deepStrictEqual(result, {
    amount: 25,
    category: 'transport',
    description: 'uber',
    currency: 'USD',
  });
});

test('expense: "add expense 2000 groceries" — command verb stripped', () => {
  const result = expenseService.parseExpenseFromText('add expense 2000 groceries');
  assert.deepStrictEqual(result, {
    amount: 2000,
    category: 'groceries',
    description: 'groceries',
    currency: 'INR',
  });
});

test('expense: "Rs 300 chai" — Rs prefix parses, stays INR', () => {
  const result = expenseService.parseExpenseFromText('Rs 300 chai');
  assert.strictEqual(result.amount, 300);
  assert.strictEqual(result.currency, 'INR');
  assert.strictEqual(result.category, 'food');
  assert.strictEqual(result.description, 'chai');
});

test('expense: word currencies — dollars → USD, euros → EUR, pounds → GBP', () => {
  const usd = expenseService.parseExpenseFromText('spent 40 dollars on cab');
  assert.strictEqual(usd.currency, 'USD');
  assert.strictEqual(usd.amount, 40);
  assert.strictEqual(usd.category, 'transport');

  const eur = expenseService.parseExpenseFromText('€40 dinner');
  assert.strictEqual(eur.currency, 'EUR');
  assert.strictEqual(eur.amount, 40);
  assert.strictEqual(eur.category, 'food');

  const gbp = expenseService.parseExpenseFromText('£15 taxi');
  assert.strictEqual(gbp.currency, 'GBP');
  assert.strictEqual(gbp.amount, 15);
  assert.strictEqual(gbp.category, 'transport');
});

test('expense: "INR" / "usd" keywords respected', () => {
  const inr = expenseService.parseExpenseFromText('paid inr 750 for netflix');
  assert.strictEqual(inr.currency, 'INR');
  assert.strictEqual(inr.amount, 750);
  assert.strictEqual(inr.category, 'entertainment');

  // "50 usd taxi": no pattern matches "usd" as suffix, but the leading-number
  // fallback still recovers the amount and the currency regex catches "usd".
  const usd = expenseService.parseExpenseFromText('50 usd taxi');
  assert.strictEqual(usd.currency, 'USD');
  assert.strictEqual(usd.amount, 50);
});

test('expense: decimals parse fully — "spent 25.50 on coffee"', () => {
  const result = expenseService.parseExpenseFromText('spent 25.50 on coffee');
  assert.strictEqual(result.amount, 25.5);
  assert.strictEqual(result.category, 'food');
  assert.strictEqual(result.description, 'coffee');
});

test('expense: thousands separators parse fully (regression)', () => {
  // Regression: "1,000" used to parse as amount 1 because the amount regexes
  // stopped at the comma. Comma groups are now consumed and stripped.
  const result = expenseService.parseExpenseFromText('spent 1,000 on rent');
  assert.strictEqual(result.amount, 1000);
  assert.strictEqual(result.category, 'bills'); // 'rent' keyword
  assert.strictEqual(result.description, 'rent');

  const big = expenseService.parseExpenseFromText('paid ₹12,345.50 for insurance');
  assert.strictEqual(big.amount, 12345.5);
  assert.strictEqual(big.category, 'bills');
});

test('expense: category keywords match whole words only (regression)', () => {
  // Regression: keyword matching used String.includes, so the food keyword
  // 'chai' fired inside 'chair'. Now word-boundary matched.
  const chair = expenseService.parseExpenseFromText('spent 900 on chair');
  assert.strictEqual(chair.category, 'other');
  assert.strictEqual(chair.description, 'chair');

  // Real keyword still matches as a whole word.
  const chai = expenseService.parseExpenseFromText('spent 20 on chai');
  assert.strictEqual(chai.category, 'food');
});

test('expense: unknown keywords fall back to category "other"', () => {
  const result = expenseService.parseExpenseFromText('spent 120 on stationery');
  assert.strictEqual(result.category, 'other');
  assert.strictEqual(result.description, 'stationery');
});

test('expense: bare number with no words — category other, null description', () => {
  const result = expenseService.parseExpenseFromText('500');
  assert.deepStrictEqual(result, {
    amount: 500,
    category: 'other',
    description: null,
    currency: 'INR',
  });
});

test('expense: inputs with no amount fail gracefully (null)', () => {
  assert.strictEqual(expenseService.parseExpenseFromText('spent money on lunch'), null);
  assert.strictEqual(expenseService.parseExpenseFromText('hello there'), null);
  assert.strictEqual(expenseService.parseExpenseFromText(''), null);
});

test('expense: zero amount is rejected', () => {
  assert.strictEqual(expenseService.parseExpenseFromText('spent 0 on lunch'), null);
});

test('expense: non-string input is caught and returns null', () => {
  assert.strictEqual(expenseService.parseExpenseFromText(null), null);
});

// ═══════════════════════════════════════════════════════════════════════
// 2. timezone.service — pure methods only (no getUserTimezone/setUserTimezone)
// ═══════════════════════════════════════════════════════════════════════

test('timezone: detectTimezoneFromPhone — country prefixes', () => {
  assert.strictEqual(timezoneService.detectTimezoneFromPhone('919876543210'), 'Asia/Kolkata');
  assert.strictEqual(timezoneService.detectTimezoneFromPhone('447911123456'), 'Europe/London');
  assert.strictEqual(timezoneService.detectTimezoneFromPhone('971501234567'), 'Asia/Dubai');
});

test('timezone: detectTimezoneFromPhone strips formatting characters', () => {
  assert.strictEqual(timezoneService.detectTimezoneFromPhone('+91 98765 43210'), 'Asia/Kolkata');
});

test('timezone: US area codes win by longest prefix over bare "1"', () => {
  assert.strictEqual(timezoneService.detectTimezoneFromPhone('14155552671'), 'America/Los_Angeles');
  assert.strictEqual(timezoneService.detectTimezoneFromPhone('13035551234'), 'America/Denver');
  assert.strictEqual(timezoneService.detectTimezoneFromPhone('18085551234'), 'Pacific/Honolulu');
  // Unmapped area code falls back to the generic '1' → Eastern.
  assert.strictEqual(timezoneService.detectTimezoneFromPhone('12125551234'), 'America/New_York');
});

test('timezone: unknown prefix falls back to Asia/Kolkata', () => {
  // NOTE: the code comment at timezone.service.js:295 says "Default to UTC"
  // but the implementation returns 'Asia/Kolkata' — asserting actual behavior.
  assert.strictEqual(timezoneService.detectTimezoneFromPhone('299123456'), 'Asia/Kolkata');
  assert.strictEqual(timezoneService.detectTimezoneFromPhone(''), 'Asia/Kolkata');
});

test('timezone: resolveTimezone maps cities and aliases to IANA zones', () => {
  assert.strictEqual(timezoneService.resolveTimezone('mumbai'), 'Asia/Kolkata');
  assert.strictEqual(timezoneService.resolveTimezone('delhi'), 'Asia/Kolkata');
  assert.strictEqual(timezoneService.resolveTimezone('new york'), 'America/New_York');
  assert.strictEqual(timezoneService.resolveTimezone('london'), 'Europe/London');
  assert.strictEqual(timezoneService.resolveTimezone('ist'), 'Asia/Kolkata');
  assert.strictEqual(timezoneService.resolveTimezone('utc'), 'UTC');
});

test('timezone: resolveTimezone is case-insensitive and trims', () => {
  assert.strictEqual(timezoneService.resolveTimezone('  MUMBAI  '), 'Asia/Kolkata');
  assert.strictEqual(timezoneService.resolveTimezone('New York'), 'America/New_York');
});

test('timezone: resolveTimezone passes through anything containing "/" unvalidated', () => {
  assert.strictEqual(timezoneService.resolveTimezone('Asia/Tokyo'), 'Asia/Tokyo');
  // NOTE: possible bug — no IANA validation; garbage with a slash is returned
  // as-is (timezone.service.js:404-406). setUserTimezone validates later, but
  // direct callers of resolveTimezone get an invalid zone back.
  assert.strictEqual(timezoneService.resolveTimezone('Foo/Bar'), 'Foo/Bar');
});

test('timezone: resolveTimezone partial matching finds embedded city names', () => {
  assert.strictEqual(timezoneService.resolveTimezone('bangal'), 'Asia/Kolkata'); // prefix of bangalore
  assert.strictEqual(timezoneService.resolveTimezone('i live in tokyo'), 'Asia/Tokyo');
});

test('timezone: resolveTimezone returns null for garbage and empty input', () => {
  assert.strictEqual(timezoneService.resolveTimezone('zzzz'), null);
  assert.strictEqual(timezoneService.resolveTimezone(''), null);
  assert.strictEqual(timezoneService.resolveTimezone(null), null);
});

test('timezone: getFriendlyTimezoneName — known zones get labels, unknown pass through', () => {
  assert.strictEqual(timezoneService.getFriendlyTimezoneName('Asia/Kolkata'), 'India (IST)');
  assert.strictEqual(timezoneService.getFriendlyTimezoneName('Europe/London'), 'UK (GMT/BST)');
  assert.strictEqual(timezoneService.getFriendlyTimezoneName('America/Los_Angeles'), 'US Pacific (PST/PDT)');
  assert.strictEqual(timezoneService.getFriendlyTimezoneName('Asia/Kathmandu'), 'Asia/Kathmandu');
});

test('timezone: isTimezoneQuery recognizes queries, rejects commands and chatter', () => {
  assert.ok(timezoneService.isTimezoneQuery('what is my timezone'));
  assert.ok(timezoneService.isTimezoneQuery('my timezone'));
  assert.ok(timezoneService.isTimezoneQuery('timezone?'));
  assert.ok(timezoneService.isTimezoneQuery('tz'));
  assert.ok(!timezoneService.isTimezoneQuery('set timezone to mumbai'));
  assert.ok(!timezoneService.isTimezoneQuery('hello'));
});

test('timezone: parseTimezoneCommand extracts the target location (lowercased)', () => {
  assert.strictEqual(timezoneService.parseTimezoneCommand('set timezone to Mumbai'), 'mumbai');
  assert.strictEqual(timezoneService.parseTimezoneCommand('set my timezone to New York'), 'new york');
  assert.strictEqual(timezoneService.parseTimezoneCommand('set timezone mumbai'), 'mumbai');
  assert.strictEqual(timezoneService.parseTimezoneCommand('timezone Mumbai'), 'mumbai');
  assert.strictEqual(timezoneService.parseTimezoneCommand('change timezone to Delhi'), 'delhi');
});

test('timezone: parseTimezoneCommand returns null when there is nothing to set', () => {
  assert.strictEqual(timezoneService.parseTimezoneCommand('what is my timezone'), null);
  assert.strictEqual(timezoneService.parseTimezoneCommand('timezone?'), null);
  assert.strictEqual(timezoneService.parseTimezoneCommand('hello'), null);
});

// ═══════════════════════════════════════════════════════════════════════
// 3. follow-up.service — parseFollowUpFromText
// ═══════════════════════════════════════════════════════════════════════

test('follow-up: "Follow up with Rahul about the proposal" — name + subject, no date', () => {
  const result = followUpService.parseFollowUpFromText('Follow up with Rahul about the proposal');
  assert.strictEqual(result.contactName, 'Rahul');
  assert.strictEqual(result.subject, 'the proposal');
  assert.strictEqual(result.dueDate, null);
});

test('follow-up: multi-word names with honorifics — "Dr. Sharma regarding the deal"', () => {
  const result = followUpService.parseFollowUpFromText('follow up with Dr. Sharma regarding the deal');
  assert.strictEqual(result.contactName, 'Dr. Sharma');
  assert.strictEqual(result.subject, 'the deal');
});

test('follow-up: "check in with" phrasing works like "follow up with"', () => {
  const result = followUpService.parseFollowUpFromText('check in with Priya about pricing');
  assert.strictEqual(result.contactName, 'Priya');
  assert.strictEqual(result.subject, 'pricing');
});

test('follow-up: lowercase names still extract (case-insensitive match)', () => {
  const result = followUpService.parseFollowUpFromText('follow up with rahul about deal');
  assert.strictEqual(result.contactName, 'rahul');
  assert.strictEqual(result.subject, 'deal');
});

test('follow-up: "remind me to follow up with Sarah tomorrow" — name + tomorrow 9 AM', () => {
  const result = followUpService.parseFollowUpFromText('remind me to follow up with Sarah tomorrow');
  assert.strictEqual(result.contactName, 'Sarah');

  const expected = new Date();
  expected.setDate(expected.getDate() + 1);
  expected.setHours(9, 0, 0, 0);
  assert.ok(result.dueDate instanceof Date, 'dueDate must be a Date');
  assert.strictEqual(result.dueDate.getTime(), expected.getTime(), 'due tomorrow at 9:00 AM');

  // NOTE: possible bug — the timing word leaks into the subject; the default-
  // subject cleanup only strips "on/by/in <day>" combos, so a bare trailing
  // "tomorrow" survives (follow-up.service.js:200-211).
  assert.strictEqual(result.subject, 'tomorrow');
});

test('follow-up: "follow up with Emily on Friday" — upcoming Friday 9 AM', () => {
  const result = followUpService.parseFollowUpFromText('follow up with Emily on Friday');
  assert.strictEqual(result.contactName, 'Emily');
  assert.ok(result.dueDate instanceof Date, 'dueDate must be a Date');
  assert.strictEqual(result.dueDate.getDay(), 5, 'due on a Friday');
  assert.strictEqual(result.dueDate.getHours(), 9, 'default 9 AM');
  // On a Friday before 9 AM this resolves to TODAY 9 AM (same-day rule);
  // otherwise the next Friday — either way, within a week from now.
  const daysAhead = (result.dueDate.getTime() - Date.now()) / (24 * 3600 * 1000);
  assert.ok(daysAhead > 0 && daysAhead <= 7, `next occurrence within a week, got ${daysAhead}`);
  // NOTE: possible bug — "on" doubles as the subject separator, so the day
  // name is captured as the subject (follow-up.service.js:177-181).
  assert.strictEqual(result.subject, 'Friday');
});

test('follow-up: relative timing — "in 3 days" parses to +3 days 9 AM', () => {
  const result = followUpService.parseFollowUpFromText('follow up with Rahul about invoice in 3 days');
  assert.strictEqual(result.contactName, 'Rahul');
  assert.ok(result.subject.includes('invoice'), `subject should mention invoice: ${result.subject}`);

  const expected = new Date();
  expected.setDate(expected.getDate() + 3);
  expected.setHours(9, 0, 0, 0);
  assert.ok(result.dueDate instanceof Date);
  assert.strictEqual(result.dueDate.getTime(), expected.getTime());
});

test('follow-up: "today" defaults to 5 PM today', () => {
  const result = followUpService.parseFollowUpFromText('follow up with Amit about payment today');
  assert.ok(result.dueDate instanceof Date);
  const expected = new Date();
  expected.setHours(17, 0, 0, 0);
  assert.strictEqual(result.dueDate.getTime(), expected.getTime());
});

test('follow-up: non-matching input falls back to full text as subject', () => {
  const result = followUpService.parseFollowUpFromText('buy milk');
  assert.deepStrictEqual(result, {
    contactName: null,
    subject: 'buy milk',
    dueDate: null,
  });
});

test('follow-up: bare "follow up" gets a default subject', () => {
  const result = followUpService.parseFollowUpFromText('follow up');
  assert.strictEqual(result.contactName, null);
  assert.strictEqual(result.subject, 'Follow up');
  assert.strictEqual(result.dueDate, null);
});

test('follow-up: non-string input is caught and echoed back as the subject', () => {
  const result = followUpService.parseFollowUpFromText(null);
  assert.deepStrictEqual(result, { contactName: null, subject: null, dueDate: null });
});

// ═══════════════════════════════════════════════════════════════════════
