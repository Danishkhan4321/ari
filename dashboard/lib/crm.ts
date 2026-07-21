// dashboard/lib/crm.ts
// SERVER-ONLY CRM data layer. Imports ./db (pg), so this file must never be
// imported by a client component — use lib/crm-shared.ts for client-safe
// constants/types. Every query is scoped by the session's user_phone; an id
// alone is never sufficient (inherits the IDOR discipline from the bot).
import { query } from "./db";
import { STAGES, normalizePriority, type Lead, type Contact, type Stage } from "./crm-shared";

// Re-export the client-safe bits so existing server imports of "@/lib/crm"
// keep working (page.tsx imports computeStats etc. from here).
export {
  STAGES,
  STAGE_LABELS,
  STAGE_COLORS,
  computeStats,
} from "./crm-shared";
export type { Lead, Contact, Stage, PipelineStats } from "./crm-shared";

// ── Lazy column-ensure ──────────────────────────────────────────────────
// The dashboard writes directly to the same Postgres the bot uses. A few
// columns (priority + the import-only title/linkedin_url/website/custom_fields)
// are added lazily — mirroring how import/route.ts and session.ts manage
// their own schema. Guarded by a module flag so it runs at most once per
// server process. NOTE: the bot's sales.service.js CREATE TABLE should also
// gain `priority` for a clean fresh-DB schema (follow-up); this ALTER keeps
// production correct in the meantime.
let crmColsReady = false;
export async function ensureCrmColumns(): Promise<void> {
  if (crmColsReady) return;
  await query(
    `ALTER TABLE sales_leads ADD COLUMN IF NOT EXISTS priority VARCHAR(10);
     ALTER TABLE sales_leads ADD COLUMN IF NOT EXISTS title TEXT;
     ALTER TABLE sales_leads ADD COLUMN IF NOT EXISTS linkedin_url TEXT;
     ALTER TABLE sales_leads ADD COLUMN IF NOT EXISTS website TEXT;
     ALTER TABLE sales_leads ADD COLUMN IF NOT EXISTS custom_fields JSONB;
     ALTER TABLE sales_leads ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP;`
  );
  crmColsReady = true;
}

/** All leads for this user, newest first. */
export async function getLeads(userPhone: string): Promise<Lead[]> {
  await ensureCrmColumns();
  const res = await query<Lead>(
    `SELECT id, name, email, company, stage, notes, source, priority, deal_value,
            last_contacted_at, next_followup_at, created_at, updated_at
       FROM sales_leads
      WHERE user_phone = $1
      ORDER BY updated_at DESC
      LIMIT 500`,
    [userPhone]
  );
  return res.rows;
}

// Fields a user may edit inline from the lead profile. Stage has its own
// route (/api/contacts/stage); everything else flows through updateLeadFields.
const TEXT_FIELDS = ["name", "email", "company", "title", "source", "notes", "linkedin_url", "website"] as const;
type TextField = (typeof TEXT_FIELDS)[number];

// Per-field length caps — defensive bound against multi-MB writes into the
// shared Postgres (these are TEXT columns with no DB-side limit).
const TEXT_LIMITS: Record<string, number> = {
  name: 256, email: 256, company: 256, title: 256, source: 256,
  linkedin_url: 2048, website: 2048, notes: 10000,
};
/** Trim, null-if-empty, and clip a text field to its cap. */
function cleanText(field: string, v: unknown): string | null {
  const s = v == null ? "" : String(v).trim();
  if (s === "") return null;
  const max = TEXT_LIMITS[field] ?? 256;
  return s.length > max ? s.slice(0, max) : s;
}
/** Parse a money value; reject non-finite / negative / absurd magnitudes. */
function toMoney(v: unknown): number | null {
  if (v === "" || v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1e12) return null;
  return n;
}

export interface LeadInput {
  name?: string | null;
  email?: string | null;
  company?: string | null;
  title?: string | null;
  source?: string | null;
  notes?: string | null;
  linkedin_url?: string | null;
  website?: string | null;
  deal_value?: number | string | null;
  priority?: string | null;
  stage?: string | null;
  archived?: boolean;
}

/** Does this user already have a lead with this email? (dedupe hint). */
export async function findLeadByEmail(
  userPhone: string,
  email: string
): Promise<{ id: number; name: string } | null> {
  const e = email.trim().toLowerCase();
  if (!e) return null;
  const res = await query<{ id: number; name: string }>(
    `SELECT id, name FROM sales_leads
      WHERE user_phone = $1 AND LOWER(email) = $2
      ORDER BY id ASC LIMIT 1`,
    [userPhone, e]
  );
  return res.rows[0] ?? null;
}

