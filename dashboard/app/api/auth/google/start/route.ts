// dashboard/app/api/auth/google/start/route.ts
// GET /api/auth/google/start[?flow=onboarding]
// Kicks off "Continue with Google". Sets a state cookie carrying both a
// random token (CSRF) and an optional flow flag — the callback uses the
// flag to decide whether to sign in an existing user or attach the
// returned email to a pending onboarding row.
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomBytes } from "crypto";
import { buildAuthorizeUrl, getGoogleClient } from "@/lib/google-oauth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!getGoogleClient()) {
    return NextResponse.json(
      { ok: false, error: "Google OAuth is not configured on this dashboard." },
      { status: 503 }
    );
  }
  const url = new URL(req.url);
  const requestedFlow = url.searchParams.get("flow");
  const flow = url.searchParams.get("client") === "desktop"
    ? "desktop"
    : requestedFlow === "onboarding" ? "onboarding" : "signin";

  // State carries flow flag — the callback parses both the random token
  // (CSRF) and the flow tag.
  const nonce = randomBytes(24).toString("hex");
  const state = `${flow}:${nonce}`;

  cookies().set({
    name: "g_oauth_state",
    value: state,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600, // 10 min — Google's window
  });
  const auth = buildAuthorizeUrl(state);
  if (!auth) {
    return NextResponse.json({ ok: false, error: "Could not build Google URL." }, { status: 500 });
  }
  return NextResponse.redirect(auth, 302);
}
