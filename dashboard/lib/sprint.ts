// dashboard/lib/sprint.ts
//
// Sprint helpers — read/write the same `sprints` and `sprint_items`
// tables that the bot's src/services/sprint.service.js owns. Schema
// definition lives there; this file is read-mostly with thin write
// helpers so the dashboard never touches DDL.
//
// All functions take an `adminPhone` (the team owner's phone). The
// API route is responsible for translating "logged-in user + team
// name" → adminPhone via the teams table; this file does NOT know
// about teams. That keeps the layering predictable.
import { query } from "@/lib/db";

export type SprintRow = {
  id: number;
  team_admin_phone: string;
  name: string;
  start_date: string;
  end_date: string | null;
  goal: string | null;
  status: "active" | "completed" | string;
  created_at: string;
};

export type SprintItem = {
  id: number;
  sprint_id: number;
  title: string;
  description: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  story_points: number;
  status: "todo" | "in_progress" | "done" | "blocked" | string;
  created_at: string;
  completed_at: string | null;
};

export type SprintStats = {
  totalItems: number;
  totalPoints: number;
  completedItems: number;
  completedPoints: number;
  inProgressItems: number;
  blockedItems: number;
  progressPercent: number;
  daysRemaining: number | null;
  daysTotal: number | null;
};

export type SprintHistoryRow = {
  id: number;
  name: string;
  goal: string | null;
  start_date: string;
  end_date: string | null;
  total_items: number;
  total_points: number;
  completed_items: number;
  completed_points: number;
  created_at: string;
};

// ---------- READ ----------

export async function getActiveSprint(adminPhone: string): Promise<{
  sprint: SprintRow;
  items: SprintItem[];
  stats: SprintStats;
} | null> {
  const sRes = await query<SprintRow>(
    `SELECT * FROM sprints
      WHERE team_admin_phone = $1 AND status = 'active'
      ORDER BY id DESC LIMIT 1`,
    [adminPhone]
  );
  const sprint = sRes.rows[0];
  if (!sprint) return null;

  const iRes = await query<SprintItem>(
    `SELECT * FROM sprint_items
      WHERE sprint_id = $1
      ORDER BY
        CASE status
          WHEN 'in_progress' THEN 1
          WHEN 'todo' THEN 2
          WHEN 'blocked' THEN 3
          WHEN 'done' THEN 4
          ELSE 5
        END,
        created_at ASC`,
    [sprint.id]
  );

  return { sprint, items: iRes.rows, stats: deriveStats(sprint, iRes.rows) };
}

export async function getSprintHistory(
  adminPhone: string,
  limit = 5
): Promise<SprintHistoryRow[]> {
  const r = await query<{
    id: number; name: string; goal: string | null;
    start_date: string; end_date: string | null;
    total_items: string | number; total_points: string | number;
    completed_items: string | number; completed_points: string | number;
    created_at: string;
  }>(
    `SELECT s.id, s.name, s.goal, s.start_date, s.end_date, s.created_at,
            COUNT(si.id) AS total_items,
            COALESCE(SUM(si.story_points), 0) AS total_points,
            COUNT(CASE WHEN si.status = 'done' THEN 1 END) AS completed_items,
            COALESCE(SUM(CASE WHEN si.status = 'done' THEN si.story_points ELSE 0 END), 0) AS completed_points
       FROM sprints s
  LEFT JOIN sprint_items si ON si.sprint_id = s.id
      WHERE s.team_admin_phone = $1 AND s.status = 'completed'
   GROUP BY s.id
   ORDER BY s.created_at DESC
      LIMIT $2`,
    [adminPhone, limit]
  );
  return r.rows.map(row => ({
    id: row.id,
    name: row.name,
    goal: row.goal,
    start_date: row.start_date,
    end_date: row.end_date,
    total_items: Number(row.total_items) || 0,
    total_points: Number(row.total_points) || 0,
    completed_items: Number(row.completed_items) || 0,
    completed_points: Number(row.completed_points) || 0,
    created_at: row.created_at,
  }));
}

export async function getVelocity(adminPhone: string, sprintCount = 3): Promise<{
  avgVelocity: number;
  sprints: { name: string; points: number }[];
}> {
  const history = await getSprintHistory(adminPhone, sprintCount);
  if (history.length === 0) return { avgVelocity: 0, sprints: [] };
  const sprints = history.map(s => ({ name: s.name, points: s.completed_points }));
  const total = sprints.reduce((acc, s) => acc + s.points, 0);
  const avgVelocity = Math.round((total / sprints.length) * 10) / 10;
  return { avgVelocity, sprints };
}

// ---------- WRITE ----------

