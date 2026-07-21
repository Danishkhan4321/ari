// dashboard/app/api/onboarding/save/route.ts
// POST { subscription_id, name, phone }
// Saves the user-provided pieces of the onboarding wizard. The subscription
// is verified earlier when the row is upserted by the page itself; here we
// only let the caller fill in name + phone.
import { NextResponse } from "next/server";
import { getPending, normalizePhone, setNameAndPhone } from "@/lib/onboarding";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { subscription_id?: string; name?: string; phone?: string } = {};
  try { body = await req.json(); } catch { /* fall through */ }

  const subId = String(body.subscription_id || "").trim();
  const name = String(body.name || "").trim();
  const phoneRaw = String(body.phone || "").trim();
  if (!subId) return NextResponse.json({ ok: false, error: "subscription_id required" }, { status: 400 });
  if (name.length < 1 || name.length > 60) {
    return NextResponse.json({ ok: false, error: "name length 1–60" }, { status: 400 });
  }
  const phone = normalizePhone(phoneRaw);
  if (!phone) {
    return NextResponse.json({ ok: false, error: "phone must be a valid international number (10–15 digits incl. country code)" }, { status: 400 });
  }

  // Make sure the row actually exists (the page upserted it on first visit)
  const existing = await getPending(subId);
  if (!existing) {
    return NextResponse.json({ ok: false, error: "no onboarding session for this subscription" }, { status: 404 });
  }
  if (existing.status === "completed") {
    return NextResponse.json({ ok: false, error: "onboarding already finished" }, { status: 409 });
  }

  await setNameAndPhone(subId, name, phone);
  return NextResponse.json({ ok: true });
}
