/**
 * Migration: functional index on LOWER(TRIM(key_name)) for memory_trunk.
 *
 * memory.service.js queries memory_trunk with `LOWER(TRIM(key_name))` in
 * both the dedup-by-key SELECT (line ~290) and the contact lookup SELECTs
 * (lines ~542-544). Without a functional index, each query did a full
 * per-user scan to apply the LOWER/TRIM expression. After this index
 * Postgres can use it directly.
 *
 * Why no CONCURRENTLY: see migrations/4_slow_query_indexes.js — the
 * migration runner wraps each up() in a transaction, and CONCURRENTLY
 * requires running outside one. memory_trunk is small enough (cron-side
 * facts cache) that a brief share lock is acceptable.
 */

exports.up = async (pgm) => {
  // Functional expression index. Postgres uses it for any predicate where
  // the LEFT side is exactly `LOWER(TRIM(key_name))`, which matches the
  // production queries in memory.service.js.
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_memory_trunk_lower_key
      ON memory_trunk((LOWER(TRIM(key_name))));
  `);

  // Composite (user, lower_key) is the most-common access pattern in the
  // contact lookup paths.
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_memory_trunk_user_lower_key
      ON memory_trunk(user_phone, (LOWER(TRIM(key_name))));
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`DROP INDEX IF EXISTS idx_memory_trunk_lower_key;`);
  await pgm.db.query(`DROP INDEX IF EXISTS idx_memory_trunk_user_lower_key;`);
};
