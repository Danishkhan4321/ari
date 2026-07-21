// dashboard/app/api/inbox/scheduled/route.ts
// GET /api/inbox/scheduled — pending scheduled emails for the user
// POST { id, action: "cancel" } — cancel a scheduled send (status='cancelled')
import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
  try {
    const r = await query(
      `SELECT id, recipients, subject, status, lead_id, email_type,
              is_recurring, recurrence_pattern, recurrence_days
         FROM scheduled_emails
        WHERE user_phone = $1
        ORDER BY id DESC
        LIMIT 100`,
      [userPhone]
    );
    return NextResponse.json({ ok: true, emails: r.rows });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
  let body: { id?: number; action?: string } = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  if (body.action !== "cancel") return NextResponse.json({ ok: false, error: "invalid action" }, { status: 400 });
  const r = await query(
    `UPDATE scheduled_emails SET status = 'cancelled'
       WHERE id = $1 AND user_phone = $2 AND status IN ('pending','queued','scheduled')
     RETURNING id`,
    [id, userPhone]
  );
  if (r.rowCount === 0) return NextResponse.json({ ok: false, error: "not found or already sent" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
