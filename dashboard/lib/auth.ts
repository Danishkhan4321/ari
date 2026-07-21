// dashboard/lib/auth.ts
// Magic-link claim. Reuses the bot's existing `link_codes` table — when the
// user says "open dashboard" in WhatsApp, the bot inserts a row with
// platform='web' and DMs them a URL. The dashboard claims the code, marks
// it used, and creates a session.
import { query } from "./db";

export type ClaimResult =
  | { ok: true; userPhone: string }
  | { ok: false; reason: "invalid" | "expired" | "used" | "error" };

export async function claimLinkCode(code: string): Promise<ClaimResult> {
  if (!code || typeof code !== "string") return { ok: false, reason: "invalid" };
  const trimmed = code.trim().toUpperCase();
  if (trimmed.length < 4 || trimmed.length > 12) return { ok: false, reason: "invalid" };

  try {
    // Atomic claim — only one request can mark a code used.
    const res = await query<{ user_id: string }>(
      `UPDATE link_codes
         SET used = true
       WHERE code = $1
         AND used = false
         AND expires_at > NOW()
       RETURNING user_id`,
      [trimmed]
    );
    if (res.rows.length === 0) {
      // Distinguish expired vs invalid for a friendlier error
      const peek = await query<{ used: boolean; expires_at: Date }>(
        `SELECT used, expires_at FROM link_codes WHERE code = $1 LIMIT 1`,
        [trimmed]
      );
      if (peek.rows.length === 0) return { ok: false, reason: "invalid" };
      if (peek.rows[0].used) return { ok: false, reason: "used" };
      return { ok: false, reason: "expired" };
    }
    return { ok: true, userPhone: res.rows[0].user_id };
  } catch {
    return { ok: false, reason: "error" };
  }
}
