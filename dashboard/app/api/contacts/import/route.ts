// dashboard/app/api/contacts/import/route.ts
// POST { rows: [{ name, email?, phone?, company?, title?, linkedin?,
//                 website?, customFields? }], assignToGroupId? }
//
// Imports contacts into either sales_leads (if email present) or
// contacts (phone-only address book), deduping by email/phone. If
// assignToGroupId is given, all created/matched rows are added to it.
//
// Why this is fast: previous version ran 2 queries per row (SELECT
// existing + INSERT/UPDATE) = ~2N round-trips, which timed out at the
// proxy layer for any non-trivial CSV. This version:
//   1. Pre-fetches all existing leads/contacts for this user in 2
//      queries (one for emails, one for phones) — even at 5k rows
//      that's still 2 round-trips.
//   2. Bulk-inserts new rows in chunks of ~100 with multi-row VALUES.
//   3. Bulk-updates existing rows (one per match — rare and small).
// On a 200-row CSV this drops total wall time from ~50s to ~2s.
//
// Errors always return JSON so the client never sees an HTML error
// page from Nginx / Cloudflare.
import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { addMembers, getGroup } from "@/lib/groups";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";
// Give the function ~5 min before Vercel's edge times us out — well
// past Cloudflare's 100s default but a safety net for huge imports.
export const maxDuration = 300;

type Row = {
  name?: string;
  email?: string;
  phone?: string;
  company?: string;
  title?: string;
  linkedin?: string;
  website?: string;
  customFields?: Record<string, string>;
};

let leadsColumnsReady = false;
async function ensureLeadsColumns(): Promise<void> {
  if (leadsColumnsReady) return;
  try {
    await query(`ALTER TABLE sales_leads ADD COLUMN IF NOT EXISTS custom_fields JSONB`);
    await query(`ALTER TABLE sales_leads ADD COLUMN IF NOT EXISTS title VARCHAR(200)`);
    await query(`ALTER TABLE sales_leads ADD COLUMN IF NOT EXISTS linkedin_url VARCHAR(500)`);
    await query(`ALTER TABLE sales_leads ADD COLUMN IF NOT EXISTS website VARCHAR(500)`);
    leadsColumnsReady = true;
  } catch {
    // If the migration fails, only the standard fields will import.
  }
}

export async function POST(req: Request) {
  // Outer try/catch guarantees a JSON response. Without it, an unhandled
  // error returns Next.js's HTML error page and the client's
  // response.json() throws "Unexpected token '<'".
  try {
    return await handlePost(req);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: `import crashed: ${msg}` }, { status: 500 });
  }
}

