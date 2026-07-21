// dashboard/app/api/chat/send/route.ts
// POST { text: "…" } → routes the user's message through the bot's
// processing pipeline and returns the bot's reply text.
//
// The bot writes both the user's message and the assistant's reply to
// conversation_history, so the polling endpoint will pick them up too.
// The reply text is returned here purely for the client to render
// optimistically without waiting for the next poll tick.
import { NextResponse } from "next/server";
import { sendThroughBot } from "@/lib/bot-bridge";
import { getCurrentUserPhone } from "@/lib/session";
import { validateChatAttachments } from "@/lib/chat-attachments";
import {
  discardStagedChatAttachments,
  stageChatAttachment,
  type StagedChatAttachment,
} from "@/lib/local-attachment-store";
import { chatSessionStore, ChatSessionError, isChatSessionId } from "@/lib/chat-session-store";
import { chatSessionAttachmentStore } from "@/lib/chat-session-attachment-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) {
    return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
  }
  const contentType = req.headers.get("content-type") || "";
  let text = "";
  let runId = "";
  let sessionId = "";
  let clientMessageId = "";
  let files: File[] = [];
  try {
    if (contentType.includes("application/json")) {
      const body = (await req.json()) as { text?: string; runId?: string; sessionId?: string; clientMessageId?: string };
      text = (body.text ?? "").trim();
      runId = String(body.runId || "");
      sessionId = String(body.sessionId || "");
      clientMessageId = String(body.clientMessageId || "");
    } else {
      const formData = await req.formData();
      text = String(formData.get("text") || "").trim();
      runId = String(formData.get("runId") || "");
      sessionId = String(formData.get("sessionId") || "");
      clientMessageId = String(formData.get("clientMessageId") || "");
      files = formData.getAll("attachments").filter((value): value is File => value instanceof File);
    }
  } catch {
    return NextResponse.json({ ok: false, error: "invalid message" }, { status: 400 });
  }
  if (!text && files.length === 0) {
    return NextResponse.json({ ok: false, error: "Add a message or a document." }, { status: 400 });
  }
  if (text.length > 5000) {
    return NextResponse.json({ ok: false, error: "message too long" }, { status: 400 });
  }
  if (runId && !/^[a-zA-Z0-9_-]{8,100}$/.test(runId)) {
    return NextResponse.json({ ok: false, error: "invalid run" }, { status: 400 });
  }
  if (!runId || !isChatSessionId(sessionId) || !isChatSessionId(clientMessageId)) {
    return NextResponse.json({ ok: false, error: "invalid session message" }, { status: 400 });
  }
  try {
    await chatSessionStore.requireOwnedSession(userPhone, sessionId);
  } catch (error) {
    const status = error instanceof ChatSessionError ? error.status : 500;
    return NextResponse.json({ ok: false, error: status === 500 ? "Could not verify the session." : error instanceof Error ? error.message : "invalid session" }, { status });
  }

  const attachmentError = validateChatAttachments(files);
  if (attachmentError) {
    return NextResponse.json({ ok: false, error: attachmentError }, { status: 400 });
  }

  let attachments: StagedChatAttachment[] = [];
  try {
    for (const file of files) attachments.push(await stageChatAttachment(userPhone, file));
  } catch {
    await discardStagedChatAttachments(attachments);
    return NextResponse.json({ ok: false, error: "A document could not be prepared locally. Please try again." }, { status: 500 });
  }

  const fallbackText = attachments.length === 0
    ? text
    : text || `Attached ${attachments.length === 1 ? "a document" : `${attachments.length} documents`}.`;
  try {
    await chatSessionAttachmentStore.save(userPhone, sessionId, clientMessageId, attachments);
  } catch {
    // save() persists files one at a time. Roll back any earlier rows/files
    // from this same message if a later attachment fails.
    await chatSessionAttachmentStore.discardForMessage(userPhone, sessionId, clientMessageId).catch(() => {});
    await discardStagedChatAttachments(attachments);
    return NextResponse.json({ ok: false, error: "A document could not be saved to this session." }, { status: 500 });
  }
  const result = await sendThroughBot(userPhone, fallbackText, attachments, { runId, sessionId, clientMessageId });
  if (!result.ok) {
    await chatSessionAttachmentStore.discardForMessage(userPhone, sessionId, clientMessageId).catch(() => {});
    await discardStagedChatAttachments(attachments);
    return NextResponse.json({ ok: false, error: result.error }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
