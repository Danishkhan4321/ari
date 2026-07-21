// dashboard/app/api/events/route.ts
// GET — user-scoped Server-Sent Events stream of product-data invalidations
// (entity_change_events, written by the bot after every successful agent
// mutation). Open pages subscribe via lib/use-entity-events.ts and refetch
// when an event names an entity they display. Same transport pattern as
// /api/chat/activity (poll + Last-Event-ID resume), but without a session
// scope: a mutation from any chat session or WhatsApp should refresh the UI.
import { query } from "@/lib/db";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type EntityEventRow = {
  id: number;
  entities: string[];
  tool_name: string | null;
  created_at: string;
};

export async function GET(req: Request) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) {
    return Response.json({ ok: false, error: "not signed in" }, { status: 401 });
  }

  const encoder = new TextEncoder();
  const lastEventId = req.headers.get("last-event-id");
  const headerCursor = Number.parseInt(lastEventId || "0", 10);
  let cursor = Number.isFinite(headerCursor) ? headerCursor : 0;
  if (!lastEventId) {
    try {
      const latest = await query<{ id: string | number }>(
        `SELECT COALESCE(MAX(id), 0) AS id FROM entity_change_events WHERE user_phone = $1`,
        [userPhone],
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
          const rows = (await query<EntityEventRow>(
            `SELECT id, entities, tool_name, created_at
               FROM entity_change_events
              WHERE user_phone = $1
                AND id > $2
                AND created_at > NOW() - INTERVAL '30 minutes'
              ORDER BY id ASC
              LIMIT 100`,
            [userPhone, cursor],
          )).rows;
          for (const row of rows) {
            cursor = Math.max(cursor, Number(row.id));
            enqueue(`id: ${row.id}\nevent: entity.changed\ndata: ${JSON.stringify(row)}\n\n`);
          }
        } catch (error) {
          // 42P01: the bot has not created the table yet (no mutation ever
          // happened). Keep the stream alive; it recovers on the next poll.
          const code = (error as { code?: string })?.code;
          if (code !== "42P01") enqueue(`event: unavailable\ndata: {}\n\n`);
        } finally {
          polling = false;
        }
      };

      enqueue(": connected\n\n");
      void poll();
      pollTimer = setInterval(() => void poll(), 2000);
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
