export const ENRICHMENT_FIELDS = ["profile", "email", "phone"] as const;
export type EnrichmentField = (typeof ENRICHMENT_FIELDS)[number];
export const MAX_ENRICHMENT_LEADS = 100;

export function enrichmentAvailability(userPhone: string): { enabled: boolean; reason: string | null } {
  if (process.env.LEAD_ENRICHMENT_ENABLED !== "true") {
    return { enabled: false, reason: "Lead enrichment is currently turned off." };
  }
  const allowlist = (process.env.LEAD_ENRICHMENT_ALLOWLIST || "").split(",").map(v => v.replace(/\D/g, "")).filter(Boolean);
  if (allowlist.length > 0 && !allowlist.includes(userPhone.replace(/\D/g, ""))) {
    return { enabled: false, reason: "Lead enrichment is not enabled for this workspace." };
  }
  return { enabled: true, reason: null };
}

export function enrichmentEnabled(userPhone: string): boolean {
  return enrichmentAvailability(userPhone).enabled;
}

export function leadEligibility(lead: Record<string, unknown>): { eligible: boolean; reason?: string } {
  if (!String(lead.name || "").trim()) return { eligible: false, reason: "Missing name" };
  const email = String(lead.email || "");
  const strong = Boolean(
    String(lead.linkedin_url || "").trim() || /@[^@]+\.[^@]+$/.test(email)
    || String(lead.company || "").trim()
    || String(lead.company_domain || "").trim()
    || (String(lead.company || "").trim() && String(lead.website || "").trim())
    || (String(lead.company || "").trim() && String(lead.location || "").trim())
  );
  return strong ? { eligible: true } : { eligible: false, reason: "Add a company, LinkedIn profile, work email, website, or location" };
}

export function estimateEnrichmentCost(count: number, fields: readonly string[]): number {
  const safe = Math.max(0, Math.min(MAX_ENRICHMENT_LEADS, Number(count) || 0));
  const batches = Math.ceil(safe / 10);
  return Number((batches * 0.025 + safe * 0.014 + safe * (fields.includes("email") ? 0.02 : 0) + safe * (fields.includes("phone") ? 0.07 : 0)).toFixed(6));
}
