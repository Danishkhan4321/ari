// dashboard/app/api/team/[name]/invite-link/route.ts
//
// GET — generate (or fetch) a one-tap WhatsApp invite link the admin
// can share. The link opens WhatsApp prefilled with a message that,
// when sent to Ari's number, registers the sender as a team member
// and triggers the welcome flow.
//
// We piggyback on the bot's existing message-handling: the prefilled
// text is "join ari team <code>" — the bot's intent handler
// recognizes that pattern and routes to a join handler.
import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getCurrentUserPhone } from "@/lib/session";
import { resolveTeamAdmin } from "@/lib/sprint";
import crypto from "node:crypto";
import { ariWhatsAppDigits, formatWhatsAppDisplay } from "@/lib/whatsapp";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { name: string } }) {
  try {
    const userPhone = await getCurrentUserPhone();
    if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
    const teamName = decodeURIComponent(params.name);
    const adminPhone = await resolveTeamAdmin(teamName, userPhone);
    if (!adminPhone) return NextResponse.json({ ok: false, error: "team not found" }, { status: 404 });
    if (adminPhone !== userPhone) return NextResponse.json({ ok: false, error: "admin only" }, { status: 403 });

    // Reuse table if exists; else lazy-create.
    await query(`
      CREATE TABLE IF NOT EXISTS team_invite_codes (
        code         VARCHAR(20) PRIMARY KEY,
        admin_phone  VARCHAR(50) NOT NULL,
        team_name    VARCHAR(100) NOT NULL,
        created_at   TIMESTAMP DEFAULT NOW(),
        expires_at   TIMESTAMP,
        used_count   INT NOT NULL DEFAULT 0
      )
    `).catch(() => {});

    // Find an active (non-expired) code for this team, or create one.
    const found = await query<{ code: string }>(
      `SELECT code FROM team_invite_codes
        WHERE admin_phone = $1 AND team_name = $2
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY created_at DESC LIMIT 1`,
      [adminPhone, teamName.toLowerCase()]
    );
    let code = found.rows[0]?.code;
    if (!code) {
      code = crypto.randomBytes(4).toString("hex"); // 8-char hex
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30);
      await query(
        `INSERT INTO team_invite_codes (code, admin_phone, team_name, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [code, adminPhone, teamName.toLowerCase(), expiresAt]
      );
    }

    const prefill = `join ari team ${code}`;
    const digits = ariWhatsAppDigits();
    const waLink = `https://wa.me/${digits}?text=${encodeURIComponent(prefill)}`;
    return NextResponse.json({
      ok: true,
      code,
      whatsapp_url: waLink,
      prefill_text: prefill,
      ari_number: formatWhatsAppDisplay(digits),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
