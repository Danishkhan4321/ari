// dashboard/app/api/chat/messages/route.ts
// GET /api/chat/messages?since=<id> → returns conversation_history rows
// for the current user with id > since (or last 50 if no `since`).
//
// The dashboard chat page polls this every few seconds. Polling is
// intentional — keeps the bot side oblivious to the dashboard's
// existence (it just writes to conversation_history like always).
import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { conversationPhoneCandidates } from "@/lib/chat-phone";
import { chatSessionAttachmentStore } from "@/lib/chat-session-attachment-store";
import { ChatSessionError, chatSessionStore } from "@/lib/chat-session-store";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";

type Row = {
  id: number;
  role: string;
  content: string;
  created_at: string;
  client_message_id: string | null;
};

export async function GET(req: Request) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) {
    return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
  }
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId") || "";
  const sinceParam = url.searchParams.get("since");
  const since = sinceParam ? Number.parseInt(sinceParam, 10) : NaN;
  const [phone, normalizedPhone = phone] = conversationPhoneCandidates(userPhone);

  try {
    await chatSessionStore.requireOwnedSession(userPhone, sessionId);
    const rows = Number.isFinite(since)
      ? (await query<Row>(
          `SELECT history.id, history.role, history.content, history.created_at, history.client_message_id
             FROM conversation_history history
            WHERE (history.user_phone = $1 OR history.user_phone = $2)
              AND history.session_id = $3 AND history.id > $4
            ORDER BY history.id ASC
            LIMIT 200`,
          [phone, normalizedPhone, sessionId, since]
        )).rows
      : (await query<Row>(
          `SELECT history.id, history.role, history.content, history.created_at, history.client_message_id
             FROM conversation_history history
            WHERE (history.user_phone = $1 OR history.user_phone = $2)
              AND history.session_id = $3
            ORDER BY history.id DESC
            LIMIT 50`,
          [phone, normalizedPhone, sessionId]
        )).rows.reverse();
    const attachments = await chatSessionAttachmentStore.listForSession(userPhone, sessionId);
    const byClientMessage = new Map<string, typeof attachments>();
    for (const attachment of attachments) {
      const list = byClientMessage.get(attachment.clientMessageId) || [];
      list.push(attachment);
      byClientMessage.set(attachment.clientMessageId, list);
    }
    const messages = rows.map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      created_at: row.created_at,
      clientMessageId: row.client_message_id,
      attachments: row.client_message_id
        ? (byClientMessage.get(row.client_message_id) || []).map((attachment) => ({
            id: attachment.id,
            fileName: attachment.fileName,
            mimeType: attachment.mimeType,
            url: `/api/chat/attachments/${attachment.id}`,
          }))
        : [],
    }));
    return NextResponse.json({ ok: true, messages });
  } catch (error) {
    if (error instanceof ChatSessionError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }
    return NextResponse.json({ ok: false, error: "Could not load chat messages." }, { status: 500 });
  }
}
