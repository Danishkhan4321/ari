/**
 * Runtime validation + ambiguity resolution for LLM tool parameters.
 *
 * Two main responsibilities:
 *
 * 1. Nearest-AM/PM resolver — when the user says "10:30" without AM/PM,
 *    pick the nearest FUTURE occurrence of that clock time in their
 *    local timezone. If now = 11 AM and the user says "10:30", 10:30 AM
 *    already passed so the nearest future is 10:30 PM today.
 *    If now = 9 AM, nearest future is 10:30 AM today.
 *    If now = 11 PM, nearest future is 10:30 AM TOMORROW.
 *
 * 2. Future-datetime validator — guards the LLM from committing a past
 *    datetime when the user's wording is ambiguous. Returns a structured
 *    needs-clarification result so the caller can ask the user.
 *
 * Usage:
 *
 *   const { resolveAmbiguousTime } = require('../utils/tool-validation');
 *   const out = resolveAmbiguousTime({ hour12: 10, minute: 30, userPhone });
 *   // → { resolved: Date, picked: 'pm-today', candidates: [...] }
 */

const logger = require('./logger');

// Deferred import for the USER TIMEZONE LOOKUP service (phone → IANA).
// We use this to learn WHICH tz the user is in — not for any math.
let tzSvc = null;
function getUserTzService() {
  if (!tzSvc) tzSvc = require('../services/timezone.service');
  return tzSvc;
}

/**
 * Decompose a UTC Date into wall-clock parts for a specific IANA timezone.
 * DST-safe (uses Intl.DateTimeFormat).
 */
function getZonedParts(date, timeZone) {
  // hourCycle 'h23' (not hour12:false): on Node ≤20 ICU, hour12:false maps to
  // the h24 cycle, which formats midnight as "24" — parseInt then yields
  // hour=24 and every midnight computation is off. h23 gives "00" on all
  // Node versions. Caught by tests/time-parsing.test.js failing on CI's
  // Node 20 while passing on Node 22/24.
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  const map = {};
  for (const p of dtf.formatToParts(date)) if (p.type !== 'literal') map[p.type] = p.value;
  return {
    year: parseInt(map.year), month: parseInt(map.month), day: parseInt(map.day),
    hour: parseInt(map.hour), minute: parseInt(map.minute), second: parseInt(map.second)
  };
}

/**
 * Convert a wall-clock time in a given timezone to a UTC Date.
 * Uses a small fixed-point iteration to nail DST edges.
 */
function makeDateInTz(parts, tz) {
  // Jul 2026 fix: compare FULL dates (year/month/day), not just day-of-month.
  // The old delta used `day * 24h` as an absolute quantity, so on the last day
  // of a month an evening IST time (whose UTC guess lands in the next month)
  // produced a ~30-day correction and "converged" on the same day-of-month one
  // month later — e.g. "8pm" on Jul 31 scheduled for Aug 31. Caught by
  // tests/time-parsing.test.js.
  const desiredMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0, 0);
  let guessMs = desiredMs;
  for (let i = 0; i < 3; i++) {
    const actual = getZonedParts(new Date(guessMs), tz);
    const actualMs = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second || 0, 0);
    const delta = desiredMs - actualMs;
    if (delta === 0) break;
    guessMs += delta;
  }
  return new Date(guessMs);
}

/**
 * Add N calendar days to a wall-clock parts triplet in a specific timezone.
 */
function addDaysInZone(parts, daysToAdd, tz) {
  const noonUtc = makeDateInTz({ year: parts.year, month: parts.month, day: parts.day, hour: 12, minute: 0, second: 0 }, tz);
  const shifted = new Date(noonUtc.getTime() + daysToAdd * 86400000);
  const newLocal = getZonedParts(shifted, tz);
  return { year: newLocal.year, month: newLocal.month, day: newLocal.day };
}

