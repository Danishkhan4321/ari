/**
 * A Map with max size limit and TTL-based expiry.
 * Prevents memory leaks from unbounded in-memory caches.
 */
class BoundedMap {
  constructor(maxSize = 10000, defaultTTL = 0) {
    this.map = new Map();
    this.maxSize = maxSize;
    this.defaultTTL = defaultTTL; // ms, 0 = no auto-expiry

    // Periodic cleanup every 5 minutes
    this._cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    this._cleanupInterval.unref(); // Don't prevent process exit
  }

  set(key, value, ttl) {
    const expiry = (ttl || this.defaultTTL) > 0
      ? Date.now() + (ttl || this.defaultTTL)
      : 0;

    this.map.set(key, { value, expiry });

    // Evict oldest entries if over max size
    if (this.map.size > this.maxSize) {
      const toDelete = this.map.size - this.maxSize;
      let count = 0;
      for (const k of this.map.keys()) {
        if (count >= toDelete) break;
        this.map.delete(k);
        count++;
      }
    }
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiry > 0 && Date.now() > entry.expiry) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  delete(key) {
    return this.map.delete(key);
  }

  get size() {
    return this.map.size;
  }

  clear() {
    this.map.clear();
  }

  cleanup() {
    if (this.defaultTTL === 0 && !this._hasExpiring()) return;
    const now = Date.now();
    for (const [key, entry] of this.map) {
      if (entry.expiry > 0 && now > entry.expiry) {
        this.map.delete(key);
      }
    }
  }

  _hasExpiring() {
    for (const entry of this.map.values()) {
      if (entry.expiry > 0) return true;
    }
    return false;
  }

  /**
   * Iterate over [key, value] pairs (unwraps internal {value, expiry} wrapper).
   * Skips expired entries.
   */
  *entries() {
    const now = Date.now();
    for (const [key, entry] of this.map) {
      if (entry.expiry > 0 && now > entry.expiry) {
        this.map.delete(key);
        continue;
      }
      yield [key, entry.value];
    }
  }

  /**
   * Iterate over keys. Skips expired entries.
   */
  *keys() {
    for (const [key] of this.entries()) {
      yield key;
    }
  }

  /**
   * Iterate over values. Skips expired entries.
   */
  *values() {
    for (const [, value] of this.entries()) {
      yield value;
    }
  }

  [Symbol.iterator]() {
    return this.entries();
  }

  destroy() {
    clearInterval(this._cleanupInterval);
    this.map.clear();
  }
}

module.exports = BoundedMap;
