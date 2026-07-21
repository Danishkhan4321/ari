'use strict';

const { query, pool } = require('../config/database');
const logger = require('../utils/logger');
const exaAgent = require('./exa-agent.service');
const policy = require('./lead-enrichment-policy');

const FIELD_COLUMNS = {
  email: 'email', phone: 'phone', title: 'title', location: 'location',
  linkedin_url: 'linkedin_url', website: 'website', company: 'company',
  company_domain: 'company_domain', company_description: 'company_description',
  company_industry: 'company_industry', company_workforce: 'company_workforce',
  company_headquarters: 'company_headquarters', company_founded_year: 'company_founded_year',
  company_funding: 'company_funding', social_profiles: 'social_profiles',
};

function buildOutputSchema(requestedFields, maxItems) {
  const fields = new Set(requestedFields || []);
  const properties = {
    lead_id: { type: 'integer' },
    matched_name: { type: 'string' },
    identity_verified: { type: 'boolean' },
    identity_confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    match_evidence: { type: 'string' },
    title: { type: 'string' }, location: { type: 'string' },
    linkedin_url: { type: 'string', format: 'uri' },
    social_profiles: { type: 'array', maxItems: 10, items: { type: 'string', format: 'uri' } },
    company_name: { type: 'string' }, company_domain: { type: 'string' },
    company_website: { type: 'string', format: 'uri' }, company_description: { type: 'string' },
    company_industry: { type: 'string' }, company_workforce: { type: 'integer' },
    company_headquarters: { type: 'string' }, company_founded_year: { type: 'integer' },
    company_funding: { type: 'object', additionalProperties: true },
    source_urls: { type: 'array', maxItems: 12, items: { type: 'string', format: 'uri' } },
  };
  if (fields.has('email')) properties.work_email = { type: 'string', format: 'email' };
  if (fields.has('phone')) properties.phone = { type: 'string', format: 'phone' };
  return {
    type: 'object', required: ['leads'], properties: {
      leads: { type: 'array', maxItems, items: { type: 'object', required: ['lead_id', 'matched_name', 'identity_verified', 'identity_confidence', 'source_urls'], properties } }
    }
  };
}

function buildRunPayload(rows, requestedFields) {
  const paid = requestedFields.filter(field => field === 'email' || field === 'phone');
  return {
    query: `Enrich each input sales lead using current public professional sources. Return exactly one row per input lead, preserve lead_id, and return the matched professional's full name in matched_name. Mark a match as high confidence only when the full name and company, profile URL, work email domain, or location align closely with the same professional profile. Include at least one public source URL for every high confidence match. If the identity is ambiguous, set identity_verified to false and identity_confidence to low, and do not return enrichment fields. Do not infer sensitive traits. ${paid.length ? `Only request these paid contact fields for a high confidence match: ${paid.join(', ')}.` : 'Do not return email addresses or phone numbers.'}`,
    effort: 'low',
    input: { data: rows },
    outputSchema: buildOutputSchema(requestedFields, rows.length),
  };
}

async function claimJob() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query(`
      SELECT id FROM lead_enrichment_jobs
       WHERE status IN ('queued','researching')
         AND (lease_until IS NULL OR lease_until < NOW())
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED LIMIT 1`);
    if (!selected.rows[0]) { await client.query('COMMIT'); return null; }
    const result = await client.query(`
      UPDATE lead_enrichment_jobs
         SET status = CASE WHEN status='queued' THEN 'researching' ELSE status END,
             started_at = COALESCE(started_at, NOW()), lease_until = NOW() + INTERVAL '2 minutes', updated_at = NOW()
       WHERE id=$1 RETURNING *`, [selected.rows[0].id]);
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function waitForRun(jobId, runId) {
  const deadline = Date.now() + 55 * 60 * 1000;
  while (Date.now() < deadline) {
    const job = await query('SELECT cancel_requested_at FROM lead_enrichment_jobs WHERE id=$1', [jobId]);
    if (job.rows[0]?.cancel_requested_at) {
      await exaAgent.cancelRun(runId).catch(() => {});
      return { status: 'cancelled' };
    }
    const run = await exaAgent.getRun(runId);
    if (['completed', 'failed', 'cancelled'].includes(run.status)) return run;
    await query(`UPDATE lead_enrichment_jobs SET lease_until=NOW()+INTERVAL '2 minutes', updated_at=NOW() WHERE id=$1`, [jobId]);
    await new Promise(resolve => setTimeout(resolve, 4000));
  }
  throw new Error('Exa enrichment run timed out');
}

