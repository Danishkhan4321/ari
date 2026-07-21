// dashboard/lib/broadcast.ts
//
// Team broadcast tracking. Schema lives in src/services/team-comms.service.js
// (tables team_messages + team_message_recipients). Sending is delegated
// to the bot's /webhook/internal/dashboard-team-broadcast endpoint
// because the bot owns the WhatsApp credentials.
import { query } from "@/lib/db";

export type BroadcastSummary = {
  id: number;
  admin_phone: string;
  team_name: string | null;
  message_text: string;
  message_type: string;
  total_members: number;
  created_at: string;
  // Computed counts:
  delivered_count: number;
  read_count: number;
  failed_count: number;
};

export type BroadcastRecipient = {
  id: number;
  team_message_id: number;
  member_phone: string;
  member_name: string | null;
  wamid: string | null;
  status: "pending" | "sent" | "delivered" | "read" | "failed" | string;
  status_updated_at: string | null;
  created_at: string;
};

export async function ensureBroadcastTables(): Promise<void> {
  // Lazy create — mirrors what the bot does. Works whether the bot has
  // booted on this DB yet or not.
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS team_messages (
        id            SERIAL PRIMARY KEY,
        admin_phone   VARCHAR(20)  NOT NULL,
        team_name     VARCHAR(100),
        message_text  TEXT         NOT NULL,
        message_type  VARCHAR(30)  DEFAULT 'broadcast',
        total_members INTEGER      DEFAULT 0,
        created_at    TIMESTAMP    DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_team_msg_admin ON team_messages(admin_phone, created_at DESC)`);
    await query(`
      CREATE TABLE IF NOT EXISTS team_message_recipients (
        id              SERIAL PRIMARY KEY,
        team_message_id INTEGER REFERENCES team_messages(id) ON DELETE CASCADE,
        member_phone    VARCHAR(20)  NOT NULL,
        member_name     VARCHAR(100),
        wamid           VARCHAR(255),
        status          VARCHAR(20)  DEFAULT 'pending',
        status_updated_at TIMESTAMP,
        created_at      TIMESTAMP    DEFAULT NOW(),
        UNIQUE(team_message_id, member_phone)
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_tmr_msg ON team_message_recipients(team_message_id)`);
  } catch { /* swallow — degraded is better than crashed */ }
}

export async function listBroadcasts(adminPhone: string, teamName?: string | null): Promise<BroadcastSummary[]> {
  await ensureBroadcastTables();
  const wheres: string[] = ["m.admin_phone = $1"];
  const params: unknown[] = [adminPhone];
  if (teamName) { params.push(teamName.toLowerCase()); wheres.push(`m.team_name = $${params.length}`); }
  const r = await query<BroadcastSummary>(
    `SELECT m.id, m.admin_phone, m.team_name, m.message_text, m.message_type,
            m.total_members, m.created_at,
            COALESCE(SUM(CASE WHEN r.status IN ('delivered','read') THEN 1 ELSE 0 END), 0)::int AS delivered_count,
            COALESCE(SUM(CASE WHEN r.status = 'read' THEN 1 ELSE 0 END), 0)::int AS read_count,
            COALESCE(SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END), 0)::int AS failed_count
       FROM team_messages m
  LEFT JOIN team_message_recipients r ON r.team_message_id = m.id
      WHERE ${wheres.join(" AND ")}
   GROUP BY m.id
   ORDER BY m.created_at DESC
      LIMIT 200`,
    params
  );
  return r.rows;
}

export async function getRecipients(adminPhone: string, broadcastId: number): Promise<BroadcastRecipient[]> {
  await ensureBroadcastTables();
  const r = await query<BroadcastRecipient>(
    `SELECT r.*
       FROM team_message_recipients r
       JOIN team_messages m ON m.id = r.team_message_id
      WHERE r.team_message_id = $1 AND m.admin_phone = $2
      ORDER BY r.member_name NULLS LAST, r.member_phone`,
    [broadcastId, adminPhone]
  );
  return r.rows;
}
