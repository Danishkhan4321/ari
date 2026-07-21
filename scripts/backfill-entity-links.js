#!/usr/bin/env node
'use strict';

/**
 * Backfill the entity context layer from existing data.
 *
 * Idempotent (associations upsert on conflict; facts dedupe on write):
 *   1. Every completed meeting with attendees → link to contacts/leads.
 *   2. Every tracked email → link to the lead with that recipient address.
 *
 * Usage:
 *   node -r dotenv/config scripts/backfill-entity-links.js [--dry-run]
 *
 * Fact extraction (LLM) is intentionally NOT part of the backfill — run cost
 * stays at zero. New meetings get facts via the live hook.
 */

const { query, pool } = require('../src/config/database');
const entityContext = require('../src/services/entity-context.service');

const DRY_RUN = process.argv.includes('--dry-run');

async function backfillMeetings() {
  const meetings = await query(`
    SELECT id, user_phone, title, attendees
      FROM meeting_recordings
     WHERE status = 'completed'
       AND attendees IS NOT NULL AND attendees NOT IN ('', '[]')
     ORDER BY id
  `);
  console.log(`Meetings with attendees: ${meetings.rows.length}`);

  let contacts = 0;
  let leads = 0;
  for (const m of meetings.rows) {
    if (DRY_RUN) {
      const parsed = entityContext._internals.parseAttendees(m.attendees);
      if (parsed.names.length || parsed.emails.length) {
        console.log(`  [dry] meeting ${m.id} (${m.user_phone}): ${parsed.names.length} name(s), ${parsed.emails.length} email(s)`);
      }
      continue;
    }
    const linked = await entityContext.linkMeeting(m.user_phone, m.id, {
      attendees: m.attendees,
      title: m.title,
    });
    contacts += linked.contacts;
    leads += linked.leads;
  }
  console.log(`Meetings backfill: linked ${contacts} contact edge(s), ${leads} lead edge(s)`);
}

async function backfillTrackedEmails() {
  let rows = [];
  try {
    const result = await query(`
      SELECT t.id, t.user_phone, t.recipient_email, l.id AS lead_id
        FROM tracked_emails t
        JOIN sales_leads l
          ON l.user_phone = t.user_phone
         AND LOWER(l.email) = LOWER(t.recipient_email)
       ORDER BY t.id
    `);
    rows = result.rows;
  } catch (e) {
    console.log(`tracked_emails backfill skipped: ${e.message}`);
    return;
  }
  console.log(`Tracked emails matching a lead: ${rows.length}`);

  let linked = 0;
  for (const row of rows) {
    if (DRY_RUN) continue;
    const ok = await entityContext.link(
      row.user_phone,
      { type: 'email', id: row.id },
      { type: 'lead', id: row.lead_id },
      'sent_to',
      { createdBy: 'backfill' }
    );
    if (ok) linked += 1;
  }
  console.log(`Tracked-email backfill: ${DRY_RUN ? '(dry run)' : `${linked} edge(s)`}`);
}

(async () => {
  console.log(`Entity-link backfill starting${DRY_RUN ? ' (DRY RUN)' : ''}...`);
  try {
    await backfillMeetings();
    await backfillTrackedEmails();
    console.log('Done.');
  } catch (e) {
    console.error(`Backfill failed: ${e.message}`);
    process.exitCode = 1;
  } finally {
    try { await pool.end(); } catch (_) { /* ignore */ }
  }
})();
