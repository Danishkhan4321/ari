// dashboard/app/api/team/[name]/broadcasts/route.ts
//
// GET  — list past broadcasts with delivered/read counts.
// POST — compose + send a new broadcast (admin only).
//        Delegates the actual WhatsApp send to the bot's
//        /webhook/internal/dashboard-team-broadcast endpoint, which owns
//        Meta credentials. We never call Meta directly from the dashboard.
import { NextResponse } from "next/server";
import { getCurrentUserPhone } from "@/lib/session";
import { resolveTeamAdmin } from "@/lib/sprint";
import { listBroadcasts } from "@/lib/broadcast";
import { query } from "@/lib/db";
import { callBotInternal } from "@/lib/bot-bridge";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { name: string } }) {
  try {
    const userPhone = await getCurrentUserPhone();
    if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
    const teamName = decodeURIComponent(params.name);
    const adminPhone = await resolveTeamAdmin(teamName, userPhone);
    if (!adminPhone) return NextResponse.json({ ok: false, error: "team not found" }, { status: 404 });

    const safe = async <T>(fn: () => Promise<T>, fb: T) => { try { return await fn(); } catch { return fb; } };
    const broadcasts = await safe(() => listBroadcasts(adminPhone, teamName.toLowerCase()), []);
    return NextResponse.json({ ok: true, is_admin: adminPhone === userPhone, broadcasts });
  } catch {
    return NextResponse.json({ ok: false, error: "Could not load broadcasts." }, { status: 500 });
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

    let body: { message?: string } = {};
    try { body = await req.json(); } catch { /* validate */ }
    const message = String(body.message || "").trim();
    if (!message) return NextResponse.json({ ok: false, error: "message required" }, { status: 400 });
    if (message.length > 4000) return NextResponse.json({ ok: false, error: "message too long" }, { status: 400 });

    // Pull team members so we can pre-flight the recipient count to the user.
    const memRes = await query<{ member_phone: string; member_name: string | null }>(
      `SELECT DISTINCT member_phone, member_name FROM teams
        WHERE LOWER(team_name) = LOWER($1) AND admin_phone = $2`,
      [teamName.toLowerCase(), adminPhone]
    );
    const members = memRes.rows;
    if (members.length === 0) return NextResponse.json({ ok: false, error: "no members to send to" }, { status: 400 });

    const reply = await callBotInternal<{
      ok: boolean;
      team_message_id: number;
      total: number;
      sent: number;
      failed: number;
      failed_recipients: { name: string; phone: string }[];
    }>("/webhook/internal/dashboard-team-broadcast", {
        admin_phone: adminPhone,
        team_name: teamName.toLowerCase(),
        message_text: message,
        members,
      }, 60_000);
    if (!reply.ok) {
      return NextResponse.json({ ok: false, error: reply.error }, { status: 502 });
    }
    return NextResponse.json(reply.data);
  } catch {
    return NextResponse.json({ ok: false, error: "The broadcast could not be completed." }, { status: 500 });
  }
}
