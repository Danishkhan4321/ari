// dashboard/app/api/team/[name]/chats/route.ts
//
// GET  — list chats (groups + DMs) the current user belongs to.
// POST — create a new chat. Body:
//          { type: "group"|"dm", name?, member_phones: string[] }
import { NextResponse } from "next/server";
import { getCurrentUserPhone } from "@/lib/session";
import { resolveTeamAdmin } from "@/lib/sprint";
import { listChats, createChat } from "@/lib/team-chat";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { name: string } }) {
  try {
    const userPhone = await getCurrentUserPhone();
    if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
    const teamName = decodeURIComponent(params.name);
    const adminPhone = await resolveTeamAdmin(teamName, userPhone);
    if (!adminPhone) return NextResponse.json({ ok: false, error: "team not found" }, { status: 404 });

    const chats = await listChats(adminPhone, userPhone);
    return NextResponse.json({ ok: true, chats, current_user_phone: userPhone });
  } catch {
    return NextResponse.json({ ok: false, error: "Could not load team chats." }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: { params: { name: string } }) {
  try {
    const userPhone = await getCurrentUserPhone();
    if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
    const teamName = decodeURIComponent(params.name);
    const adminPhone = await resolveTeamAdmin(teamName, userPhone);
    if (!adminPhone) return NextResponse.json({ ok: false, error: "team not found" }, { status: 404 });

    let body: { type?: string; name?: string; member_phones?: string[] } = {};
    try { body = await req.json(); } catch { /* validate next */ }
    const type = body.type === "dm" ? "dm" : "group";
    const name = type === "group" ? String(body.name || "").trim().slice(0, 200) : null;
    const memberPhones = (body.member_phones || []).map(p => String(p).replace(/\D/g, "")).filter(Boolean);

    if (memberPhones.length === 0) return NextResponse.json({ ok: false, error: "at least one other member required" }, { status: 400 });
    if (type === "group" && !name) return NextResponse.json({ ok: false, error: "group name required" }, { status: 400 });
    if (type === "dm" && memberPhones.length !== 1) return NextResponse.json({ ok: false, error: "DM must have exactly one other member" }, { status: 400 });

    // Verify all picked phones are members of the team
    const teamMembers = await query<{ member_phone: string; member_name: string | null }>(
      `SELECT member_phone, member_name FROM teams WHERE admin_phone = $1 AND team_name = $2`,
      [adminPhone, teamName.toLowerCase()]
    );
    const teamPhones = new Set(teamMembers.rows.map(m => m.member_phone));
    teamPhones.add(adminPhone); // admin counts as a member for chat purposes
    const invalid = memberPhones.filter(p => !teamPhones.has(p));
    if (invalid.length > 0) {
      return NextResponse.json({ ok: false, error: `not in team: ${invalid.join(", ")}` }, { status: 400 });
    }

    // Build name lookup
    const memberNames: Record<string, string | null> = {};
    for (const m of teamMembers.rows) memberNames[m.member_phone] = m.member_name;
    const creatorName = memberNames[userPhone] || null;

    const chat = await createChat(adminPhone, {
      type,
      name,
      teamName: teamName.toLowerCase(),
      creatorPhone: userPhone,
      creatorName,
      memberPhones,
      memberNames,
    });
    if (!chat) return NextResponse.json({ ok: false, error: "could not create chat" }, { status: 500 });
    return NextResponse.json({ ok: true, chat });
  } catch {
    return NextResponse.json({ ok: false, error: "Could not create the team chat." }, { status: 500 });
  }
}
