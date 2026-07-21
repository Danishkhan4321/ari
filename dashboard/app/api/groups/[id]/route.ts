// dashboard/app/api/groups/[id]/route.ts
// GET — group detail + members
// DELETE — remove the group (cascades to members)
import { NextResponse } from "next/server";
import { getGroup, listGroupMembers, deleteGroup, updateGroup } from "@/lib/groups";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const userPhone = await getCurrentUserPhone();
    if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
    const id = Number(params.id);
    if (!Number.isInteger(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
    const group = await getGroup(userPhone, id);
    if (!group) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    const members = await listGroupMembers(userPhone, id);
    return NextResponse.json({ ok: true, group, members });
  } catch {
    return NextResponse.json({ ok: false, error: "Could not load the contact group." }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  try {
    const userPhone = await getCurrentUserPhone();
    if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
    const id = Number(params.id);
    if (!Number.isInteger(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
    const ok = await deleteGroup(userPhone, id);
    if (!ok) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false, error: "Could not remove the contact group." }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const userPhone = await getCurrentUserPhone();
    if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
    const id = Number(params.id);
    if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
    const body = await req.json() as { name?: string; emoji?: string | null; archived?: boolean };
    if (body.name !== undefined && (body.name.trim().length < 1 || body.name.trim().length > 120)) {
      return NextResponse.json({ ok: false, error: "name must be between 1 and 120 characters" }, { status: 400 });
    }
    const group = await updateGroup(userPhone, id, { name: body.name, emoji: body.emoji ? String(body.emoji).slice(0, 8) : body.emoji, archived: body.archived });
    if (!group) return NextResponse.json({ ok: false, error: "group not found" }, { status: 404 });
    return NextResponse.json({ ok: true, group });
  } catch {
    return NextResponse.json({ ok: false, error: "Could not update the contact group." }, { status: 500 });
  }
}
