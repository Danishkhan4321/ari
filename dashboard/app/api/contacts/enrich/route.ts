import { NextResponse } from "next/server";

import { callBotInternal } from "@/lib/bot-bridge";
import {
  dedupeEnrichmentTargets,
  enrichmentFingerprint,
  normalizeEnrichmentResult,
  type EnrichmentResult,
} from "@/lib/contact-enrichment";
import { query } from "@/lib/db";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";

type ProfileRow = EnrichmentResult & {
  name: string;
  phone: string | null;
};

export async function POST(req: Request) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) {
    return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });
  }

  try {
    const body = await req.json().catch(() => null) as { member?: unknown } | null;
    const [target] = dedupeEnrichmentTargets(body?.member ? [body.member] : []);
    if (!target) {
      return NextResponse.json({ ok: false, error: "A valid contact is required." }, { status: 400 });
    }

    const table = target.kind === "lead" ? "sales_leads" : "contacts";
    const phoneExpression = target.kind === "lead" ? "NULL::text AS phone" : "phone";
    const profileResult = await query<ProfileRow>(
      `SELECT name, email, ${phoneExpression}, company, title, linkedin_url, website
         FROM ${table}
        WHERE id = $1 AND user_phone = $2
        LIMIT 1`,
      [target.id, userPhone],
    );
    const profile = profileResult.rows[0];
    if (!profile) {
      return NextResponse.json({ ok: false, error: "Contact not found." }, { status: 404 });
    }

    const fingerprint = enrichmentFingerprint(profile);
    const claimed = await query<{ id: string }>(
      `INSERT INTO contact_enrichment_runs
         (user_phone, member_kind, member_id, fingerprint, status)
       VALUES ($1, $2, $3, $4, 'in_progress')
       ON CONFLICT (user_phone, member_kind, member_id, fingerprint) DO UPDATE
         SET status = 'in_progress', attempts = contact_enrichment_runs.attempts + 1,
             started_at = NOW(), completed_at = NULL, error_code = NULL, updated_at = NOW()
       WHERE contact_enrichment_runs.status = 'failed'
          OR (contact_enrichment_runs.status = 'in_progress'
              AND contact_enrichment_runs.updated_at < NOW() - INTERVAL '10 minutes')
       RETURNING id::text`,
      [userPhone, target.kind, target.id, fingerprint],
    );

    if (claimed.rowCount === 0) {
      const existing = await query<{ status: string; result: EnrichmentResult | null }>(
        `SELECT status, result
           FROM contact_enrichment_runs
          WHERE user_phone = $1 AND member_kind = $2 AND member_id = $3 AND fingerprint = $4`,
        [userPhone, target.kind, target.id, fingerprint],
      );
      const run = existing.rows[0];
      if (run?.status === "succeeded") {
        return NextResponse.json({ ok: true, status: "skipped", data: run.result, message: "Already enriched." });
      }
      return NextResponse.json(
        { ok: false, status: "in_progress", error: "This contact is already being enriched." },
        { status: 409 },
      );
    }

    const botReply = await callBotInternal<{ ok: boolean; data?: unknown; error?: string }>(
      "/webhook/internal/dashboard-contact-enrich",
      { profile },
      45_000,
    );
    if (!botReply.ok || !botReply.data.ok) {
      await query(
        `UPDATE contact_enrichment_runs
            SET status = 'failed', error_code = 'lookup_failed', completed_at = NOW(), updated_at = NOW()
          WHERE id = $1`,
        [claimed.rows[0].id],
      );
      let error = "Contact enrichment failed.";
      if (!botReply.ok) error = botReply.error;
      else if (typeof botReply.data.error === "string") error = botReply.data.error;
      return NextResponse.json({ ok: false, status: "failed", error }, { status: 422 });
    }

    const data = normalizeEnrichmentResult(botReply.data.data);
    const updated = await query<ProfileRow>(
      `UPDATE ${table}
          SET email = COALESCE(email, $1),
              company = COALESCE(company, $2),
              title = COALESCE(title, $3),
              linkedin_url = COALESCE(linkedin_url, $4),
              website = COALESCE(website, $5),
              updated_at = NOW()
        WHERE id = $6 AND user_phone = $7
        RETURNING name, email, phone, company, title, linkedin_url, website`,
      [data.email, data.company, data.title, data.linkedin_url, data.website, target.id, userPhone],
    );
    const finalData = normalizeEnrichmentResult(updated.rows[0]);
    await query(
      `UPDATE contact_enrichment_runs
          SET status = 'succeeded', result = $1::jsonb, completed_at = NOW(), updated_at = NOW()
        WHERE id = $2`,
      [JSON.stringify(finalData), claimed.rows[0].id],
    );
    return NextResponse.json({ ok: true, status: "succeeded", data: finalData });
  } catch (error) {
    console.error("[ContactEnrichment] request failed", error instanceof Error ? error.name : "unknown");
    return NextResponse.json(
      { ok: false, status: "failed", error: "Contact enrichment is temporarily unavailable." },
      { status: 500 },
    );
  }
}
