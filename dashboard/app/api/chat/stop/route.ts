import { NextResponse } from "next/server";
import { cancelBotRun } from "@/lib/bot-bridge";
import { getCurrentUserPhone } from "@/lib/session";
import { chatSessionStore, ChatSessionError, isChatSessionId } from "@/lib/chat-session-store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
  let runId = "";
  let sessionId = "";
  try {
    const body = await req.json() as { runId?: string; sessionId?: string };
    runId = String(body.runId || "");
    sessionId = String(body.sessionId || "");
  } catch {
    return NextResponse.json({ ok: false, error: "invalid request" }, { status: 400 });
  }
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(runId) || !isChatSessionId(sessionId)) {
    return NextResponse.json({ ok: false, error: "invalid run" }, { status: 400 });
  }
  try {
    await chatSessionStore.requireOwnedSession(userPhone, sessionId);
  } catch (error) {
    const status = error instanceof ChatSessionError ? error.status : 500;
    return NextResponse.json({ ok: false, error: "invalid session" }, { status });
  }
  const result = await cancelBotRun(userPhone, runId, sessionId);
  const status = result.ok ? 200 : result.code === "not_found" ? 404 : 502;
  return NextResponse.json(result, { status });
}
