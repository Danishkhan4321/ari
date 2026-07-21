// dashboard/app/api/auth/google/callback/route.ts
// GET /api/auth/google/callback?code=…&state=…
// Three flows funnel through here:
//
// 1. signin (default) — user clicked "Continue with Google" on /login.
//    A verified Google identity is resolved to a stable Ari account, creating
//    one on first use. Existing WhatsApp-linked accounts are preserved.
//
// 2. onboarding — user is mid-wizard on /onboarding and just authorised
//    Google. We attach the email to the pending_onboarding row carried
//    by the ari_onboarding_sub cookie, then bounce them back to
//    /onboarding so the wizard's last button can finalize.
//
// 3. desktop — the system browser completes Google OAuth, then receives a
//    one-time ticket that hands the session back to the installed Ari app.
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { exchangeCodeForUserInfo, getGoogleClient } from "@/lib/google-oauth";
import { query } from "@/lib/db";
import { createSession, setSessionCookie } from "@/lib/session";
import { readOnboardingCookie, setGoogleEmail, getPending } from "@/lib/onboarding";
import { resolveGoogleIdentity } from "@/lib/google-identity";

export const dynamic = "force-dynamic";

const BASE = (process.env.DASHBOARD_BASE_URL || "http://127.0.0.1:43101").replace(/\/+$/, "");

function fail(reason: string, target: "login" | "onboarding" = "login") {
  return NextResponse.redirect(`${BASE}/${target}?error=${encodeURIComponent(reason)}`, 303);
}

export async function GET(req: Request) {
  if (!getGoogleClient()) return fail("not_configured");

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    return fail(oauthError === "access_denied" ? "google_denied" : "google_error");
  }
  if (!code || !state) return fail("invalid_callback");

  const stateCookie = cookies().get("g_oauth_state")?.value;
  cookies().set({ name: "g_oauth_state", value: "", path: "/", maxAge: 0 });
  if (!stateCookie || stateCookie !== state) return fail("state_mismatch");

  // Decode flow from the state ("signin:..." | "onboarding:..." | "desktop:...")
  const flowTag = state.split(":", 1)[0];
  const flow = flowTag === "onboarding" ? "onboarding" : flowTag === "desktop" ? "desktop" : "signin";

  const user = await exchangeCodeForUserInfo(code, state);
  if (!user || !user.email) return fail("google_exchange_failed", flow === "onboarding" ? "onboarding" : "login");
  if (user.email_verified === false) return fail("email_unverified", flow === "onboarding" ? "onboarding" : "login");

  const email = user.email.toLowerCase();

  if (flow === "onboarding") {
    const subId = readOnboardingCookie();
    if (!subId) return fail("onboarding_session_lost", "onboarding");
    const pending = await getPending(subId);
    if (!pending) return fail("onboarding_session_lost", "onboarding");

    // Optional sanity check: warn if the Google email differs from the
    // email Dodo had on file. We don't block — users may sign up with
    // a different email than the one they OAuth with.
    // (No-op for now; could surface in UI later.)

    await setGoogleEmail(subId, email);
    return NextResponse.redirect(`${BASE}/onboarding`, 303);
  }

  // ─── signin flow ────────────────────────────────────────────────────
  // Register any verified Google user. Existing WhatsApp-linked accounts are
  // resolved to their current phone key so their data remains continuous.
  const userPhone = await resolveGoogleIdentity({
    sub: user.sub,
    email,
    name: user.name,
    picture: user.picture,
  });

  // Capture the Google profile name so the sidebar / greeting can show
  // "Welcome back, Danish" instead of an email-derived stub. Lazy
  // migration adds the column on first sign-in. Best-effort — failure
  // here doesn't block sign-in.
  if (user.name) {
    try {
      await query(`ALTER TABLE google_tokens ADD COLUMN IF NOT EXISTS google_name VARCHAR(120)`);
      await query(
        `UPDATE google_tokens SET google_name = $1 WHERE user_phone = $2`,
        [user.name.slice(0, 120), userPhone]
      );
    } catch { /* ignore */ }
  }

  const token = await createSession(userPhone);
  setSessionCookie(token);

  const connectPath = flow === "desktop" ? "/auth/connect?client=desktop" : "/auth/connect";
  return NextResponse.redirect(`${BASE}${connectPath}`, 303);
}
