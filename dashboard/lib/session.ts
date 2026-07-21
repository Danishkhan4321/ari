// dashboard/lib/session.ts
// Cookie-backed session store. The cookie holds a random opaque token; the
// real mapping (token → user_phone) lives in the dashboard_sessions table.
//
// Why a server-side table instead of a JWT?
//   - No need to rotate a signing secret
//   - Logout actually invalidates (delete the row)
//   - Cheap: one indexed lookup per request
import { cookies } from "next/headers";
import { randomBytes } from "crypto";
import { query } from "./db";

const COOKIE_NAME = "ari_session";
const SESSION_DAYS = 30;

let tableReady = false;
async function ensureTable(): Promise<void> {
  if (tableReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS dashboard_sessions (
      id SERIAL PRIMARY KEY,
      token VARCHAR(64) UNIQUE NOT NULL,
      user_phone VARCHAR(50) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      expires_at TIMESTAMP NOT NULL,
      last_used_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_token ON dashboard_sessions(token)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_user ON dashboard_sessions(user_phone)`);
  // Best-effort cleanup of expired rows on first hit
  await query(`DELETE FROM dashboard_sessions WHERE expires_at < NOW() - INTERVAL '1 day'`);
  tableReady = true;
}

export async function createSession(userPhone: string): Promise<string> {
  await ensureTable();
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await query(
    `INSERT INTO dashboard_sessions (token, user_phone, expires_at) VALUES ($1, $2, $3)`,
    [token, userPhone, expiresAt.toISOString()]
  );
  return token;
}

export async function getSessionUser(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  await ensureTable();
  const res = await query<{ user_phone: string }>(
    `UPDATE dashboard_sessions
       SET last_used_at = NOW()
     WHERE token = $1 AND expires_at > NOW()
     RETURNING user_phone`,
    [token]
  );
  return res.rows[0]?.user_phone ?? null;
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (!token) return;
  await ensureTable();
  await query(`DELETE FROM dashboard_sessions WHERE token = $1`, [token]);
}

// ─── Cookie helpers (Next.js App Router) ────────────────────────────────
export function setSessionCookie(token: string) {
  cookies().set({
    name: COOKIE_NAME,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export function clearSessionCookie() {
  cookies().set({ name: COOKIE_NAME, value: "", path: "/", maxAge: 0 });
}

export function readSessionCookie(): string | undefined {
  return cookies().get(COOKIE_NAME)?.value;
}

export async function getCurrentUserPhone(): Promise<string | null> {
  // The browser demo uses an in-memory database; keep that behavior isolated.
  if (process.env.ARI_DEMO_MODE === "true") {
    return process.env.ARI_DEMO_USER_PHONE || "+919000000001";
  }
  // Electron has its own local sign-in bypass, but still uses the real local
  // database so dashboard messages and bot replies remain connected.
  // Digits-only: every product table is keyed by the bare digit string (the
  // dashboard bridge strips non-digits before the bot writes), so a
  // '+'-prefixed session identity makes agent-written rows invisible here.
  if (process.env.ARI_DESKTOP_AUTH_BYPASS === "true") {
    const raw = process.env.ARI_DESKTOP_USER_PHONE || process.env.ARI_DEMO_USER_PHONE || "";
    const digits = raw.replace(/\D/g, "");
    return digits || null;
  }
  return getSessionUser(readSessionCookie());
}
