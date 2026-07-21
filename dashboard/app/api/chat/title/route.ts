import { NextResponse } from "next/server";
import { ChatSessionError, chatSessionStore } from "@/lib/chat-session-store";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

  let body: { sessionId?: unknown; title?: unknown };
  try {
    body = await req.json() as { sessionId?: unknown; title?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid request" }, { status: 400 });
  }

  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  if (!sessionId || typeof body.title !== "string") {
    return NextResponse.json({ ok: false, error: "Enter a title of up to 120 characters." }, { status: 400 });
  }

  try {
    const title = await chatSessionStore.renameSession(userPhone, sessionId, body.title);
    return NextResponse.json({ ok: true, title });
  } catch (error) {
    if (error instanceof ChatSessionError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }
    return NextResponse.json({ ok: false, error: "Could not rename this session." }, { status: 500 });
  }
}
