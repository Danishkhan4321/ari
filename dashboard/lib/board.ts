// dashboard/lib/board.ts
//
// Shared Kanban boards. Schema lives in src/services/shared-board.service.js
// on the bot side: tables shared_boards + board_tasks. Status columns are
// stored as plain strings; we display them as fixed Kanban columns:
// todo · in_progress · done · blocked.
import { query } from "@/lib/db";

export type Board = {
  id: number;
  team_admin_phone: string;
  name: string;
  description: string | null;
  created_by: string;
  created_at: string;
};

export type BoardTask = {
  id: number;
  board_id: number;
  title: string;
  description: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  status: "todo" | "in_progress" | "done" | "blocked" | string;
  priority: "low" | "normal" | "high" | string;
  due_date: string | null;
  created_by: string;
  created_at: string;
  completed_at: string | null;
};

export async function listBoards(adminPhone: string): Promise<(Board & { task_count: number })[]> {
  const r = await query<Board & { task_count: string | number }>(
    `SELECT b.*, COUNT(t.id)::int AS task_count
       FROM shared_boards b
  LEFT JOIN board_tasks t ON t.board_id = b.id
      WHERE b.team_admin_phone = $1
   GROUP BY b.id
   ORDER BY b.created_at DESC`,
    [adminPhone]
  );
  return r.rows.map(row => ({ ...row, task_count: Number(row.task_count) || 0 }));
}

export async function getBoard(adminPhone: string, boardId: number): Promise<{ board: Board; tasks: BoardTask[] } | null> {
  const b = await query<Board>(
    `SELECT * FROM shared_boards WHERE id = $1 AND team_admin_phone = $2`,
    [boardId, adminPhone]
  );
  if (!b.rows[0]) return null;
  const t = await query<BoardTask>(
    `SELECT * FROM board_tasks WHERE board_id = $1 ORDER BY created_at ASC`,
    [boardId]
  );
  return { board: b.rows[0], tasks: t.rows };
}

export async function createBoard(adminPhone: string, name: string, description: string | null, createdBy: string): Promise<Board | null> {
  const r = await query<Board>(
    `INSERT INTO shared_boards (team_admin_phone, name, description, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (team_admin_phone, name) DO NOTHING
     RETURNING *`,
    [adminPhone, name, description, createdBy]
  );
  return r.rows[0] ?? null;
}

export async function deleteBoard(adminPhone: string, boardId: number): Promise<boolean> {
  const r = await query(
    `DELETE FROM shared_boards WHERE id = $1 AND team_admin_phone = $2`,
    [boardId, adminPhone]
  );
  return (r.rowCount ?? 0) > 0;
}

const VALID_TASK_STATUSES = new Set(["todo", "in_progress", "done", "blocked"]);

export async function addTask(
  adminPhone: string,
  boardId: number,
  fields: { title: string; description?: string | null; assignedTo?: string | null; assignedToName?: string | null; priority?: string; status?: string; createdBy: string }
): Promise<BoardTask | null> {
  // Verify board ownership before insert.
  const owns = await query<{ id: number }>(
    `SELECT id FROM shared_boards WHERE id = $1 AND team_admin_phone = $2`,
    [boardId, adminPhone]
  );
  if (!owns.rows[0]) return null;
  // Allow callers to seed an initial status so the "+ Add task" button
  // inside a non-todo column drops the new task into that column directly.
  // Unknown values fall back to 'todo' rather than rejecting the insert.
  const status = fields.status && VALID_TASK_STATUSES.has(fields.status) ? fields.status : "todo";
  const r = await query<BoardTask>(
    `INSERT INTO board_tasks (board_id, title, description, assigned_to, assigned_to_name, priority, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [boardId, fields.title.trim().slice(0, 480), fields.description ?? null, fields.assignedTo ?? null, fields.assignedToName ?? null, fields.priority || "normal", status, fields.createdBy]
  );
  return r.rows[0] ?? null;
}

export async function updateTaskStatus(adminPhone: string, taskId: number, status: string): Promise<BoardTask | null> {
  const r = await query<BoardTask>(
    `UPDATE board_tasks bt
        SET status = $1,
            completed_at = CASE WHEN $1 = 'done' THEN NOW() ELSE NULL END
       FROM shared_boards b
      WHERE bt.id = $2
        AND bt.board_id = b.id
        AND b.team_admin_phone = $3
   RETURNING bt.*`,
    [status, taskId, adminPhone]
  );
  return r.rows[0] ?? null;
}

export async function deleteTask(adminPhone: string, taskId: number): Promise<boolean> {
  const r = await query(
    `DELETE FROM board_tasks bt
       USING shared_boards b
      WHERE bt.id = $1 AND bt.board_id = b.id AND b.team_admin_phone = $2`,
    [taskId, adminPhone]
  );
  return (r.rowCount ?? 0) > 0;
}
