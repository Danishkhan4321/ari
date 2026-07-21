// dashboard/lib/api-team.ts
//
// Higher-order function for team-scoped API routes. Replaces ~25 lines
// of identical boilerplate per route (auth + team-resolve + try/catch
// + JSON error response) with a single wrap.
//
// Usage:
//   export const GET = withTeamScope(async (_req, { adminPhone, isAdmin }) => {
//     const data = await loadStuff(adminPhone);
//     return NextResponse.json({ ok: true, data, is_admin: isAdmin });
//   });
//
//   export const POST = withTeamScope(async (req, { adminPhone, teamName }) => {
//     // ... handler logic
//   }, { adminOnly: true });
//
// Each route can still throw — we catch + return JSON 500 so the
// client never sees a Next default HTML 500 page.
import { NextResponse } from "next/server";
import { getCurrentUserPhone } from "@/lib/session";
import { resolveTeamAdmin } from "@/lib/sprint";

export type TeamCtx = {
  userPhone: string;
  adminPhone: string;
  teamName: string;
  isAdmin: boolean;
};

type Handler = (req: Request, ctx: TeamCtx) => Promise<NextResponse> | NextResponse;

export function withTeamScope(
  handler: Handler,
  opts: { adminOnly?: boolean } = {}
) {
  return async (req: Request, { params }: { params: { name: string } }) => {
    try {
      const userPhone = await getCurrentUserPhone();
      if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

      const teamName = decodeURIComponent(params.name);
      const adminPhone = await resolveTeamAdmin(teamName, userPhone);
      if (!adminPhone) return NextResponse.json({ ok: false, error: "team not found" }, { status: 404 });

      const isAdmin = adminPhone === userPhone;
      if (opts.adminOnly && !isAdmin) {
        return NextResponse.json({ ok: false, error: "admin only" }, { status: 403 });
      }

      return await handler(req, { userPhone, adminPhone, teamName, isAdmin });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ ok: false, error: msg }, { status: 500 });
    }
  };
}

// Same shape but for nested params like /[name]/items/[id]/route.ts.
// The handler gets the additional `params` for downstream identifiers.
export function withTeamScopeAndParams<P extends Record<string, string>>(
  handler: (req: Request, ctx: TeamCtx & { params: P }) => Promise<NextResponse> | NextResponse,
  opts: { adminOnly?: boolean } = {}
) {
  return async (req: Request, { params }: { params: P & { name: string } }) => {
    try {
      const userPhone = await getCurrentUserPhone();
      if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

      const teamName = decodeURIComponent(params.name);
      const adminPhone = await resolveTeamAdmin(teamName, userPhone);
      if (!adminPhone) return NextResponse.json({ ok: false, error: "team not found" }, { status: 404 });

      const isAdmin = adminPhone === userPhone;
      if (opts.adminOnly && !isAdmin) {
        return NextResponse.json({ ok: false, error: "admin only" }, { status: 403 });
      }

      return await handler(req, { userPhone, adminPhone, teamName, isAdmin, params });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ ok: false, error: msg }, { status: 500 });
    }
  };
}
