// dashboard/app/api/groups/[id]/sync-gmail/route.ts
// POST — looks up Gmail history for every lead in this group that has an
// email address, persists results into sales_emails_log, and bumps
// sales_leads.last_contacted_at. Used by the "Sync Gmail history" button
// on group detail so the dashboard reflects emails the user sent before
// they ever started using Ari.
import { NextResponse } from "next/server";
import { getCurrentUserPhone } from "@/lib/session";
import { getGroup, listGroupMembers } from "@/lib/groups";

export const dynamic = "force-dynamic";

const BOT_INTERNAL_URL = process.env.BOT_INTERNAL_URL || "http://127.0.0.1:43100";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

  const groupId = Number(params.id);
  if (!Number.isInteger(groupId)) {
    return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
  }

  const group = await getGroup(userPhone, groupId);
  if (!group) return NextResponse.json({ ok: false, error: "group not found" }, { status: 404 });

  const members = await listGroupMembers(userPhone, groupId);
  const emails = Array.from(new Set(
    members.map(m => m.email?.trim().toLowerCase()).filter((e): e is string => Boolean(e))
  ));
  if (emails.length === 0) {
    return NextResponse.json({ ok: true, scanned: 0, persisted: 0, message: "no emails in group" });
  }

  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    return NextResponse.json({ ok: false, error: "INTERNAL_API_SECRET not set" }, { status: 500 });
  }

  try {
    const res = await fetch(`${BOT_INTERNAL_URL}/webhook/internal/gmail-history-lookup`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": secret,
        "x-forwarded-proto": "https", // skip bot's HTTP→HTTPS redirect
      },
      body: JSON.stringify({
        user_phone: userPhone,
        emails,
        persist: true,
      }),
      // Gmail can be slow; one history lookup per email × 200 max = wide budget
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `bot returned ${res.status}: ${txt.slice(0, 200)}` }, { status: 502 });
    }
    const d = (await res.json()) as { ok: boolean; results?: Record<string, unknown>; persisted?: number; error?: string };
    if (!d.ok) {
      return NextResponse.json({ ok: false, error: d.error || "bot lookup failed" }, { status: 502 });
    }
    return NextResponse.json({
      ok: true,
      scanned: emails.length,
      persisted: d.persisted ?? 0,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