function requestedResultFields(requestedFields) {
  const result = [...policy.PROFILE_FIELDS];
  if (requestedFields.includes('email')) result.push('email');
  if (requestedFields.includes('phone')) result.push('phone');
  return result;
}

async function applyResult(job, item, raw, runId) {
  const normalized = policy.normalizeResult(raw);
  if (!policy.isHighConfidenceMatch(item.input_snapshot, normalized)) {
    await query(`UPDATE lead_enrichment_items SET status='unchanged', normalized_result=$1, error=NULL, updated_at=NOW() WHERE id=$2`, [JSON.stringify(normalized), item.id]);
    return { unchanged: 1 };
  }
  const leadResult = await query(`SELECT * FROM sales_leads WHERE id=$1 AND user_phone=$2`, [item.lead_id, job.user_phone]);
  const lead = leadResult.rows[0];
  if (!lead) return { failed: 1 };
  let applied = 0; let unchanged = 0;
  for (const field of requestedResultFields(job.requested_fields)) {
    const proposed = normalized[field];
    let decision = policy.classifyField(lead[field], proposed);
    let evidence = normalized.match_evidence;
    if (decision !== 'empty' && ['email', 'phone'].includes(field)) {
      const duplicate = await query(`SELECT id,name FROM sales_leads WHERE user_phone=$1 AND id<>$2 AND LOWER(COALESCE(${FIELD_COLUMNS[field]},''))=LOWER($3) LIMIT 1`,
        [job.user_phone, item.lead_id, String(proposed)]);
      if (duplicate.rows[0]) {
        decision = 'ignored';
        evidence = `${evidence ? `${evidence} ` : ''}Possible duplicate of ${duplicate.rows[0].name} (lead ${duplicate.rows[0].id}).`;
      }
    }
    if (decision === 'empty') continue;
    await query(`
      INSERT INTO lead_enrichment_fields
        (job_id,item_id,lead_id,field_name,current_value,proposed_value,decision,exa_run_id,source_urls,match_evidence,decided_at)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::text,$8,$9::jsonb,$10,CASE WHEN $7::text='applied' THEN NOW() ELSE NULL END)
      ON CONFLICT(item_id,field_name) DO UPDATE SET proposed_value=EXCLUDED.proposed_value, decision=EXCLUDED.decision,
        source_urls=EXCLUDED.source_urls, match_evidence=EXCLUDED.match_evidence`,
      [job.id, item.id, item.lead_id, field, JSON.stringify(lead[field] ?? null), JSON.stringify(proposed), decision === 'apply' ? 'applied' : decision, runId, JSON.stringify(normalized.source_urls), evidence]);
    if (decision === 'apply') {
      const column = FIELD_COLUMNS[field];
      const value = ['company_funding', 'social_profiles'].includes(field) ? JSON.stringify(proposed) : proposed;
      await query(`UPDATE sales_leads SET ${column}=$1, enrichment_status='enriched', enriched_at=NOW(), updated_at=NOW() WHERE id=$2 AND user_phone=$3`, [value, item.lead_id, job.user_phone]);
      lead[field] = proposed; applied += 1;
    } else unchanged += 1;
  }
  await query(`UPDATE lead_enrichment_items SET status=$1, normalized_result=$2, source_urls=$3, exa_run_id=$4, updated_at=NOW() WHERE id=$5`,
    [applied ? 'enriched' : 'unchanged', JSON.stringify(normalized), JSON.stringify(normalized.source_urls), runId, item.id]);
  return { enriched: applied ? 1 : 0, conflicts: 0, unchanged: applied ? 0 : 1 };
}

