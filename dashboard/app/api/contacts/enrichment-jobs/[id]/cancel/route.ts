import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getCurrentUserPhone } from "@/lib/session";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
  const id = Number(params.id);
  const result = await query(`UPDATE lead_enrichment_jobs SET cancel_requested_at=NOW(),
    status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END, completed_at=CASE WHEN status='queued' THEN NOW() ELSE completed_at END,
    updated_at=NOW() WHERE id=$1 AND user_phone=$2 AND status IN ('queued','researching','applying') RETURNING id,status`, [id, userPhone]);
  if (!result.rows[0]) return NextResponse.json({ ok: false, error: "job is not cancellable" }, { status: 409 });
  return NextResponse.json({ ok: true, job: result.rows[0] });
}
