// dashboard/app/api/team/[name]/members/route.ts
//
// POST   — add a member. Admin-only. Body: { name, phone, role? }.
// PATCH  — update a member's name or role. Admin-only.
// DELETE — remove a member. Admin-only. ?phone=<member>. Removing the
//          admin themselves is rejected (delete the team via a
//          separate flow if needed).
import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";

const ALLOWED_ROLES = new Set(["admin", "manager", "lead", "member"]);

export async function POST(req: Request, { params }: { params: { name: string } }) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

  const teamName = decodeURIComponent(params.name).toLowerCase();
  // Confirm admin
  const owns = await query(
    `SELECT 1 FROM teams WHERE admin_phone = $1 AND team_name = $2 LIMIT 1`,
    [userPhone, teamName]
  );
  if (owns.rows.length === 0) {
    return NextResponse.json({ ok: false, error: "only the team admin can add members" }, { status: 403 });
  }

  let body: { name?: string; phone?: string; role?: string } = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const name = String(body.name || "").trim().slice(0, 120);
  const phone = String(body.phone || "").replace(/\D/g, "").slice(0, 20);
  const requestedRole = String(body.role || "member").trim().toLowerCase();
  const role = ALLOWED_ROLES.has(requestedRole) ? requestedRole : "member";
  if (!name || !phone) {
    return NextResponse.json({ ok: false, error: "name and phone are required" }, { status: 400 });
  }

  // De-dupe — same admin + same team + same member_phone
  const dup = await query(
    `SELECT id FROM teams
      WHERE admin_phone = $1 AND team_name = $2 AND member_phone = $3
      LIMIT 1`,
    [userPhone, teamName, phone]
  );
  if (dup.rows.length > 0) {
    return NextResponse.json({ ok: false, error: "already a member" }, { status: 409 });
  }

  await query(
    `INSERT INTO teams (admin_phone, member_phone, member_name, role, team_name)
     VALUES ($1, $2, $3, $4, $5)`,
    [userPhone, phone, name, role, teamName]
  );

  return NextResponse.json({ ok: true });
}

export async function PATCH(req: Request, { params }: { params: { name: string } }) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

  const teamName = decodeURIComponent(params.name).toLowerCase();
  const owns = await query(`SELECT 1 FROM teams WHERE admin_phone = $1 AND team_name = $2 LIMIT 1`, [userPhone, teamName]);
  if (owns.rows.length === 0) return NextResponse.json({ ok: false, error: "only the team admin can edit members" }, { status: 403 });

  let body: { phone?: string; name?: string; role?: string } = {};
  try { body = await req.json(); } catch { /* validate below */ }
  const phone = String(body.phone || "").replace(/\D/g, "").slice(0, 20);
  const name = String(body.name || "").trim().slice(0, 120);
  const requestedRole = String(body.role || "member").trim().toLowerCase();
  if (!phone || !name) return NextResponse.json({ ok: false, error: "name and phone are required" }, { status: 400 });
  if (!ALLOWED_ROLES.has(requestedRole)) return NextResponse.json({ ok: false, error: "invalid role" }, { status: 400 });
  if (phone === userPhone && requestedRole !== "admin") return NextResponse.json({ ok: false, error: "the team owner must remain an admin" }, { status: 400 });

  const result = await query(
    `UPDATE teams SET member_name = $1, role = $2
      WHERE admin_phone = $3 AND team_name = $4 AND member_phone = $5
      RETURNING id, member_phone, member_name, role`,
    [name, requestedRole, userPhone, teamName, phone],
  );
  if (result.rowCount === 0) return NextResponse.json({ ok: false, error: "member not found" }, { status: 404 });
  return NextResponse.json({ ok: true, member: result.rows[0] });
}

export async function DELETE(req: Request, { params }: { params: { name: string } }) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

  const teamName = decodeURIComponent(params.name).toLowerCase();
  const url = new URL(req.url);
  const phone = String(url.searchParams.get("phone") || "").replace(/\D/g, "").slice(0, 20);
  if (!phone) {
    return NextResponse.json({ ok: false, error: "phone required" }, { status: 400 });
  }
  if (phone === userPhone) {
    return NextResponse.json({ ok: false, error: "you can't remove yourself; delete the team instead" }, { status: 400 });
  }

  // Must be admin
  const owns = await query(
    `SELECT 1 FROM teams WHERE admin_phone = $1 AND team_name = $2 LIMIT 1`,
    [userPhone, teamName]
  );
  if (owns.rows.length === 0) {
    return NextResponse.json({ ok: false, error: "only the admin can remove members" }, { status: 403 });
  }

  const r = await query(
    `DELETE FROM teams
      WHERE admin_phone = $1 AND team_name = $2 AND member_phone = $3
      RETURNING id`,
    [userPhone, teamName, phone]
  );
  if (r.rowCount === 0) {
    return NextResponse.json({ ok: false, error: "not a member" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