/** Create a lead. Returns the new id, or an error string. name is required. */
export async function createLead(
  userPhone: string,
  input: LeadInput
): Promise<{ id: number } | { error: string }> {
  await ensureCrmColumns();
  const name = cleanText("name", input.name);
  if (!name) return { error: "name is required" };

  // Stage must be canonical (crm-shared STAGES). The pipeline board's
  // normalizeStage() maps canonical values onto its display columns, and
  // computeStats buckets canonical values correctly — so "new" is the right
  // entry stage. Non-canonical / arbitrary input is coalesced, never stored raw.
  const s = String(input.stage ?? "").toLowerCase().trim();
  const stage = (STAGES as readonly string[]).includes(s) ? s : "new";

  const res = await query<{ id: number }>(
    `INSERT INTO sales_leads
       (user_phone, name, email, company, title, source, stage, deal_value,
        priority, notes, linkedin_url, website, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW(), NOW())
     RETURNING id`,
    [
      userPhone,
      name,
      cleanText("email", input.email),
      cleanText("company", input.company),
      cleanText("title", input.title),
      cleanText("source", input.source) ?? "manual",
      stage,
      toMoney(input.deal_value),
      normalizePriority(input.priority),
      cleanText("notes", input.notes),
      cleanText("linkedin_url", input.linkedin_url),
      cleanText("website", input.website),
    ]
  );
  return { id: res.rows[0].id };
}

/**
 * Update a whitelist of editable fields on a lead. user_phone-scoped — the
 * id alone is never sufficient. Returns true if a row was updated.
 */
export async function updateLeadFields(
  userPhone: string,
  leadId: number,
  patch: LeadInput
): Promise<boolean> {
  await ensureCrmColumns();
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;

  for (const f of TEXT_FIELDS) {
    if (f in patch) {
      sets.push(`${f} = $${i++}`);
      vals.push(cleanText(f, patch[f as TextField]));
    }
  }
  if ("deal_value" in patch) {
    sets.push(`deal_value = $${i++}`);
    vals.push(toMoney(patch.deal_value));
  }
  if ("priority" in patch) {
    sets.push(`priority = $${i++}`);
    vals.push(normalizePriority(patch.priority));
  }
  if ("archived" in patch) {
    sets.push(`archived_at = ${patch.archived ? "NOW()" : "NULL"}`);
  }

  if (sets.length === 0) return false;
  sets.push(`updated_at = NOW()`);
  vals.push(leadId, userPhone);
  const res = await query(
    `UPDATE sales_leads SET ${sets.join(", ")}
      WHERE id = $${i++} AND user_phone = $${i++}`,
    vals
  );
  return (res.rowCount ?? 0) > 0;
}

export async function deleteLead(userPhone: string, leadId: number): Promise<boolean> {
  await ensureCrmColumns();
  const result = await query(
    `DELETE FROM sales_leads WHERE id = $1 AND user_phone = $2 RETURNING id`,
    [leadId, userPhone],
  );
  if ((result.rowCount ?? 0) > 0) {
    await query(`DELETE FROM contact_group_members WHERE member_kind = 'lead' AND member_id = $1`, [leadId]);
  }
  return (result.rowCount ?? 0) > 0;
}

/**
 * Move a lead to a new stage. Scoped by user_phone so a user can only
 * move their OWN leads — the id alone is never sufficient.
 */
export async function updateLeadStage(
  userPhone: string,
  leadId: number,
  stage: Stage
): Promise<Lead | null> {
  if (!STAGES.includes(stage)) return null;
  const touchesContact = ["contacted", "replied", "meeting", "proposal", "negotiation"].includes(stage);
  const res = await query<Lead>(
    `UPDATE sales_leads
        SET stage = $1,
            updated_at = NOW(),
            last_contacted_at = ${touchesContact ? "NOW()" : "last_contacted_at"}
      WHERE id = $2 AND user_phone = $3
      RETURNING id, name, email, company, stage, notes, source, deal_value,
                last_contacted_at, next_followup_at, created_at, updated_at`,
    [stage, leadId, userPhone]
  );
  return res.rows[0] ?? null;
}

/** Address-book contacts for this user. */
export async function getContacts(userPhone: string): Promise<Contact[]> {
  const res = await query<Contact>(
    `SELECT id, name, phone, notes, category, created_at
       FROM contacts
      WHERE user_phone = $1
      ORDER BY name ASC
      LIMIT 1000`,
    [userPhone]
  );
  return res.rows;
}
