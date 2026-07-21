// dashboard/app/api/team/overview/route.ts
// GET — single shot returning members, recent standup configs, recent
// polls, and pending leave requests for the signed-in user (as admin).
import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
  const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch { return fallback; }
  };
  const [members, standups, polls, leave, incidents] = await Promise.all([
    safe(async () => (await query(
      `SELECT id, member_phone, member_name, role, team_name FROM teams
        WHERE admin_phone = $1 OR member_phone = $1
        ORDER BY team_name, member_name LIMIT 200`,
      [userPhone]
    )).rows, []),
    safe(async () => (await query(
      `SELECT id, name, schedule_days, is_active, deadline, team_name
         FROM standup_configs
        WHERE admin_phone = $1
        ORDER BY is_active DESC, id DESC LIMIT 20`,
      [userPhone]
    )).rows, []),
    safe(async () => (await query(
      `SELECT id, question, status, poll_type, team_name FROM polls
        WHERE creator_phone = $1
        ORDER BY id DESC LIMIT 20`,
      [userPhone]
    )).rows, []),
    safe(async () => (await query(
      `SELECT id, employee_phone, leave_type, start_date, end_date, status, half_day, half_day_period
         FROM leave_requests
        WHERE manager_phone = $1 OR employee_phone = $1
        ORDER BY id DESC LIMIT 30`,
      [userPhone]
    )).rows, []),
    safe(async () => (await query(
      `SELECT id, title, severity, status, reported_by_name FROM incidents
        WHERE team_admin_phone = $1
        ORDER BY id DESC LIMIT 20`,
      [userPhone]
    )).rows, []),
  ]);
  return NextResponse.json({ ok: true, members, standups, polls, leave, incidents });
}
