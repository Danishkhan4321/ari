// dashboard/app/api/team/[name]/setup-status/route.ts
//
// GET — single-shot setup-state lookup for the SetupChecklist
// component on the empty Today view. Returns booleans for each
// "have they done X yet?" check, in one round-trip.
import { NextResponse } from "next/server";
import { withTeamScope } from "@/lib/api-team";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export const GET = withTeamScope(async (_req, { adminPhone, teamName }) => {
  const safe = async <T>(fn: () => Promise<T>, fb: T) => { try { return await fn(); } catch { return fb; } };

  // Each check is intentionally cheap — single index lookup, EXISTS-style.
  const [broadcastSent, birthdaysSet] = await Promise.all([
    safe(async () => (await query<{ n: number }>(
      `SELECT 1 AS n FROM team_messages WHERE admin_phone = $1 AND team_name = $2 LIMIT 1`,
      [adminPhone, teamName.toLowerCase()]
    )).rowCount, 0),
    safe(async () => (await query<{ n: number }>(
      `SELECT 1 AS n FROM team_member_meta
        WHERE admin_phone = $1 AND team_name = $2 AND birthday IS NOT NULL LIMIT 1`,
      [adminPhone, teamName.toLowerCase()]
    )).rowCount, 0),
  ]);

  return NextResponse.json({
    ok: true,
    broadcast_sent: (broadcastSent ?? 0) > 0,
    birthdays_set: (birthdaysSet ?? 0) > 0,
  });
});
