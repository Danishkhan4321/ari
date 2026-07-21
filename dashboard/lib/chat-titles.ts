import { query } from "@/lib/db";

const MAX_CHAT_TITLE_LENGTH = 120;
let tableReady = false;

export function normalizeChatTitle(value: string): string | null {
  const title = value.trim().replace(/\s+/g, " ");
  return title.length > 0 && title.length <= MAX_CHAT_TITLE_LENGTH ? title : null;
}

export async function ensureChatTitleTable(): Promise<void> {
  if (tableReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS ari_chat_titles (
      user_phone TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      title VARCHAR(120) NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (user_phone, message_id)
    )
  `);
  tableReady = true;
}
