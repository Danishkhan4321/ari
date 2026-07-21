// dashboard/app/api/kpis/route.ts
// GET /api/kpis — top-strip numbers for the home page.
// Counts/sums are fast (indexed columns + COUNT/SUM only). Each query
// is independently scoped to the signed-in user_phone.
import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";

type Kpis = {
  active_reminders: number;
  open_deals: number;
  pipeline_value: number;       // dollars
  recent_messages: number;       // last 24h
};

export async function GET() {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

  // Use Promise.all so all 4 counts run in parallel.
  const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch { return fallback; }
  };
  const [reminders, deals, pipeline, msgs] = await Promise.all([
    safe(async () => (await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM reminders WHERE user_phone = $1 AND status = 'pending'`,
      [userPhone]
    )).rows[0]?.count, "0"),
    safe(async () => (await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM sales_leads
        WHERE user_phone = $1
          AND COALESCE(stage,'') NOT IN ('won','lost','closed_won','closed_lost')`,
      [userPhone]
    )).rows[0]?.count, "0"),
    safe(async () => (await query<{ sum: string }>(
      `SELECT COALESCE(SUM(deal_value), 0)::text AS sum FROM sales_leads
        WHERE user_phone = $1
          AND COALESCE(stage,'') NOT IN ('won','lost','closed_won','closed_lost')`,
      [userPhone]
    )).rows[0]?.sum, "0"),
    safe(async () => (await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM conversation_history
        WHERE user_phone = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
      [userPhone]
    )).rows[0]?.count, "0"),
  ]);

  const out: Kpis = {
    active_reminders: parseInt(reminders || "0", 10) || 0,
    open_deals:       parseInt(deals     || "0", 10) || 0,
    pipeline_value:   parseFloat(pipeline || "0")   || 0,
    recent_messages:  parseInt(msgs      || "0", 10) || 0,
  };
  return NextResponse.json({ ok: true, kpis: out });
}
