// dashboard/app/api/crm/leads/route.ts
// PATCH { leadId, stage } → move a lead to a new pipeline stage.
// Auth: session cookie → user_phone. The update is scoped by user_phone in
// the SQL, so a user can never move a lead that isn't theirs even if they
// guess another lead's id.
import { NextResponse } from "next/server";
import { getCurrentUserPhone } from "@/lib/session";
import { updateLeadStage, STAGES, type Stage } from "@/lib/crm";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: { leadId?: number; stage?: string } = {};
  try {
    body = (await req.json()) as { leadId?: number; stage?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid body" }, { status: 400 });
  }

  const leadId = Number(body.leadId);
  const stage = body.stage as Stage;
  if (!Number.isInteger(leadId) || leadId <= 0) {
    return NextResponse.json({ ok: false, error: "invalid leadId" }, { status: 400 });
  }
  if (!STAGES.includes(stage)) {
    return NextResponse.json(
      { ok: false, error: `invalid stage; one of ${STAGES.join(", ")}` },
      { status: 400 }
    );
  }

  const updated = await updateLeadStage(userPhone, leadId, stage);
  if (!updated) {
    // Either the lead doesn't exist or it isn't owned by this user. Same
    // 404 either way — don't leak which.
    return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, lead: updated });
}
