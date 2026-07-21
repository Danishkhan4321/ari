import { createHash } from "crypto";
import { query } from "./db";

export type GoogleIdentityProfile = {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
};

type QueryResult<T> = { rows: T[] };
type QueryLike = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<QueryResult<T>>;

let tableReady = false;

export function deriveGoogleUserPhone(subject: string): string {
  if (!subject || subject.length > 255) throw new TypeError("invalid Google subject");
  const digest = createHash("sha256").update(`ari-google:${subject}`, "utf8").digest("hex");
  const numeric = BigInt(`0x${digest.slice(0, 16)}`).toString().padStart(17, "0").slice(-17);
  // A 20-digit, digits-only compatibility key. Leading zeroes make it an
  // invalid real WhatsApp destination while preserving existing DB contracts.
  return `000${numeric}`;
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

export async function resolveGoogleIdentity(
  profile: GoogleIdentityProfile,
  queryFn: QueryLike = query as QueryLike,
): Promise<string> {
  const subject = String(profile.sub || "").trim();
  const email = String(profile.email || "").trim().toLowerCase();
  if (!subject || !email) throw new TypeError("verified Google subject and email are required");

  await ensureTable(queryFn);
  const existing = await queryFn<{ user_phone: string }>(
    `SELECT user_phone FROM ari_user_identities WHERE provider = 'google' AND provider_subject = $1 LIMIT 1`,
    [subject],
  );

  let userPhone = existing.rows[0]?.user_phone;
  if (!userPhone) {
    // Preserve existing WhatsApp-linked data when this email was connected
    // for Calendar/Gmail before open Google registration existed.
    try {
      const legacy = await queryFn<{ user_phone: string }>(
        `SELECT user_phone FROM google_tokens WHERE LOWER(google_email) = $1 LIMIT 1`,
        [email],
      );
      userPhone = legacy.rows[0]?.user_phone;
    } catch {
      // Fresh hackathon databases may not have the optional integration table.
    }
  }
  userPhone ||= deriveGoogleUserPhone(subject);

  const saved = await queryFn<{ user_phone: string }>(
    `INSERT INTO ari_user_identities
       (provider, provider_subject, user_phone, email, display_name, avatar_url)
     VALUES ('google', $1, $2, $3, $4, $5)
     ON CONFLICT (provider, provider_subject) DO UPDATE SET
       email = EXCLUDED.email,
       display_name = EXCLUDED.display_name,
       avatar_url = EXCLUDED.avatar_url,
       updated_at = NOW(),
       last_login_at = NOW()
     RETURNING user_phone`,
    [subject, userPhone, email, profile.name?.slice(0, 120) || null, profile.picture || null],
  );
  const canonicalUserPhone = saved.rows[0]?.user_phone || userPhone;

  try {
    await queryFn(
      `INSERT INTO users (phone_number, name) VALUES ($1, $2)
       ON CONFLICT (phone_number) DO UPDATE SET
         name = COALESCE(NULLIF(users.name, ''), EXCLUDED.name)`,
      [canonicalUserPhone, profile.name?.slice(0, 120) || null],
    );
  } catch {
    // Identity and session creation must not depend on the optional profile row.
  }

  return canonicalUserPhone;
}

export function resetGoogleIdentityTableForTests(): void {
  tableReady = false;
}
