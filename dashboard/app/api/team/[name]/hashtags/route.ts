// dashboard/app/api/team/[name]/hashtags/route.ts
//
// GET — top hashtags this week + last week, with mention counts +
// distinct contributor counts. Used by the Today "What we're rallying
// around" widget.
import { NextResponse } from "next/server";
import { getCurrentUserPhone } from "@/lib/session";
import { resolveTeamAdmin } from "@/lib/sprint";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { name: string } }) {
  try {
    const userPhone = await getCurrentUserPhone();
    if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
    const teamName = decodeURIComponent(params.name);
    const adminPhone = await resolveTeamAdmin(teamName, userPhone);
    if (!adminPhone) return NextResponse.json({ ok: false, error: "team not found" }, { status: 404 });

    const safe = async <T>(fn: () => Promise<T>, fb: T) => { try { return await fn(); } catch { return fb; } };

    const thisWeek = await safe(async () => (await query<{ tag: string; mentions: string | number; contributors: string | number; last_seen: string }>(
      `SELECT tag,
              COUNT(*)::int AS mentions,
              COUNT(DISTINCT user_phone)::int AS contributors,
              MAX(created_at)::text AS last_seen
         FROM team_hashtag_mentions
        WHERE admin_phone = $1
          AND created_at > date_trunc('week', NOW())
     GROUP BY tag
     ORDER BY mentions DESC, last_seen DESC
        LIMIT 10`,
      [adminPhone]
    )).rows.map(r => ({ tag: r.tag, mentions: Number(r.mentions) || 0, contributors: Number(r.contributors) || 0, last_seen: r.last_seen })), []);

    return NextResponse.json({ ok: true, this_week: thisWeek });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
