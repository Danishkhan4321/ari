import { NextResponse } from "next/server";
import { chatSessionStore } from "@/lib/chat-session-store";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
  try {
    return NextResponse.json({ ok: true, sessions: await chatSessionStore.listSessions(userPhone) });
  } catch {
    return NextResponse.json({ ok: false, error: "Could not load sessions." }, { status: 500 });
  }
}

export async function POST() {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
  try {
    return NextResponse.json({ ok: true, session: await chatSessionStore.createSession(userPhone) });
  } catch {
    return NextResponse.json({ ok: false, error: "Could not create a new session." }, { status: 500 });
  }
}
