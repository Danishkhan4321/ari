export type EnrichmentTarget = { kind: "lead" | "contact"; id: number };

export type BulkEnrichmentState = "enriching" | "succeeded" | "skipped" | "failed";
export type BulkEnrichmentReply = { ok: boolean; status?: string };
export type BulkEnrichmentSummary = { total: number; succeeded: number; skipped: number; failed: number };

export async function runBulkContactEnrichment(
  targets: EnrichmentTarget[],
  enrich: (target: EnrichmentTarget) => Promise<BulkEnrichmentReply>,
  onProgress: (target: EnrichmentTarget, status: BulkEnrichmentState) => void,
): Promise<BulkEnrichmentSummary> {
  const seen = new Set<string>();
  const unique = targets.filter(target => {
    if (!Number.isInteger(target.id) || target.id <= 0) return false;
    const key = `${target.kind}:${target.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const summary: BulkEnrichmentSummary = { total: unique.length, succeeded: 0, skipped: 0, failed: 0 };

  for (const target of unique) {
    onProgress(target, "enriching");
    try {
      const reply = await enrich(target);
      const status: BulkEnrichmentState = reply.ok && reply.status === "skipped"
        ? "skipped"
        : reply.ok
          ? "succeeded"
          : "failed";
      summary[status === "succeeded" ? "succeeded" : status === "skipped" ? "skipped" : "failed"] += 1;
      onProgress(target, status);
    } catch {
      summary.failed += 1;
      onProgress(target, "failed");
    }
  }

  return summary;
}
