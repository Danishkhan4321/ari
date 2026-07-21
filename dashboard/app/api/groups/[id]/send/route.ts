// dashboard/app/api/groups/[id]/send/route.ts
// POST { subject, body, drafts: [{member_kind, member_id, to, subject, body}], scheduledFor?, track? }
//   - drafts is the per-recipient personalized payload from the Review step
//   - subject + body are the templates (kept for the campaign record)
//
// Dispatches the campaign to the bot's internal /webhook/internal/
// dashboard-bulk-send route, which sends each draft 1:1 via the user's Gmail
// (tokens encrypted in google_tokens). The bot ACCEPTS the batch (202) and
// sends in the BACKGROUND — it writes email_sends rows (analytics), logs each
// lead send to sales_emails_log WITH the gmail message id (timeline + "Open in
// Gmail"), bumps last_contacted_at, and finalizes the bulk_email_campaigns row
// itself. So this route only records the campaign (status 'sending'),
// dispatches, and returns; the campaigns page shows live sent/opens/clicks.
import { NextResponse } from "next/server";
import { recordCampaign, finalizeCampaign, getGroup } from "@/lib/groups";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";

const BOT_INTERNAL_URL = process.env.BOT_INTERNAL_URL || "http://127.0.0.1:43100";

// The bot sends asynchronously, so there's no per-request timeout to outrun.
// Keep a generous sanity cap (Gmail's own daily limits bite well below this).
const MAX_RECIPIENTS = 2000;

type Draft = {
  member_kind: "lead" | "contact";
  member_id: number;
  to: string;
  subject: string;
  body: string;
};

// Per-recipient payload sent to the bot. member_kind/member_id let the bot log
// lead sends to sales_emails_log with the gmail message id (timeline deep-link).
function toBotDrafts(drafts: Draft[]) {
  return drafts.map(d => ({
    to: d.to, subject: d.subject, body: d.body,
    member_kind: d.member_kind, member_id: d.member_id,
  }));
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
  const groupId = Number(params.id);
  if (!Number.isInteger(groupId)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });

  let body: { subject?: string; body?: string; drafts?: Draft[]; scheduledFor?: string; track?: boolean; dailyLimit?: number } = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const subject = String(body.subject || "").trim();
  const bodyTemplate = String(body.body || "").trim();
  const drafts = (body.drafts || []).filter(d => d && d.to && d.subject && d.body);
  if (!subject || !bodyTemplate || drafts.length === 0) {
    return NextResponse.json({ ok: false, error: "subject, body, and at least 1 draft required" }, { status: 400 });
  }
  if (drafts.length > MAX_RECIPIENTS) {
    return NextResponse.json({ ok: false, error: `Campaigns are limited to ${MAX_RECIPIENTS} recipients.` }, { status: 400 });
  }

  // Verify group ownership
  const group = await getGroup(userPhone, groupId);
  if (!group) return NextResponse.json({ ok: false, error: "group not found" }, { status: 404 });

  // Pre-send leak guard: each draft body must not contain another recipient's email
  const allEmails = drafts.map(d => d.to.toLowerCase());
  const leaks: string[] = [];
  for (const d of drafts) {
    const myEmail = d.to.toLowerCase();
    const otherInBody = allEmails.find(e => e !== myEmail && d.body.toLowerCase().includes(e));
    if (otherInBody) leaks.push(d.to);
  }
  if (leaks.length > 0) {
    return NextResponse.json({ ok: false, error: `leak guard tripped — ${leaks.length} draft(s) contain other recipients' emails. Aborted.` }, { status: 400 });
  }

  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    return NextResponse.json({ ok: false, error: "INTERNAL_API_SECRET not set" }, { status: 500 });
  }

  // Schedule path — not wired on the bot yet; record + dispatch so the bot
  // returns its clear 501, then surface that message.
  const scheduledFor = body.scheduledFor ? new Date(body.scheduledFor) : null;
  if (scheduledFor && scheduledFor.getTime() > Date.now()) {
    const campaignId = await recordCampaign({
      userPhone, groupId, subject, bodyTemplate, recipientCount: drafts.length, scheduledFor, dailySendLimit: body.dailyLimit,
    });
    const res = await fetch(`${BOT_INTERNAL_URL}/webhook/internal/dashboard-bulk-send`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": secret, "x-forwarded-proto": "https" },
      body: JSON.stringify({
        user_phone: userPhone, campaign_id: campaignId,
        scheduled_for: scheduledFor.toISOString(), track: body.track !== false,
        drafts: toBotDrafts(drafts),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      await finalizeCampaign(campaignId, 0, drafts.length, "cancelled");
      const msg = res.status === 501
        ? 'Scheduled send isn’t available yet — use "Send now" instead.'
        : `scheduling failed (${res.status})`;
      return NextResponse.json({ ok: false, error: msg }, { status: res.status === 501 ? 400 : 502 });
    }
    return NextResponse.json({ ok: true, campaign_id: campaignId, scheduled: true });
  }

  // Immediate send path. recordCampaign creates the row as 'sending'; the bot
  // accepts the batch (202), sends in the background, and finalizes the row.
  const campaignId = await recordCampaign({
    userPhone, groupId, subject, bodyTemplate, recipientCount: drafts.length, dailySendLimit: body.dailyLimit,
  });

  try {
    const res = await fetch(`${BOT_INTERNAL_URL}/webhook/internal/dashboard-bulk-send`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": secret, "x-forwarded-proto": "https" },
      body: JSON.stringify({
        user_phone: userPhone, campaign_id: campaignId, track: body.track !== false,
        drafts: toBotDrafts(drafts),
      }),
      // The bot ACKs immediately (202) before sending, so this returns fast.
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      await finalizeCampaign(campaignId, 0, drafts.length, "cancelled");
      return NextResponse.json({ ok: false, error: `bot returned ${res.status}: ${text.slice(0, 200)}` }, { status: 502 });
    }
    // Accepted — sending happens in the background; the campaign row stays
    // 'sending' until the bot finalizes it. Counts/opens/clicks populate live
    // on the campaigns page from email_sends.
    return NextResponse.json({ ok: true, campaign_id: campaignId, async: true });
  } catch (e) {
    // We never reached the bot (or it didn't ACK) — nothing was sent.
    await finalizeCampaign(campaignId, 0, drafts.length, "cancelled");
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
