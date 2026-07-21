import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { query } from "@/lib/db";
import { getCurrentUserPhone } from "@/lib/session";
import { ENRICHMENT_FIELDS, enrichmentAvailability, enrichmentEnabled, estimateEnrichmentCost, leadEligibility, MAX_ENRICHMENT_LEADS } from "@/lib/lead-enrichment";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
  if (!enrichmentEnabled(userPhone)) return NextResponse.json({ ok: false, error: "Lead enrichment is not enabled for this workspace" }, { status: 403 });
  let body: { leadIds?: unknown[]; fields?: unknown[]; confirmCost?: boolean } = {};
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: "invalid body" }, { status: 400 }); }
  const leadIds = [...new Set((body.leadIds || []).map(Number).filter(id => Number.isInteger(id) && id > 0))];
  const fields = [...new Set((body.fields || ["profile"]).map(String).filter(v => (ENRICHMENT_FIELDS as readonly string[]).includes(v)))];
  if (!fields.includes("profile")) fields.unshift("profile");
  if (leadIds.length === 0 || leadIds.length > MAX_ENRICHMENT_LEADS) {
    return NextResponse.json({ ok: false, error: `Select between 1 and ${MAX_ENRICHMENT_LEADS} leads` }, { status: 400 });
  }

  const leadsResult = await query(`SELECT id,name,email,company,title,location,linkedin_url,website,company_domain
      FROM sales_leads WHERE user_phone=$1 AND id=ANY($2::bigint[]) ORDER BY id`, [userPhone, leadIds]);
  if (leadsResult.rows.length !== leadIds.length) return NextResponse.json({ ok: false, error: "One or more leads were not found" }, { status: 404 });
  const evaluated = leadsResult.rows.map(lead => ({ lead, ...leadEligibility(lead) }));
  const eligible = evaluated.filter(row => row.eligible);
  const estimate = estimateEnrichmentCost(eligible.length, fields);
  if (eligible.length === 0) return NextResponse.json({ ok: false, error: "Selected leads need stronger identifying data", ineligible: evaluated.map(r => ({ leadId: r.lead.id, reason: r.reason })) }, { status: 400 });
  if (estimate > 1 && body.confirmCost !== true) return NextResponse.json({ ok: false, code: "cost_confirmation_required", estimatedCost: estimate }, { status: 409 });

  const usage = await query<{ daily: string; monthly: string }>(`SELECT
    COALESCE(SUM(actual_cost_usd + CASE WHEN status IN ('queued','researching','applying') THEN estimated_cost_usd ELSE 0 END) FILTER (WHERE created_at >= date_trunc('day',NOW())),0) daily,
    COALESCE(SUM(actual_cost_usd + CASE WHEN status IN ('queued','researching','applying') THEN estimated_cost_usd ELSE 0 END) FILTER (WHERE created_at >= date_trunc('month',NOW())),0) monthly
    FROM lead_enrichment_jobs WHERE user_phone=$1`, [userPhone]);
  const dailyLimit = Number(process.env.LEAD_ENRICHMENT_DAILY_BUDGET_USD || 5);
  const monthlyLimit = Number(process.env.LEAD_ENRICHMENT_MONTHLY_BUDGET_USD || 25);
  if (Number(usage.rows[0].daily) + estimate > dailyLimit || Number(usage.rows[0].monthly) + estimate > monthlyLimit) {
    return NextResponse.json({ ok: false, code: "budget_exceeded", error: "Enrichment budget limit reached", usage: usage.rows[0], limits: { daily: dailyLimit, monthly: monthlyLimit } }, { status: 429 });
  }

  const slot = Math.floor(Date.now() / (10 * 60 * 1000));
  const key = createHash("sha256").update(`${eligible.map(r => Number(r.lead.id)).sort((a,b)=>a-b).join(",")}|${[...fields].sort().join(",")}|${slot}`).digest("hex").slice(0,64);
  const existing = await query(`SELECT id,status FROM lead_enrichment_jobs WHERE user_phone=$1 AND idempotency_key=$2`, [userPhone, key]);
  if (existing.rows[0]) return NextResponse.json({ ok: true, jobId: Number(existing.rows[0].id), status: existing.rows[0].status, reused: true });
  const created = await query(`INSERT INTO lead_enrichment_jobs
    (user_phone,status,requested_fields,lead_count,eligible_count,estimated_cost_usd,idempotency_key)
    VALUES($1,'queued',$2,$3,$4,$5,$6) RETURNING id,status`, [userPhone, fields, leadIds.length, eligible.length, estimate, key]);
  const jobId = created.rows[0].id;
  try {
    for (const row of eligible) {
      const lead = row.lead;
      const snapshot = { name: lead.name, email: lead.email, company: lead.company, title: lead.title, location: lead.location,
        linkedin_url: lead.linkedin_url, website: lead.website, company_domain: lead.company_domain };
      await query(`INSERT INTO lead_enrichment_items(job_id,lead_id,input_snapshot) VALUES($1,$2,$3::jsonb)`, [jobId, lead.id, JSON.stringify(snapshot)]);
    }
  } catch (error) {
    await query(`DELETE FROM lead_enrichment_jobs WHERE id=$1 AND user_phone=$2`, [jobId, userPhone]);
    throw error;
  }
  return NextResponse.json({ ok: true, jobId: Number(jobId), status: "queued", estimatedCost: estimate,
    eligibleCount: eligible.length, ineligible: evaluated.filter(r => !r.eligible).map(r => ({ leadId: r.lead.id, reason: r.reason })) }, { status: 202 });
}

export async function GET() {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
  if (process.env.ARI_DEMO_MODE === "true") {
    const availability = enrichmentAvailability(userPhone);
    return NextResponse.json({ ok: true, enabled: availability.enabled, disabledReason: availability.reason, jobs: [], usage: { daily: "0", monthly: "0" }, limits: { daily: 5, monthly: 25 } });
  }
  const result = await query(`SELECT id,status,lead_count,eligible_count,processed_count,enriched_count,unchanged_count,conflict_count,failed_count,
    estimated_cost_usd,actual_cost_usd,requested_fields,error,created_at,completed_at
    FROM lead_enrichment_jobs WHERE user_phone=$1 ORDER BY created_at DESC LIMIT 10`, [userPhone]);
  const usage = await query<{ daily: string; monthly: string }>(`SELECT
    COALESCE(SUM(actual_cost_usd) FILTER (WHERE created_at >= date_trunc('day',NOW())),0) daily,
    COALESCE(SUM(actual_cost_usd) FILTER (WHERE created_at >= date_trunc('month',NOW())),0) monthly
    FROM lead_enrichment_jobs WHERE user_phone=$1`, [userPhone]);
  const availability = enrichmentAvailability(userPhone);
  return NextResponse.json({ ok: true, enabled: availability.enabled, disabledReason: availability.reason, jobs: result.rows, usage: usage.rows[0],
    limits: { daily: Number(process.env.LEAD_ENRICHMENT_DAILY_BUDGET_USD || 5), monthly: Number(process.env.LEAD_ENRICHMENT_MONTHLY_BUDGET_USD || 25) } });
}
