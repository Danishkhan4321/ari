// dashboard/app/api/contacts/create/route.ts
// POST /api/contacts/create — manually create a sales lead from the
// dashboard (the "+ New lead" slide-over). source defaults to "manual".
// Scoped by the session user_phone.
import { NextResponse } from "next/server";
import { createLead, type LeadInput } from "@/lib/crm";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";

const ALLOWED_KEYS: (keyof LeadInput)[] = [
  "name", "email", "company", "title", "source", "stage",
  "notes", "linkedin_url", "website", "deal_value", "priority",
];

export async function POST(req: Request) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* fall through */ }

  const input: LeadInput = {};
  for (const k of ALLOWED_KEYS) {
    if (k in body) (input as Record<string, unknown>)[k] = body[k];
  }

  try {
    const result = await createLead(userPhone, input);
    if ("error" in result) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
    }
    return NextResponse.json({ ok: true, id: result.id });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
