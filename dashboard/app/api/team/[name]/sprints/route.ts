// dashboard/app/api/team/[name]/sprints/route.ts
//
// GET    — full sprint payload for a team:
//          { active: { sprint, items, stats } | null, history, velocity }
//          One round-trip so the page renders fast.
//
// POST   — start a new sprint (admin-only).
//          Body: { name, endDate?: ISOdate, goal?: string }
//          Returns the new sprint or { ok:false, error } if one is already active.
//
// Authorization: only the team admin can mutate sprints; members can read.
import { NextResponse } from "next/server";
import { getCurrentUserPhone } from "@/lib/session";
import {
  resolveTeamAdmin,
  getActiveSprint,
  getSprintHistory,
  getVelocity,
  startSprint,
} from "@/lib/sprint";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { name: string } }) {
  try {
    const userPhone = await getCurrentUserPhone();
    if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

    const teamName = decodeURIComponent(params.name);
    const adminPhone = await resolveTeamAdmin(teamName, userPhone);
    if (!adminPhone) return NextResponse.json({ ok: false, error: "team not found" }, { status: 404 });

    // Fan out the three reads in parallel. Each is independently safe-
    // wrapped so a single missing table doesn't blow up the whole page.
    const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
      try { return await fn(); } catch { return fallback; }
    };

    const [active, history, velocity] = await Promise.all([
      safe(() => getActiveSprint(adminPhone), null),
      safe(() => getSprintHistory(adminPhone, 5), []),
      safe(() => getVelocity(adminPhone, 3), { avgVelocity: 0, sprints: [] }),
    ]);

    return NextResponse.json({
      ok: true,
      is_admin: adminPhone === userPhone,
      active,
      history,
      velocity,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: `sprints/get crashed: ${msg}` }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: { params: { name: string } }) {
  try {
    const userPhone = await getCurrentUserPhone();
    if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

    const teamName = decodeURIComponent(params.name);
    const adminPhone = await resolveTeamAdmin(teamName, userPhone);
    if (!adminPhone) return NextResponse.json({ ok: false, error: "team not found" }, { status: 404 });
    if (adminPhone !== userPhone) {
      return NextResponse.json({ ok: false, error: "only the team admin can start a sprint" }, { status: 403 });
    }

    let body: { name?: string; endDate?: string | null; goal?: string | null } = {};
    try { body = await req.json(); } catch { /* allow empty body to fall through to validation */ }
    const name = String(body.name || "").trim();
    if (!name) return NextResponse.json({ ok: false, error: "name required" }, { status: 400 });
    if (name.length > 250) return NextResponse.json({ ok: false, error: "name too long" }, { status: 400 });

    // endDate must be a parseable ISO date if provided. Anything else
    // we drop rather than insert garbage.
    let endDate: string | null = null;
    if (body.endDate) {
      const d = new Date(body.endDate);
      if (!Number.isNaN(d.getTime())) endDate = d.toISOString().slice(0, 10);
    }
    const goal = body.goal ? String(body.goal).trim().slice(0, 1000) : null;

    const result = await startSprint(adminPhone, name, endDate, goal);
    if (!result.ok) return NextResponse.json(result, { status: 409 });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: `sprints/post crashed: ${msg}` }, { status: 500 });
  }
}
