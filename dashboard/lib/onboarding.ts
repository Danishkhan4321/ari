// dashboard/lib/onboarding.ts
// Server-side state for the post-purchase onboarding wizard.
//
// One row per Dodo subscription. We key on subscription_id so the user
// can refresh, leave, come back via email link, etc., without losing
// progress. Once status='completed' we transfer the data into the
// canonical google_tokens / linked_accounts tables and the bot picks
// them up as a real Ari user.
import { cookies } from "next/headers";
import { query } from "./db";

const COOKIE_NAME = "ari_onboarding_sub";

let tableReady = false;
async function ensureTable(): Promise<void> {
  if (tableReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS pending_onboarding (
      subscription_id VARCHAR(64) PRIMARY KEY,
      product_id VARCHAR(64),
      tier VARCHAR(20),
      cycle VARCHAR(20),
      dodo_email VARCHAR(255),
      name VARCHAR(100),
      phone VARCHAR(20),
      google_email VARCHAR(255),
      status VARCHAR(20) DEFAULT 'started',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      completed_at TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_pending_onboarding_phone ON pending_onboarding(phone)`);
  tableReady = true;
}

export type PendingOnboarding = {
  subscription_id: string;
  product_id: string | null;
  tier: string | null;
  cycle: string | null;
  dodo_email: string | null;
  name: string | null;
  phone: string | null;
  google_email: string | null;
  status: string;
};

export async function upsertPending(row: {
  subscription_id: string;
  product_id?: string;
  tier?: string;
  cycle?: string;
  dodo_email?: string;
}): Promise<void> {
  await ensureTable();
  await query(
    `INSERT INTO pending_onboarding (subscription_id, product_id, tier, cycle, dodo_email)
       VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (subscription_id) DO UPDATE
       SET product_id = COALESCE(EXCLUDED.product_id, pending_onboarding.product_id),
           tier       = COALESCE(EXCLUDED.tier,       pending_onboarding.tier),
           cycle      = COALESCE(EXCLUDED.cycle,      pending_onboarding.cycle),
           dodo_email = COALESCE(EXCLUDED.dodo_email, pending_onboarding.dodo_email),
           updated_at = NOW()`,
    [row.subscription_id, row.product_id ?? null, row.tier ?? null, row.cycle ?? null, row.dodo_email ?? null]
  );
}

export async function getPending(subscriptionId: string): Promise<PendingOnboarding | null> {
  await ensureTable();
  const r = await query<PendingOnboarding>(
    `SELECT subscription_id, product_id, tier, cycle, dodo_email, name, phone, google_email, status
       FROM pending_onboarding WHERE subscription_id = $1`,
    [subscriptionId]
  );
  return r.rows[0] ?? null;
}

export async function setNameAndPhone(subscriptionId: string, name: string, phone: string): Promise<void> {
  await ensureTable();
  await query(
    `UPDATE pending_onboarding
        SET name = $2, phone = $3, status = 'profile_set', updated_at = NOW()
      WHERE subscription_id = $1`,
    [subscriptionId, name, phone]
  );
}

export async function setGoogleEmail(subscriptionId: string, email: string): Promise<void> {
  await ensureTable();
  await query(
    `UPDATE pending_onboarding
        SET google_email = $2, status = 'gmail_connected', updated_at = NOW()
      WHERE subscription_id = $1`,
    [subscriptionId, email]
  );
}

export async function markCompleted(subscriptionId: string): Promise<void> {
  await ensureTable();
  await query(
    `UPDATE pending_onboarding
        SET status = 'completed', completed_at = NOW(), updated_at = NOW()
      WHERE subscription_id = $1`,
    [subscriptionId]
  );
}

// ─── Cookie helpers ─────────────────────────────────────────────────────
// We carry the active subscription_id in an HttpOnly cookie so the
// Google OAuth round-trip can find its way back to the right row.
export function setOnboardingCookie(subscriptionId: string) {
  cookies().set({
    name: COOKIE_NAME,
    value: subscriptionId,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60, // 1 hour — wizard should finish well within this
  });
}

export function readOnboardingCookie(): string | undefined {
  return cookies().get(COOKIE_NAME)?.value;
}

export function clearOnboardingCookie() {
  cookies().set({ name: COOKIE_NAME, value: "", path: "/", maxAge: 0 });
}

// Phone normalization: strip non-digits, reject obviously-malformed.
// We standardize on the WhatsApp format (no leading +, just digits with
// country code) so it matches the user_phone the bot uses.
export function normalizePhone(input: string): string | null {
  const digits = String(input || "").replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  return digits;
}
