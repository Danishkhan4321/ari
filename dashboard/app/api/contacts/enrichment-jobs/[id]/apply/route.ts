import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getCurrentUserPhone } from "@/lib/session";

const COLUMNS: Record<string,string> = { email:'email',phone:'phone',title:'title',location:'location',linkedin_url:'linkedin_url',website:'website',company:'company',
  company_domain:'company_domain',company_description:'company_description',company_industry:'company_industry',company_workforce:'company_workforce',
  company_headquarters:'company_headquarters',company_founded_year:'company_founded_year',company_funding:'company_funding',social_profiles:'social_profiles' };

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
  const jobId = Number(params.id);
  let body: { decisions?: Array<{ fieldId?: number; action?: string }> } = {};
  try { body = await req.json(); } catch { return NextResponse.json({ ok:false,error:'invalid body' },{status:400}); }
  const decisions = Array.isArray(body.decisions) ? body.decisions.slice(0, 200) : [];
  let applied = 0; let kept = 0;
  for (const decision of decisions) {
    const fieldId = Number(decision.fieldId);
    if (!Number.isInteger(fieldId) || !['replace','keep'].includes(String(decision.action))) continue;
    const found = await query(`SELECT f.*,j.user_phone FROM lead_enrichment_fields f JOIN lead_enrichment_jobs j ON j.id=f.job_id
      WHERE f.id=$1 AND f.job_id=$2 AND j.user_phone=$3 AND f.decision='conflict'`, [fieldId, jobId, userPhone]);
    const field = found.rows[0];
    if (!field || !COLUMNS[field.field_name]) continue;
    if (decision.action === 'replace') {
      await query(`UPDATE sales_leads SET ${COLUMNS[field.field_name]}=$1, enrichment_status='enriched', enriched_at=NOW(), updated_at=NOW()
        WHERE id=$2 AND user_phone=$3`, [field.proposed_value, field.lead_id, userPhone]);
      applied += 1;
    } else kept += 1;
    await query(`UPDATE lead_enrichment_fields SET decision=$1,decided_at=NOW() WHERE id=$2`, [decision.action === 'replace' ? 'applied' : 'rejected', fieldId]);
  }
  const remaining = await query(`SELECT COUNT(*)::int count FROM lead_enrichment_fields WHERE job_id=$1 AND decision='conflict'`, [jobId]);
  return NextResponse.json({ ok:true,applied,kept,remaining:remaining.rows[0].count });
}
