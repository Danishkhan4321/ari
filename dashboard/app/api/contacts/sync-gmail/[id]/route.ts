// dashboard/app/api/contacts/sync-gmail/[id]/route.ts
// POST — syncs Gmail history for a single lead. Called silently when the
// user opens /contacts/<id> so direct-from-Gmail emails show up in the
// activity timeline without requiring a manual "sync" click.
import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";

const BOT_INTERNAL_URL = process.env.BOT_INTERNAL_URL || "http://127.0.0.1:43100";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
  }

  const r = await query<{ email: string | null }>(
    `SELECT email FROM sales_leads WHERE id = $1 AND user_phone = $2`,
    [id, userPhone]
  );
  const email = r.rows[0]?.email?.trim().toLowerCase();
  if (!email) {
    return NextResponse.json({ ok: true, scanned: 0, persisted: 0, message: "no email on lead" });
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
        emails: [email],
        persist: true,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `bot returned ${res.status}: ${txt.slice(0, 200)}` }, { status: 502 });
    }
    const d = (await res.json()) as { ok: boolean; persisted?: number; error?: string };
    if (!d.ok) {
      return NextResponse.json({ ok: false, error: d.error || "bot lookup failed" }, { status: 502 });
    }
    return NextResponse.json({ ok: true, scanned: 1, persisted: d.persisted ?? 0 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
