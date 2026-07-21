// dashboard/app/api/team/[name]/sprints/items/route.ts
//
// POST — add an item to the team's active sprint (admin or member can add).
// Body: { title, assignedTo?, assignedToName?, storyPoints? }
import { NextResponse } from "next/server";
import { getCurrentUserPhone } from "@/lib/session";
import { resolveTeamAdmin, getActiveSprint, addSprintItem } from "@/lib/sprint";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { name: string } }) {
  try {
    const userPhone = await getCurrentUserPhone();
    if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

    const teamName = decodeURIComponent(params.name);
    const adminPhone = await resolveTeamAdmin(teamName, userPhone);
    if (!adminPhone) return NextResponse.json({ ok: false, error: "team not found" }, { status: 404 });

    let body: { title?: string; assignedTo?: string | null; assignedToName?: string | null; storyPoints?: number } = {};
    try { body = await req.json(); } catch { /* validate next */ }
    const title = String(body.title || "").trim();
    if (!title) return NextResponse.json({ ok: false, error: "title required" }, { status: 400 });
    if (title.length > 480) return NextResponse.json({ ok: false, error: "title too long" }, { status: 400 });

    const active = await getActiveSprint(adminPhone);
    if (!active) return NextResponse.json({ ok: false, error: "no active sprint" }, { status: 409 });

    const item = await addSprintItem(adminPhone, active.sprint.id, {
      title,
      assignedTo: body.assignedTo ?? null,
      assignedToName: body.assignedToName ?? null,
      storyPoints: typeof body.storyPoints === "number" ? body.storyPoints : 1,
    });
    if (!item) return NextResponse.json({ ok: false, error: "could not add item" }, { status: 500 });
    return NextResponse.json({ ok: true, item });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: `sprint-items/post crashed: ${msg}` }, { status: 500 });
  }
}
