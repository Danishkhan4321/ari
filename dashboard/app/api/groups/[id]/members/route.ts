// dashboard/app/api/groups/[id]/members/route.ts
//
// POST   { members: [{kind, id}] } — add members to a group
// DELETE — remove members. Two shapes:
//          (a) ?kind=lead&memberId=42      → single (legacy)
//          (b) JSON body { members: [...] } → bulk, single DB round-trip
import { NextResponse } from "next/server";
import { addMembers, removeMember, removeMembersBulk } from "@/lib/groups";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";

type Member = { kind: "lead" | "contact"; id: number };

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
  const groupId = Number(params.id);
  if (!Number.isInteger(groupId)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
  let body: { members?: Member[] } = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const members = (body.members || []).filter(m =>
    m && (m.kind === "lead" || m.kind === "contact") && Number.isInteger(m.id) && m.id > 0
  );
  if (members.length === 0) return NextResponse.json({ ok: false, error: "no valid members" }, { status: 400 });
  const added = await addMembers(userPhone, groupId, members);
  return NextResponse.json({ ok: true, added });
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  try {
    const userPhone = await getCurrentUserPhone();
    if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
    const groupId = Number(params.id);
    if (!Number.isInteger(groupId)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });

    // Bulk mode — JSON body with members array. Single DB round-trip.
    let body: { members?: Member[] } = {};
    try { body = await req.json(); } catch { /* fine — fall back to query string */ }
    const bulkMembers = (body.members || []).filter(m =>
      m && (m.kind === "lead" || m.kind === "contact") && Number.isInteger(m.id) && m.id > 0
    );
    if (bulkMembers.length > 0) {
      const removed = await removeMembersBulk(userPhone, groupId, bulkMembers);
      return NextResponse.json({ ok: true, removed });
    }

    // Single mode — legacy query string. Kept so the per-row × button
    // (used by group-detail's "remove one" path) still works.
    const url = new URL(req.url);
    const kind = url.searchParams.get("kind") as "lead" | "contact" | null;
    const memberId = Number(url.searchParams.get("memberId"));
    if (kind !== "lead" && kind !== "contact") return NextResponse.json({ ok: false, error: "kind required" }, { status: 400 });
    if (!Number.isInteger(memberId)) return NextResponse.json({ ok: false, error: "memberId required" }, { status: 400 });
    const ok = await removeMember(userPhone, groupId, kind, memberId);
    if (!ok) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    return NextResponse.json({ ok: true, removed: 1 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: `delete crashed: ${msg}` }, { status: 500 });
  }
}
