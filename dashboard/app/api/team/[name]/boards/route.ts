// dashboard/app/api/team/[name]/boards/route.ts
//
// GET  — list all boards in the team, with task counts.
//        Optional ?include=tasks to return tasks on each board (one extra query)
// POST — create a new board (admin only)
import { NextResponse } from "next/server";
import { getCurrentUserPhone } from "@/lib/session";
import { resolveTeamAdmin } from "@/lib/sprint";
import { listBoards, createBoard, getBoard } from "@/lib/board";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: { name: string } }) {
  try {
    const userPhone = await getCurrentUserPhone();
    if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

    const teamName = decodeURIComponent(params.name);
    const adminPhone = await resolveTeamAdmin(teamName, userPhone);
    if (!adminPhone) return NextResponse.json({ ok: false, error: "team not found" }, { status: 404 });

    const url = new URL(req.url);
    const includeTasks = url.searchParams.get("include") === "tasks";

    const boards = await listBoards(adminPhone);
    if (!includeTasks) return NextResponse.json({ ok: true, is_admin: adminPhone === userPhone, boards });

    // Hydrate each board with its tasks. Done in parallel; small N (≤20 boards typically).
    const hydrated = await Promise.all(
      boards.map(async b => {
        const got = await getBoard(adminPhone, b.id);
        return { ...b, tasks: got?.tasks ?? [] };
      })
    );
    return NextResponse.json({ ok: true, is_admin: adminPhone === userPhone, boards: hydrated });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: { params: { name: string } }) {
  try {
    const userPhone = await getCurrentUserPhone();
    if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

    const teamName = decodeURIComponent(params.name);
    const adminPhone = await resolveTeamAdmin(teamName, userPhone);
    if (!adminPhone) return NextResponse.json({ ok: false, error: "team not found" }, { status: 404 });
    if (adminPhone !== userPhone) return NextResponse.json({ ok: false, error: "admin only" }, { status: 403 });

    let body: { name?: string; description?: string | null } = {};
    try { body = await req.json(); } catch { /* validate next */ }
    const name = String(body.name || "").trim();
    if (!name) return NextResponse.json({ ok: false, error: "name required" }, { status: 400 });

    const board = await createBoard(adminPhone, name.slice(0, 250), body.description?.slice(0, 1000) || null, userPhone);
    if (!board) return NextResponse.json({ ok: false, error: "name taken" }, { status: 409 });
    return NextResponse.json({ ok: true, board });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