/**
 * Given a 12-hour clock hour+minute that the user spoke (1..12), produce
 * the nearest FUTURE Date at that clock time in the user's timezone.
 *
 * Rules (in priority order):
 *   1. If hour+minute for TODAY at AM is in the future, that's a candidate.
 *   2. If hour+minute for TODAY at PM is in the future, that's a candidate.
 *   3. If neither today candidate is in the future, add tomorrow AM + tomorrow PM.
 *   4. Return the candidate with the smallest positive delta from now.
 *
 * @param {object} opts
 * @param {number} opts.hour12 1-12 (user's spoken hour)
 * @param {number} [opts.minute=0]
 * @param {string} opts.userPhone
 * @param {Date} [opts.now=new Date()] injected for tests
 * @returns {Promise<{
 *   resolved: Date,
 *   picked: 'am-today'|'pm-today'|'am-tomorrow'|'pm-tomorrow',
 *   candidates: Array<{label: string, at: Date, deltaMs: number}>,
 *   timezone: string
 * }>}
 */
async function resolveAmbiguousTime({ hour12, minute = 0, userPhone, now = new Date() }) {
  if (!Number.isFinite(hour12) || hour12 < 1 || hour12 > 12) {
    throw new Error(`resolveAmbiguousTime: hour12 must be 1-12, got ${hour12}`);
  }

  const tz = userPhone ? await getUserTzService().getUserTimezone(userPhone) : 'Asia/Kolkata';

  // Current wall-clock parts in the user's timezone
  const nowLocal = getZonedParts(now, tz);

  // "12 AM" = 00:xx, other AM hours stay as-is. "12 PM" = 12:xx, other PM = hour+12.
  const amHour = hour12 === 12 ? 0 : hour12;
  const pmHour = hour12 === 12 ? 12 : hour12 + 12;

  const tomorrow = addDaysInZone(nowLocal, 1, tz);

  const candidates = [
    { label: 'am-today',     at: makeDateInTz({ ...nowLocal,  hour: amHour, minute }, tz) },
    { label: 'pm-today',     at: makeDateInTz({ ...nowLocal,  hour: pmHour, minute }, tz) },
    { label: 'am-tomorrow',  at: makeDateInTz({ ...tomorrow,  hour: amHour, minute }, tz) },
    { label: 'pm-tomorrow',  at: makeDateInTz({ ...tomorrow,  hour: pmHour, minute }, tz) }
  ].map(c => ({ ...c, deltaMs: c.at.getTime() - now.getTime() }));

  // Pick the smallest positive delta (nearest future)
  const future = candidates.filter(c => c.deltaMs > 0).sort((a, b) => a.deltaMs - b.deltaMs);

  if (future.length === 0) {
    // Should be impossible with tomorrow candidates, but guard anyway.
    return {
      resolved: candidates[2].at,
      picked: 'am-tomorrow',
      candidates,
      timezone: tz
    };
  }

  const best = future[0];
  logger.info({
    userPhone, hour12, minute, picked: best.label, deltaMin: Math.round(best.deltaMs / 60000), tz
  }, 'nearest-AM-PM resolved');

  return {
    resolved: best.at,
    picked: best.label,
    candidates,
    timezone: tz
  };
}

/**
 * Parse a user's raw time string and — if AM/PM is missing — return the
 * nearest future occurrence. If AM/PM is explicit, just compute and return
 * that. If hour is >=13 (24hr), just compute and return directly.
 *
 * Accepted inputs (best-effort):
 *   "10:30"   ambiguous → nearest-AM-PM
 *   "10"      ambiguous (assume :00) → nearest-AM-PM
 *   "10:30 am" / "10:30am" / "10:30 pm"  explicit
 *   "22:30"   24-hr → compute today, roll to tomorrow if already past
 *
 * @param {string} input  raw time text
 * @param {string} userPhone
 * @param {Date}   [now=new Date()]
 * @returns {Promise<{resolved: Date, picked: string, ambiguous: boolean, timezone: string} | null>}
 */
