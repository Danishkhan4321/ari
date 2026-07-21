// dashboard/app/api/contacts/stage/route.ts
// POST { id, stage } — update a sales_lead's stage. Used by the kanban
// drag-drop. Authorization: WHERE user_phone bound to the session.
import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getCurrentUserPhone } from "@/lib/session";
import { STAGES, normalizeStage } from "@/lib/crm-shared";

export const dynamic = "force-dynamic";

// Accept canonical stages plus the legacy aliases still in flight before the
// 6_canonicalize_lead_stages backfill runs; always STORE canonical.
const ACCEPTED = new Set<string>([...STAGES, "lead", "qualified", "discovery", "won", "lost"]);

export async function POST(req: Request) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

  let body: { id?: number; stage?: string } = {};
  try { body = await req.json(); } catch { /* fall through */ }
  const id = Number(body.id);
  const raw = String(body.stage || "").toLowerCase().trim();
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  }
  if (!ACCEPTED.has(raw)) {
    return NextResponse.json({ ok: false, error: `stage must be one of: ${STAGES.join(", ")}` }, { status: 400 });
  }
  const stage = normalizeStage(raw); // canonicalize legacy → canonical before storing
  try {
    const r = await query(
      `UPDATE sales_leads SET stage = $1 WHERE id = $2 AND user_phone = $3 RETURNING id`,
      [stage, id, userPhone]
    );
    if (r.rowCount === 0) {
      return NextResponse.json({ ok: false, error: "lead not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
