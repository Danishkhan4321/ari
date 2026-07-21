// dashboard/app/api/team/[name]/meta/route.ts
//
// GET   — list per-member metadata (birthday, joined_at, manager) for this team.
// PATCH — admin upserts metadata for one member.
//          Body: { member_phone, birthday?, joined_at?, manager_phone?, notes? }
import { NextResponse } from "next/server";
import { getCurrentUserPhone } from "@/lib/session";
import { resolveTeamAdmin } from "@/lib/sprint";
import { getMemberMeta, upsertMemberMeta } from "@/lib/team-meta";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { name: string } }) {
  try {
    const userPhone = await getCurrentUserPhone();
    if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
    const teamName = decodeURIComponent(params.name);
    const adminPhone = await resolveTeamAdmin(teamName, userPhone);
    if (!adminPhone) return NextResponse.json({ ok: false, error: "team not found" }, { status: 404 });
    const meta = await getMemberMeta(adminPhone, teamName);
    return NextResponse.json({ ok: true, meta, is_admin: adminPhone === userPhone });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: { params: { name: string } }) {
  try {
    const userPhone = await getCurrentUserPhone();
    if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
    const teamName = decodeURIComponent(params.name);
    const adminPhone = await resolveTeamAdmin(teamName, userPhone);
    if (!adminPhone) return NextResponse.json({ ok: false, error: "team not found" }, { status: 404 });
    if (adminPhone !== userPhone) return NextResponse.json({ ok: false, error: "admin only" }, { status: 403 });

    let body: { member_phone?: string; birthday?: string | null; joined_at?: string | null; manager_phone?: string | null; notes?: string | null } = {};
    try { body = await req.json(); } catch { /* validate */ }
    const memberPhone = String(body.member_phone || "").replace(/\D/g, "");
    if (!memberPhone) return NextResponse.json({ ok: false, error: "member_phone required" }, { status: 400 });

    await upsertMemberMeta(adminPhone, teamName, memberPhone, {
      birthday: body.birthday ?? null,
      joined_at: body.joined_at ?? null,
      manager_phone: body.manager_phone ?? null,
      notes: body.notes ?? null,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
