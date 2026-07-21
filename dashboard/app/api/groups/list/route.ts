// dashboard/app/api/groups/list/route.ts
// GET — list of groups owned by the signed-in user, with member counts.
// POST { name, emoji? } — create a new group.
import { NextResponse } from "next/server";
import { listGroups, createGroup } from "@/lib/groups";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
  const groups = await listGroups(userPhone);
  return NextResponse.json({ ok: true, groups });
}

export async function POST(req: Request) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
  let body: { name?: string; emoji?: string } = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const name = String(body.name || "").trim();
  if (name.length < 1 || name.length > 120) {
    return NextResponse.json({ ok: false, error: "name 1–120 chars" }, { status: 400 });
  }
  const emoji = body.emoji ? String(body.emoji).slice(0, 8) : null;
  const group = await createGroup(userPhone, name, emoji);
  return NextResponse.json({ ok: true, group });
}
