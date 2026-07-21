// dashboard/app/api/team/list/route.ts
//
// GET — returns every team the signed-in user belongs to, with member
//       counts and the user's own role per team. Used by the team
//       selector at the top of /team.
//
// POST — create a new team. Body: { name, members?: [{name, phone,
//        role?}] }. The creator is auto-added as admin. Each row in
//        `teams` is one member-team relationship; we use `admin_phone`
//        to denote ownership.
import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";

export type TeamRef = {
  name: string;
  member_count: number;
  is_admin: boolean;
  admin_phone: string;
  your_role: string | null;
};

export async function GET() {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

  if (process.env.ARI_DEMO_MODE === "true") {
    const demo = await query<{
      team_name: string;
      admin_phone: string;
      member_count: string;
      your_role: string | null;
    }>(
      `SELECT team_name, admin_phone, COUNT(*)::text AS member_count,
              MAX(CASE WHEN member_phone = $1 THEN role ELSE NULL END) AS your_role
         FROM teams
        WHERE admin_phone = $1 OR member_phone = $1
        GROUP BY team_name, admin_phone
        ORDER BY team_name`,
      [userPhone],
    );
    return NextResponse.json({
      ok: true,
      teams: demo.rows.map(row => ({
        name: row.team_name,
        member_count: parseInt(row.member_count, 10) || 0,
        is_admin: row.admin_phone === userPhone,
        admin_phone: row.admin_phone,
        your_role: row.your_role,
      })),
    });
  }

  // Distinct team_name across all rows where the user is admin OR member.
  // Then for each, count members (any row with the same team_name +
  // admin_phone) and grab the user's own role.
  const r = await query<{
    team_name: string;
    admin_phone: string;
    member_count: string;
    is_admin: boolean;
    your_role: string | null;
  }>(
    `WITH my_teams AS (
       SELECT DISTINCT team_name, admin_phone
         FROM teams
        WHERE admin_phone = $1 OR member_phone = $1
     )
     SELECT
       mt.team_name,
       mt.admin_phone,
       (SELECT COUNT(*) FROM teams t
          WHERE t.team_name = mt.team_name AND t.admin_phone = mt.admin_phone)::text AS member_count,
       (mt.admin_phone = $1) AS is_admin,
       (SELECT t.role FROM teams t
          WHERE t.team_name = mt.team_name AND t.admin_phone = mt.admin_phone AND t.member_phone = $1
          LIMIT 1) AS your_role
       FROM my_teams mt
      ORDER BY mt.team_name ASC`,
    [userPhone]
  );

  const teams: TeamRef[] = r.rows.map(row => ({
    name: row.team_name,
    member_count: parseInt(row.member_count, 10) || 0,
    is_admin: Boolean(row.is_admin),
    admin_phone: row.admin_phone,
    your_role: row.your_role || null,
  }));

  return NextResponse.json({ ok: true, teams });
}

export async function POST(req: Request) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

  let body: {
    name?: string;
    members?: { name?: string; phone?: string; role?: string }[];
  } = {};
  try { body = await req.json(); } catch { /* ignore */ }

  const teamName = String(body.name || "").trim().toLowerCase().replace(/\s+/g, "-").slice(0, 60);
  if (!teamName) {
    return NextResponse.json({ ok: false, error: "name required" }, { status: 400 });
  }
  if (!/^[a-z0-9_-]+$/.test(teamName)) {
    return NextResponse.json({ ok: false, error: "name can only have letters, numbers, dashes, underscores" }, { status: 400 });
  }

  // Make sure the user doesn't already admin a team with this name
  const exists = await query(
    `SELECT 1 FROM teams WHERE admin_phone = $1 AND team_name = $2 LIMIT 1`,
    [userPhone, teamName]
  );
  if (exists.rows.length > 0) {
    return NextResponse.json({ ok: false, error: `you already have a team called "${teamName}"` }, { status: 409 });
  }

  // Always add the creator first (as admin role).
  // Use the Google email-derived name if available; fall back to a
  // generic label.
  const meName = await safeGetOwnerName(userPhone);
  await query(
    `INSERT INTO teams (admin_phone, member_phone, member_name, role, team_name)
     VALUES ($1, $1, $2, 'admin', $3)`,
    [userPhone, meName, teamName]
  );

  // Add provided members (if any). Skip rows missing phone or name.
  let added = 1;
  for (const m of (body.members || []).slice(0, 50)) {
    const phone = String(m.phone || "").replace(/\D/g, "").slice(0, 20);
    const name = String(m.name || "").trim().slice(0, 120);
    const role = String(m.role || "member").trim().slice(0, 32) || "member";
    if (!phone || !name) continue;
    if (phone === userPhone) continue; // already added
    try {
      await query(
        `INSERT INTO teams (admin_phone, member_phone, member_name, role, team_name)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [userPhone, phone, name, role, teamName]
      );
      added++;
    } catch { /* ignore per-row failures */ }
  }

  return NextResponse.json({ ok: true, team: { name: teamName, member_count: added, is_admin: true } });
}

async function safeGetOwnerName(userPhone: string): Promise<string> {
  try {
    const r = await query<{ google_email: string | null }>(
      `SELECT google_email FROM google_tokens WHERE user_phone = $1 LIMIT 1`,
      [userPhone]
    );
    const email = r.rows[0]?.google_email;
    if (email) {
      const local = email.split("@")[0];
      return local.charAt(0).toUpperCase() + local.slice(1);
    }
  } catch { /* fall through */ }
  return `+${userPhone}`;
}
