// dashboard/lib/team-meta.ts
//
// Per-member team metadata that the original `teams` table doesn't
// have a column for: birthday, work-anniversary date, public-profile
// opt-in. Stored in a side table so we don't have to alter `teams`
// (used by both bot + dashboard with no migration tooling).
import { query } from "@/lib/db";

export async function ensureTeamMetaTable(): Promise<void> {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS team_member_meta (
        id               SERIAL PRIMARY KEY,
        admin_phone      VARCHAR(50) NOT NULL,
        team_name        VARCHAR(100) NOT NULL,
        member_phone     VARCHAR(50) NOT NULL,
        birthday         DATE,
        joined_at        DATE,
        manager_phone    VARCHAR(50),
        notes            TEXT,
        updated_at       TIMESTAMP DEFAULT NOW(),
        UNIQUE(admin_phone, team_name, member_phone)
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_tmm_admin ON team_member_meta(admin_phone, team_name)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_tmm_birthday ON team_member_meta(birthday)`);
  } catch { /* swallow */ }

  // Public team page opt-in (one row per team)
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS team_public_meta (
        admin_phone   VARCHAR(50) NOT NULL,
        team_name     VARCHAR(100) NOT NULL,
        slug          VARCHAR(100) UNIQUE,
        public_enabled BOOLEAN DEFAULT false,
        tagline       TEXT,
        updated_at    TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (admin_phone, team_name)
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_team_public_slug ON team_public_meta(slug)`);
  } catch { /* swallow */ }
}

export type MemberMeta = {
  member_phone: string;
  birthday: string | null;
  joined_at: string | null;
  manager_phone: string | null;
  notes: string | null;
};

export async function getMemberMeta(adminPhone: string, teamName: string): Promise<MemberMeta[]> {
  await ensureTeamMetaTable();
  const r = await query<MemberMeta>(
    `SELECT member_phone, birthday::text AS birthday, joined_at::text AS joined_at, manager_phone, notes
       FROM team_member_meta
      WHERE admin_phone = $1 AND team_name = $2`,
    [adminPhone, teamName.toLowerCase()]
  );
  return r.rows;
}

export async function upsertMemberMeta(
  adminPhone: string,
  teamName: string,
  memberPhone: string,
  patch: { birthday?: string | null; joined_at?: string | null; manager_phone?: string | null; notes?: string | null }
): Promise<void> {
  await ensureTeamMetaTable();
  await query(
    `INSERT INTO team_member_meta (admin_phone, team_name, member_phone, birthday, joined_at, manager_phone, notes, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (admin_phone, team_name, member_phone)
     DO UPDATE SET
       birthday      = COALESCE(EXCLUDED.birthday,      team_member_meta.birthday),
       joined_at     = COALESCE(EXCLUDED.joined_at,     team_member_meta.joined_at),
       manager_phone = COALESCE(EXCLUDED.manager_phone, team_member_meta.manager_phone),
       notes         = COALESCE(EXCLUDED.notes,         team_member_meta.notes),
       updated_at    = NOW()`,
    [adminPhone, teamName.toLowerCase(), memberPhone, patch.birthday ?? null, patch.joined_at ?? null, patch.manager_phone ?? null, patch.notes ?? null]
  );
}

export async function getPublicMeta(adminPhone: string, teamName: string): Promise<{ slug: string | null; public_enabled: boolean; tagline: string | null } | null> {
  await ensureTeamMetaTable();
  const r = await query<{ slug: string | null; public_enabled: boolean; tagline: string | null }>(
    `SELECT slug, public_enabled, tagline FROM team_public_meta
      WHERE admin_phone = $1 AND team_name = $2`,
    [adminPhone, teamName.toLowerCase()]
  );
  return r.rows[0] ?? null;
}

export async function upsertPublicMeta(
  adminPhone: string, teamName: string,
  patch: { slug?: string | null; public_enabled?: boolean; tagline?: string | null }
): Promise<void> {
  await ensureTeamMetaTable();
  await query(
    `INSERT INTO team_public_meta (admin_phone, team_name, slug, public_enabled, tagline, updated_at)
     VALUES ($1, $2, $3, COALESCE($4, false), $5, NOW())
     ON CONFLICT (admin_phone, team_name)
     DO UPDATE SET
       slug = COALESCE(EXCLUDED.slug, team_public_meta.slug),
       public_enabled = COALESCE(EXCLUDED.public_enabled, team_public_meta.public_enabled),
       tagline = COALESCE(EXCLUDED.tagline, team_public_meta.tagline),
       updated_at = NOW()`,
    [adminPhone, teamName.toLowerCase(), patch.slug ?? null, patch.public_enabled ?? null, patch.tagline ?? null]
  );
}

export async function resolveSlug(slug: string): Promise<{ admin_phone: string; team_name: string; tagline: string | null } | null> {
  await ensureTeamMetaTable();
  const r = await query<{ admin_phone: string; team_name: string; tagline: string | null }>(
    `SELECT admin_phone, team_name, tagline
       FROM team_public_meta
      WHERE slug = $1 AND public_enabled = true
      LIMIT 1`,
    [slug.toLowerCase()]
  );
  return r.rows[0] ?? null;
}
