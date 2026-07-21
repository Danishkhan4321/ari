// dashboard/app/api/team/leave/decide/route.ts
//
// POST — approve or reject a leave request. Manager-only.
// Body: { id, decision: "approved" | "rejected" }
import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

  let body: { id?: number; decision?: string } = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const id = Number(body.id);
  const decision = String(body.decision || "").toLowerCase();
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  }
  if (decision !== "approved" && decision !== "rejected") {
    return NextResponse.json({ ok: false, error: "decision must be approved|rejected" }, { status: 400 });
  }

  // Manager check: either the row's manager_phone OR the team admin of
  // the employee's team. Easiest: confirm the user is admin of *some*
  // team that contains the employee.
  const lr = await query<{ employee_phone: string; manager_phone: string | null; status: string }>(
    `SELECT employee_phone, manager_phone, status FROM leave_requests WHERE id = $1 LIMIT 1`,
    [id]
  );
  const row = lr.rows[0];
  if (!row) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  if (row.status !== "pending") {
    return NextResponse.json({ ok: false, error: `already ${row.status}` }, { status: 400 });
  }

  const isManager = row.manager_phone === userPhone;
  let isTeamAdmin = false;
  if (!isManager) {
    const r = await query(
      `SELECT 1 FROM teams
        WHERE admin_phone = $1 AND member_phone = $2 LIMIT 1`,
      [userPhone, row.employee_phone]
    );
    isTeamAdmin = r.rows.length > 0;
  }
  if (!isManager && !isTeamAdmin) {
    return NextResponse.json({ ok: false, error: "only the manager / team admin can decide" }, { status: 403 });
  }

  await query(
    `UPDATE leave_requests
        SET status = $1, responded_at = NOW()
      WHERE id = $2`,
    [decision, id]
  );

  return NextResponse.json({ ok: true });
}
