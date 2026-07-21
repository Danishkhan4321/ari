import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ ok: false, error: "invalid job" }, { status: 400 });
  const job = await query(`SELECT * FROM lead_enrichment_jobs WHERE id=$1 AND user_phone=$2`, [id, userPhone]);
  if (!job.rows[0]) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  const items = await query(`SELECT i.id,i.lead_id,i.status,i.error,l.name FROM lead_enrichment_items i
    JOIN sales_leads l ON l.id=i.lead_id AND l.user_phone=$2 WHERE i.job_id=$1 ORDER BY i.id`, [id, userPhone]);
  const conflicts = await query(`SELECT f.id,f.lead_id,f.field_name,f.current_value,f.proposed_value,f.source_urls,f.match_evidence,l.name
    FROM lead_enrichment_fields f JOIN sales_leads l ON l.id=f.lead_id AND l.user_phone=$2
    WHERE f.job_id=$1 AND f.decision='conflict' ORDER BY f.id`, [id, userPhone]);
  return NextResponse.json({ ok: true, job: job.rows[0], items: items.rows, conflicts: conflicts.rows });
}
