import { NextResponse } from "next/server";
import { getCurrentUserPhone } from "@/lib/session";
import { resolveTeamAdmin } from "@/lib/sprint";
import { listOneOnOnes, scheduleOneOnOne } from "@/lib/one-on-one";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { name: string } }) {
  try {
    const userPhone = await getCurrentUserPhone();
    if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
    const teamName = decodeURIComponent(params.name);
    const adminPhone = await resolveTeamAdmin(teamName, userPhone);
    if (!adminPhone) return NextResponse.json({ ok: false, error: "team not found" }, { status: 404 });
    const safe = async <T>(fn: () => Promise<T>, fb: T) => { try { return await fn(); } catch { return fb; } };
    const oneOnOnes = await safe(() => listOneOnOnes(adminPhone), []);
    return NextResponse.json({ ok: true, oneOnOnes, is_admin: adminPhone === userPhone });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: { params: { name: string } }) {
  try {
    const userPhone = await getCurrentUserPhone();
    if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
    const teamName = decodeURIComponent(params.name);
    const adminPhone = await resolveTeamAdmin(teamName, userPhone);
    if (!adminPhone) return NextResponse.json({ ok: false, error: "team not found" }, { status: 404 });
    if (adminPhone !== userPhone) return NextResponse.json({ ok: false, error: "admin only" }, { status: 403 });

    let body: { manager_phone?: string; report_phone?: string; next_at?: string; cadence_days?: number; agenda?: string | null } = {};
    try { body = await req.json(); } catch { /* validate */ }
    const managerPhone = String(body.manager_phone || "").replace(/\D/g, "");
    const reportPhone = String(body.report_phone || "").replace(/\D/g, "");
    const nextAt = String(body.next_at || "");
    if (!managerPhone || !reportPhone) return NextResponse.json({ ok: false, error: "manager_phone and report_phone required" }, { status: 400 });
    const dt = new Date(nextAt);
    if (Number.isNaN(dt.getTime())) return NextResponse.json({ ok: false, error: "next_at invalid" }, { status: 400 });

    const names = await query<{ manager_name: string | null; report_name: string | null }>(
      `SELECT
         (SELECT member_name FROM teams WHERE admin_phone = $1 AND member_phone = $2 LIMIT 1) AS manager_name,
         (SELECT member_name FROM teams WHERE admin_phone = $1 AND member_phone = $3 LIMIT 1) AS report_name`,
      [adminPhone, managerPhone, reportPhone]
    );

    const r = await scheduleOneOnOne(adminPhone, {
      teamName: teamName.toLowerCase(),
      managerPhone, managerName: names.rows[0]?.manager_name ?? null,
      reportPhone, reportName: names.rows[0]?.report_name ?? null,
      nextAtIso: dt.toISOString(),
      cadenceDays: body.cadence_days ?? null,
      agenda: body.agenda ?? null,
    });
    return NextResponse.json({ ok: true, oneOnOne: r });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
