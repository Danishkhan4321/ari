import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { inferAttachmentMimeType, sanitizeAttachmentName } from "@/lib/chat-attachments";

export type StagedChatAttachment = {
  localPath: string;
  fileName: string;
  mimeType: string;
  size: number;
};

const ATTACHMENT_DIRECTORY = path.join(os.tmpdir(), "ari-desktop-attachments");

export async function stageChatAttachment(userPhone: string, file: File): Promise<StagedChatAttachment> {
  await mkdir(ATTACHMENT_DIRECTORY, { recursive: true });
  const safePhone = userPhone.replace(/\D/g, "") || "local-user";
  const fileName = sanitizeAttachmentName(file.name);
  const localPath = path.join(ATTACHMENT_DIRECTORY, `${safePhone}-${randomUUID()}`);
  await writeFile(localPath, Buffer.from(await file.arrayBuffer()), { flag: "wx" });
  return {
    localPath,
    fileName,
    mimeType: inferAttachmentMimeType(file.type, fileName),
    size: file.size,
  };
}

export async function discardStagedChatAttachments(attachments: StagedChatAttachment[]): Promise<void> {
  await Promise.all(attachments.map((attachment) => rm(attachment.localPath, { force: true }).catch(() => {})));
}
