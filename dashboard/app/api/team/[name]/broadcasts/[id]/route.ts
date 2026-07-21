// dashboard/app/api/team/[name]/broadcasts/[id]/route.ts
//
// GET — recipient list with per-member status (sent / delivered / read / failed).
import { NextResponse } from "next/server";
import { getCurrentUserPhone } from "@/lib/session";
import { resolveTeamAdmin } from "@/lib/sprint";
import { getRecipients } from "@/lib/broadcast";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { name: string; id: string } }) {
  try {
    const userPhone = await getCurrentUserPhone();
    if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
    const teamName = decodeURIComponent(params.name);
    const adminPhone = await resolveTeamAdmin(teamName, userPhone);
    if (!adminPhone) return NextResponse.json({ ok: false, error: "team not found" }, { status: 404 });

    const id = Number(params.id);
    if (!Number.isInteger(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });

    const recipients = await getRecipients(adminPhone, id);
    return NextResponse.json({ ok: true, recipients });
  } catch {
    return NextResponse.json({ ok: false, error: "Could not load broadcast recipients." }, { status: 500 });
  }
}
