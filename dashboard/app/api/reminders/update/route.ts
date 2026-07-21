// dashboard/app/api/reminders/update/route.ts
// POST /api/reminders/update — performs one of three actions on a single
// reminder owned by the signed-in user:
//   action=cancel  → status='cancelled'
//   action=done    → status='completed'
//   action=snooze  → snooze_until=<iso>
//
// Authorization is enforced by the WHERE user_phone = $1 filter — we
// never trust an id from the client without binding it to the session
// user, so a malicious payload can't reschedule someone else's reminder.
import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";

type Action = "cancel" | "done" | "snooze";

type Body = {
  id?: number;
  action?: Action;
  snoozeUntil?: string; // ISO string, only for action=snooze
};

export async function POST(req: Request) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

  let body: Body = {};
  try { body = (await req.json()) as Body; } catch { /* fall through */ }
  const id = Number(body.id);
  const action = body.action;
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  }
  if (action !== "cancel" && action !== "done" && action !== "snooze") {
    return NextResponse.json({ ok: false, error: "invalid action" }, { status: 400 });
  }

  try {
    if (action === "cancel" || action === "done") {
      const status = action === "cancel" ? "cancelled" : "completed";
      const r = await query(
        `UPDATE reminders SET status = $1
           WHERE id = $2 AND user_phone = $3 AND status = 'pending'
         RETURNING id`,
        [status, id, userPhone]
      );
      if (r.rowCount === 0) {
        return NextResponse.json({ ok: false, error: "reminder not found or already finalized" }, { status: 404 });
      }
      return NextResponse.json({ ok: true });
    }

    // snooze
    const iso = String(body.snoozeUntil || "");
    const t = new Date(iso);
    if (Number.isNaN(t.getTime())) {
      return NextResponse.json({ ok: false, error: "snoozeUntil must be a valid ISO timestamp" }, { status: 400 });
    }
    if (t.getTime() < Date.now() - 60_000) {
      return NextResponse.json({ ok: false, error: "snoozeUntil must be in the future" }, { status: 400 });
    }
    const r = await query(
      `UPDATE reminders SET snooze_until = $1, status = 'pending'
         WHERE id = $2 AND user_phone = $3
       RETURNING id`,
      [t.toISOString(), id, userPhone]
    );
    if (r.rowCount === 0) {
      return NextResponse.json({ ok: false, error: "reminder not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