async function parseTimeWithDefaults(input, userPhone, now = new Date()) {
  const text = String(input || '').trim().toLowerCase();
  if (!text) return null;

  // explicit am/pm
  const explicit = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (explicit) {
    let h = parseInt(explicit[1], 10);
    const m = explicit[2] ? parseInt(explicit[2], 10) : 0;
    if (explicit[3] === 'am' && h === 12) h = 0;
    else if (explicit[3] === 'pm' && h < 12) h += 12;
    return computeTodayOrTomorrow(h, m, userPhone, now, /*ambiguous=*/false);
  }

  // 24-hour hh:mm
  const twentyFour = text.match(/^(\d{1,2}):(\d{2})$/);
  if (twentyFour) {
    const h = parseInt(twentyFour[1], 10);
    const m = parseInt(twentyFour[2], 10);
    if (h >= 13) {
      return computeTodayOrTomorrow(h, m, userPhone, now, /*ambiguous=*/false);
    }
    // 0..12 with minutes — treat as AMBIGUOUS and resolve nearest
    const r = await resolveAmbiguousTime({ hour12: h === 0 ? 12 : h, minute: m, userPhone, now });
    return { resolved: r.resolved, picked: r.picked, ambiguous: true, timezone: r.timezone };
  }

  // bare hour "10" or "3"
  const bareHour = text.match(/^(\d{1,2})$/);
  if (bareHour) {
    const h = parseInt(bareHour[1], 10);
    if (h >= 13 && h <= 23) return computeTodayOrTomorrow(h, 0, userPhone, now, false);
    if (h >= 1 && h <= 12) {
      const r = await resolveAmbiguousTime({ hour12: h, minute: 0, userPhone, now });
      return { resolved: r.resolved, picked: r.picked, ambiguous: true, timezone: r.timezone };
    }
  }

  return null;
}

async function computeTodayOrTomorrow(hour24, minute, userPhone, now, ambiguous) {
  const tz = userPhone ? await getUserTzService().getUserTimezone(userPhone) : 'Asia/Kolkata';
  const nowLocal = getZonedParts(now, tz);
  let target = makeDateInTz({ ...nowLocal, hour: hour24, minute }, tz);
  let picked = 'today';
  if (target.getTime() <= now.getTime()) {
    const tomorrow = addDaysInZone(nowLocal, 1, tz);
    target = makeDateInTz({ ...tomorrow, hour: hour24, minute }, tz);
    picked = 'tomorrow';
  }
  return { resolved: target, picked, ambiguous, timezone: tz };
}

/**
 * Validate a datetime is strictly in the future (with optional grace period).
 * Returns {ok: true} or {ok: false, reason, suggestion}.
 *
 * @param {Date|string|number} dt
 * @param {object} [opts]
 * @param {number} [opts.graceMs=60000] - allow up to 1min in the past (clock skew)
 * @param {string} [opts.context='datetime'] - 'reminder'|'meeting'|'scheduled_email' etc, for messaging
 * @returns {{ok: boolean, reason?: string, suggestion?: string}}
 */
function mustBeFuture(dt, opts = {}) {
  const { graceMs = 60000, context = 'datetime' } = opts;
  const d = dt instanceof Date ? dt : new Date(dt);
  if (!Number.isFinite(d.getTime())) {
    return { ok: false, reason: 'invalid_datetime', suggestion: `The ${context} value is not a valid date/time.` };
  }
  const deltaMs = d.getTime() - Date.now();
  if (deltaMs < -graceMs) {
    return {
      ok: false,
      reason: 'past_datetime',
      suggestion: `That ${context} is in the past. Did you mean a later time?`
    };
  }
  return { ok: true };
}

module.exports = {
  resolveAmbiguousTime,
  parseTimeWithDefaults,
  mustBeFuture
};
