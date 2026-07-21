// dashboard/app/api/team/[name]/sprints/end/route.ts
//
// POST — close the team's active sprint (admin-only).
// No body. Returns { ok: true } even if there was no active sprint —
// the UI only offers this button when a sprint is active, so the
// race-loss case doesn't need to surface as an error.
import { NextResponse } from "next/server";
import { getCurrentUserPhone } from "@/lib/session";
import { resolveTeamAdmin, endActiveSprint } from "@/lib/sprint";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { name: string } }) {
  try {
    const userPhone = await getCurrentUserPhone();
    if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

    const teamName = decodeURIComponent(params.name);
    const adminPhone = await resolveTeamAdmin(teamName, userPhone);
    if (!adminPhone) return NextResponse.json({ ok: false, error: "team not found" }, { status: 404 });
    if (adminPhone !== userPhone) {
      return NextResponse.json({ ok: false, error: "only the team admin can end a sprint" }, { status: 403 });
    }

    const ended = await endActiveSprint(adminPhone);
    return NextResponse.json({ ok: true, ended });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: `sprints/end crashed: ${msg}` }, { status: 500 });
  }
}
