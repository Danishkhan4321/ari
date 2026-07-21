// dashboard/app/api/team/poll/vote/route.ts
//
// POST — cast or change a vote on a team poll.
// Body: { poll_id, option_index }
//
// Verified the user is in the poll's team (else 403). Single-vote
// model: re-submitting just updates the existing row. Multi-select
// polls aren't supported here yet — they fall through to an error.
import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

  let body: { poll_id?: number; option_index?: number } = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const pollId = Number(body.poll_id);
  const optionIndex = Number(body.option_index);
  if (!Number.isInteger(pollId) || pollId <= 0) {
    return NextResponse.json({ ok: false, error: "poll_id required" }, { status: 400 });
  }
  if (!Number.isInteger(optionIndex) || optionIndex < 0) {
    return NextResponse.json({ ok: false, error: "option_index required" }, { status: 400 });
  }

  // Load the poll + verify the user is in the same team
  const pr = await query<{
    id: number; status: string; options: unknown;
    team_name: string | null; multi_select: boolean | null;
  }>(
    `SELECT id, status, options, team_name, multi_select FROM polls WHERE id = $1 LIMIT 1`,
    [pollId]
  );
  const poll = pr.rows[0];
  if (!poll) return NextResponse.json({ ok: false, error: "poll not found" }, { status: 404 });
  if (poll.status !== "active") {
    return NextResponse.json({ ok: false, error: "poll is closed" }, { status: 400 });
  }
  if (poll.multi_select) {
    return NextResponse.json({ ok: false, error: "multi-select polls aren't supported here yet" }, { status: 400 });
  }
  const opts = Array.isArray(poll.options) ? (poll.options as string[]) : [];
  if (optionIndex >= opts.length) {
    return NextResponse.json({ ok: false, error: "invalid option" }, { status: 400 });
  }

  // User must be in this team (admin or member). poll.team_name carries it.
  if (poll.team_name) {
    const inTeam = await query(
      `SELECT 1 FROM teams
        WHERE team_name = $1 AND (admin_phone = $2 OR member_phone = $2)
        LIMIT 1`,
      [poll.team_name, userPhone]
    );
    if (inTeam.rows.length === 0) {
      return NextResponse.json({ ok: false, error: "you're not in this team" }, { status: 403 });
    }
  }

  // Upsert vote
  const existing = await query<{ id: number }>(
    `SELECT id FROM poll_votes WHERE poll_id = $1 AND voter_phone = $2 LIMIT 1`,
    [pollId, userPhone]
  );
  if (existing.rows[0]) {
    await query(
      `UPDATE poll_votes SET selected_option = $1, created_at = NOW() WHERE id = $2`,
      [optionIndex, existing.rows[0].id]
    );
  } else {
    await query(
      `INSERT INTO poll_votes (poll_id, voter_phone, selected_option) VALUES ($1, $2, $3)`,
      [pollId, userPhone, optionIndex]
    );
  }

  return NextResponse.json({ ok: true });
}
