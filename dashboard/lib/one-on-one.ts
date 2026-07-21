// dashboard/lib/one-on-one.ts
//
// Lightweight 1:1 scheduler. A 1:1 is a recurring or one-off meeting
// between a manager + a report. The bot pings both the day-before with
// open-blocker context.
import { query } from "@/lib/db";

export async function ensureOneOnOnesTable(): Promise<void> {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS one_on_ones (
        id              SERIAL PRIMARY KEY,
        admin_phone     VARCHAR(50) NOT NULL,
        team_name       VARCHAR(100),
        manager_phone   VARCHAR(50) NOT NULL,
        manager_name    VARCHAR(255),
        report_phone    VARCHAR(50) NOT NULL,
        report_name     VARCHAR(255),
        next_at         TIMESTAMP NOT NULL,
        cadence_days    INT,
        agenda          TEXT,
        last_notes      TEXT,
        last_notes_at   TIMESTAMP,
        last_sent_prep_for TIMESTAMP,
        created_at      TIMESTAMP DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_1to1_admin ON one_on_ones(admin_phone)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_1to1_next  ON one_on_ones(next_at)`);
    // Idempotent ALTERs for existing installs
    await query(`ALTER TABLE one_on_ones ADD COLUMN IF NOT EXISTS last_notes TEXT`).catch(() => {});
    await query(`ALTER TABLE one_on_ones ADD COLUMN IF NOT EXISTS last_notes_at TIMESTAMP`).catch(() => {});
  } catch { /* swallow */ }
}

export type OneOnOne = {
  id: number; admin_phone: string; team_name: string | null;
  manager_phone: string; manager_name: string | null;
  report_phone: string; report_name: string | null;
  next_at: string; cadence_days: number | null;
  agenda: string | null; last_sent_prep_for: string | null;
  created_at: string;
};

export async function listOneOnOnes(adminPhone: string): Promise<OneOnOne[]> {
  await ensureOneOnOnesTable();
  const r = await query<OneOnOne>(
    `SELECT * FROM one_on_ones WHERE admin_phone = $1 ORDER BY next_at ASC`,
    [adminPhone]
  );
  return r.rows;
}

export async function scheduleOneOnOne(
  adminPhone: string,
  data: {
    teamName: string | null;
    managerPhone: string; managerName: string | null;
    reportPhone: string; reportName: string | null;
    nextAtIso: string; cadenceDays?: number | null; agenda?: string | null;
  }
): Promise<OneOnOne | null> {
  await ensureOneOnOnesTable();
  const r = await query<OneOnOne>(
    `INSERT INTO one_on_ones (admin_phone, team_name, manager_phone, manager_name, report_phone, report_name, next_at, cadence_days, agenda)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [adminPhone, data.teamName, data.managerPhone, data.managerName, data.reportPhone, data.reportName, data.nextAtIso, data.cadenceDays ?? null, data.agenda ?? null]
  );
  return r.rows[0] ?? null;
}

export async function deleteOneOnOne(adminPhone: string, id: number): Promise<boolean> {
  await ensureOneOnOnesTable();
  const r = await query(`DELETE FROM one_on_ones WHERE id = $1 AND admin_phone = $2`, [id, adminPhone]);
  return (r.rowCount ?? 0) > 0;
}