async function handlePost(req: Request) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

  let body: { rows?: Row[]; assignToGroupId?: number } = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const allRows = body.rows || [];
  // Only require a name. No-contact rows go to sales_leads with NULL
  // email — they're useful as records you can email/call later once
  // you find their contact info.
  const rows = allRows.filter(r => r && r.name && String(r.name).trim().length > 0);
  if (rows.length === 0) {
    return NextResponse.json({ ok: false, error: "no valid rows (every row needs at least a name)" }, { status: 400 });
  }
  if (rows.length > 5000) {
    return NextResponse.json({ ok: false, error: "max 5000 rows per import" }, { status: 400 });
  }

  await ensureLeadsColumns();

  // ─── Normalize rows up front ───────────────────────────────────────
  type Norm = {
    name: string;
    email: string;            // "" if absent
    phone: string;            // "" if absent
    company: string | null;
    title: string | null;
    linkedin: string | null;
    website: string | null;
    customFields: Record<string, string>;
    hasCustom: boolean;
  };
  const normalized: Norm[] = [];
  let skippedNoName = 0;
  for (const r of rows) {
    const name = String(r.name || "").trim().slice(0, 120);
    if (!name) { skippedNoName++; continue; }
    const email = r.email ? String(r.email).trim().toLowerCase().slice(0, 200) : "";
    const phone = r.phone ? String(r.phone).replace(/\D/g, "").slice(0, 20) : "";
    const company = r.company ? String(r.company).trim().slice(0, 120) : null;
    const title = r.title ? String(r.title).trim().slice(0, 200) : null;
    const linkedin = r.linkedin ? String(r.linkedin).trim().slice(0, 500) : null;
    const website = r.website ? String(r.website).trim().slice(0, 500) : null;
    const customFields = sanitizeCustomFields(r.customFields);
    normalized.push({
      name, email, phone, company, title, linkedin, website,
      customFields, hasCustom: Object.keys(customFields).length > 0,
    });
  }

  // Three buckets:
  //   - emailRows     → sales_leads, deduped by email
  //   - phoneOnlyRows → contacts (address book), deduped by phone
  //   - noContactRows → sales_leads with NULL email; no dedupe (a
  //                     re-import will add duplicates, which is the
  //                     least surprising default for these)
  const emailRows = normalized.filter(r => r.email);
  const phoneOnlyRows = normalized.filter(r => !r.email && r.phone);
  const noContactRows = normalized.filter(r => !r.email && !r.phone);

  // Dedup within the import itself — but DON'T drop duplicates. When a
  // CSV has multiple rows with the same email (common with law-firm
  // directories where many attorneys list the firm's info@ address),
  // we keep the FIRST as a normal email-bearing lead and re-route the
  // rest into the no-contact bucket. Same idea for phone-only rows.
  // This preserves every row's unique data (name, company, title) so
  // the import count matches the CSV row count.
  const seenEmails = new Set<string>();
  const uniqueEmailRows: Norm[] = [];
  const dupedAsNoContact: Norm[] = [];
  for (const r of emailRows) {
    if (seenEmails.has(r.email)) {
      dupedAsNoContact.push({ ...r, email: "" });
      continue;
    }
    seenEmails.add(r.email);
    uniqueEmailRows.push(r);
  }
  const seenPhones = new Set<string>();
  const uniquePhoneRows: Norm[] = [];
  for (const r of phoneOnlyRows) {
    if (seenPhones.has(r.phone)) {
      dupedAsNoContact.push({ ...r, phone: "" });
      continue;
    }
    seenPhones.add(r.phone);
    uniquePhoneRows.push(r);
  }
  // Roll the within-CSV duplicates into the no-contact bucket — they'll
  // be inserted as separate leads with NULL email + NULL phone.
  const noContactRowsAll = [...noContactRows, ...dupedAsNoContact];
  const dupedCount = dupedAsNoContact.length;

  // ─── Pre-fetch existing rows in 2 queries ──────────────────────────
  const existingByEmail = new Map<string, number>(); // email → lead id
  if (uniqueEmailRows.length > 0) {
    const r = await query<{ id: number; email: string }>(
      `SELECT id, LOWER(email) AS email FROM sales_leads
        WHERE user_phone = $1 AND LOWER(email) = ANY($2::text[])`,
      [userPhone, uniqueEmailRows.map(x => x.email)]
    );
    for (const row of r.rows) existingByEmail.set(row.email, row.id);
  }
  const existingByPhone = new Map<string, number>(); // phone → contact id
  if (uniquePhoneRows.length > 0) {
    const r = await query<{ id: number; phone: string }>(
      `SELECT id, phone FROM contacts
        WHERE user_phone = $1 AND phone = ANY($2::text[])`,
      [userPhone, uniquePhoneRows.map(x => x.phone)]
    );
    for (const row of r.rows) existingByPhone.set(row.phone, row.id);
  }

  // ─── Bucket: leads to insert vs update ─────────────────────────────
  const leadInserts: Norm[] = [];
  const leadUpdates: { id: number; row: Norm }[] = [];
  for (const r of uniqueEmailRows) {
    const existing = existingByEmail.get(r.email);
    if (existing) leadUpdates.push({ id: existing, row: r });
    else leadInserts.push(r);
  }
  const contactInserts: Norm[] = [];
  const matchedContacts: number[] = [];
  for (const r of uniquePhoneRows) {
    const existing = existingByPhone.get(r.phone);
    if (existing) matchedContacts.push(existing);
    else contactInserts.push(r);
  }

  // ─── Bulk-insert leads in chunks of 100 ────────────────────────────
  const createdLeadIds: number[] = [];
  let customFieldsCaptured = 0;
  if (leadInserts.length > 0) {
    const CHUNK = 100;
    for (let i = 0; i < leadInserts.length; i += CHUNK) {
      const chunk = leadInserts.slice(i, i + CHUNK);
      // Build a parameterized multi-row VALUES string. 8 cols per row
      // with the new schema (or 4 if columns aren't ready yet).
      if (leadsColumnsReady) {
        const placeholders: string[] = [];
        const args: unknown[] = [userPhone];
        let idx = 2;
        for (const r of chunk) {
          placeholders.push(
            `($1, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, 'import', $${idx++}::jsonb)`
          );
          args.push(r.name, r.email, r.company, r.title, r.linkedin, r.website,
                    r.hasCustom ? JSON.stringify(r.customFields) : null);
          if (r.hasCustom) customFieldsCaptured++;
        }
        const sql = `
          INSERT INTO sales_leads
            (user_phone, name, email, company, title, linkedin_url, website, source, custom_fields)
          VALUES ${placeholders.join(", ")}
          RETURNING id
        `;
        const r = await query<{ id: number }>(sql, args);
        for (const row of r.rows) createdLeadIds.push(row.id);
      } else {
        // Legacy schema without the new columns — fall back to 4-col
        // INSERT (name, email, company, source).
        const placeholders: string[] = [];
        const args: unknown[] = [userPhone];
        let idx = 2;
        for (const r of chunk) {
          placeholders.push(`($1, $${idx++}, $${idx++}, $${idx++}, 'import')`);
          args.push(r.name, r.email, r.company);
        }
        const sql = `
          INSERT INTO sales_leads (user_phone, name, email, company, source)
          VALUES ${placeholders.join(", ")}
          RETURNING id
        `;
        const r = await query<{ id: number }>(sql, args);
        for (const row of r.rows) createdLeadIds.push(row.id);
      }
    }
  }

  // ─── Update existing leads (one query per row, rare path) ─────────
  if (leadUpdates.length > 0 && leadsColumnsReady) {
    for (const u of leadUpdates) {
      await query(
        `UPDATE sales_leads
            SET title = COALESCE($1, title),
                linkedin_url = COALESCE($2, linkedin_url),
                website = COALESCE($3, website),
                company = COALESCE($4, company),
                custom_fields = COALESCE(custom_fields, '{}'::jsonb) || $5::jsonb
          WHERE id = $6 AND user_phone = $7`,
        [u.row.title, u.row.linkedin, u.row.website, u.row.company,
         JSON.stringify(u.row.customFields), u.id, userPhone]
      );
      if (u.row.hasCustom) customFieldsCaptured++;
    }
  }

  // ─── Bulk-insert contacts (phone-only) ─────────────────────────────
  const createdContactIds: number[] = [];
  if (contactInserts.length > 0) {
    const CHUNK = 200;
    for (let i = 0; i < contactInserts.length; i += CHUNK) {
      const chunk = contactInserts.slice(i, i + CHUNK);
      const placeholders: string[] = [];
      const args: unknown[] = [userPhone];
      let idx = 2;
      for (const r of chunk) {
        placeholders.push(`($1, $${idx++}, $${idx++}, 'imported')`);
        args.push(r.name, r.phone);
      }
      const sql = `
        INSERT INTO contacts (user_phone, name, phone, category)
        VALUES ${placeholders.join(", ")}
        RETURNING id
      `;
      const r = await query<{ id: number }>(sql, args);
      for (const row of r.rows) createdContactIds.push(row.id);
    }
  }

  // ─── Bulk-insert leads with no email and no phone ──────────────────
  // These land in sales_leads with email = NULL. No dedupe: a re-import
  // will add duplicates, but that's the least surprising default for a
  // table where we have no natural unique key. Includes within-CSV
  // duplicates that we re-routed here so every distinct row imports.
  const createdNoContactIds: number[] = [];
  if (noContactRowsAll.length > 0) {
    const CHUNK = 100;
    for (let i = 0; i < noContactRowsAll.length; i += CHUNK) {
      const chunk = noContactRowsAll.slice(i, i + CHUNK);
      if (leadsColumnsReady) {
        const placeholders: string[] = [];
        const args: unknown[] = [userPhone];
        let idx = 2;
        for (const r of chunk) {
          placeholders.push(
            `($1, $${idx++}, NULL, $${idx++}, $${idx++}, $${idx++}, $${idx++}, 'import', $${idx++}::jsonb)`
          );
          args.push(r.name, r.company, r.title, r.linkedin, r.website,
                    r.hasCustom ? JSON.stringify(r.customFields) : null);
          if (r.hasCustom) customFieldsCaptured++;
        }
        const sql = `
          INSERT INTO sales_leads
            (user_phone, name, email, company, title, linkedin_url, website, source, custom_fields)
          VALUES ${placeholders.join(", ")}
          RETURNING id
        `;
        const r = await query<{ id: number }>(sql, args);
        for (const row of r.rows) createdNoContactIds.push(row.id);
      } else {
        const placeholders: string[] = [];
        const args: unknown[] = [userPhone];
        let idx = 2;
        for (const r of chunk) {
          placeholders.push(`($1, $${idx++}, NULL, $${idx++}, 'import')`);
          args.push(r.name, r.company);
        }
        const sql = `
          INSERT INTO sales_leads (user_phone, name, email, company, source)
          VALUES ${placeholders.join(", ")}
          RETURNING id
        `;
        const r = await query<{ id: number }>(sql, args);
        for (const row of r.rows) createdNoContactIds.push(row.id);
      }
    }
  }

  // ─── Build the create-list for group assignment ────────────────────
  const created: { kind: "lead" | "contact"; id: number }[] = [
    ...createdLeadIds.map(id => ({ kind: "lead" as const, id })),
    ...createdNoContactIds.map(id => ({ kind: "lead" as const, id })),
    ...leadUpdates.map(u => ({ kind: "lead" as const, id: u.id })),
    ...createdContactIds.map(id => ({ kind: "contact" as const, id })),
    ...matchedContacts.map(id => ({ kind: "contact" as const, id })),
  ];

  // Optionally assign all rows (created + matched) to a group
  let added = 0;
  const gid = Number(body.assignToGroupId);
  if (Number.isInteger(gid) && gid > 0 && created.length > 0) {
    const group = await getGroup(userPhone, gid);
    if (group) {
      added = await addMembers(userPhone, gid, created);
    }
  }

  return NextResponse.json({
    ok: true,
    imported: createdLeadIds.length + createdContactIds.length + createdNoContactIds.length,
    matchedExisting: leadUpdates.length + matchedContacts.length,
    skipped: skippedNoName,
    mergedDuplicates: dupedCount,
    addedToGroup: added,
    customFieldsCaptured,
  });
}

// Defensive: cap label and value lengths so a malformed paste can't
// blow up the JSONB column or our display layer.
function sanitizeCustomFields(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== "object") return out;
  let count = 0;
  for (const [rawKey, rawVal] of Object.entries(input as Record<string, unknown>)) {
    if (count >= 30) break; // hard cap on number of custom fields per row
    const key = String(rawKey).trim().slice(0, 50);
    if (!key) continue;
    const val = String(rawVal ?? "").trim().slice(0, 500);
    if (!val) continue;
    out[key] = val;
    count++;
  }
  return out;
}
