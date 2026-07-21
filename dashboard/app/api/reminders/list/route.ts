// dashboard/app/api/reminders/list/route.ts
// GET /api/reminders/list — returns active (pending) reminders for the
// signed-in user, plus the next N upcoming completed/cancelled ones
// for context. Uses the same `reminders` table the bot writes to.
import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";

export type ReminderRow = {
  id: number;
  message: string;
  reminder_time: string;          // ISO
  status: string;                 // pending | sent | completed | cancelled
  is_recurring: boolean;
  recurrence_pattern: string | null;
  recurrence_days: string | null;
  recurrence_time: string | null; // HH:MM:SS
  next_occurrence: string | null;
  snooze_until: string | null;
  created_at: string;
};

export async function GET() {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) {
    return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
  }
  try {
    const active = await query<ReminderRow>(
      `SELECT id, message, reminder_time, status, is_recurring,
              recurrence_pattern, recurrence_days, recurrence_time,
              next_occurrence, snooze_until, created_at
         FROM reminders
        WHERE user_phone = $1 AND status = 'pending'
        ORDER BY COALESCE(snooze_until, next_occurrence, reminder_time) ASC NULLS LAST
        LIMIT 200`,
      [userPhone]
    );
    const past = await query<ReminderRow>(
      `SELECT id, message, reminder_time, status, is_recurring,
              recurrence_pattern, recurrence_days, recurrence_time,
              next_occurrence, snooze_until, created_at
         FROM reminders
        WHERE user_phone = $1 AND status IN ('completed','cancelled','sent')
        ORDER BY reminder_time DESC
        LIMIT 30`,
      [userPhone]
    );
    return NextResponse.json({ ok: true, active: active.rows, past: past.rows });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
