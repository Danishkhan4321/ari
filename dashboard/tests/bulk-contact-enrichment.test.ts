import assert from "node:assert/strict";
import test from "node:test";

import { runBulkContactEnrichment } from "../lib/bulk-contact-enrichment";

test("bulk contact enrichment deduplicates targets and reports per-contact progress", async () => {
  const calls: string[] = [];
  const progress: string[] = [];
  const summary = await runBulkContactEnrichment(
    [
      { kind: "contact", id: 4 },
      { kind: "contact", id: 4 },
      { kind: "contact", id: 7 },
      { kind: "contact", id: 9 },
    ],
    async target => {
      calls.push(`${target.kind}:${target.id}`);
      if (target.id === 7) return { ok: true, status: "skipped" };
      if (target.id === 9) return { ok: false, status: "failed" };
      return { ok: true, status: "succeeded" };
    },
    (target, status) => progress.push(`${target.id}:${status}`),
  );

  assert.deepEqual(calls, ["contact:4", "contact:7", "contact:9"]);
  assert.deepEqual(summary, { total: 3, succeeded: 1, skipped: 1, failed: 1 });
  assert.deepEqual(progress, [
    "4:enriching", "4:succeeded",
    "7:enriching", "7:skipped",
    "9:enriching", "9:failed",
  ]);
});
