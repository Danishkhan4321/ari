// Minimal, verified Google OpenID Connect helpers for Ari sign-in.
import { OAuth2Client } from "google-auth-library";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export function getGoogleClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_DASHBOARD_REDIRECT_URI
    || `${(process.env.DASHBOARD_BASE_URL || "").replace(/\/+$/, "")}/api/auth/google/callback`;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

export function buildAuthorizeUrl(state: string): string | null {
  const client = getGoogleClient();
  if (!client) return null;
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    access_type: "online",
    prompt: "select_account",
    state,
    nonce: state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export type GoogleUserInfo = {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
};

export async function exchangeCodeForUserInfo(code: string, expectedNonce: string): Promise<GoogleUserInfo | null> {
  const client = getGoogleClient();
  if (!client) return null;

  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code,
      redirect_uri: client.redirectUri,
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!tokenResponse.ok) return null;
  const tokens = (await tokenResponse.json()) as { id_token?: string };
  if (!tokens.id_token) return null;

  // Verify signature, issuer, expiry, audience, and the per-login nonce.
  const verifier = new OAuth2Client(client.clientId);
  const loginTicket = await verifier.verifyIdToken({
    idToken: tokens.id_token,
    audience: client.clientId,
  });
  const payload = loginTicket.getPayload();
  if (!payload?.sub || !payload.email || payload.nonce !== expectedNonce) return null;

  return {
    sub: payload.sub,
    email: payload.email,
    email_verified: payload.email_verified,
    name: payload.name,
    picture: payload.picture,
  };
}
