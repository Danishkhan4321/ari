// dashboard/app/api/ai/email-draft/route.ts
//
// POST { purpose, tone?, group_name?, sample_member? }
//   → { ok, subject, body }
//
// Generates a bulk-email template via the bot's internal AI route.
// Subject + body use {first_name}, {name}, {company} placeholders so
// the existing per-recipient compile step in the composer Just Works.
import { NextResponse } from "next/server";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";

const BOT_INTERNAL_URL = process.env.BOT_INTERNAL_URL || "http://127.0.0.1:43100";

export async function POST(req: Request) {
  try {
    const userPhone = await getCurrentUserPhone();
    if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

    let body: {
      purpose?: string;
      tone?: string;
      group_name?: string;
      sample_member?: { name?: string; company?: string | null };
      sender_name?: string;
    } = {};
    try { body = await req.json(); } catch { /* ignore */ }

    const purpose = String(body.purpose || "").trim();
    if (purpose.length < 3) {
      return NextResponse.json({ ok: false, error: "purpose required" }, { status: 400 });
    }

    const secret = process.env.INTERNAL_API_SECRET;
    if (!secret) {
      return NextResponse.json({ ok: false, error: "INTERNAL_API_SECRET not set" }, { status: 500 });
    }

    const res = await fetch(`${BOT_INTERNAL_URL}/webhook/internal/ai-email-draft`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": secret,
        "x-forwarded-proto": "https", // skip bot's HTTP→HTTPS redirect
      },
      body: JSON.stringify({
        user_phone: userPhone,
        purpose,
        tone: body.tone,
        group_name: body.group_name,
        sample_member: body.sample_member,
        sender_name: body.sender_name,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return NextResponse.json(
        { ok: false, error: `AI service returned ${res.status}: ${txt.slice(0, 200)}` },
        { status: 502 }
      );
    }
    const d = (await res.json()) as { ok: boolean; subject?: string; body?: string; error?: string };
    if (!d.ok || !d.subject || !d.body) {
      return NextResponse.json({ ok: false, error: d.error || "no draft returned" }, { status: 502 });
    }
    return NextResponse.json({ ok: true, subject: d.subject, body: d.body });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
