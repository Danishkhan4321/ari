// dashboard/app/api/contacts/[id]/route.ts
// PATCH /api/contacts/<lead_id> — update a whitelist of editable lead fields
// (name, email, company, title, source, notes, linkedin_url, website,
// deal_value, priority). Stage has its own route (/api/contacts/stage).
// Authorization: every write is scoped by the session user_phone — the id
// alone is never sufficient (IDOR discipline).
import { NextResponse } from "next/server";
import { deleteLead, updateLeadFields, type LeadInput } from "@/lib/crm";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";

// Only these keys are forwarded to the data layer (which whitelists again).
const ALLOWED_KEYS: (keyof LeadInput)[] = [
  "name", "email", "company", "title", "source", "notes",
  "linkedin_url", "website", "deal_value", "priority",
  "archived",
];

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* fall through to empty */ }

  const patch: LeadInput = {};
  for (const k of ALLOWED_KEYS) {
    if (k in body) (patch as Record<string, unknown>)[k] = body[k];
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: false, error: "no editable fields supplied" }, { status: 400 });
  }
  if (patch.name != null && String(patch.name).trim() === "") {
    return NextResponse.json({ ok: false, error: "name cannot be empty" }, { status: 400 });
  }

  try {
    const ok = await updateLeadFields(userPhone, id, patch);
    if (!ok) return NextResponse.json({ ok: false, error: "lead not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
  try {
    const ok = await deleteLead(userPhone, id);
    return ok
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ ok: false, error: "contact not found" }, { status: 404 });
  } catch {
    return NextResponse.json({ ok: false, error: "Could not delete the contact." }, { status: 500 });
  }
}
