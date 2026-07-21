import { randomUUID } from "node:crypto";
import { query } from "@/lib/db";
import { ensureSessionLogFile } from "@/lib/chat-session-logs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TITLE_LENGTH = 120;

export type ChatSessionRecord = {
  id: string;
  title: string | null;
  isLegacy: boolean;
  createdAt: string;
  updatedAt: string;
};

type SessionRow = {
  id: string;
  title: string | null;
  is_legacy: boolean;
  created_at: string;
  updated_at: string;
};

type QueryLike = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

export class ChatSessionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function isChatSessionId(value: string): boolean {
  return UUID_RE.test(value);
}

export function normalizeSessionTitle(value: string): string | null {
  const title = value.trim().replace(/\s+/g, " ");
  return title.length > 0 && title.length <= MAX_TITLE_LENGTH ? title : null;
}

function mapSession(row: SessionRow): ChatSessionRecord {
  return {
    id: row.id,
    title: row.title,
    isLegacy: Boolean(row.is_legacy),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createChatSessionStore(options: {
  queryFn?: QueryLike;
  idFactory?: () => string;
  ensureLogFile?: (sessionId: string) => Promise<void>;
} = {}) {
  const queryFn = options.queryFn ?? (query as QueryLike);
  const idFactory = options.idFactory ?? randomUUID;
  const ensureLogFile = options.ensureLogFile ?? ensureSessionLogFile;

  async function listSessions(userPhone: string): Promise<ChatSessionRecord[]> {
    const result = await queryFn(
      `SELECT id, title, is_legacy, created_at, updated_at
         FROM ari_chat_sessions
        WHERE user_phone = $1 AND archived_at IS NULL
        ORDER BY updated_at DESC
        LIMIT 100`,
      [userPhone],
    );
    return result.rows.map((row) => mapSession(row as SessionRow));
  }

  async function createSession(userPhone: string): Promise<ChatSessionRecord> {
    const id = idFactory();
    const result = await queryFn(
      `INSERT INTO ari_chat_sessions (id, user_phone)
       VALUES ($1, $2)
       RETURNING id, title, is_legacy, created_at, updated_at`,
      [id, userPhone],
    );
    await ensureLogFile(id);
    return mapSession(result.rows[0] as SessionRow);
  }

  async function requireOwnedSession(userPhone: string, sessionId: string): Promise<ChatSessionRecord> {
    if (!isChatSessionId(sessionId)) throw new ChatSessionError("invalid session", 400);
    const result = await queryFn(
      `SELECT id, title, is_legacy, created_at, updated_at
         FROM ari_chat_sessions
        WHERE user_phone = $1 AND id = $2 AND archived_at IS NULL`,
      [userPhone, sessionId],
    );
    if (!result.rows[0]) throw new ChatSessionError("Session not found.", 404);
    return mapSession(result.rows[0] as SessionRow);
  }

  async function renameSession(userPhone: string, sessionId: string, rawTitle: string): Promise<string> {
    const title = normalizeSessionTitle(rawTitle);
    if (!title) throw new ChatSessionError("Enter a title of up to 120 characters.", 400);
    await requireOwnedSession(userPhone, sessionId);
    await queryFn(
      `UPDATE ari_chat_sessions SET title = $3, updated_at = NOW()
        WHERE user_phone = $1 AND id = $2`,
      [userPhone, sessionId, title],
    );
    return title;
  }

  return { listSessions, createSession, requireOwnedSession, renameSession };
}

export const chatSessionStore = createChatSessionStore();
