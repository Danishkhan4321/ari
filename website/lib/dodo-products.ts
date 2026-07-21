// ari-website/lib/dodo-products.ts
// Single source of truth for Dodo Payments buy links per tier + cycle.
//
// The pricing page (and any other CTA) imports `buyLink(tier, cycle)` to
// resolve the right Dodo checkout URL. To switch from test mode to live:
//   1. Create the same 6 products via Dodo's API in live mode
//   2. Replace the IDs in the LIVE_IDS block below
//   3. Set NEXT_PUBLIC_DODO_MODE=live (Vercel/Cloudflare env var, or .env)
// No other code change needed.

export type Tier = "cub" | "pack" | "alpha";
export type Cycle = "monthly" | "annual";

const TEST_IDS: Record<Tier, Record<Cycle, string>> = {
  cub:   { monthly: "pdt_0Ndsqg9tNymnW8W34GHBf", annual: "pdt_0NdsqjgYH3ZIl9tDOJ2hG" },
  pack:  { monthly: "pdt_0NdsqjknyEawL5foYHwki", annual: "pdt_0Ndsqjnxbr929Q0M5wN6w" },
  alpha: { monthly: "pdt_0Ndsqjr3UtlvRhx2flDMa", annual: "pdt_0NdsqjuQ0eRMiEKDzARHU" },
};

// Live mode product IDs — created in Dodo live API on 2026-05-01.
// To rotate: create new products, paste new IDs here, redeploy.
const LIVE_IDS: Record<Tier, Record<Cycle, string>> = {
  cub:   { monthly: "pdt_0NdsuVkqGbtvBEBJH82rT", annual: "pdt_0NdsuVoR9m1TcDLxhMNCZ" },
  pack:  { monthly: "pdt_0NdsuVs4GOBTRCnLSgU1J", annual: "pdt_0NdsuVveOiDlF1Ix5uYmJ" },
  alpha: { monthly: "pdt_0NdsuVzVqDis8erYKWreM", annual: "pdt_0NdsuW2trmLGrl1ylwavi" },
};

// Mode resolution:
//   1. If NEXT_PUBLIC_DODO_MODE is explicitly set, honor it. Useful for
//      preview deploys that should hit test products even when built in
//      production mode.
//   2. Otherwise, default to "live" in production builds, "test" in dev.
//   This avoids the foot-gun where you forget to set the env var and
//   silently ship test checkout to real customers.
const MODE: "test" | "live" =
  process.env.NEXT_PUBLIC_DODO_MODE === "live"
    ? "live"
    : process.env.NEXT_PUBLIC_DODO_MODE === "test"
    ? "test"
    : process.env.NODE_ENV === "production"
    ? "live"
    : "test";

const HOST = MODE === "live"
  ? "https://checkout.dodopayments.com"
  : "https://test.checkout.dodopayments.com";

export function productId(tier: Tier, cycle: Cycle): string {
  const ids = MODE === "live" ? LIVE_IDS : TEST_IDS;
  const id = ids[tier]?.[cycle];
  if (!id) {
    throw new Error(`No Dodo product id for ${tier}/${cycle} in ${MODE} mode. Update ari-website/lib/dodo-products.ts.`);
  }
  return id;
}

export function buyLink(tier: Tier, cycle: Cycle): string {
  // Route through the dashboard, which creates a Dodo Checkout Session
  // with a return_url pointing at the post-purchase onboarding wizard.
  // Dodo's static /buy/{productId} URLs don't support a configurable
  // return URL, so going via the dashboard is what makes onboarding
  // possible. The redirect chain is:
  //   click → local Ari app/api/checkout/start?tier=X&cycle=Y
  //         → 303 → checkout.dodopayments.com/session/<id>
  //         → after payment: local Ari app/onboarding?subscription_id=…
  const dashboardBase = process.env.NEXT_PUBLIC_DASHBOARD_BASE_URL
    || "http://127.0.0.1:43101";
  return `${dashboardBase}/api/checkout/start?tier=${tier}&cycle=${cycle}`;
}

// Kept for reference / a future "quick-pay" marketing surface that
// bypasses our onboarding (no return_url plumbed). Not used by the
// pricing page anymore.
export function directBuyLink(tier: Tier, cycle: Cycle): string {
  return `${HOST}/buy/${productId(tier, cycle)}`;
}

export function isLiveMode(): boolean {
  return MODE === "live";
}
