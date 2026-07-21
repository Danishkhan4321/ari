// dashboard/app/api/onboarding/complete/route.ts
// POST { subscription_id }
// Final step of onboarding. Verifies all required fields are present, then:
//   - Inserts a row into google_tokens linking the user_phone (from
//     onboarding) to the google_email collected in OAuth. (Bot uses this
//     same table for "connect google" so dashboard sign-in via "Continue
//     with Google" will Just Work.)
//   - Inserts a self-referential row into linked_accounts so the bot
//     accepts messages from this WhatsApp number.
//   - Creates a dashboard_session and sets the cookie.
//   - Marks pending_onboarding as completed.
//   - Returns a redirect to /.
//
// We do not yet write OAuth tokens (access/refresh) — that requires a
// separate "connect Gmail" pass that asks for gmail.* scopes. For now,
// "Continue with Google" sign-in just needs the email match.
import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { clearOnboardingCookie, getPending, markCompleted } from "@/lib/onboarding";
import { createSession, setSessionCookie } from "@/lib/session";

export const dynamic = "force-dynamic";

const BASE = (process.env.DASHBOARD_BASE_URL || "http://127.0.0.1:43101").replace(/\/+$/, "");

export async function POST(req: Request) {
  let body: { subscription_id?: string } = {};
  try { body = await req.json(); } catch { /* fall through */ }
  const subId = String(body.subscription_id || "").trim();
  if (!subId) {
    return NextResponse.json({ ok: false, error: "subscription_id required" }, { status: 400 });
  }

  const pending = await getPending(subId);
  if (!pending) {
    return NextResponse.json({ ok: false, error: "no onboarding session" }, { status: 404 });
  }
  if (!pending.name || !pending.phone) {
    return NextResponse.json({ ok: false, error: "name and phone not yet saved" }, { status: 400 });
  }
  if (!pending.google_email) {
    return NextResponse.json({ ok: false, error: "google not yet connected" }, { status: 400 });
  }

  // Canonical identity is digits-only (matches the WhatsApp webhook and the
  // dashboard→bot bridge).
  const phone = String(pending.phone).replace(/\D/g, "");
  if (!phone) {
    return NextResponse.json({ ok: false, error: "invalid phone" }, { status: 400 });
  }

  // ─── Ownership guard ─────────────────────────────────────────────────
  // The claimed WhatsApp number may already belong to an existing user.
  // Without this check, anyone completing onboarding could type another
  // user's number and be signed into their entire workspace.
  const existingToken = await query<{ google_email: string | null }>(
    `SELECT google_email FROM google_tokens WHERE user_phone = $1 LIMIT 1`,
    [phone]
  ).catch(() => ({ rows: [] as { google_email: string | null }[] }));
  const existingEmail = existingToken.rows[0]?.google_email;
  if (existingEmail && existingEmail.toLowerCase() !== pending.google_email.toLowerCase()) {
    return NextResponse.json(
      { ok: false, error: "this WhatsApp number is already linked to a different Google account. Sign in with that account, or contact support." },
      { status: 409 }
    );
  }
  if (!existingEmail) {
    // No Google link yet — but the number may still belong to an active
    // WhatsApp user whose identity we cannot verify from here. Do not allow
    // a silent claim of an in-use number.
    const activity = await query(
      `SELECT 1 FROM conversation_history WHERE user_phone = $1 LIMIT 1`,
      [phone]
    ).catch(() => ({ rows: [] }));
    if (activity.rows.length > 0) {
      return NextResponse.json(
        { ok: false, error: "this WhatsApp number is already in use with Ari. Message Ari on WhatsApp and say \"connect google\" to link your account instead." },
        { status: 409 }
      );
    }
  }

  // ─── Wire the user into the bot's existing tables ────────────────────
  // google_tokens (user_phone is UNIQUE — INSERT ON CONFLICT is safe even
  // if the user already had a partial OAuth record from elsewhere)
  try {
    await query(
      `INSERT INTO google_tokens
         (user_phone, access_token_enc, refresh_token_enc, token_iv, token_auth_tag, google_email)
       VALUES ($1, '', NULL, '', '', $2)
       ON CONFLICT (user_phone) DO UPDATE
         SET google_email = EXCLUDED.google_email,
             updated_at = NOW()`,
      [phone, pending.google_email]
    );
  } catch (e) {
    // Bot's own ensureTable() may have stricter NOT NULL — try a more
    // tolerant insert with empty strings as placeholders. If that also
    // fails, surface the error so we can fix schema drift.
    return NextResponse.json({ ok: false, error: "could not link Google account: " + (e instanceof Error ? e.message : String(e)) }, { status: 500 });
  }

  // linked_accounts — self-link so the bot's account-link service treats
  // this user as a valid primary identity (matches what the bot does on
  // first message, but we do it eagerly so the dashboard can cross-check)
  try {
    await query(
      `INSERT INTO linked_accounts
         (primary_user_id, platform_user_id, platform, display_name, is_primary, notify_platform)
       VALUES ($1, $1, 'whatsapp', $2, true, 'whatsapp')
       ON CONFLICT (platform_user_id) DO NOTHING`,
      [phone, pending.name]
    );
  } catch { /* non-critical */ }

  await markCompleted(subId);
  clearOnboardingCookie();

  // Sign them straight in
  const token = await createSession(phone);
  setSessionCookie(token);

  return NextResponse.json({ ok: true, redirect: `${BASE}/` });
}
