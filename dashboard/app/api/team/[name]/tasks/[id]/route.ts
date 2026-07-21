import { NextResponse } from "next/server";

import { query } from "@/lib/db";
import { getCurrentUserPhone } from "@/lib/session";
import { resolveTeamAdmin } from "@/lib/sprint";
import { parseTeamTaskUpdateInput } from "@/lib/team-task";
import { ensureTeamTaskSchema } from "@/lib/team-task-schema";

export const dynamic = "force-dynamic";

type TaskAccessRow = {
  id: number;
  user_phone: string;
  assigned_to: string | null;
  assigned_by: string | null;
  team_admin_phone: string | null;
  team_name: string | null;
};

async function resolveTaskAccess(teamName: string, id: number, userPhone: string) {
  const adminPhone = await resolveTeamAdmin(teamName, userPhone);
  if (!adminPhone) return { error: NextResponse.json({ ok: false, error: "Team not found." }, { status: 404 }) };
  await ensureTeamTaskSchema();
  const result = await query<TaskAccessRow>(
    `SELECT id, user_phone, assigned_to, assigned_by, team_admin_phone, team_name
       FROM tasks WHERE id = $1 LIMIT 1`,
    [id],
  );
  const task = result.rows[0];
  if (!task) return { error: NextResponse.json({ ok: false, error: "Task not found." }, { status: 404 }) };
  const scopedToTeam = task.team_admin_phone === adminPhone && task.team_name?.toLowerCase() === teamName.toLowerCase();
  let legacyInTeam = false;
  if (!task.team_admin_phone && !task.team_name && task.assigned_by === userPhone && task.assigned_to) {
    const member = await query(
      `SELECT 1 FROM teams WHERE admin_phone = $1 AND LOWER(team_name) = LOWER($2) AND member_phone = $3 LIMIT 1`,
      [adminPhone, teamName, task.assigned_to],
    );
    legacyInTeam = (member.rowCount || 0) > 0;
  }
  if (!scopedToTeam && !legacyInTeam) {
    return { error: NextResponse.json({ ok: false, error: "Task not found." }, { status: 404 }) };
  }
  return { adminPhone, task };
}

export async function PATCH(req: Request, { params }: { params: { name: string; id: string } }) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });
  const teamName = decodeURIComponent(params.name).trim().toLowerCase();
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ ok: false, error: "Invalid task." }, { status: 400 });

  try {
    const access = await resolveTaskAccess(teamName, id, userPhone);
    if (access.error) return access.error;
    const { adminPhone, task } = access;
    const parsed = parseTeamTaskUpdateInput(await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
    const input = parsed.value;
    const isManager = userPhone === adminPhone || userPhone === task.user_phone || userPhone === task.assigned_by;
    const isAssignee = userPhone === task.assigned_to;
    const onlyStatus = Object.keys(input).every(key => key === "status");
    if (!isManager && !(isAssignee && onlyStatus)) {
      return NextResponse.json({ ok: false, error: "You do not have permission to edit this task." }, { status: 403 });
    }

    if (input.assignee) {
      const member = await query(
        `SELECT 1 FROM teams WHERE admin_phone = $1 AND LOWER(team_name) = LOWER($2) AND member_phone = $3 LIMIT 1`,
        [adminPhone, teamName, input.assignee],
      );
      if (member.rowCount === 0) return NextResponse.json({ ok: false, error: "The selected assignee is not in this team." }, { status: 400 });
    }

    const updated = await query(
      `UPDATE tasks
          SET assigned_to = CASE WHEN $1 THEN $2 ELSE assigned_to END,
              title = CASE WHEN $3 THEN $4 ELSE title END,
              description = CASE WHEN $5 THEN $6 ELSE description END,
              due_date = CASE WHEN $7 THEN $8 ELSE due_date END,
              priority = CASE WHEN $9 THEN $10 ELSE priority END,
              status = CASE WHEN $11 THEN $12 ELSE status END,
              completed_at = CASE
                WHEN $11 AND $12 = 'completed' THEN COALESCE(completed_at, NOW())
                WHEN $11 AND $12 <> 'completed' THEN NULL
                ELSE completed_at
              END,
              team_admin_phone = COALESCE(team_admin_phone, $13),
              team_name = COALESCE(team_name, $14)
        WHERE id = $15
        RETURNING id, title, description, assigned_to, assigned_by, due_date, priority, status, created_at, completed_at`,
      [
        input.assignee !== undefined, input.assignee || null,
        input.title !== undefined, input.title || null,
        input.description !== undefined, input.description ?? null,
        input.dueAt !== undefined, input.dueAt || null,
        input.priority !== undefined, input.priority || null,
        input.status !== undefined, input.status || null,
        adminPhone, teamName, id,
      ],
    );
    return NextResponse.json({ ok: true, task: updated.rows[0] });
  } catch (error) {
    console.error("[TeamTask] update failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ ok: false, error: "The task could not be updated." }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: { name: string; id: string } }) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });
  const teamName = decodeURIComponent(params.name).trim().toLowerCase();
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ ok: false, error: "Invalid task." }, { status: 400 });

  try {
    const access = await resolveTaskAccess(teamName, id, userPhone);
    if (access.error) return access.error;
    const { adminPhone, task } = access;
    if (userPhone !== adminPhone && userPhone !== task.user_phone && userPhone !== task.assigned_by) {
      return NextResponse.json({ ok: false, error: "You do not have permission to delete this task." }, { status: 403 });
    }
    await query(`DELETE FROM tasks WHERE id = $1`, [id]);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[TeamTask] delete failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ ok: false, error: "The task could not be deleted." }, { status: 500 });
  }
}
