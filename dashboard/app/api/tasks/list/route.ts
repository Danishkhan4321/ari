// dashboard/app/api/tasks/list/route.ts
// GET /api/tasks/list — tasks owned by, or assigned to/by, the user.
// Splits into 3 buckets so the UI can render distinct lists without
// extra round-trips.
import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";

export type TaskRow = {
  id: number;
  title: string | null;
  description: string;
  status: string;
  priority: string | null;
  assigned_to: string | null;
  assigned_by: string | null;
  due_date: string | null;
};

export async function GET() {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

  const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch { return fallback; }
  };

  const [mine, assignedToMe, assignedByMe] = await Promise.all([
    safe(async () => (await query<TaskRow>(
      `SELECT id, title, description, status, priority, assigned_to, assigned_by, due_date
         FROM tasks
        WHERE user_phone = $1 AND COALESCE(assigned_to, '') IN ('', $1)
        ORDER BY (status = 'completed') ASC, id DESC
        LIMIT 200`,
      [userPhone]
    )).rows, [] as TaskRow[]),
    safe(async () => (await query<TaskRow>(
      `SELECT id, title, description, status, priority, assigned_to, assigned_by, due_date
         FROM tasks
        WHERE assigned_to = $1 AND user_phone <> $1
        ORDER BY (status = 'completed') ASC, id DESC
        LIMIT 100`,
      [userPhone]
    )).rows, [] as TaskRow[]),
    safe(async () => (await query<TaskRow>(
      `SELECT id, title, description, status, priority, assigned_to, assigned_by, due_date
         FROM tasks
        WHERE assigned_by = $1 AND assigned_to <> $1
        ORDER BY (status = 'completed') ASC, id DESC
        LIMIT 100`,
      [userPhone]
    )).rows, [] as TaskRow[]),
  ]);

  return NextResponse.json({ ok: true, mine, assignedToMe, assignedByMe });
}
