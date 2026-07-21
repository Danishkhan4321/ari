import { NextResponse } from "next/server";
import { consumeDesktopAuthTicket } from "@/lib/desktop-auth";
import { createSession, SESSION_MAX_AGE_SECONDS } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let ticket = "";
  try {
    ticket = String(((await req.json()) as { ticket?: string }).ticket || "");
  } catch {
    return NextResponse.json({ ok: false, error: "invalid ticket" }, { status: 400 });
  }
  const userPhone = await consumeDesktopAuthTicket(ticket);
  if (!userPhone) {
    return NextResponse.json({ ok: false, error: "ticket expired or already used" }, { status: 401 });
  }
  const token = await createSession(userPhone);
  return NextResponse.json(
    { ok: true, token, maxAge: SESSION_MAX_AGE_SECONDS },
    { headers: { "cache-control": "no-store" } },
  );
}
