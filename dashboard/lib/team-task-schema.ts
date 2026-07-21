import { query } from "@/lib/db";

let schemaPromise: Promise<void> | null = null;

export function ensureTeamTaskSchema(): Promise<void> {
  // The in-memory demo schema is recreated for each process and already
  // includes these columns. pg-mem does not implement every PostgreSQL DDL
  // variation used by the idempotent production guard.
  if (process.env.ARI_DEMO_MODE === "true") return Promise.resolve();
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS team_admin_phone TEXT`);
      await query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS team_name TEXT`);
      await query(`CREATE INDEX IF NOT EXISTS idx_tasks_team_status ON tasks(team_admin_phone, LOWER(team_name), status, due_date)`);
    })().catch(error => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}
