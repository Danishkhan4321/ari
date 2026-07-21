// dashboard/lib/team-onboarding.ts
//
// Lightweight new-hire onboarding tracker. When admin marks a member
// as a new hire, Ari sends them a paced sequence of nudges (Day 1
// welcome → Day 3 setup check → Week 1 standup → Week 2 catch-up).
// Cron picks up due nudges and sends WhatsApps via the bot.
import { query } from "@/lib/db";

export async function ensureOnboardingTable(): Promise<void> {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS team_onboardings (
        id              SERIAL PRIMARY KEY,
        admin_phone     VARCHAR(50) NOT NULL,
        team_name       VARCHAR(100),
        member_phone    VARCHAR(50) NOT NULL,
        member_name     VARCHAR(255),
        started_at      TIMESTAMP NOT NULL DEFAULT NOW(),
        manager_phone   VARCHAR(50),
        completed_at    TIMESTAMP,
        last_nudge_idx  INT NOT NULL DEFAULT -1,
        UNIQUE(admin_phone, team_name, member_phone)
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_t_onboarding_admin ON team_onboardings(admin_phone)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_t_onboarding_active ON team_onboardings(completed_at)`);
  } catch { /* swallow */ }
}

export type TeamOnboarding = {
  id: number; admin_phone: string; team_name: string | null;
  member_phone: string; member_name: string | null;
  started_at: string; manager_phone: string | null;
  completed_at: string | null; last_nudge_idx: number;
};

export async function listTeamOnboardings(adminPhone: string): Promise<TeamOnboarding[]> {
  await ensureOnboardingTable();
  const r = await query<TeamOnboarding>(
    `SELECT * FROM team_onboardings
      WHERE admin_phone = $1
      ORDER BY started_at DESC
      LIMIT 50`,
    [adminPhone]
  );
  return r.rows;
}

export async function startTeamOnboarding(
  adminPhone: string,
  data: { teamName: string | null; memberPhone: string; memberName: string | null; managerPhone: string | null }
): Promise<TeamOnboarding | null> {
  await ensureOnboardingTable();
  const r = await query<TeamOnboarding>(
    `INSERT INTO team_onboardings (admin_phone, team_name, member_phone, member_name, manager_phone)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (admin_phone, team_name, member_phone)
     DO UPDATE SET started_at = NOW(), completed_at = NULL, last_nudge_idx = -1
     RETURNING *`,
    [adminPhone, data.teamName, data.memberPhone, data.memberName, data.managerPhone]
  );
  return r.rows[0] ?? null;
}

export async function completeTeamOnboarding(adminPhone: string, id: number): Promise<boolean> {
  await ensureOnboardingTable();
  const r = await query(
    `UPDATE team_onboardings SET completed_at = NOW() WHERE id = $1 AND admin_phone = $2`,
    [id, adminPhone]
  );
  return (r.rowCount ?? 0) > 0;
}
