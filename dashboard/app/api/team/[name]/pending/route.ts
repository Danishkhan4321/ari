// dashboard/app/api/team/[name]/pending/route.ts
//
// GET — "things waiting on you" for the logged-in user, scoped to one team.
// Aggregates across:
//   - sprint items assigned to me (in active sprint, not done)
//   - 1:1s I'm in within next 24h
//   - today's standup if there's an active config and I haven't submitted
//   - leave requests pending my approval (if I'm the admin)
//   - open incidents assigned to me
//
// One round-trip. Each query is independently safe-wrapped — a missing
// table doesn't block the rest of the response.
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
    const isAdmin = adminPhone === userPhone;

    const safe = async <T>(fn: () => Promise<T>, fb: T): Promise<T> => {
      try { return await fn(); } catch { return fb; }
    };

    // Fan out in parallel.
    const [sprintItems, oneOnOnes, standupNeeded, pendingLeaves, openIncidents] = await Promise.all([
      // Sprint items assigned to me, in active sprint of this team admin
      safe(async () => (await query<{ id: number; title: string; story_points: number; status: string }>(
        `SELECT si.id, si.title, si.story_points, si.status
           FROM sprint_items si
           JOIN sprints s ON s.id = si.sprint_id
          WHERE s.team_admin_phone = $1 AND s.status = 'active'
            AND si.assigned_to = $2
            AND si.status != 'done'
          ORDER BY
            CASE si.status WHEN 'in_progress' THEN 1 WHEN 'blocked' THEN 2 WHEN 'todo' THEN 3 ELSE 4 END,
            si.created_at ASC
          LIMIT 5`,
        [adminPhone, userPhone]
      )).rows, []),

      // 1:1s in the next 24h where I'm manager or report.
      // Pre-compute partner name on the server — frontend doesn't know
      // which side of the 1:1 the current user is on.
      safe(async () => {
        const r = await query<{
          id: number; manager_name: string | null; report_name: string | null;
          manager_phone: string; report_phone: string;
          next_at: string; agenda: string | null;
        }>(
          `SELECT id, manager_name, report_name, manager_phone, report_phone, next_at, agenda
             FROM one_on_ones
            WHERE admin_phone = $1
              AND (manager_phone = $2 OR report_phone = $2)
              AND next_at >= NOW()
              AND next_at <= NOW() + INTERVAL '24 hours'
            ORDER BY next_at ASC LIMIT 3`,
          [adminPhone, userPhone]
        );
        return r.rows.map(o => {
          const isManager = o.manager_phone === userPhone;
          return {
            id: o.id,
            partner_name: isManager ? (o.report_name || `+${o.report_phone}`) : (o.manager_name || `+${o.manager_phone}`),
            role: isManager ? "manager" : "report",
            next_at: o.next_at,
            agenda: o.agenda,
          };
        });
      }, [] as { id: number; partner_name: string; role: string; next_at: string; agenda: string | null }[]),

      // Standup needed today? Active config + I'm a member + I haven't submitted
      safe(async () => {
        const cfg = await query<{ id: number }>(
          `SELECT id FROM standup_configs
            WHERE admin_phone = $1 AND team_name = $2 AND is_active = true
            ORDER BY id DESC LIMIT 1`,
          [adminPhone, teamName.toLowerCase()]
        );
        if (cfg.rows.length === 0) return null;
        const configId = cfg.rows[0].id;
        // Did this user submit anything today (non-placeholder)?
        const sub = await query<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM standup_responses
            WHERE config_id = $1 AND member_phone = $2
              AND response_date = CURRENT_DATE
              AND answer != '__placeholder__'`,
          [configId, userPhone]
        );
        return (sub.rows[0]?.n ?? 0) > 0 ? null : { config_id: configId };
      }, null),

      // Leave requests pending my approval (admin only)
      isAdmin ? safe(async () => (await query<{ id: number; employee_name: string | null; employee_phone: string; leave_type: string; start_date: string; end_date: string }>(
        `SELECT lr.id, lr.employee_phone, lr.leave_type, lr.start_date::text, lr.end_date::text,
                t.member_name AS employee_name
           FROM leave_requests lr
      LEFT JOIN teams t ON t.member_phone = lr.employee_phone AND t.admin_phone = $1
          WHERE lr.manager_phone = $1 AND lr.status = 'pending'
          ORDER BY lr.created_at ASC LIMIT 5`,
        [adminPhone]
      )).rows, []) : Promise.resolve([]),

      // Open incidents assigned to me
      safe(async () => (await query<{ id: number; title: string; severity: string }>(
        `SELECT id, title, severity FROM incidents
          WHERE team_admin_phone = $1
            AND assigned_to = $2
            AND status NOT IN ('resolved', 'closed')
          ORDER BY
            CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END
          LIMIT 5`,
        [adminPhone, userPhone]
      )).rows, []),
    ]);

    const totalCount =
      sprintItems.length +
      oneOnOnes.length +
      (standupNeeded ? 1 : 0) +
      pendingLeaves.length +
      openIncidents.length;

    return NextResponse.json({
      ok: true,
      total_count: totalCount,
      sprint_items: sprintItems,
      one_on_ones: oneOnOnes,
      standup_needed: standupNeeded,
      pending_leaves: pendingLeaves,
      open_incidents: openIncidents,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
