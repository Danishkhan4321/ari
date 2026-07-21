import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { ensureEmailSendsTable } from "@/lib/email-tracking";
import { getCurrentUserPhone } from "@/lib/session";
import { deleteCampaign, updateCampaign } from "@/lib/groups";

export const dynamic = "force-dynamic";

type CampaignDetail = {
  id: number;
  group_id: number | null;
  group_name: string | null;
  subject: string;
  body_template: string;
  recipient_count: number;
  sent_count: number;
  failed_count: number;
  status: string;
  scheduled_for: string | null;
  created_at: string;
  completed_at: string | null;
  daily_send_limit: number;
  archived_at: string | null;
};

type RecipientActivity = {
  id: number;
  recipient_email: string;
  subject: string | null;
  send_status: string;
  send_error: string | null;
  opened_at: string | null;
  open_count: number;
  clicked_at: string | null;
  click_count: number;
  sent_at: string;
};

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

  const campaignId = Number(params.id);
  if (!Number.isInteger(campaignId) || campaignId <= 0) {
    return NextResponse.json({ ok: false, error: "invalid campaign" }, { status: 400 });
  }

  const campaignResult = await query<CampaignDetail>(
    `SELECT c.id, c.group_id, g.name AS group_name, c.subject, c.body_template,
            c.recipient_count, c.sent_count, c.failed_count, c.status,
            c.scheduled_for, c.created_at, c.completed_at, c.daily_send_limit, c.archived_at
      FROM bulk_email_campaigns c
      LEFT JOIN contact_groups g ON g.id = c.group_id
      WHERE c.id = $1 AND c.user_phone = $2
      LIMIT 1`,
    [campaignId, userPhone],
  );

  const campaign = campaignResult.rows[0];
  if (!campaign) return NextResponse.json({ ok: false, error: "campaign not found" }, { status: 404 });

  await ensureEmailSendsTable();
  const recipientResult = await query<RecipientActivity>(
    `SELECT id, recipient_email, subject, send_status, send_error, opened_at,
            open_count, clicked_at, click_count, sent_at
      FROM email_sends
      WHERE campaign_id = $1 AND user_phone = $2
      ORDER BY sent_at DESC, id DESC`,
    [campaignId, userPhone],
  );

  return NextResponse.json({ ok: true, campaign, recipients: recipientResult.rows });
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ ok: false, error: "invalid campaign" }, { status: 400 });
  const body = await request.json().catch(() => ({})) as { archived?: boolean; action?: "pause" | "resume" };
  const ok = await updateCampaign(userPhone, id, { archived: body.archived, status: body.action === "pause" ? "paused" : body.action === "resume" ? "sending" : undefined });
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ ok: false, error: "campaign not found" }, { status: 404 });
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ ok: false, error: "invalid campaign" }, { status: 400 });
  const ok = await deleteCampaign(userPhone, id);
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ ok: false, error: "Active campaigns cannot be deleted. Pause or wait for completion first." }, { status: 409 });
}
