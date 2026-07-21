import assert from "node:assert/strict";
import test from "node:test";

import {
  dedupeEnrichmentTargets,
  normalizeEnrichmentResult,
} from "../lib/contact-enrichment";

test("bulk enrichment deduplicates repeated member selections", () => {
  const result = dedupeEnrichmentTargets([
    { kind: "lead", id: 12 },
    { kind: "lead", id: 12 },
    { kind: "contact", id: 12 },
    { kind: "lead", id: -1 },
  ]);

  assert.deepEqual(result, [
    { kind: "lead", id: 12 },
    { kind: "contact", id: 12 },
  ]);
});

test("enrichment result keeps only valid public profile fields", () => {
  const result = normalizeEnrichmentResult({
    email: " AKASH@example.com ",
    company: " Acme ",
    title: " Founder ",
    linkedin_url: "https://www.linkedin.com/in/akash",
    website: "javascript:alert(1)",
    internal_error: "must not leak",
  });

  assert.deepEqual(result, {
    email: "akash@example.com",
    company: "Acme",
    title: "Founder",
    linkedin_url: "https://www.linkedin.com/in/akash",
    website: null,
  });
});

test("enrichment rejects malformed emails and non-http profile URLs", () => {
  const result = normalizeEnrichmentResult({
    email: "not-an-email",
    company: null,
    title: "",
    linkedin_url: "file:///etc/passwd",
    website: "https://example.com/profile",
  });

  assert.equal(result.email, null);
  assert.equal(result.linkedin_url, null);
  assert.equal(result.website, "https://example.com/profile");
});
