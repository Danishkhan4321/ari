/**
 * Centralized user-facing time formatter.
 *
 * Every time a date/time is rendered to a WhatsApp message, it MUST go
 * through this helper so the user sees it in their own timezone.
 *
 * This eliminates an entire class of bugs where `Date.toLocaleTimeString(...)`
 * was called without `{ timeZone: userTz }`, making the formatter fall back
 * to the server's timezone (UTC on EC2) and off-by-N-hours rendering.
 *
 * Usage:
 *   const tf = require('../utils/time-format');
 *   const s = await tf.formatUserTime(someDate, userPhone, { mode: 'datetime' });
 *
 * If you already have the timezone string, use formatInTz() directly:
 *   tf.formatInTz(date, 'Asia/Kolkata', { mode: 'time' })
 */

const logger = require('./logger');

let timezoneService = null;
function getTimezoneService() {
  // Lazy import to avoid circular deps between messaging and timezone services.
  if (!timezoneService) timezoneService = require('../services/timezone.service');
  return timezoneService;
}

/**
 * Modes: 'time', 'date', 'datetime', 'day-date', 'weekday-date', 'relative'.
 * Locale: defaults to 'en-IN' for IST-friendly rendering.
 *
 * @param {Date|string|number} input
 * @param {string} tz IANA tz name (e.g. 'Asia/Kolkata')
 * @param {object} [opts]
 * @param {'time'|'date'|'datetime'|'day-date'|'weekday-date'} [opts.mode='datetime']
 * @param {string} [opts.locale='en-IN']
 * @returns {string}
 */
function formatInTz(input, tz, opts = {}) {
  const { mode = 'datetime', locale = 'en-IN' } = opts;
  const date = input instanceof Date ? input : new Date(input);
  if (isNaN(date.getTime())) return '';

  const baseTz = tz || 'Asia/Kolkata';

  const time = { timeZone: baseTz, hour: 'numeric', minute: '2-digit', hour12: true };
  const dateOnly = { timeZone: baseTz, day: 'numeric', month: 'short' };
  const dateYear = { timeZone: baseTz, day: 'numeric', month: 'short', year: 'numeric' };
  const weekdayShort = { timeZone: baseTz, weekday: 'short', day: 'numeric', month: 'short' };
  const weekdayLong = { timeZone: baseTz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };

  try {
    switch (mode) {
      case 'time':
        return date.toLocaleTimeString(locale, time);
      case 'date':
        return date.toLocaleDateString(locale, dateOnly);
      case 'date-year':
        return date.toLocaleDateString(locale, dateYear);
      case 'weekday-date':
        return date.toLocaleDateString(locale, weekdayShort);
      case 'weekday-long':
        return date.toLocaleDateString(locale, weekdayLong);
      case 'day-date':
        // e.g. "20 Apr, 10:30 pm" — a very common pattern in reminder/calendar output
        return `${date.toLocaleDateString(locale, dateOnly)}, ${date.toLocaleTimeString(locale, time)}`;
      case 'datetime':
      default:
        return `${date.toLocaleDateString(locale, weekdayShort)}, ${date.toLocaleTimeString(locale, time)}`;
    }
  } catch (e) {
    logger.warn(`formatInTz fallback for tz=${baseTz}: ${e.message}`);
    return date.toISOString();
  }
}

/**
 * Same as formatInTz() but looks up the user's stored timezone by phone.
 * Returns 'Asia/Kolkata' if no timezone is stored.
 *
 * @param {Date|string|number} input
 * @param {string} userPhone
 * @param {object} [opts] see formatInTz
 * @returns {Promise<string>}
 */
async function formatUserTime(input, userPhone, opts = {}) {
  let tz = 'Asia/Kolkata';
  if (userPhone) {
    try {
      tz = await getTimezoneService().getUserTimezone(userPhone);
    } catch (_) { /* stay on default */ }
  }
  return formatInTz(input, tz, opts);
}

/**
 * Human-friendly delta ("in 3h 12m", "in 2 days", "5 min ago", etc.).
 * Positive deltas show as "in …", negative as "… ago".
 *
 * @param {Date|string|number} input
 * @param {Date|number} [now=Date.now()]
 * @returns {string}
 */
function formatRelative(input, now = Date.now()) {
  const target = input instanceof Date ? input.getTime() : new Date(input).getTime();
  if (!Number.isFinite(target)) return '';
  const nowMs = typeof now === 'number' ? now : now.getTime();
  const diffSec = Math.round((target - nowMs) / 1000);
  const future = diffSec >= 0;
  const abs = Math.abs(diffSec);

  let str;
  if (abs < 60) str = `${abs}s`;
  else if (abs < 3600) str = `${Math.round(abs / 60)}m`;
  else if (abs < 86400) {
    const h = Math.floor(abs / 3600);
    const m = Math.round((abs % 3600) / 60);
    str = m > 0 ? `${h}h ${m}m` : `${h}h`;
  } else if (abs < 86400 * 7) str = `${Math.round(abs / 86400)}d`;
  else if (abs < 86400 * 30) str = `${Math.round(abs / (86400 * 7))}w`;
  else str = `${Math.round(abs / (86400 * 30))}mo`;

  return future ? `in ${str}` : `${str} ago`;
}

module.exports = {
  formatInTz,
  formatUserTime,
  formatRelative
};
