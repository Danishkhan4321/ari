// dashboard/app/api/chat/stream/route.ts
// GET — proxies the bot's in-process live run-event stream (SSE) to the
// signed-in browser. This is the PUSH channel for status lines and assistant
// text deltas; the polled /api/chat/activity feed remains the durable
// fallback. Auth: dashboard session cookie → user phone; the bot side is
// reached with the shared internal secret, never exposed to the browser.
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BOT_INTERNAL_URL = process.env.BOT_INTERNAL_URL || "http://127.0.0.1:43100";

export async function GET(req: Request) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) {
    return Response.json({ ok: false, error: "not signed in" }, { status: 401 });
  }
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    return Response.json({ ok: false, error: "not configured" }, { status: 503 });
  }

  const upstreamUrl = new URL(`${BOT_INTERNAL_URL}/webhook/internal/run-events`);
  upstreamUrl.searchParams.set("user_phone", userPhone);

  const lastEventId = req.headers.get("last-event-id");
  let upstream: globalThis.Response;
  try {
    upstream = await fetch(upstreamUrl, {
      headers: {
        "x-internal-secret": secret,
        "x-forwarded-proto": "https",
        ...(lastEventId ? { "last-event-id": lastEventId } : {}),
      },
      signal: req.signal,
    });
  } catch {
    return Response.json({ ok: false, error: "stream unavailable" }, { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    return Response.json({ ok: false, error: "stream unavailable" }, { status: 502 });
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
