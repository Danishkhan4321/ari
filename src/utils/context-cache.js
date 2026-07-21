/**
 * Per-user context cache — wraps the getContext() fan-out in webhook.controller.
 *
 * getContext issues 7-10 parallel DB/API calls per inbound message (memory trunk,
 * pending reminders, lists, contacts, Google connection, calendar, tasks, notes,
 * sales pipeline, etc). For rapid-fire user turns ("hi", "hi", "set reminder")
 * this is entirely redundant — the context doesn't change.
 *
 * Cache strategy:
 *  - Keyed by userPhone (universal ID with prefix: wa_/dc_/tg_/sl_/gc_)
 *  - 60s TTL (short enough that stale data is rare, long enough to catch bursts)
 *  - allowStale: true — serve stale immediately while background-revalidating,
 *    so even cache misses after expiry return fast
 *  - Max 5000 users in memory — on a t3.small this is ~25MB at typical context size
 *
 * Invalidation:
 *  - bust(userPhone) must be called after any write that changes the user's context:
 *    reminder create/update/delete, list add/remove, memory save, contact add,
 *    note save, calendar event create, sales lead update, etc.
 *  - The goal is: cache hit → stale in <5 seconds of the write, never beyond one TTL.
 */

const { LRUCache } = require('lru-cache');
const logger = require('./logger');

const DEFAULT_TTL_MS = parseInt(process.env.CONTEXT_CACHE_TTL_MS || '60000', 10);
const MAX_ENTRIES = parseInt(process.env.CONTEXT_CACHE_MAX || '5000', 10);

// Stats for /health visibility.
const stats = { hits: 0, misses: 0, stale: 0, busts: 0 };

const cache = new LRUCache({
  max: MAX_ENTRIES,
  ttl: DEFAULT_TTL_MS,
  allowStale: true,
  updateAgeOnGet: false, // Expire on wall-clock, not on read.
  noUpdateTTL: false
});

/**
 * Get-or-build context for userPhone. Fetcher is only called on cache miss.
 * Stale-while-revalidate semantics: if the entry is stale, it is returned
 * immediately while a background revalidation runs.
 *
 * @param {string} userPhone
 * @param {() => Promise<object>} fetcher - builds fresh context (the uncached version)
 * @returns {Promise<object>}
 */
async function getOrBuild(userPhone, fetcher) {
  if (!userPhone || typeof fetcher !== 'function') {
    // Degraded mode: bypass cache entirely.
    return fetcher ? fetcher() : null;
  }

  // has() honors allowStale; peek skips staleness check.
  const cached = cache.get(userPhone, { allowStale: true });
  const isStale = cached !== undefined && cache.getRemainingTTL(userPhone) <= 0;

  if (cached !== undefined && !isStale) {
    stats.hits++;
    return cached;
  }

  if (cached !== undefined && isStale) {
    // Return stale immediately, kick off background refresh.
    stats.stale++;
    refreshInBackground(userPhone, fetcher);
    return cached;
  }

  stats.misses++;
  try {
    const fresh = await fetcher();
    if (fresh !== null && fresh !== undefined) {
      cache.set(userPhone, fresh);
    }
    return fresh;
  } catch (e) {
    logger.warn(`context-cache fetcher failed for ${userPhone}: ${e.message}`);
    throw e;
  }
}

function refreshInBackground(userPhone, fetcher) {
  // Fire-and-forget revalidation. Errors are swallowed (the stale value
  // already served the request).
  Promise.resolve()
    .then(() => fetcher())
    .then(fresh => {
      if (fresh !== null && fresh !== undefined) cache.set(userPhone, fresh);
    })
    .catch(e => logger.debug(`context-cache background refresh failed for ${userPhone}: ${e.message}`));
}

/**
 * Invalidate cache for a user. Call from any write path that changes their context.
 * @param {string} userPhone
 */
function bust(userPhone) {
  if (!userPhone) return;
  cache.delete(userPhone);
  stats.busts++;
}

/**
 * Bust multiple users at once (e.g. team-scoped writes).
 * @param {string[]} userPhones
 */
function bustMany(userPhones) {
  if (!Array.isArray(userPhones)) return;
  for (const p of userPhones) bust(p);
}

function getStats() {
  const total = stats.hits + stats.misses + stats.stale;
  return {
    ...stats,
    size: cache.size,
    maxSize: MAX_ENTRIES,
    ttlMs: DEFAULT_TTL_MS,
    hitRate: total > 0 ? Math.round(((stats.hits + stats.stale) / total) * 100) / 100 : 0
  };
}

function clear() {
  cache.clear();
}

module.exports = { getOrBuild, bust, bustMany, getStats, clear };
