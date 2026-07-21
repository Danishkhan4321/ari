// dashboard/app/api/productivity/overview/route.ts
// GET — habits + recent focus sessions + last 90d expenses summary +
// the user's last 7 days of self-standups (yesterday/today/blockers).
import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
  const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch { return fallback; }
  };
  const [habits, focus, expenses, expByCat, selfStandups] = await Promise.all([
    safe(async () => (await query(
      `SELECT h.id, h.name, h.frequency, h.target_count, h.active,
              (SELECT COUNT(*) FROM habit_logs l WHERE l.habit_id = h.id)::int AS log_count
         FROM habits h
        WHERE h.user_phone = $1
        ORDER BY h.active DESC, h.id DESC
        LIMIT 50`,
      [userPhone]
    )).rows, []),
    safe(async () => (await query(
      `SELECT id, duration_mins, mode, status, label
         FROM focus_sessions
        WHERE user_phone = $1
        ORDER BY id DESC LIMIT 30`,
      [userPhone]
    )).rows, []),
    safe(async () => (await query(
      `SELECT id, amount, currency, category, description, date FROM expenses
        WHERE user_phone = $1 AND date >= CURRENT_DATE - INTERVAL '90 days'
        ORDER BY date DESC, id DESC LIMIT 100`,
      [userPhone]
    )).rows, []),
    safe(async () => (await query(
      `SELECT category, SUM(amount)::numeric AS total, COUNT(*)::int AS n
         FROM expenses
        WHERE user_phone = $1 AND date >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY category
        ORDER BY total DESC
        LIMIT 12`,
      [userPhone]
    )).rows, []),
    safe(async () => (await query(
      `SELECT id, date, yesterday_done, today_plan, blockers, mood, energy_level, created_at
         FROM self_standups
        WHERE user_phone = $1
          AND date >= CURRENT_DATE - INTERVAL '7 days'
        ORDER BY date DESC`,
      [userPhone]
    )).rows, []),
  ]);
  return NextResponse.json({ ok: true, habits, focus, expenses, expByCat, selfStandups });
}
