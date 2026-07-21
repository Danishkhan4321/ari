import { NextResponse } from "next/server";
import { getCurrentUserPhone } from "@/lib/session";
import { resolveTeamAdmin } from "@/lib/sprint";
import { deleteOneOnOne } from "@/lib/one-on-one";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: { name: string; id: string } }) {
  try {
    const userPhone = await getCurrentUserPhone();
    if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
    const teamName = decodeURIComponent(params.name);
    const adminPhone = await resolveTeamAdmin(teamName, userPhone);
    if (!adminPhone) return NextResponse.json({ ok: false, error: "team not found" }, { status: 404 });
    if (adminPhone !== userPhone) return NextResponse.json({ ok: false, error: "admin only" }, { status: 403 });
    const id = Number(params.id);
    if (!Number.isInteger(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
    const ok = await deleteOneOnOne(adminPhone, id);
    if (!ok) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
