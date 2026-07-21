/**
 * Time-parsing + index-list unit tests (offline — no network, no DB, no API keys).
 *
 * Covers three previously untested pure utility modules:
 *
 *   1. src/utils/tool-validation.js
 *      - resolveAmbiguousTime: nearest-AM/PM roll-forward for bare "5"-style
 *        times, 12 AM/PM special-casing, candidate shape, input validation.
 *      - parseTimeWithDefaults: explicit am/pm parsing, 24-hour times,
 *        bare hours, roll-to-tomorrow when the time already passed, nulls
 *        for garbage.
 *      - mustBeFuture: future/past/grace-window/invalid datetime guard used
 *        before committing reminders & meetings.
 *   2. src/utils/parse-index-list.js — parseIndexList: "1 & 2", ranges,
 *      "all", ordinals, "first three", "last one", duplicates, garbage.
 *   3. src/utils/time-format.js — formatRelative with an injected `now`.
 *
 * Timezone determinism: every time function here takes an injected `now`
 * and does its math via Intl with an explicit IANA zone. We always pass
 * userPhone = null, which short-circuits to 'Asia/Kolkata' WITHOUT touching
 * the timezone service / DB (the service is lazily required only when a
 * phone is given). All expected values are computed in Asia/Kolkata
 * (UTC+05:30, no DST), so tests pass regardless of the machine's local TZ.
 *
 * Run: node --test tests/time-parsing.test.js
 */

'use strict';

// Deterministic, quiet env BEFORE any src module loads (logger reads this).
process.env.LOG_LEVEL = 'silent';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { resolveAmbiguousTime, parseTimeWithDefaults, mustBeFuture } =
  require('../src/utils/tool-validation');
const { parseIndexList } = require('../src/utils/parse-index-list');
const { formatRelative } = require('../src/utils/time-format');

// ── IST helpers (Asia/Kolkata = UTC+05:30, fixed offset, no DST) ───────────

/** Build a UTC Date whose IST wall-clock reads y-mo-d h:mi:00. */
function ist(y, mo, d, h, mi) {
  return new Date(Date.UTC(y, mo - 1, d, h, mi, 0) - 5.5 * 3600 * 1000);
}

/** Decompose a Date into IST wall-clock parts (machine-TZ independent). */
function istParts(date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  const map = {};
  for (const p of dtf.formatToParts(date)) if (p.type !== 'literal') map[p.type] = p.value;
  return {
    year: +map.year, month: +map.month, day: +map.day,
    hour: +map.hour % 24, minute: +map.minute, second: +map.second
  };
}

