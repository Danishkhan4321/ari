// dashboard/app/api/team/[name]/sprints/plan-with-ai/route.ts
//
// POST — generate (preview only — no DB write) an AI project plan
//        from a natural-language goal. Returns the plan structure so
//        the user can preview, edit, and accept.
//
// Body: { goal, weeks }
// Auth: admin only (only admins can spend AI credits + create sprints).
import { NextResponse } from "next/server";
import { getCurrentUserPhone } from "@/lib/session";
import { resolveTeamAdmin } from "@/lib/sprint";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

const BOT_INTERNAL_URL = process.env.BOT_INTERNAL_URL || "http://127.0.0.1:43100";

export async function POST(req: Request, { params }: { params: { name: string } }) {
  try {
    const userPhone = await getCurrentUserPhone();
    if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
    const teamName = decodeURIComponent(params.name);
    const adminPhone = await resolveTeamAdmin(teamName, userPhone);
    if (!adminPhone) return NextResponse.json({ ok: false, error: "team not found" }, { status: 404 });
    if (adminPhone !== userPhone) return NextResponse.json({ ok: false, error: "admin only" }, { status: 403 });

    let body: { goal?: string; weeks?: number } = {};
    try { body = await req.json(); } catch { /* validate next */ }
    const goal = String(body.goal || "").trim();
    const weeks = Math.max(1, Math.min(26, Number(body.weeks) || 8));
    if (!goal) return NextResponse.json({ ok: false, error: "goal required" }, { status: 400 });
    if (goal.length > 1500) return NextResponse.json({ ok: false, error: "goal too long" }, { status: 400 });

    // Pull team members for the LLM to assign work to.
    const memRes = await query<{ member_phone: string; member_name: string | null }>(
      `SELECT member_phone, member_name FROM teams
        WHERE admin_phone = $1 AND team_name = $2
        ORDER BY id ASC`,
      [adminPhone, teamName.toLowerCase()]
    );
    const members = memRes.rows.map(r => ({ name: r.member_name || `+${r.member_phone}`, phone: r.member_phone }));
    if (members.length === 0) return NextResponse.json({ ok: false, error: "no members in team" }, { status: 400 });

    const secret = process.env.INTERNAL_API_SECRET;
    if (!secret) return NextResponse.json({ ok: false, error: "INTERNAL_API_SECRET not set" }, { status: 500 });

    const res = await fetch(`${BOT_INTERNAL_URL}/webhook/internal/ai-project-plan`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": secret,
        "x-forwarded-proto": "https",
      },
      body: JSON.stringify({ goal, weeks, members }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `bot returned ${res.status}: ${txt.slice(0, 200)}` }, { status: 502 });
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
