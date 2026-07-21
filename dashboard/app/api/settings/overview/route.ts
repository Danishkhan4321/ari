// dashboard/app/api/settings/overview/route.ts
// GET — connected integrations and session details for the signed-in user.
import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getCurrentUserPhone } from "@/lib/session";
import { callBotInternal } from "@/lib/bot-bridge";

export const dynamic = "force-dynamic";

export async function GET() {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

  // 42P01 = table not created yet (fresh install) — genuinely disconnected.
  // Other database failures must not masquerade as "nothing connected".
  const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch (error) {
      if ((error as { code?: string })?.code === "42P01") return fallback;
      throw error;
    }
  };

  try {
  const [googleStatus, legacyGoogle, microsoft, dashboardSessions] = await Promise.all([
    callBotInternal<{ connected: boolean; allConnected: boolean; products: Record<string, boolean>; email: string | null }>(
      "/webhook/internal/dashboard-google-status",
      { user_phone: userPhone },
      10_000,
    ),
    safe(async () => (await query<{ google_email: string | null; scopes: string | null }>(
      `SELECT google_email, scopes FROM google_tokens WHERE user_phone = $1`,
      [userPhone]
    )).rows[0] ?? null, null),
    safe(async () => (await query<{ microsoft_email: string | null }>(
      `SELECT microsoft_email FROM microsoft_tokens WHERE user_phone = $1`,
      [userPhone]
    )).rows[0] ?? null, null),
    safe(async () => (await query<{ count: string; latest: string | null }>(
      `SELECT COUNT(*)::text AS count, MAX(last_used_at)::text AS latest
         FROM dashboard_sessions WHERE user_phone = $1 AND expires_at > NOW()`,
      [userPhone]
    )).rows[0] ?? null, null),
  ]);

  const google = googleStatus.ok
    ? { connected: googleStatus.data.connected, allConnected: googleStatus.data.allConnected, products: googleStatus.data.products, google_email: googleStatus.data.email, scopes: null }
    : legacyGoogle
      ? { connected: true, ...legacyGoogle }
      : { connected: false, google_email: null, scopes: null };

  return NextResponse.json({
    ok: true,
    user_phone: userPhone,
    google,
    microsoft,
    dashboardSessions,
  });
  } catch (error) {
    const correlationId = crypto.randomUUID();
    console.error(`[settings/overview] ${correlationId} database failure:`, error);
    return NextResponse.json({ ok: false, error: "database_unavailable", correlationId }, { status: 503 });
  }
}