/** Assert a Date lands on the given IST wall-clock (y, mo, d, h, mi). */
function assertIst(date, y, mo, d, h, mi, msg) {
  const p = istParts(date);
  assert.deepEqual(
    { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute },
    { year: y, month: mo, day: d, hour: h, minute: mi },
    msg
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// resolveAmbiguousTime — nearest-AM/PM roll-forward
// ═══════════════════════════════════════════════════════════════════════════

describe('resolveAmbiguousTime', () => {
  it('morning now: bare "5" resolves to 5 PM today (5 AM already passed)', async () => {
    const r = await resolveAmbiguousTime({ hour12: 5, userPhone: null, now: ist(2026, 7, 15, 9, 0) });
    assert.equal(r.picked, 'pm-today');
    assertIst(r.resolved, 2026, 7, 15, 17, 0);
    assert.equal(r.timezone, 'Asia/Kolkata');
  });

  it('evening now (8 PM): bare "5" rolls to 5 AM tomorrow', async () => {
    const r = await resolveAmbiguousTime({ hour12: 5, userPhone: null, now: ist(2026, 7, 15, 20, 0) });
    assert.equal(r.picked, 'am-tomorrow');
    assertIst(r.resolved, 2026, 7, 16, 5, 0);
  });

  it('early morning (3 AM): bare "5" stays at 5 AM today', async () => {
    const r = await resolveAmbiguousTime({ hour12: 5, userPhone: null, now: ist(2026, 7, 15, 3, 0) });
    assert.equal(r.picked, 'am-today');
    assertIst(r.resolved, 2026, 7, 15, 5, 0);
  });

  it('honours minutes: "10:30" at 9 AM → 10:30 AM today', async () => {
    const r = await resolveAmbiguousTime({ hour12: 10, minute: 30, userPhone: null, now: ist(2026, 7, 15, 9, 0) });
    assert.equal(r.picked, 'am-today');
    assertIst(r.resolved, 2026, 7, 15, 10, 30);
  });

  it('"12" at 11 AM → noon today (12 PM = 12:00, not 24:00)', async () => {
    const r = await resolveAmbiguousTime({ hour12: 12, userPhone: null, now: ist(2026, 7, 15, 11, 0) });
    assert.equal(r.picked, 'pm-today');
    assertIst(r.resolved, 2026, 7, 15, 12, 0);
  });

  it('"12" at 1 PM → midnight tonight, i.e. 12 AM tomorrow (00:00)', async () => {
    const r = await resolveAmbiguousTime({ hour12: 12, userPhone: null, now: ist(2026, 7, 15, 13, 0) });
    assert.equal(r.picked, 'am-tomorrow');
    assertIst(r.resolved, 2026, 7, 16, 0, 0);
  });

  it('returns all 4 candidates with deltas; picked is the nearest future one', async () => {
    const now = ist(2026, 7, 15, 9, 0);
    const r = await resolveAmbiguousTime({ hour12: 5, userPhone: null, now });
    assert.deepEqual(r.candidates.map(c => c.label), ['am-today', 'pm-today', 'am-tomorrow', 'pm-tomorrow']);
    for (const c of r.candidates) {
      assert.equal(c.deltaMs, c.at.getTime() - now.getTime(), `${c.label} delta consistent`);
    }
    const futures = r.candidates.filter(c => c.deltaMs > 0);
    const nearest = futures.reduce((a, b) => (a.deltaMs < b.deltaMs ? a : b));
    assert.equal(r.picked, nearest.label);
    assert.equal(r.resolved.getTime(), nearest.at.getTime());
  });

  it('rejects out-of-range hours (0, 13, NaN)', async () => {
    await assert.rejects(() => resolveAmbiguousTime({ hour12: 0, userPhone: null }), /hour12 must be 1-12/);
    await assert.rejects(() => resolveAmbiguousTime({ hour12: 13, userPhone: null }), /hour12 must be 1-12/);
    await assert.rejects(() => resolveAmbiguousTime({ hour12: NaN, userPhone: null }), /hour12 must be 1-12/);
  });

  // Regression: makeDateInTz used to compare only day-of-month in its
  // fixed-point iteration, so on the LAST day of a month an evening
  // wall-clock (>= 18:30 IST, when local rolls past midnight UTC-side)
  // converged to the same day-of-month in the NEXT month — "8" asked on the
  // morning of Jul 31 skipped 8 PM tonight and scheduled 8 AM Aug 1, with a
  // pm-today candidate dated AUG 31. Fixed Jul 2026 (full-date delta).
  it('month-end evening candidate stays in the same month (regression)', async () => {
    const r = await resolveAmbiguousTime({ hour12: 8, userPhone: null, now: ist(2026, 7, 31, 9, 0) });
    const pmToday = r.candidates.find(c => c.label === 'pm-today');
    assertIst(pmToday.at, 2026, 7, 31, 20, 0, 'pm-today must be tonight, not next month');
    // Nearest future slot from 9 AM is 8 PM tonight.
    assert.equal(r.picked, 'pm-today');
    assertIst(r.resolved, 2026, 7, 31, 20, 0);
  });

  it('year-end evening works too (Dec 31 → same day, not Jan 31)', async () => {
    const r = await resolveAmbiguousTime({ hour12: 9, userPhone: null, now: ist(2026, 12, 31, 10, 0) });
    assert.equal(r.picked, 'pm-today');
    assertIst(r.resolved, 2026, 12, 31, 21, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// parseTimeWithDefaults — string → nearest/explicit datetime
// ═══════════════════════════════════════════════════════════════════════════

describe('parseTimeWithDefaults', () => {
  it('explicit "10:30 am" before 10:30 → today, not ambiguous', async () => {
    const r = await parseTimeWithDefaults('10:30 am', null, ist(2026, 7, 15, 9, 0));
    assert.equal(r.ambiguous, false);
    assert.equal(r.picked, 'today');
    assert.equal(r.timezone, 'Asia/Kolkata');
    assertIst(r.resolved, 2026, 7, 15, 10, 30);
  });

  it('explicit "10:30pm" (no space) → 22:30 today', async () => {
    const r = await parseTimeWithDefaults('10:30pm', null, ist(2026, 7, 15, 9, 0));
    assert.equal(r.ambiguous, false);
    assertIst(r.resolved, 2026, 7, 15, 22, 30);
  });

  it('explicit "10:30 am" AFTER 10:30 rolls to tomorrow', async () => {
    const r = await parseTimeWithDefaults('10:30 am', null, ist(2026, 7, 15, 11, 0));
    assert.equal(r.picked, 'tomorrow');
    assertIst(r.resolved, 2026, 7, 16, 10, 30);
  });

  it('explicit time exactly equal to now rolls to tomorrow (<= comparison)', async () => {
    const r = await parseTimeWithDefaults('10:30 am', null, ist(2026, 7, 15, 10, 30));
    assert.equal(r.picked, 'tomorrow');
    assertIst(r.resolved, 2026, 7, 16, 10, 30);
  });

  it('"12 am" maps to 00:00 (rolls to tomorrow when past)', async () => {
    const r = await parseTimeWithDefaults('12 am', null, ist(2026, 7, 15, 9, 0));
    assert.equal(r.picked, 'tomorrow');
    assertIst(r.resolved, 2026, 7, 16, 0, 0);
  });

  it('"12 pm" maps to noon, not midnight', async () => {
    const r = await parseTimeWithDefaults('12 pm', null, ist(2026, 7, 15, 9, 0));
    assert.equal(r.picked, 'today');
    assertIst(r.resolved, 2026, 7, 15, 12, 0);
  });

  it('24-hour "22:30" is unambiguous → today when still ahead', async () => {
    const r = await parseTimeWithDefaults('22:30', null, ist(2026, 7, 15, 10, 0));
    assert.equal(r.ambiguous, false);
    assert.equal(r.picked, 'today');
    assertIst(r.resolved, 2026, 7, 15, 22, 30);
  });

  it('24-hour "22:30" already past → tomorrow', async () => {
    const r = await parseTimeWithDefaults('22:30', null, ist(2026, 7, 15, 23, 0));
    assert.equal(r.picked, 'tomorrow');
    assertIst(r.resolved, 2026, 7, 16, 22, 30);
  });

  it('"5:30" (hh:mm with h<=12) treated as ambiguous → nearest future', async () => {
    const r = await parseTimeWithDefaults('5:30', null, ist(2026, 7, 15, 9, 0));
    assert.equal(r.ambiguous, true);
    assert.equal(r.picked, 'pm-today');
    assertIst(r.resolved, 2026, 7, 15, 17, 30);
  });

  it('"00:15" is remapped to ambiguous 12:15 (hour 0 → hour12 12)', async () => {
    // Documented in the code: 0..12 with minutes is treated as AMBIGUOUS.
    const r = await parseTimeWithDefaults('00:15', null, ist(2026, 7, 15, 13, 0));
    assert.equal(r.ambiguous, true);
    assert.equal(r.picked, 'am-tomorrow');
    assertIst(r.resolved, 2026, 7, 16, 0, 15);
  });

  it('bare 24-hour hour "15" → 15:00 today, not ambiguous', async () => {
    const r = await parseTimeWithDefaults('15', null, ist(2026, 7, 15, 10, 0));
    assert.equal(r.ambiguous, false);
    assertIst(r.resolved, 2026, 7, 15, 15, 0);
  });

  it('bare "3" is ambiguous and resolves nearest (3 PM when now is 9 AM)', async () => {
    const r = await parseTimeWithDefaults('3', null, ist(2026, 7, 15, 9, 0));
    assert.equal(r.ambiguous, true);
    assert.equal(r.picked, 'pm-today');
    assertIst(r.resolved, 2026, 7, 15, 15, 0);
  });

  it('returns null for garbage / unparseable input', async () => {
    const now = ist(2026, 7, 15, 9, 0);
    assert.equal(await parseTimeWithDefaults('', null, now), null);
    assert.equal(await parseTimeWithDefaults('   ', null, now), null);
    assert.equal(await parseTimeWithDefaults('abc', null, now), null);
    assert.equal(await parseTimeWithDefaults('0', null, now), null);   // hour 0 bare: rejected
    assert.equal(await parseTimeWithDefaults('24', null, now), null);  // > 23: rejected
    assert.equal(await parseTimeWithDefaults(null, null, now), null);
    assert.equal(await parseTimeWithDefaults(undefined, null, now), null);
  });

  // Regression for the makeDateInTz month-boundary bug (fixed Jul 2026):
  // "20:00" asked on the last day of July used to resolve to AUGUST 31 —
  // one month late — because the fixed-point delta compared only
  // day-of-month. Must stay on Jul 31.
  it('month-end "20:00" resolves same-day (regression)', async () => {
    const r = await parseTimeWithDefaults('20:00', null, ist(2026, 7, 31, 10, 0));
    assert.equal(r.picked, 'today');
    assertIst(r.resolved, 2026, 7, 31, 20, 0, 'must stay on Jul 31');
  });

  it('mid-month "20:00" control case resolves same-day (bug is month-end only)', async () => {
    const r = await parseTimeWithDefaults('20:00', null, ist(2026, 7, 15, 10, 0));
    assert.equal(r.picked, 'today');
    assertIst(r.resolved, 2026, 7, 15, 20, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// mustBeFuture — past-datetime guard
// ═══════════════════════════════════════════════════════════════════════════
// `now` is not injectable here (uses Date.now() internally), so offsets are
// kept far from the grace boundary to stay deterministic.

describe('mustBeFuture', () => {
  it('accepts a datetime one hour ahead', () => {
    assert.deepEqual(mustBeFuture(new Date(Date.now() + 3600 * 1000)), { ok: true });
  });

  it('rejects a datetime one hour in the past with reason + suggestion', () => {
    const r = mustBeFuture(new Date(Date.now() - 3600 * 1000), { context: 'reminder' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'past_datetime');
    assert.match(r.suggestion, /reminder is in the past/);
  });

  it('tolerates small clock skew inside the default 60s grace window', () => {
    assert.deepEqual(mustBeFuture(new Date(Date.now() - 30 * 1000)), { ok: true });
  });

  it('honours a custom graceMs', () => {
    const r = mustBeFuture(new Date(Date.now() - 30 * 1000), { graceMs: 1000 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'past_datetime');
  });

  it('rejects invalid datetimes with reason invalid_datetime', () => {
    const r1 = mustBeFuture('definitely not a date', { context: 'meeting' });
    assert.equal(r1.ok, false);
    assert.equal(r1.reason, 'invalid_datetime');
    assert.match(r1.suggestion, /meeting/);
    assert.equal(mustBeFuture(new Date(NaN)).reason, 'invalid_datetime');
  });

  it('accepts ISO strings and epoch numbers', () => {
    assert.equal(mustBeFuture(new Date(Date.now() + 86400000).toISOString()).ok, true);
    assert.equal(mustBeFuture(Date.now() + 86400000).ok, true);
    assert.equal(mustBeFuture(Date.now() - 86400000).ok, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// parseIndexList — natural-language index lists
// ═══════════════════════════════════════════════════════════════════════════

describe('parseIndexList', () => {
  it('"1 & 2" → ids [1, 2]', () => {
    assert.deepEqual(parseIndexList('1 & 2'), { ids: [1, 2], all: false });
  });

  it('"1, 2, 3" comma list', () => {
    assert.deepEqual(parseIndexList('1, 2, 3'), { ids: [1, 2, 3], all: false });
    assert.deepEqual(parseIndexList('1,2,3'), { ids: [1, 2, 3], all: false });
  });

  it('ranges: "1-3", "1 to 5", "2 through 4"', () => {
    assert.deepEqual(parseIndexList('1-3'), { ids: [1, 2, 3], all: false });
    assert.deepEqual(parseIndexList('1 to 5'), { ids: [1, 2, 3, 4, 5], all: false });
    assert.deepEqual(parseIndexList('2 through 4'), { ids: [2, 3, 4], all: false });
  });

  it('"all" variants set all:true and return no ids', () => {
    assert.deepEqual(parseIndexList('all'), { ids: [], all: true });
    assert.deepEqual(parseIndexList('cancel all'), { ids: [], all: true });
    assert.deepEqual(parseIndexList('everything'), { ids: [], all: true });
    assert.deepEqual(parseIndexList('all of them'), { ids: [], all: true });
  });

  it('"first three" / "top 2" expand from 1', () => {
    assert.deepEqual(parseIndexList('first three'), { ids: [1, 2, 3], all: false });
    assert.deepEqual(parseIndexList('top 2'), { ids: [1, 2], all: false });
  });

  it('ordinals: "the second one", "3rd one"', () => {
    assert.deepEqual(parseIndexList('the second one'), { ids: [2], all: false });
    assert.deepEqual(parseIndexList('3rd one'), { ids: [3], all: false });
  });

  it('"last one" sets last:true with empty ids', () => {
    assert.deepEqual(parseIndexList('last one'), { ids: [], all: false, last: true });
    assert.deepEqual(parseIndexList('the last'), { ids: [], all: false, last: true });
  });

  it('mixed phrasing: "delete 5 and 6"', () => {
    assert.deepEqual(parseIndexList('delete 5 and 6'), { ids: [5, 6], all: false });
  });

  it('"delete the last 2" flags last AND captures the bare integer', () => {
    assert.deepEqual(parseIndexList('delete the last 2'), { ids: [2], all: false, last: true });
  });

  it('garbage and non-string input → empty result (no last key)', () => {
    assert.deepEqual(parseIndexList('nothing relevant'), { ids: [], all: false });
    assert.deepEqual(parseIndexList(''), { ids: [], all: false });
    assert.deepEqual(parseIndexList(null), { ids: [], all: false });
    assert.deepEqual(parseIndexList(undefined), { ids: [], all: false });
    assert.deepEqual(parseIndexList(42), { ids: [], all: false });
  });

  it('duplicates collapse, output is sorted ascending', () => {
    assert.deepEqual(parseIndexList('2, 2 and 2'), { ids: [2], all: false });
    assert.deepEqual(parseIndexList('9, 3, 7'), { ids: [3, 7, 9], all: false });
    assert.deepEqual(parseIndexList('3 and 1-2'), { ids: [1, 2, 3], all: false });
  });

  it('accepts "#3" and "task 5" forms', () => {
    assert.deepEqual(parseIndexList('#3 and task 5'), { ids: [3, 5], all: false });
  });

  it('rejects 0 and numbers >= 1000, keeps 999', () => {
    assert.deepEqual(parseIndexList('0'), { ids: [], all: false });
    assert.deepEqual(parseIndexList('1000'), { ids: [], all: false });
    assert.deepEqual(parseIndexList('999'), { ids: [999], all: false });
  });

  it('over-cap range "1-100" degrades to just [1] (range span >= 50 dropped)', () => {
    // Range is rejected by MAX_RANGE; the bare-integer pass only re-captures
    // "1" (the "100" after "-" fails the boundary check). Current behaviour.
    assert.deepEqual(parseIndexList('1-100'), { ids: [1], all: false });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// formatRelative — human-friendly deltas with injected now
// ═══════════════════════════════════════════════════════════════════════════

describe('formatRelative', () => {
  const NOW = Date.UTC(2026, 0, 15, 12, 0, 0); // arbitrary fixed epoch

  it('same instant → "in 0s" (zero counts as future)', () => {
    assert.equal(formatRelative(NOW, NOW), 'in 0s');
  });

  it('seconds: "in 30s" / "45s ago"', () => {
    assert.equal(formatRelative(NOW + 30 * 1000, NOW), 'in 30s');
    assert.equal(formatRelative(NOW - 45 * 1000, NOW), '45s ago');
  });

  it('minutes: "in 10m" / "5m ago"', () => {
    assert.equal(formatRelative(NOW + 10 * 60 * 1000, NOW), 'in 10m');
    assert.equal(formatRelative(NOW - 5 * 60 * 1000, NOW), '5m ago');
  });

  it('hours with minute remainder: "in 3h 12m"; exact hours drop minutes', () => {
    assert.equal(formatRelative(NOW + (3 * 3600 + 12 * 60) * 1000, NOW), 'in 3h 12m');
    assert.equal(formatRelative(NOW + 2 * 3600 * 1000, NOW), 'in 2h');
    assert.equal(formatRelative(NOW - (1 * 3600 + 30 * 60) * 1000, NOW), '1h 30m ago');
  });

  it('days under a week: "in 1d" / "3d ago"', () => {
    assert.equal(formatRelative(NOW + 86400 * 1000, NOW), 'in 1d');
    assert.equal(formatRelative(NOW - 3 * 86400 * 1000, NOW), '3d ago');
  });

  it('weeks under a month, then months', () => {
    assert.equal(formatRelative(NOW + 14 * 86400 * 1000, NOW), 'in 2w');
    assert.equal(formatRelative(NOW - 60 * 86400 * 1000, NOW), '2mo ago');
  });

  it('accepts Date instances, ISO strings, and a Date `now`', () => {
    const target = new Date(NOW + 5 * 60 * 1000);
    assert.equal(formatRelative(target, new Date(NOW)), 'in 5m');
    assert.equal(formatRelative(target.toISOString(), NOW), 'in 5m');
  });

  it('invalid input → empty string', () => {
    assert.equal(formatRelative('garbage', NOW), '');
    assert.equal(formatRelative(new Date(NaN), NOW), '');
    assert.equal(formatRelative(undefined, NOW), '');
  });

  // NOTE: possible bug — src/utils/time-format.js:114,117 round minutes
  // without carrying into the next unit, so 59m30s+ renders as "60m" instead
  // of "1h", and 23h59m30s renders as "23h 60m" instead of "1d"/"24h".
  // Asserts CURRENT behaviour.
  it('rounding does not carry units: 3599s → "in 60m", 86399s → "23h 60m ago"', () => {
    assert.equal(formatRelative(NOW + 3599 * 1000, NOW), 'in 60m');
    assert.equal(formatRelative(NOW - 86399 * 1000, NOW), '23h 60m ago');
  });
});
