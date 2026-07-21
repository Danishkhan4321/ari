// dashboard/app/api/checkout/start/route.ts
// GET /api/checkout/start?tier=cub&cycle=monthly
// Creates a Dodo Checkout Session with our return_url and 302-redirects
// the customer to Dodo. After payment, Dodo sends them back to
// /onboarding with subscription_id+status+email appended.
//
// Why we route through here instead of linking to /buy/pdt_xxx directly:
// static buy links don't support a configurable redirect URL — see Dodo
// docs. Sessions API does, and that's what the onboarding flow needs.
import { NextResponse } from "next/server";
import { createCheckoutSession } from "@/lib/dodo";
import { productId, type Cycle, type Tier } from "@/lib/products";

export const dynamic = "force-dynamic";

const BASE = (process.env.DASHBOARD_BASE_URL || "http://127.0.0.1:43101").replace(/\/+$/, "");

function isTier(v: string): v is Tier { return v === "cub" || v === "pack" || v === "alpha"; }
function isCycle(v: string): v is Cycle { return v === "monthly" || v === "annual"; }

export async function GET(req: Request) {
  const url = new URL(req.url);
  const tier = (url.searchParams.get("tier") || "").toLowerCase();
  const cycle = (url.searchParams.get("cycle") || "").toLowerCase();
  if (!isTier(tier) || !isCycle(cycle)) {
    return NextResponse.json({ ok: false, error: "tier/cycle required" }, { status: 400 });
  }

  let pid: string;
  try {
    pid = productId(tier, cycle);
  } catch {
    return NextResponse.json({ ok: false, error: "no product id configured" }, { status: 500 });
  }

  const session = await createCheckoutSession({
    productId: pid,
    returnUrl: `${BASE}/onboarding`,
    metadata: { tier, cycle },
  });
  if (!session) {
    return NextResponse.json({ ok: false, error: "could not create checkout session" }, { status: 502 });
  }
  return NextResponse.redirect(session.checkout_url, 303);
}
