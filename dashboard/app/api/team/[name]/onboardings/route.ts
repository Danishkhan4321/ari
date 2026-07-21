// dashboard/app/api/team/[name]/onboardings/route.ts
import { NextResponse } from "next/server";
import { getCurrentUserPhone } from "@/lib/session";
import { resolveTeamAdmin } from "@/lib/sprint";
import { listTeamOnboardings, startTeamOnboarding } from "@/lib/team-onboarding";
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
    const onboardings = await safe(() => listTeamOnboardings(adminPhone), []);
    return NextResponse.json({ ok: true, onboardings, is_admin: adminPhone === userPhone });
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

    let body: { member_phone?: string; manager_phone?: string | null } = {};
    try { body = await req.json(); } catch { /* validate */ }
    const memberPhone = String(body.member_phone || "").replace(/\D/g, "");
    if (!memberPhone) return NextResponse.json({ ok: false, error: "member_phone required" }, { status: 400 });

    // Confirm member is in the team and pull their name.
    const r = await query<{ member_name: string | null }>(
      `SELECT member_name FROM teams WHERE admin_phone = $1 AND team_name = $2 AND member_phone = $3 LIMIT 1`,
      [adminPhone, teamName.toLowerCase(), memberPhone]
    );
    if (r.rows.length === 0) return NextResponse.json({ ok: false, error: "member not in this team" }, { status: 404 });

    const ob = await startTeamOnboarding(adminPhone, {
      teamName: teamName.toLowerCase(),
      memberPhone,
      memberName: r.rows[0].member_name,
      managerPhone: body.manager_phone ?? null,
    });
    return NextResponse.json({ ok: true, onboarding: ob });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
