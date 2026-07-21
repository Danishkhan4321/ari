// dashboard/app/api/tasks/update/route.ts
// POST { id, action } — toggle status or delete a task. Authorization
// requires the row's user_phone (creator) OR assigned_to (delegate)
// to match the session — both surfaces of the bot allow these actors
// to mark a task done.
import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";
type Action = "complete" | "reopen" | "delete";

export async function POST(req: Request) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

  let body: { id?: number; action?: Action } = {};
  try { body = await req.json(); } catch { /* fall through */ }
  const id = Number(body.id);
  const action = body.action;
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  if (action !== "complete" && action !== "reopen" && action !== "delete") {
    return NextResponse.json({ ok: false, error: "invalid action" }, { status: 400 });
  }
  try {
    if (action === "delete") {
      const r = await query(
        `DELETE FROM tasks WHERE id = $1 AND (user_phone = $2 OR assigned_by = $2) RETURNING id`,
        [id, userPhone]
      );
      if (r.rowCount === 0) return NextResponse.json({ ok: false, error: "not found or not yours" }, { status: 404 });
    } else {
      const status = action === "complete" ? "completed" : "pending";
      const r = await query(
        `UPDATE tasks SET status = $1
           WHERE id = $2 AND (user_phone = $3 OR assigned_to = $3 OR assigned_by = $3)
         RETURNING id`,
        [status, id, userPhone]
      );
      if (r.rowCount === 0) return NextResponse.json({ ok: false, error: "not found or not yours" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
