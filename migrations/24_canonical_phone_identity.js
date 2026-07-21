'use strict';

/**
 * Canonicalize user identity keys to digits-only phone strings.
 *
 * The WhatsApp webhook and the dashboard→bot bridge key every table by the
 * bare digit string ("919035380366"), but the desktop session and some
 * dashboard writes used a '+'-prefixed form ("+919035380366"). The same user
 * therefore existed under two identities, and rows written by the agent were
 * invisible to the dashboard UI (teams, activity stream, scheduled emails,
 * group members) and vice versa.
 *
 * This migration rewrites '+'-prefixed (or otherwise formatted) phone keys to
 * their digits-only form wherever that would NOT collide with an existing
 * digits-only row (collisions are left in place and logged by count — they
 * mean both identities wrote the "same" logical row and need a manual merge).
 */

const TARGETS = [
  ['teams', 'admin_phone'],
  ['teams', 'member_phone'],
  ['contact_groups', 'user_phone'],
  ['sales_leads', 'user_phone'],
  ['contacts', 'user_phone'],
  ['tasks', 'user_phone'],
  ['tasks', 'assigned_by'],
  ['tasks', 'assigned_to'],
  ['reminders', 'user_phone'],
  ['scheduled_emails', 'user_phone'],
  ['agent_runs', 'user_phone'],
  ['agent_run_events', 'user_phone'],
  ['conversation_history', 'user_phone'],
  ['google_tokens', 'user_phone'],
  ['microsoft_tokens', 'user_phone'],
  ['user_settings', 'user_phone'],
  ['memories', 'user_phone'],
  ['notes', 'user_phone'],
];

exports.up = async (pgm) => {
  for (const [table, column] of TARGETS) {
    // Tables are lazily created by the services; skip ones that do not exist
    // yet in this database.
    const exists = await pgm.db.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = $1 AND column_name = $2 LIMIT 1`,
      [table, column]
    );
    if (exists.rows.length === 0) continue;

    // Rewrite each formatted key to digits-only, but never create a collision
    // inside this single UPDATE. A row is rewritten only when:
    //   (1) no existing digits-only row already holds the normalized value, AND
    //   (2) it is the sole winner (lowest ctid) among formatted rows that
    //       normalize to the same value.
    // Any remaining formatted duplicates are left in place and reported for a
    // manual merge, rather than aborting the whole migration on a unique-index
    // violation.
    const result = await pgm.db.query(`
      UPDATE ${table} t
         SET ${column} = regexp_replace(t.${column}, '[^0-9]', '', 'g')
       WHERE t.${column} ~ '[^0-9]'
         AND length(regexp_replace(t.${column}, '[^0-9]', '', 'g')) > 0
         AND NOT EXISTS (
           SELECT 1 FROM ${table} existing
            WHERE existing.${column} = regexp_replace(t.${column}, '[^0-9]', '', 'g')
         )
         AND NOT EXISTS (
           SELECT 1 FROM ${table} peer
            WHERE peer.${column} ~ '[^0-9]'
              AND regexp_replace(peer.${column}, '[^0-9]', '', 'g')
                  = regexp_replace(t.${column}, '[^0-9]', '', 'g')
              AND peer.ctid < t.ctid
         )
    `);
    const remaining = await pgm.db.query(
      `SELECT COUNT(*)::int AS n FROM ${table} WHERE ${column} ~ '[^0-9]'`
    );
    if (result.rowCount > 0 || remaining.rows[0].n > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[migration 24] ${table}.${column}: normalized ${result.rowCount} row(s); ` +
        `${remaining.rows[0].n} row(s) left untouched (digits-only twin exists — manual merge needed)`
      );
    }
  }
};

exports.down = async () => {
  // Data normalization is not reversible: the original formatting variants
  // are not recorded. Down is a no-op by design.
};
