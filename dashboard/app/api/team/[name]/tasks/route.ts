import { NextResponse } from "next/server";

import { callBotInternal } from "@/lib/bot-bridge";
import { query } from "@/lib/db";
import { getCurrentUserPhone } from "@/lib/session";
import { resolveTeamAdmin } from "@/lib/sprint";
import { parseTeamTaskInput } from "@/lib/team-task";
import { ensureTeamTaskSchema } from "@/lib/team-task-schema";

export const dynamic = "force-dynamic";

type CreatedTask = {
  id: number;
  title: string;
  description: string | null;
  assigned_to: string;
  assigned_by: string;
  due_date: string;
  priority: string;
  status: string;
};

export type TeamTaskRow = CreatedTask & {
  user_phone: string;
  created_at: string | null;
  completed_at: string | null;
  assignee_name: string | null;
  assigned_by_name: string | null;
};

export async function GET(_req: Request, { params }: { params: { name: string } }) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });

  try {
    const teamName = decodeURIComponent(params.name).trim().toLowerCase();
    const adminPhone = await resolveTeamAdmin(teamName, userPhone);
    if (!adminPhone) return NextResponse.json({ ok: false, error: "Team not found." }, { status: 404 });
    await ensureTeamTaskSchema();

    const members = await query<{ member_phone: string; member_name: string | null }>(
      `SELECT member_phone, member_name FROM teams WHERE admin_phone = $1 AND LOWER(team_name) = LOWER($2)`,
      [adminPhone, teamName],
    );
    const memberPhones = members.rows.map(member => member.member_phone);
    const legacyPlaceholders = memberPhones.map((_, index) => `$${index + 4}`).join(", ") || "NULL";
    const result = await query<Omit<TeamTaskRow, "assignee_name" | "assigned_by_name">>(
      `SELECT id, user_phone, title, description, assigned_to, assigned_by,
              due_date, priority, status, created_at, completed_at
         FROM tasks
        WHERE (team_admin_phone = $1 AND LOWER(team_name) = LOWER($2))
           OR (team_admin_phone IS NULL AND team_name IS NULL
               AND assigned_by = $3 AND assigned_to IN (${legacyPlaceholders}))
        ORDER BY (status = 'completed') ASC, due_date ASC NULLS LAST, id DESC
        LIMIT 500`,
      [adminPhone, teamName, userPhone, ...memberPhones],
    );
    const names = new Map(members.rows.map(member => [member.member_phone, member.member_name]));
    const tasks = result.rows.map(task => ({
      ...task,
      assignee_name: names.get(task.assigned_to) || null,
      assigned_by_name: names.get(task.assigned_by) || null,
    }));

    return NextResponse.json({ ok: true, tasks });
  } catch (error) {
    console.error("[TeamTask] list failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ ok: false, error: "Team tasks could not be loaded." }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: { params: { name: string } }) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });

  try {
    const teamName = decodeURIComponent(params.name).trim();
    const adminPhone = await resolveTeamAdmin(teamName, userPhone);
    if (!adminPhone) return NextResponse.json({ ok: false, error: "Team not found." }, { status: 404 });
    await ensureTeamTaskSchema();

    const parsed = parseTeamTaskInput(await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
    const input = parsed.value;

    const memberResult = await query<{ member_name: string | null; member_phone: string }>(
      `SELECT member_name, member_phone
         FROM teams
        WHERE admin_phone = $1 AND LOWER(team_name) = LOWER($2)`,
      [adminPhone, teamName],
    );
    const member = memberResult.rows.find(row => row.member_phone.replace(/\D/g, "") === input.assignee);
    if (!member) {
      return NextResponse.json({ ok: false, error: "The selected assignee is not in this team." }, { status: 400 });
    }

    const created = await query<CreatedTask>(
      `INSERT INTO tasks
         (user_phone, assigned_to, assigned_by, title, description, priority, due_date, status,
          team_admin_phone, team_name, completed_at)
       VALUES ($1, $2, $1, $3, $4, $5, $6, $7, $8, LOWER($9),
               CASE WHEN $7 = 'completed' THEN NOW() ELSE NULL END)
       RETURNING id, title, description, assigned_to, assigned_by, due_date, priority, status`,
      [userPhone, input.assignee, input.title, input.description, input.priority, input.dueAt, input.status, adminPhone, teamName],
    );
    const task = created.rows[0];

    let timezone = "Asia/Kolkata";
    try {
      const settings = await query<{ timezone: string | null }>(
        `SELECT timezone FROM user_settings WHERE user_phone = $1 LIMIT 1`,
        [input.assignee],
      );
      if (settings.rows[0]?.timezone) timezone = settings.rows[0].timezone;
    } catch { /* use the product default */ }
    const dueLabel = new Date(input.dueAt).toLocaleString("en-IN", {
      timeZone: timezone,
      dateStyle: "medium",
      timeStyle: "short",
    });
    const notification = await callBotInternal<{ ok: boolean; delivered?: boolean }>(
      "/webhook/internal/dashboard-notify",
      {
        recipient: input.assignee,
        text: `New team task: ${input.title}\nDue: ${dueLabel}\nPriority: ${input.priority}`,
        template_params: ["Your teammate", input.title],
      },
      20_000,
    );

    return NextResponse.json({
      ok: true,
      task,
      assignee_name: member.member_name,
      notification: notification.ok ? "delivered" : "failed",
      warning: notification.ok ? null : "Task created, but the WhatsApp notification could not be delivered.",
    });
  } catch (error) {
    console.error("[TeamTask] create failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ ok: false, error: "The task could not be created." }, { status: 500 });
  }
}
