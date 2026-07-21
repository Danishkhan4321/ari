// dashboard/lib/google-oauth.ts
// Lightweight Google OAuth helpers for "Continue with Google" sign-in.
//
// We DON'T need long-lived tokens here — the bot already stored those
// via its own OAuth flow (see src/services/google-auth.service.js). All
// we want is to verify the user is who they say they are by getting
// their email from Google, then look up the matching user_phone from
// the existing `google_tokens` table.
//
// Reuses the same OAuth client (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)
// the bot uses — but with its OWN redirect URI
// (GOOGLE_DASHBOARD_REDIRECT_URI = http://127.0.0.1:43101/api/auth/google/callback).
// Both URIs must be authorized on the same Google Cloud OAuth client.

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

export function getGoogleClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_DASHBOARD_REDIRECT_URI
    || `${(process.env.DASHBOARD_BASE_URL || "").replace(/\/+$/, "")}/api/auth/google/callback`;
  if (!clientId || !clientSecret || !redirectUri) {
    return null;
  }
  return { clientId, clientSecret, redirectUri };
}

export function buildAuthorizeUrl(state: string): string | null {
  const c = getGoogleClient();
  if (!c) return null;
  const p = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: c.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    access_type: "online",   // we don't need refresh tokens, the bot has them
    prompt: "select_account", // let users pick which Google account they're using
    state,
  });
  return `${GOOGLE_AUTH_URL}?${p.toString()}`;
}

export type GoogleUserInfo = {
  email: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
};

export async function exchangeCodeForUserInfo(code: string): Promise<GoogleUserInfo | null> {
  const c = getGoogleClient();
  if (!c) return null;

  // Code → access_token
  const tokRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      code,
      redirect_uri: c.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokRes.ok) {
    return null;
  }
  const tok = (await tokRes.json()) as { access_token?: string; id_token?: string };
  if (!tok.access_token) return null;

  // access_token → userinfo (we trust this because the connection is over
  // TLS to Google directly, so no need to verify id_token signature for
  // sign-in purposes).
  const userRes = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tok.access_token}` },
  });
  if (!userRes.ok) return null;
  const user = (await userRes.json()) as GoogleUserInfo;
  if (!user.email) return null;
  return user;
}
