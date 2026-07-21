import { createHash } from "node:crypto";

export type EnrichmentTarget = { kind: "lead" | "contact"; id: number };

export type EnrichmentResult = {
  email: string | null;
  company: string | null;
  title: string | null;
  linkedin_url: string | null;
  website: string | null;
};

export function dedupeEnrichmentTargets(input: unknown): EnrichmentTarget[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const result: EnrichmentTarget[] = [];

  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as { kind?: unknown; id?: unknown };
    if (candidate.kind !== "lead" && candidate.kind !== "contact") continue;
    if (!Number.isInteger(candidate.id) || Number(candidate.id) <= 0) continue;
    const target = { kind: candidate.kind, id: Number(candidate.id) } as EnrichmentTarget;
    const key = `${target.kind}:${target.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(target);
  }
  return result;
}

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim().replace(/\s+/g, " ").slice(0, maxLength);
  return clean || null;
}

function cleanUrl(value: unknown): string | null {
  const text = cleanText(value, 500);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function normalizeEnrichmentResult(input: unknown): EnrichmentResult {
  const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const emailText = cleanText(value.email, 254)?.toLowerCase() ?? null;
  const email = emailText && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailText) ? emailText : null;

  return {
    email,
    company: cleanText(value.company, 200),
    title: cleanText(value.title, 200),
    linkedin_url: cleanUrl(value.linkedin_url),
    website: cleanUrl(value.website),
  };
}

export function enrichmentFingerprint(profile: Record<string, unknown>): string {
  // Only stable identity fields participate. Enriched fields must not change
  // the fingerprint, otherwise a retry immediately after success would make
  // a second unnecessary Exa request.
  const identity = ["name", "phone"]
    .map(key => String(profile[key] ?? "").trim().toLowerCase())
    .join("|");
  return createHash("sha256").update(identity).digest("hex");
}
