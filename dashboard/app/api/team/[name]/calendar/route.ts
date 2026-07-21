// dashboard/app/api/team/[name]/calendar/route.ts
import { NextResponse } from "next/server";
import { getCurrentUserPhone } from "@/lib/session";
import { resolveTeamAdmin } from "@/lib/sprint";
import { getTeamCalendar } from "@/lib/team-calendar";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: { name: string } }) {
  try {
    const userPhone = await getCurrentUserPhone();
    if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
    const teamName = decodeURIComponent(params.name);
    const adminPhone = await resolveTeamAdmin(teamName, userPhone);
    if (!adminPhone) return NextResponse.json({ ok: false, error: "team not found" }, { status: 404 });

    const url = new URL(req.url);
    const from = url.searchParams.get("from") || todayIso();
    const to = url.searchParams.get("to") || isoOffsetDays(from, 30);

    const memRes = await query<{ member_phone: string }>(
      `SELECT member_phone FROM teams WHERE admin_phone = $1 AND team_name = $2`,
      [adminPhone, teamName.toLowerCase()]
    );
    const memberPhones = memRes.rows.map(r => r.member_phone);

    const events = await getTeamCalendar(adminPhone, memberPhones, teamName, from, to);
    return NextResponse.json({ ok: true, from, to, events });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function isoOffsetDays(from: string, days: number): string {
  const d = new Date(from); d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
