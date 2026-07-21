// dashboard/app/api/contacts/check-dup/route.ts
// GET /api/contacts/check-dup?email=… — returns whether the signed-in user
// already has a lead with this email. Used by the "+ New lead" form to show
// a non-blocking duplicate warning before creating.
import { NextResponse } from "next/server";
import { findLeadByEmail } from "@/lib/crm";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

  const email = (new URL(req.url).searchParams.get("email") || "").trim();
  if (!email) return NextResponse.json({ ok: true, exists: false });

  try {
    const lead = await findLeadByEmail(userPhone, email);
    return NextResponse.json({ ok: true, exists: !!lead, lead: lead ?? null });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
