import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { chatSessionAttachmentStore } from "@/lib/chat-session-attachment-store";
import { attachmentResponseHeaders } from "@/lib/chat-attachments";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
  const attachment = await chatSessionAttachmentStore.getOwned(userPhone, params.id);
  if (!attachment) return NextResponse.json({ ok: false, error: "Attachment not found." }, { status: 404 });
  try {
    const data = await readFile(attachment.localPath);
    return new Response(data, {
      headers: attachmentResponseHeaders(attachment.mimeType, attachment.fileName),
    });
  } catch {
    return NextResponse.json({ ok: false, error: "Attachment is no longer available locally." }, { status: 410 });
  }
}
