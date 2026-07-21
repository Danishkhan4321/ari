// dashboard/app/api/team/[name]/boards/[id]/tasks/route.ts
//
// POST — add a task to a board. Anyone in the team can add.
import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getCurrentUserPhone } from "@/lib/session";
import { resolveTeamAdmin } from "@/lib/sprint";
import { addTask } from "@/lib/board";
import { notifyUserViaBot } from "@/lib/bot-bridge";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { name: string; id: string } }) {
  try {
    const userPhone = await getCurrentUserPhone();
    if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

    const teamName = decodeURIComponent(params.name);
    const adminPhone = await resolveTeamAdmin(teamName, userPhone);
    if (!adminPhone) return NextResponse.json({ ok: false, error: "team not found" }, { status: 404 });

    const boardId = Number(params.id);
    if (!Number.isInteger(boardId)) return NextResponse.json({ ok: false, error: "invalid board id" }, { status: 400 });

    let body: { title?: string; description?: string | null; assignedTo?: string | null; assignedToName?: string | null; priority?: string; status?: string } = {};
    try { body = await req.json(); } catch { /* validate */ }
    const title = String(body.title || "").trim();
    if (!title) return NextResponse.json({ ok: false, error: "title required" }, { status: 400 });

    const task = await addTask(adminPhone, boardId, {
      title,
      description: body.description ?? null,
      assignedTo: body.assignedTo ?? null,
      assignedToName: body.assignedToName ?? null,
      priority: body.priority || "normal",
      status: body.status,
      createdBy: userPhone,
    });
    if (!task) return NextResponse.json({ ok: false, error: "board not found" }, { status: 404 });

    // Notify the assignee on WhatsApp. Skip if there's no assignee, or if the
    // assignee is the same person who created the task (no point pinging
    // yourself). Failures here don't block the API response — the task is
    // already saved; the worst case is a missing notification.
    if (task.assigned_to && task.assigned_to !== userPhone) {
      try {
        // Look up the assigner's display name so the message reads naturally.
        // The admin has no row in the `teams` member list, so handle that case.
        let assignerName = "Your team admin";
        if (userPhone !== adminPhone) {
          const m = await query<{ member_name: string | null }>(
            `SELECT member_name FROM teams WHERE admin_phone = $1 AND member_phone = $2 LIMIT 1`,
            [adminPhone, userPhone]
          );
          assignerName = m.rows[0]?.member_name?.trim() || "A teammate";
        }

        // Pull the board name for context in the message.
        const b = await query<{ name: string }>(
          `SELECT name FROM shared_boards WHERE id = $1`,
          [boardId]
        );
        const boardName = b.rows[0]?.name || `Board #${boardId}`;

        const lines = [
          `📋 *New task assigned to you*`,
          ``,
          `*${task.title}*`,
        ];
        if (task.description) lines.push(``, task.description);
        lines.push(``, `Board: ${boardName}`, `From: ${assignerName}`);
        if (task.priority && task.priority !== "normal") {
          lines.push(`Priority: ${task.priority}`);
        }
        lines.push(``, `Reply *done* when you're finished, or open the dashboard to update status.`);

        // Use TASK_REMINDER (template name `task_reminder_3`) so the
        // outside-24h fallback message reads as a task assignment instead of
        // a generic reminder. Template signature: 2 params [assignerName,
        // taskText]. We mirror the in-window free-form text in the template
        // params so the recipient sees the same task title/board context.
        const taskSummary = task.description
          ? `${task.title} — ${task.description}`
          : task.title;
        const result = await notifyUserViaBot(task.assigned_to, lines.join("\n"), {
          template: "TASK_REMINDER",
          templateParams: [
            assignerName.slice(0, 60),
            `${taskSummary} (board: ${boardName})`.slice(0, 1024),
          ],
        });
        if (!result.ok) {
          console.error(`[board-task-notify] failed for ${task.assigned_to}: ${result.error}`);
        }
      } catch (notifyErr) {
        console.error(`[board-task-notify] error:`, notifyErr);
      }
    }

    return NextResponse.json({ ok: true, task });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
