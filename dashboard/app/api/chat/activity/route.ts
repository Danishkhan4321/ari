import { query } from "@/lib/db";
import { getCurrentUserPhone } from "@/lib/session";
import { chatSessionStore, ChatSessionError } from "@/lib/chat-session-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type EventRow = {
  id: number;
  run_id: string;
  event_type: string;
  step: number | null;
  tool_name: string | null;
  summary: string | null;
  created_at: string;
};

export async function GET(req: Request) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) {
    return Response.json({ ok: false, error: "not signed in" }, { status: 401 });
  }
  const sessionId = new URL(req.url).searchParams.get("sessionId") || "";
  try {
    await chatSessionStore.requireOwnedSession(userPhone, sessionId);
  } catch (error) {
    const status = error instanceof ChatSessionError ? error.status : 500;
    return Response.json({ ok: false, error: "invalid session" }, { status });
  }

  const encoder = new TextEncoder();
  const lastEventId = req.headers.get("last-event-id");
  const headerCursor = Number.parseInt(lastEventId || "0", 10);
  let cursor = Number.isFinite(headerCursor) ? headerCursor : 0;
  if (!lastEventId) {
    try {
      const latest = await query<{ id: string | number }>(
        `SELECT COALESCE(MAX(events.id), 0) AS id
           FROM agent_run_events events
           JOIN agent_runs runs ON runs.id = events.run_id
          WHERE events.user_phone = $1 AND runs.session_id = $2`,
        [userPhone, sessionId],
      );
      cursor = Number(latest.rows[0]?.id || 0);
    } catch {
      cursor = 0;
    }
  }
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let polling = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enqueue = (value: string) => {
        if (!closed) controller.enqueue(encoder.encode(value));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        if (pollTimer) clearInterval(pollTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        try { controller.close(); } catch { /* connection already closed */ }
      };
      const poll = async () => {
        if (closed || polling) return;
        polling = true;
        try {
          const rows = (await query<EventRow>(
            `SELECT events.id, events.run_id, events.event_type, events.step, events.tool_name, events.summary, events.created_at
               FROM agent_run_events events
               JOIN agent_runs runs ON runs.id = events.run_id
              WHERE events.user_phone = $1
                AND runs.session_id = $2
                AND events.id > $3
                AND events.created_at > NOW() - INTERVAL '30 minutes'
              ORDER BY events.id ASC
              LIMIT 100`,
            [userPhone, sessionId, cursor],
          )).rows;

          for (const row of rows) {
            cursor = Math.max(cursor, Number(row.id));
            enqueue(`id: ${row.id}\nevent: activity\ndata: ${JSON.stringify(row)}\n\n`);
          }
        } catch (error) {
          // During a fresh local setup the migration may not have run yet.
          // Keep the stream alive; the next poll will recover automatically.
          const code = (error as { code?: string })?.code;
          if (code !== "42P01") enqueue(`event: unavailable\ndata: {}\n\n`);
        } finally {
          polling = false;
        }
      };

      enqueue(": connected\n\n");
      void poll();
      pollTimer = setInterval(() => void poll(), 1000);
      heartbeatTimer = setInterval(() => enqueue(": keep-alive\n\n"), 15000);
      req.signal.addEventListener("abort", close, { once: true });
    },
    cancel() {
      closed = true;
      if (pollTimer) clearInterval(pollTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
