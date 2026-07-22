import { createHash } from "crypto";
import { query } from "./db";

type QueryResult<T> = { rows: T[] };
type QueryLike = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<QueryResult<T>>;

export type EmailIdentityProfile = {
  email: string;
  name?: string;
};

let tableReady = false;

export function normalizeEmail(email: string): string {
  return String(email || "").trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 320;
}

export function deriveEmailUserPhone(email: string): string {
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) throw new TypeError("valid email is required");
  const digest = createHash("sha256").update(`ari-email:${normalized}`, "utf8").digest("hex");
  const numeric = BigInt(`0x${digest.slice(0, 16)}`).toString().padStart(17, "0").slice(-17);
  return `001${numeric}`;
}

async function ensureTable(queryFn: QueryLike): Promise<void> {
  if (tableReady) return;
  await queryFn(`
    CREATE TABLE IF NOT EXISTS ari_user_identities (
      provider VARCHAR(32) NOT NULL,
      provider_subject VARCHAR(255) NOT NULL,
      user_phone VARCHAR(50) NOT NULL,
      email VARCHAR(320),
      display_name VARCHAR(120),
      avatar_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (provider, provider_subject)
    )
  `);
  await queryFn(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ari_user_identities_user_phone ON ari_user_identities(user_phone)`);
  await queryFn(`CREATE INDEX IF NOT EXISTS idx_ari_user_identities_email ON ari_user_identities(provider, LOWER(email))`);
  tableReady = true;
}

export async function resolveEmailIdentity(
  profile: EmailIdentityProfile,
  queryFn: QueryLike = query as QueryLike,
): Promise<string> {
  const email = normalizeEmail(profile.email);
  if (!isValidEmail(email)) throw new TypeError("valid email is required");

  await ensureTable(queryFn);
  const userPhone = deriveEmailUserPhone(email);
  const saved = await queryFn<{ user_phone: string }>(
    `INSERT INTO ari_user_identities
       (provider, provider_subject, user_phone, email, display_name)
     VALUES ('email', $1, $2, $1, $3)
     ON CONFLICT (provider, provider_subject) DO UPDATE SET
       email = EXCLUDED.email,
       display_name = COALESCE(EXCLUDED.display_name, ari_user_identities.display_name),
       updated_at = NOW(),
       last_login_at = NOW()
     RETURNING user_phone`,
    [email, userPhone, profile.name?.slice(0, 120) || null],
  );

  const canonicalUserPhone = saved.rows[0]?.user_phone || userPhone;
  try {
    await queryFn(
      `INSERT INTO users (phone_number, name) VALUES ($1, $2)
       ON CONFLICT (phone_number) DO UPDATE SET
         name = COALESCE(NULLIF(users.name, ''), EXCLUDED.name)`,
      [canonicalUserPhone, profile.name?.slice(0, 120) || email.split("@")[0]],
    );
  } catch {
    // Session creation must not depend on the optional profile row.
  }
  return canonicalUserPhone;
}

export function resetEmailIdentityTableForTests(): void {
  tableReady = false;
}