export async function startSprint(
  adminPhone: string,
  name: string,
  endDate: string | null,
  goal: string | null
): Promise<{ ok: true; sprint: SprintRow } | { ok: false; error: string }> {
  // Refuse if there's already an active sprint — keeps semantics simple
  // (one active sprint per team, same as the bot).
  const existing = await query<{ id: number; name: string }>(
    `SELECT id, name FROM sprints WHERE team_admin_phone = $1 AND status = 'active' LIMIT 1`,
    [adminPhone]
  );
  if (existing.rows[0]) {
    return { ok: false, error: `There's already an active sprint ("${existing.rows[0].name}"). End it before starting a new one.` };
  }
  const r = await query<SprintRow>(
    `INSERT INTO sprints (team_admin_phone, name, end_date, goal)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [adminPhone, name, endDate || null, goal || null]
  );
  return { ok: true, sprint: r.rows[0] };
}

export async function endActiveSprint(adminPhone: string): Promise<boolean> {
  const r = await query(
    `UPDATE sprints SET status = 'completed'
      WHERE team_admin_phone = $1 AND status = 'active'`,
    [adminPhone]
  );
  return (r.rowCount ?? 0) > 0;
}

export async function addSprintItem(
  adminPhone: string,
  sprintId: number,
  fields: { title: string; assignedTo?: string | null; assignedToName?: string | null; storyPoints?: number; description?: string | null }
): Promise<SprintItem | null> {
  // Verify the sprint belongs to this admin before inserting — defense in
  // depth against an attacker passing a sprint_id from another team.
  const owns = await query<{ id: number }>(
    `SELECT id FROM sprints WHERE id = $1 AND team_admin_phone = $2`,
    [sprintId, adminPhone]
  );
  if (!owns.rows[0]) return null;

  const r = await query<SprintItem>(
    `INSERT INTO sprint_items (sprint_id, title, description, assigned_to, assigned_to_name, story_points)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      sprintId,
      fields.title.trim(),
      fields.description ?? null,
      fields.assignedTo ?? null,
      fields.assignedToName ?? null,
      Number.isFinite(fields.storyPoints) ? Math.max(0, Math.min(100, Number(fields.storyPoints))) : 1,
    ]
  );
  return r.rows[0] ?? null;
}

export async function updateSprintItemStatus(
  adminPhone: string,
  itemId: number,
  status: "todo" | "in_progress" | "done" | "blocked"
): Promise<SprintItem | null> {
  const r = await query<SprintItem>(
    `UPDATE sprint_items si
        SET status = $1,
            completed_at = CASE WHEN $1 = 'done' THEN NOW() ELSE NULL END
       FROM sprints s
      WHERE si.id = $2
        AND si.sprint_id = s.id
        AND s.team_admin_phone = $3
   RETURNING si.*`,
    [status, itemId, adminPhone]
  );
  return r.rows[0] ?? null;
}

export async function deleteSprintItem(
  adminPhone: string,
  itemId: number
): Promise<boolean> {
  const r = await query(
    `DELETE FROM sprint_items si
       USING sprints s
      WHERE si.id = $1
        AND si.sprint_id = s.id
        AND s.team_admin_phone = $2`,
    [itemId, adminPhone]
  );
  return (r.rowCount ?? 0) > 0;
}

// ---------- HELPERS ----------

function deriveStats(sprint: SprintRow, items: SprintItem[]): SprintStats {
  const totalItems = items.length;
  const totalPoints = items.reduce((a, i) => a + (Number(i.story_points) || 0), 0);
  const completedItems = items.filter(i => i.status === "done").length;
  const completedPoints = items
    .filter(i => i.status === "done")
    .reduce((a, i) => a + (Number(i.story_points) || 0), 0);
  const inProgressItems = items.filter(i => i.status === "in_progress").length;
  const blockedItems = items.filter(i => i.status === "blocked").length;
  const progressPercent =
    totalPoints > 0 ? Math.round((completedPoints / totalPoints) * 100) : 0;

  let daysRemaining: number | null = null;
  let daysTotal: number | null = null;
  if (sprint.end_date) {
    const end = new Date(sprint.end_date).getTime();
    const start = new Date(sprint.start_date).getTime();
    const today = Date.now();
    daysRemaining = Math.max(0, Math.ceil((end - today) / 86_400_000));
    daysTotal = Math.max(1, Math.ceil((end - start) / 86_400_000));
  }

  return {
    totalItems,
    totalPoints,
    completedItems,
    completedPoints,
    inProgressItems,
    blockedItems,
    progressPercent,
    daysRemaining,
    daysTotal,
  };
}

// Resolve "user requesting this team" → admin_phone. Mirrors the
// pattern in app/api/team/[name]/today/route.ts so authorization is
// consistent across endpoints.
export async function resolveTeamAdmin(teamName: string, userPhone: string): Promise<string | null> {
  const r = await query<{ admin_phone: string }>(
    `SELECT admin_phone FROM teams
      WHERE team_name = $1
        AND (admin_phone = $2 OR member_phone = $2)
      ORDER BY (admin_phone = $2) DESC, id ASC
      LIMIT 1`,
    [teamName.toLowerCase(), userPhone]
  );
  return r.rows[0]?.admin_phone ?? null;
}