async function processJob(job) {
  if (!exaAgent.isConfigured()) throw new Error('EXA_API_KEY is not configured');
  const itemsResult = await query(`SELECT * FROM lead_enrichment_items WHERE job_id=$1 AND status='queued' ORDER BY id`, [job.id]);
  const items = itemsResult.rows;
  for (let offset = 0; offset < items.length; offset += 10) {
    const batch = items.slice(offset, offset + 10);
    await query(`UPDATE lead_enrichment_items SET status='researching',updated_at=NOW() WHERE id=ANY($1::bigint[])`, [batch.map(item => item.id)]);
    const rows = batch.map(item => ({ lead_id: Number(item.lead_id), ...item.input_snapshot }));
    const created = await exaAgent.createRun(buildRunPayload(rows, job.requested_fields));
    await query(`UPDATE lead_enrichment_jobs SET exa_run_ids=exa_run_ids || $1::jsonb, updated_at=NOW() WHERE id=$2`, [JSON.stringify([created.id]), job.id]);
    const run = await waitForRun(job.id, created.id);
    if (run.status === 'cancelled') {
      await query(`UPDATE lead_enrichment_jobs SET status='cancelled', completed_at=NOW(), lease_until=NULL, updated_at=NOW() WHERE id=$1`, [job.id]);
      return;
    }
    if (run.status !== 'completed') throw new Error(run.error?.message || run.error || 'Exa run failed');
    const cost = Number(run.costDollars?.total ?? run.costDollars ?? 0) || 0;
    await query(`UPDATE lead_enrichment_jobs SET actual_cost_usd=actual_cost_usd+$1, updated_at=NOW() WHERE id=$2`, [cost, job.id]);
    const outputRows = run.output?.structured?.leads || [];
    const byId = new Map(outputRows.map(row => [Number(row.lead_id), row]));
    for (const item of batch) {
      const raw = byId.get(Number(item.lead_id));
      if (!raw) {
        await query(`UPDATE lead_enrichment_items SET status='failed', error='No matching result returned', updated_at=NOW() WHERE id=$1`, [item.id]);
      } else await applyResult(job, item, raw, created.id);
    }
    const progress = await query(`SELECT
      COUNT(*) FILTER (WHERE status IN ('enriched','unchanged','conflict','failed'))::int processed,
      COUNT(*) FILTER (WHERE status='enriched')::int enriched,
      COUNT(*) FILTER (WHERE status='unchanged')::int unchanged,
      COUNT(*) FILTER (WHERE status='conflict')::int conflicted,
      COUNT(*) FILTER (WHERE status='failed')::int failed
      FROM lead_enrichment_items WHERE job_id=$1`, [job.id]);
    const p = progress.rows[0];
    await query(`UPDATE lead_enrichment_jobs SET processed_count=$1,enriched_count=$2,unchanged_count=$3,conflict_count=$4,failed_count=$5,updated_at=NOW() WHERE id=$6`,
      [p.processed,p.enriched,p.unchanged,p.conflicted,p.failed,job.id]);
    await query(`UPDATE lead_enrichment_jobs SET lease_until=NOW()+INTERVAL '2 minutes', updated_at=NOW() WHERE id=$1`, [job.id]);
  }
  const counts = await query(`SELECT
      COUNT(*) FILTER (WHERE status IN ('enriched','unchanged','conflict','failed'))::int processed,
      COUNT(*) FILTER (WHERE status='enriched')::int enriched,
      COUNT(*) FILTER (WHERE status='unchanged')::int unchanged,
      COUNT(*) FILTER (WHERE status='conflict')::int conflicted,
      COUNT(*) FILTER (WHERE status='failed')::int failed
    FROM lead_enrichment_items WHERE job_id=$1`, [job.id]);
  const c = counts.rows[0];
  const status = c.failed > 0 ? (c.processed === c.failed ? 'failed' : 'partial') : 'completed';
  await query(`UPDATE lead_enrichment_jobs SET status=$1, processed_count=$2, enriched_count=$3, unchanged_count=$4,
      conflict_count=$5, failed_count=$6, completed_at=NOW(), lease_until=NULL, updated_at=NOW() WHERE id=$7`,
    [status, c.processed, c.enriched, c.unchanged, c.conflicted, c.failed, job.id]);
}

async function processNext() {
  await query(`UPDATE lead_enrichment_jobs SET status='failed',error='Worker interrupted while an Exa run was active; retry manually to avoid duplicate charges',
    completed_at=NOW(),lease_until=NULL,updated_at=NOW()
    WHERE status='researching' AND lease_until < NOW() - INTERVAL '5 minutes'`);
  const job = await claimJob();
  if (!job) return false;
  try { await processJob(job); }
  catch (error) {
    logger.error(`[LeadEnrichment] Job ${job.id} failed: ${error.message}`);
    await query(`UPDATE lead_enrichment_items SET status='failed', error=$1, updated_at=NOW()
      WHERE job_id=$2 AND status='researching'`, [String(error.message).slice(0, 2000), job.id]);
    await query(`UPDATE lead_enrichment_jobs SET status='failed', error=$1, completed_at=NOW(), lease_until=NULL, updated_at=NOW() WHERE id=$2`, [String(error.message).slice(0, 2000), job.id]);
  }
  return true;
}

module.exports = { buildOutputSchema, buildRunPayload, claimJob, processJob, processNext };
