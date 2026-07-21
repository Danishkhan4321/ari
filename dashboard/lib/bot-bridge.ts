// dashboard/lib/bot-bridge.ts
// Server-to-server bridge between the dashboard and the bot.
//
// When a user sends a chat message from the dashboard, we POST it to a
// private endpoint on Ari (default 127.0.0.1:43100) so the message
// goes through the *same* webhook controller flow that processes a
// WhatsApp message — same intent detection, same handlers, same DB
// writes, same WhatsApp reply to the user's phone.
//
// The bridge is authenticated with a shared `INTERNAL_API_SECRET` env
// var (set on both surfaces). It's never exposed to the browser.
const BOT_INTERNAL_URL =
  process.env.BOT_INTERNAL_URL || "http://127.0.0.1:43100";

export type BotBridgeReply =
  | { ok: true }
  | { ok: false; error: string };

export type DashboardAttachment = {
  localPath: string;
  fileName: string;
  mimeType: string;
  size: number;
};

export type BotChatRequest = {
  runId: string;
  sessionId: string;
  clientMessageId: string;
};

export type BotInternalReply<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number };

export async function callBotInternal<T>(
  path: string,
  payload: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<BotInternalReply<T>> {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    console.error("[BotBridge] INTERNAL_API_SECRET is not configured");
    return { ok: false, error: "Ari's internal service is not configured correctly." };
  }

  try {
    const res = await fetch(`${BOT_INTERNAL_URL}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": secret,
        "x-forwarded-proto": "https",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("application/json")) {
      console.error(`[BotBridge] ${path} returned non-JSON HTTP ${res.status}`);
      return { ok: false, status: res.status, error: "Ari's internal service returned an invalid response." };
    }
    const body = await res.json() as T & { error?: unknown };
    if (!res.ok) {
      console.error(`[BotBridge] ${path} failed with HTTP ${res.status}`);
      const publicError = typeof body?.error === "string" && res.status < 500
        ? body.error
        : "Ari's internal service is temporarily unavailable.";
      return { ok: false, status: res.status, error: publicError };
    }
    return { ok: true, data: body };
  } catch (error) {
    const kind = error instanceof Error ? error.name : "unknown";
    console.error(`[BotBridge] ${path} request failed (${kind})`);
    return { ok: false, error: "Ari's internal service is temporarily unavailable." };
  }
}

export async function sendThroughBot(
  userPhone: string,
  text: string,
  attachments: DashboardAttachment[] = [],
  request: BotChatRequest,
): Promise<BotBridgeReply> {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    console.error("[BotBridge] INTERNAL_API_SECRET is not configured");
    return { ok: false, error: "Ari chat is not configured correctly. Please contact support." };
  }
  if (!userPhone || (!text.trim() && attachments.length === 0)) {
    return { ok: false, error: "missing phone, message, or attachment" };
  }
  try {
    const res = await fetch(`${BOT_INTERNAL_URL}/webhook/internal/dashboard-message`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": secret,
        "x-forwarded-proto": "https",
      },
      body: JSON.stringify({
        user_phone: userPhone,
        text,
        attachments,
        run_id: request.runId,
        session_id: request.sessionId,
        client_message_id: request.clientMessageId,
      }),
      // Bot acks quickly; the actual LLM round-trip happens async and the
      // reply lands in conversation_history — the dashboard polls for it.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`[BotBridge] bot rejected dashboard message with HTTP ${res.status}`);
      if (res.status === 401 || res.status === 403 || res.status === 503) {
        return { ok: false, error: "Ari chat is not configured correctly. Please contact support." };
      }
      return { ok: false, error: "Ari chat is temporarily unavailable. Please try again shortly." };
    }
    return { ok: true };
  } catch (e) {
    const kind = e instanceof Error ? e.name : "unknown";
    console.error(`[BotBridge] dashboard message request failed (${kind})`);
    return { ok: false, error: "Ari chat is temporarily unavailable. Please try again shortly." };
  }
}

export type BotCancelReply =
  | { ok: true; stopped: true }
  | { ok: false; stopped: false; code?: string; error: string };

export async function cancelBotRun(userPhone: string, runId: string, sessionId: string): Promise<BotCancelReply> {
  const reply = await callBotInternal<{ ok: boolean; stopped?: boolean; code?: string }>(
    "/webhook/internal/dashboard-cancel",
    { user_phone: userPhone, run_id: runId, session_id: sessionId },
    10_000,
  );
  if (!reply.ok) return { ok: false, stopped: false, error: reply.error };
  // HTTP 200 alone is not proof of cancellation — the bot reports whether a
  // matching active run was actually aborted.
  if (reply.data?.ok !== true || reply.data?.stopped !== true) {
    return {
      ok: false,
      stopped: false,
      code: reply.data?.code || "not_found",
      error: "There was no matching active run to stop — it may have already finished.",
    };
  }
  return { ok: true, stopped: true };
}

// ─── notifyUserViaBot ────────────────────────────────────────────────────
// Reconstructed May 28 2026 after an accidental overwrite destroyed the
// original. Callers (e.g. board-task assignment notifications) use this to
// push a message to a user via the bot. It uses the direct notification
// endpoint so notification text is never interpreted as a user command.
//
// The original signature accepted { template, templateParams } for an
// outside-24h WhatsApp template fallback. The bot already applies its own
// template-fallback logic when free-form delivery is outside the 24h window,
// so the text is delivered either way. The opts are accepted for API
// compatibility; if you had richer client-driven template selection before,
// re-apply it from your canonical dashboard source.
export async function notifyUserViaBot(
  userPhone: string,
  text: string,
  opts?: { template?: string; templateParams?: string[] }
): Promise<BotBridgeReply> {
  const reply = await callBotInternal<{ ok: boolean; delivered?: boolean }>(
    "/webhook/internal/dashboard-notify",
    {
      recipient: userPhone,
      text,
      template: opts?.template,
      template_params: opts?.templateParams || [],
    },
    20_000,
  );
  return reply.ok ? { ok: true } : { ok: false, error: reply.error };
}
