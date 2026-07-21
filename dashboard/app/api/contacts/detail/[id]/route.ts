// dashboard/app/api/contacts/detail/[id]/route.ts
// GET /api/contacts/detail/<lead_id> — returns the lead row + activity
// timeline (emails sent + recent WhatsApp messages mentioning the lead).
//
// Returns:
//   lead.custom_fields — extra columns captured during CSV import.
//   activity.emails    — every row in sales_emails_log, oldest-first to
//                        newest, with sent_at so the UI can show "3 days
//                        ago" and the absolute timestamp.
import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
  }

  const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch { return fallback; }
  };

  // Lead row — try the full schema first (custom_fields, title,
  // linkedin_url all added lazily), fall back to legacy columns if the
  // ALTERs haven't run on this DB yet.
  let lead: {
    id: number; name: string; email: string | null; company: string | null;
    stage: string | null; deal_value: string | null; source: string | null;
    priority: string | null;
    notes: string | null; last_contacted_at: string | null;
    custom_fields: Record<string, string> | null;
    title: string | null;
    linkedin_url: string | null;
    website: string | null;
    phone: string | null;
    created_at: string | null;
    updated_at: string | null;
    archived_at: string | null;
  } | undefined;
  try {
    const r = await query<typeof lead extends infer T ? Exclude<T, undefined> : never>(
      `SELECT id, name, email, company, stage, deal_value, source, priority, notes,
              last_contacted_at, custom_fields, title, linkedin_url, website, phone, created_at, updated_at, archived_at
         FROM sales_leads WHERE id = $1 AND user_phone = $2`,
      [id, userPhone]
    );
    lead = r.rows[0];
  } catch {
    const r = await query<{
      id: number; name: string; email: string | null; company: string | null;
      stage: string | null; deal_value: string | null; source: string | null;
      notes: string | null; last_contacted_at: string | null; phone: string | null; created_at: string | null; updated_at: string | null; archived_at: string | null;
    }>(
      `SELECT id, name, email, company, stage, deal_value, source, notes, last_contacted_at, phone, created_at, updated_at, archived_at
         FROM sales_leads WHERE id = $1 AND user_phone = $2`,
      [id, userPhone]
    );
    if (r.rows[0]) lead = { ...r.rows[0], priority: null, custom_fields: null, title: null, linkedin_url: null, website: null };
  }
  if (!lead) return NextResponse.json({ ok: false, error: "lead not found" }, { status: 404 });

  // Activity: emails (merged from sales_emails_log AND sent_email_log
  // — the latter captures every Ari-sent message including bulk
  // dashboard sends that don't go through the sales tool) + recent
  // WhatsApp messages that mention the lead's name or company.
  const [emails, messages] = await Promise.all([
    safe(async () => {
      // sales_emails_log — keyed by lead_id (sales tool, bulk_dashboard).
      const a = (await query<{
        id: number; email_type: string | null; subject: string | null;
        gmail_message_id: string | null; sent_at: string | null;
      }>(
        `SELECT id, email_type, subject, gmail_message_id, sent_at
           FROM sales_emails_log
          WHERE lead_id = $1 AND user_phone = $2
          ORDER BY sent_at DESC NULLS LAST, id DESC
          LIMIT 50`,
        [id, userPhone]
      )).rows;
      // sent_email_log — keyed by recipient_email (every Ari send,
      // historical). Only joined if the lead has an email.
      const leadEmail = lead.email?.trim().toLowerCase();
      const b = leadEmail
        ? (await query<{
            id: number; subject: string | null;
            gmail_message_id: string | null; sent_at: string | null;
          }>(
            `SELECT id, subject, gmail_message_id, sent_at
               FROM sent_email_log
              WHERE user_phone = $1 AND LOWER(recipient_email) = $2
              ORDER BY sent_at DESC NULLS LAST, id DESC
              LIMIT 50`,
            [userPhone, leadEmail]
          )).rows.map(r => ({ ...r, email_type: "sent" as string | null }))
        : [];
      // Dedupe by gmail_message_id where present, otherwise keep both.
      const seen = new Set<string>();
      const merged: typeof a = [];
      for (const row of [...a, ...b]) {
        const k = row.gmail_message_id ? `m:${row.gmail_message_id}` : `r:${row.id}-${row.sent_at}`;
        if (seen.has(k)) continue;
        seen.add(k);
        merged.push(row);
      }
      merged.sort((x, y) => (y.sent_at || "").localeCompare(x.sent_at || ""));
      return merged.slice(0, 100);
    }, []),
    safe(async () => {
      const needles = [lead!.name, lead!.company].filter(Boolean) as string[];
      if (needles.length === 0) return [];
      const ors = needles.map((_, i) => `LOWER(content) LIKE $${i + 2}`).join(" OR ");
      const args: (string | number)[] = [userPhone, ...needles.map((n) => `%${String(n).toLowerCase()}%`)];
      return (await query<{
        id: number; role: string; content: string; created_at: string;
      }>(
        `SELECT id, role, content, created_at
           FROM conversation_history
          WHERE user_phone = $1 AND (${ors})
          ORDER BY created_at DESC
          LIMIT 30`,
        args
      )).rows;
    }, []),
  ]);

  return NextResponse.json({
    ok: true,
    lead: {
      ...lead,
      deal_value: lead.deal_value != null ? Number(lead.deal_value) : null,
      custom_fields: lead.custom_fields || {},
    },
    activity: { emails, messages },
  });
}
