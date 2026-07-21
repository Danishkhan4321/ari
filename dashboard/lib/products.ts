// dashboard/lib/products.ts
// Shared Ari product definitions. The product surfaces share
// Dodo product IDs but each holds its own copy so neither has to import
// across project boundaries.
//
// To rotate IDs: update both files together.
export type Tier = "cub" | "pack" | "alpha";
export type Cycle = "monthly" | "annual";

const TEST_IDS: Record<Tier, Record<Cycle, string>> = {
  cub:   { monthly: "pdt_0Ndsqg9tNymnW8W34GHBf", annual: "pdt_0NdsqjgYH3ZIl9tDOJ2hG" },
  pack:  { monthly: "pdt_0NdsqjknyEawL5foYHwki", annual: "pdt_0Ndsqjnxbr929Q0M5wN6w" },
  alpha: { monthly: "pdt_0Ndsqjr3UtlvRhx2flDMa", annual: "pdt_0NdsqjuQ0eRMiEKDzARHU" },
};

const LIVE_IDS: Record<Tier, Record<Cycle, string>> = {
  cub:   { monthly: "pdt_0NdsuVkqGbtvBEBJH82rT", annual: "pdt_0NdsuVoR9m1TcDLxhMNCZ" },
  pack:  { monthly: "pdt_0NdsuVs4GOBTRCnLSgU1J", annual: "pdt_0NdsuVveOiDlF1Ix5uYmJ" },
  alpha: { monthly: "pdt_0NdsuVzVqDis8erYKWreM", annual: "pdt_0NdsuW2trmLGrl1ylwavi" },
};

const MODE: "test" | "live" =
  process.env.DODO_MODE === "live"
    ? "live"
    : process.env.DODO_MODE === "test"
    ? "test"
    : process.env.NODE_ENV === "production"
    ? "live"
    : "test";

export function productId(tier: Tier, cycle: Cycle): string {
  const ids = MODE === "live" ? LIVE_IDS : TEST_IDS;
  const id = ids[tier]?.[cycle];
  if (!id) throw new Error(`No Dodo product id for ${tier}/${cycle} (${MODE} mode)`);
  return id;
}

export function tierFromProductId(productId: string): Tier | null {
  const ids = MODE === "live" ? LIVE_IDS : TEST_IDS;
  for (const tier of ["cub", "pack", "alpha"] as Tier[]) {
    if (ids[tier].monthly === productId || ids[tier].annual === productId) return tier;
  }
  return null;
}

export function dodoMode(): "test" | "live" { return MODE; }
export function dodoApiBase(): string {
  return MODE === "live" ? "https://live.dodopayments.com" : "https://test.dodopayments.com";
}
