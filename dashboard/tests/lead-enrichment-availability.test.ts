import assert from "node:assert/strict";
import test from "node:test";

import {
  enrichmentAvailability,
  estimateEnrichmentCost,
  leadEligibility,
  MAX_ENRICHMENT_LEADS,
} from "../lib/lead-enrichment";

test("lead enrichment explains global and workspace restrictions", () => {
  const originalEnabled = process.env.LEAD_ENRICHMENT_ENABLED;
  const originalAllowlist = process.env.LEAD_ENRICHMENT_ALLOWLIST;
  try {
    process.env.LEAD_ENRICHMENT_ENABLED = "false";
    assert.deepEqual(enrichmentAvailability("918420982366"), {
      enabled: false,
      reason: "Lead enrichment is currently turned off.",
    });

    process.env.LEAD_ENRICHMENT_ENABLED = "true";
    process.env.LEAD_ENRICHMENT_ALLOWLIST = "918585897351";
    assert.deepEqual(enrichmentAvailability("918420982366"), {
      enabled: false,
      reason: "Lead enrichment is not enabled for this workspace.",
    });

    process.env.LEAD_ENRICHMENT_ALLOWLIST = "918585897351,918420982366";
    assert.deepEqual(enrichmentAvailability("918420982366"), { enabled: true, reason: null });
  } finally {
    if (originalEnabled === undefined) delete process.env.LEAD_ENRICHMENT_ENABLED;
    else process.env.LEAD_ENRICHMENT_ENABLED = originalEnabled;
    if (originalAllowlist === undefined) delete process.env.LEAD_ENRICHMENT_ALLOWLIST;
    else process.env.LEAD_ENRICHMENT_ALLOWLIST = originalAllowlist;
  }
});

test("a lead with a name and company is eligible for enrichment", () => {
  assert.deepEqual(
    leadEligibility({ name: "Omar Gastelum", company: "Gastelum Law, PPLSI" }),
    { eligible: true },
  );
});

test("bulk enrichment supports a selected list of 76 leads", () => {
  assert.equal(MAX_ENRICHMENT_LEADS, 100);
  assert.equal(estimateEnrichmentCost(76, ["profile"]), 1.264);
});
