/**
 * Session-scoped list position cache.
 *
 * Problem it solves: whenever Ari shows the user a numbered list
 * ("1. Foo, 2. Bar, 3. Baz"), any follow-up like "cancel 2" or
 * "apply to 2" needs to refer back to THAT list. Previously the
 * cancel handler would re-query the DB with a different ORDER BY,
 * picking the wrong row. This cache stamps the exact ordered IDs
 * the user saw, keyed by `userPhone + listType`, with a sensible TTL.
 *
 * The cache is in-memory (BoundedMap) — fine for a single-instance bot.
 * For multi-instance, swap to Redis with the same API.
 */

const BoundedMap = require('./bounded-map');
const logger = require('./logger');

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes — covers normal follow-up windows
const MAX_ENTRIES = 10000;

/**
 * @typedef {object} ListEntry
 * @property {Array<any>} items - ordered array as shown; item.id is used for resolution
 * @property {number} shownAt - Date.now() when the list was sent
 * @property {string} listType - stable discriminator, e.g. 'reminders', 'tasks', 'visa_opps'
 */

class ListPositionCache {
  constructor() {
    /** @type {BoundedMap<string, ListEntry>} */
    this._map = new BoundedMap(MAX_ENTRIES, DEFAULT_TTL_MS);
  }

  _key(userPhone, listType) {
    return `${userPhone}::${listType}`;
  }

  /**
   * Remember the exact ordered items the user just saw.
   * Items can be full row objects OR `{id, label}` shortcuts — we store
   * whatever is given, and resolvers pick from position-1 index.
   *
   * @param {string} userPhone
   * @param {string} listType
   * @param {Array<any>} items
   */
  remember(userPhone, listType, items) {
    if (!userPhone || !listType) return;
    if (!Array.isArray(items) || items.length === 0) return;
    this._map.set(this._key(userPhone, listType), {
      items: [...items],
      shownAt: Date.now(),
      listType
    });
    logger.debug({ userPhone, listType, count: items.length }, 'list-position-cache: remembered');
  }

  /**
   * Resolve an item by its 1-based position in the most recent list of this type.
   * Returns null if no cached list, TTL expired, or out-of-range.
   *
   * @param {string} userPhone
   * @param {string} listType
   * @param {number} position 1-based
   * @returns {any|null}
   */
  pick(userPhone, listType, position) {
    const entry = this._map.get(this._key(userPhone, listType));
    if (!entry) return null;
    const n = Number(position);
    if (!Number.isInteger(n) || n < 1 || n > entry.items.length) return null;
    return entry.items[n - 1] ?? null;
  }

  /**
   * Return the cached ordered items for a list type, or null if none/expired.
   */
  getItems(userPhone, listType) {
    const entry = this._map.get(this._key(userPhone, listType));
    return entry?.items ?? null;
  }

  /**
   * Look at the most recent list of ANY type for this user — useful when the
   * handler doesn't know what list the user is referring to (e.g. ambiguous
   * "cancel 2" after both a reminder list and a task list were shown).
   *
   * Returns { listType, item } for the most-recently-shown list's Nth item
   * OR null if none match.
   *
   * @param {string} userPhone
   * @param {number} position
   */
  pickFromLatest(userPhone, position) {
    let best = null;
    for (const [key, entry] of this._map) {
      if (!key.startsWith(`${userPhone}::`)) continue;
      if (!best || entry.shownAt > best.entry.shownAt) {
        best = { key, entry };
      }
    }
    if (!best) return null;
    const n = Number(position);
    if (!Number.isInteger(n) || n < 1 || n > best.entry.items.length) return null;
    return { listType: best.entry.listType, item: best.entry.items[n - 1] };
  }

  /**
   * Clear the list after an action so stale positions don't linger.
   */
  forget(userPhone, listType) {
    this._map.delete(this._key(userPhone, listType));
  }

  /**
   * Diagnostic snapshot.
   */
  describe(userPhone, listType) {
    const entry = this._map.get(this._key(userPhone, listType));
    if (!entry) return null;
    return {
      listType: entry.listType,
      count: entry.items.length,
      ageMs: Date.now() - entry.shownAt
    };
  }
}

module.exports = new ListPositionCache();
