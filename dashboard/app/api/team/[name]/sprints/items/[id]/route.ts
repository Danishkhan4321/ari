// dashboard/app/api/team/[name]/sprints/items/[id]/route.ts
//
// PATCH  — { status: 'todo' | 'in_progress' | 'done' | 'blocked' }
// DELETE — remove an item from the sprint (admin only)
//
// Both check that the item belongs to a sprint owned by this team.
// Members can change status (so people can move their own work along
// from WhatsApp or the dashboard); only the admin can delete.
import { NextResponse } from "next/server";
import { getCurrentUserPhone } from "@/lib/session";
import { resolveTeamAdmin, updateSprintItemStatus, deleteSprintItem } from "@/lib/sprint";

export const dynamic = "force-dynamic";

const VALID_STATUSES = new Set(["todo", "in_progress", "done", "blocked"]);

export async function PATCH(
  req: Request,
  { params }: { params: { name: string; id: string } }
) {
  try {
    const userPhone = await getCurrentUserPhone();
    if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

    const teamName = decodeURIComponent(params.name);
    const adminPhone = await resolveTeamAdmin(teamName, userPhone);
    if (!adminPhone) return NextResponse.json({ ok: false, error: "team not found" }, { status: 404 });

    const itemId = Number(params.id);
    if (!Number.isInteger(itemId)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });

    let body: { status?: string } = {};
    try { body = await req.json(); } catch { /* fall through */ }
    const status = String(body.status || "");
    if (!VALID_STATUSES.has(status)) {
      return NextResponse.json({ ok: false, error: "invalid status" }, { status: 400 });
    }

    const item = await updateSprintItemStatus(adminPhone, itemId, status as "todo" | "in_progress" | "done" | "blocked");
    if (!item) return NextResponse.json({ ok: false, error: "item not found" }, { status: 404 });
    return NextResponse.json({ ok: true, item });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: `sprint-item/patch crashed: ${msg}` }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: { name: string; id: string } }
) {
  try {
    const userPhone = await getCurrentUserPhone();
    if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

    const teamName = decodeURIComponent(params.name);
    const adminPhone = await resolveTeamAdmin(teamName, userPhone);
    if (!adminPhone) return NextResponse.json({ ok: false, error: "team not found" }, { status: 404 });
    if (adminPhone !== userPhone) {
      return NextResponse.json({ ok: false, error: "only the team admin can delete items" }, { status: 403 });
    }

    const itemId = Number(params.id);
    if (!Number.isInteger(itemId)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });

    const ok = await deleteSprintItem(adminPhone, itemId);
    if (!ok) return NextResponse.json({ ok: false, error: "item not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: `sprint-item/delete crashed: ${msg}` }, { status: 500 });
  }
}
