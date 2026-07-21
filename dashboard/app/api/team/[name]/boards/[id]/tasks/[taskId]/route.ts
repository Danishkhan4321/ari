// dashboard/app/api/team/[name]/boards/[id]/tasks/[taskId]/route.ts
//
// PATCH  — update task status (any team member).
// DELETE — remove task (admin only).
import { NextResponse } from "next/server";
import { getCurrentUserPhone } from "@/lib/session";
import { resolveTeamAdmin } from "@/lib/sprint";
import { updateTaskStatus, deleteTask } from "@/lib/board";

export const dynamic = "force-dynamic";

const VALID_STATUSES = new Set(["todo", "in_progress", "done", "blocked"]);

export async function PATCH(
  req: Request,
  { params }: { params: { name: string; id: string; taskId: string } }
) {
  // TEMP-DEBUG: instrumented to chase a drag-drop failure on the team board.
  // Remove these console.log lines once the issue is resolved.
  const tag = "[board-task-PATCH]";
  try {
    const userPhone = await getCurrentUserPhone();
    if (!userPhone) {
      console.log(`${tag} 401 not signed in`);
      return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
    }

    const teamName = decodeURIComponent(params.name);
    console.log(`${tag} user=${userPhone} team="${teamName}" boardId=${params.id} taskId=${params.taskId}`);

    const adminPhone = await resolveTeamAdmin(teamName, userPhone);
    if (!adminPhone) {
      console.log(`${tag} 404 team not found for team="${teamName}" user=${userPhone}`);
      return NextResponse.json({ ok: false, error: "team not found" }, { status: 404 });
    }

    const taskId = Number(params.taskId);
    if (!Number.isInteger(taskId)) {
      console.log(`${tag} 400 invalid id "${params.taskId}"`);
      return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
    }

    let body: { status?: string } = {};
    try { body = await req.json(); } catch { /* validate */ }
    const status = String(body.status || "");
    console.log(`${tag} body status="${status}"`);
    if (!VALID_STATUSES.has(status)) {
      console.log(`${tag} 400 invalid status "${status}"`);
      return NextResponse.json({ ok: false, error: "invalid status" }, { status: 400 });
    }

    const task = await updateTaskStatus(adminPhone, taskId, status);
    if (!task) {
      console.log(`${tag} 404 task not found admin=${adminPhone} taskId=${taskId}`);
      return NextResponse.json({ ok: false, error: "task not found" }, { status: 404 });
    }
    console.log(`${tag} 200 ok taskId=${taskId} -> ${status}`);
    return NextResponse.json({ ok: true, task });
  } catch (e) {
    console.error(`${tag} 500`, e);
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: { name: string; id: string; taskId: string } }
) {
  try {
    const userPhone = await getCurrentUserPhone();
    if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

    const teamName = decodeURIComponent(params.name);
    const adminPhone = await resolveTeamAdmin(teamName, userPhone);
    if (!adminPhone) return NextResponse.json({ ok: false, error: "team not found" }, { status: 404 });
    if (adminPhone !== userPhone) return NextResponse.json({ ok: false, error: "admin only" }, { status: 403 });

    const taskId = Number(params.taskId);
    if (!Number.isInteger(taskId)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });

    const ok = await deleteTask(adminPhone, taskId);
    if (!ok) return NextResponse.json({ ok: false, error: "task not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
