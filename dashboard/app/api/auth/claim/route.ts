// dashboard/app/api/auth/claim/route.ts
// POST { code: "ABC123" } → atomically claims the link_code, creates a
// dashboard_sessions row, sets the session cookie. 200 on success.
import { NextResponse } from "next/server";
import { claimLinkCode } from "@/lib/auth";
import { createSession, setSessionCookie } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { code?: string } = {};
  try {
    body = (await req.json()) as { code?: string };
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid" }, { status: 400 });
  }

  const result = await claimLinkCode(body.code ?? "");
  if (!result.ok) {
    const status = result.reason === "error" ? 500 : 401;
    return NextResponse.json({ ok: false, reason: result.reason }, { status });
  }

  const token = await createSession(result.userPhone);
  setSessionCookie(token);
  return NextResponse.json({ ok: true });
}
