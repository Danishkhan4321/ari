// dashboard/app/api/contacts/mark-contacted/route.ts
// POST { ids: number[], when?: ISO-string, note?: string, clear?: boolean }
//   Manually mark a set of leads as contacted. Used to backfill
//   "Last contacted" data for emails sent OUTSIDE Ari (directly via
//   Gmail UI, etc.) since we don't have gmail.readonly scope to detect
//   them automatically.
//
// Behavior:
//   - clear=true → set last_contacted_at to NULL (undo)
//   - when omitted → defaults to NOW()
//   - note → if provided, written into sales_emails_log as a manual entry
//     so the lead-detail timeline reflects the touchpoint.
import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

  let body: { ids?: number[]; when?: string; note?: string; clear?: boolean } = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const ids = (body.ids || []).filter(n => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return NextResponse.json({ ok: false, error: "ids[] required" }, { status: 400 });
  if (ids.length > 1000) return NextResponse.json({ ok: false, error: "too many ids" }, { status: 400 });

  if (body.clear) {
    await query(
      `UPDATE sales_leads SET last_contacted_at = NULL
        WHERE user_phone = $1 AND id = ANY($2::int[])`,
      [userPhone, ids]
    );
    return NextResponse.json({ ok: true, updated: ids.length, cleared: true });
  }

  // Resolve target timestamp
  let when: Date;
  if (body.when) {
    const parsed = new Date(body.when);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ ok: false, error: "invalid 'when'" }, { status: 400 });
    }
    if (parsed.getTime() > Date.now() + 60_000) {
      return NextResponse.json({ ok: false, error: "'when' can't be in the future" }, { status: 400 });
    }
    when = parsed;
  } else {
    when = new Date();
  }

  const note = (body.note || "").trim().slice(0, 200);

  // Bump last_contacted_at only when newer than what's already there.
  await query(
    `UPDATE sales_leads
        SET last_contacted_at = $1
      WHERE user_phone = $2
        AND id = ANY($3::int[])
        AND (last_contacted_at IS NULL OR last_contacted_at < $1)`,
    [when.toISOString(), userPhone, ids]
  );

  // Best-effort: drop a row in sales_emails_log per lead so the timeline
  // reflects the touchpoint. The note becomes the "subject" for display.
  let logged = 0;
  for (const leadId of ids) {
    try {
      await query(
        `INSERT INTO sales_emails_log
           (user_phone, lead_id, email_type, subject, sent_at)
         VALUES ($1, $2, 'manual', $3, $4)`,
        [userPhone, leadId, note || "Marked as contacted", when.toISOString()]
      );
      logged++;
    } catch { /* ignore */ }
  }

  return NextResponse.json({ ok: true, updated: ids.length, logged });
}
