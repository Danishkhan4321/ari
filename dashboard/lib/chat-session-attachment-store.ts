import { randomUUID } from "node:crypto";
import { copyFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { query } from "@/lib/db";
import type { StagedChatAttachment } from "@/lib/local-attachment-store";

type QueryLike = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

export type SessionAttachment = {
  id: string;
  clientMessageId: string;
  fileName: string;
  mimeType: string;
  localPath: string;
  size: number;
};

export function createChatSessionAttachmentStore(queryFn: QueryLike = query as QueryLike) {
  async function save(
    userPhone: string,
    sessionId: string,
    clientMessageId: string,
    attachments: StagedChatAttachment[],
  ): Promise<SessionAttachment[]> {
    const saved: SessionAttachment[] = [];
    for (const attachment of attachments) {
      const id = randomUUID();
      const root = path.resolve(process.env.ARI_SESSION_ATTACHMENT_DIR || path.join(process.cwd(), ".ari-session-attachments"));
      const sessionDirectory = path.join(root, sessionId);
      const extension = path.extname(attachment.fileName).slice(0, 12);
      const persistentPath = path.join(sessionDirectory, `${id}${extension}`);
      await mkdir(sessionDirectory, { recursive: true });
      await copyFile(attachment.localPath, persistentPath);
      try {
        await queryFn(
          `INSERT INTO ari_chat_attachments
             (id, user_phone, session_id, client_message_id, file_name, mime_type, local_path, size_bytes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [id, userPhone, sessionId, clientMessageId, attachment.fileName, attachment.mimeType, persistentPath, attachment.size],
        );
      } catch (error) {
        await unlink(persistentPath).catch(() => {});
        throw error;
      }
      saved.push({ id, clientMessageId, fileName: attachment.fileName, mimeType: attachment.mimeType, localPath: persistentPath, size: attachment.size });
    }
    return saved;
  }

  async function listForSession(userPhone: string, sessionId: string): Promise<SessionAttachment[]> {
    const result = await queryFn(
      `SELECT id, client_message_id, file_name, mime_type, local_path, size_bytes
         FROM ari_chat_attachments
        WHERE user_phone = $1 AND session_id = $2
        ORDER BY created_at ASC`,
      [userPhone, sessionId],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      clientMessageId: String(row.client_message_id),
      fileName: String(row.file_name),
      mimeType: String(row.mime_type),
      localPath: String(row.local_path),
      size: Number(row.size_bytes),
    }));
  }

  async function getOwned(userPhone: string, id: string): Promise<SessionAttachment | null> {
    const result = await queryFn(
      `SELECT id, client_message_id, file_name, mime_type, local_path, size_bytes
         FROM ari_chat_attachments
        WHERE user_phone = $1 AND id = $2`,
      [userPhone, id],
    );
    const row = result.rows[0];
    return row ? {
      id: String(row.id),
      clientMessageId: String(row.client_message_id),
      fileName: String(row.file_name),
      mimeType: String(row.mime_type),
      localPath: String(row.local_path),
      size: Number(row.size_bytes),
    } : null;
  }

  async function discardForMessage(userPhone: string, sessionId: string, clientMessageId: string): Promise<void> {
    const rows = await queryFn(
      `DELETE FROM ari_chat_attachments
        WHERE user_phone = $1 AND session_id = $2 AND client_message_id = $3
        RETURNING local_path`,
      [userPhone, sessionId, clientMessageId],
    );
    await Promise.all(rows.rows.map((row) => unlink(String(row.local_path)).catch(() => {})));
  }

  return { save, listForSession, getOwned, discardForMessage };
}

export const chatSessionAttachmentStore = createChatSessionAttachmentStore();
