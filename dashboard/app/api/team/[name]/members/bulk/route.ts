// dashboard/app/api/team/[name]/members/bulk/route.ts
//
// POST — admin pastes N {name, phone} pairs; we add each to the team
// (skipping duplicates) and ask the bot to send each new member a
// WhatsApp welcome message.
import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getCurrentUserPhone } from "@/lib/session";
import { resolveTeamAdmin } from "@/lib/sprint";

export const dynamic = "force-dynamic";

const BOT_INTERNAL_URL = process.env.BOT_INTERNAL_URL || "http://127.0.0.1:43100";

type Row = { name: string; phone: string; role?: string };

export async function POST(req: Request, { params }: { params: { name: string } }) {
  try {
    const userPhone = await getCurrentUserPhone();
    if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

    const teamName = decodeURIComponent(params.name);
    const adminPhone = await resolveTeamAdmin(teamName, userPhone);
    if (!adminPhone) return NextResponse.json({ ok: false, error: "team not found" }, { status: 404 });
    if (adminPhone !== userPhone) return NextResponse.json({ ok: false, error: "admin only" }, { status: 403 });

    let body: { rows?: Row[]; sendWelcome?: boolean } = {};
    try { body = await req.json(); } catch { /* validate */ }
    const rows = (body.rows || []).map(r => ({
      name: String(r.name || "").trim().slice(0, 120),
      phone: String(r.phone || "").replace(/\D/g, "").slice(0, 20),
      role: String(r.role || "member").trim().slice(0, 32) || "member",
    })).filter(r => r.name && r.phone);
    if (rows.length === 0) return NextResponse.json({ ok: false, error: "no rows to add" }, { status: 400 });
    if (rows.length > 100) return NextResponse.json({ ok: false, error: "max 100 per call" }, { status: 400 });

    // Pre-fetch existing members in one query — dedupe in app.
    const existRes = await query<{ member_phone: string }>(
      `SELECT member_phone FROM teams WHERE admin_phone = $1 AND team_name = $2 AND member_phone = ANY($3::text[])`,
      [userPhone, teamName.toLowerCase(), rows.map(r => r.phone)]
    );
    const existing = new Set(existRes.rows.map(r => r.member_phone));
    const toInsert = rows.filter(r => !existing.has(r.phone));
    const skipped = rows.length - toInsert.length;

    let added = 0;
    if (toInsert.length > 0) {
      // Multi-row insert
      const placeholders: string[] = [];
      const params: unknown[] = [];
      let i = 1;
      for (const r of toInsert) {
        placeholders.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
        params.push(userPhone, r.phone, r.name, r.role, teamName.toLowerCase());
      }
      const ins = await query(
        `INSERT INTO teams (admin_phone, member_phone, member_name, role, team_name)
         VALUES ${placeholders.join(",")}
         ON CONFLICT DO NOTHING`,
        params
      );
      added = ins.rowCount ?? toInsert.length;
    }

    // Send welcome via bot (best-effort; don't block the response on a slow bot).
    let welcomed = 0;
    let welcomeFailed = 0;
    if (body.sendWelcome !== false && toInsert.length > 0 && process.env.INTERNAL_API_SECRET) {
      try {
        const adminNameRes = await query<{ member_name: string | null }>(
          `SELECT member_name FROM teams WHERE admin_phone = $1 AND member_phone = $1 LIMIT 1`,
          [userPhone]
        );
        const adminName = adminNameRes.rows[0]?.member_name || "your team admin";
        const res = await fetch(`${BOT_INTERNAL_URL}/webhook/internal/team-welcome`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-internal-secret": process.env.INTERNAL_API_SECRET!,
            "x-forwarded-proto": "https",
          },
          body: JSON.stringify({
            admin_phone: userPhone,
            admin_name: adminName,
            team_name: teamName,
            new_members: toInsert,
          }),
          signal: AbortSignal.timeout(60_000),
        });
        if (res.ok) {
          const d = await res.json();
          welcomed = d.welcomed || 0;
          welcomeFailed = d.failed || 0;
        }
      } catch { /* non-fatal — admin can resend invites */ }
    }

    return NextResponse.json({
      ok: true,
      added,
      skipped,
      total: rows.length,
      welcomed,
      welcomeFailed,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
