import { createHash, randomBytes } from "crypto";
import { query } from "./db";

type QueryResult<T> = { rows: T[] };
type QueryLike = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<QueryResult<T>>;

const TICKET_TTL_MS = 5 * 60 * 1000;
let tableReady = false;

function ticketHash(ticket: string): string {
  return createHash("sha256").update(ticket, "utf8").digest("hex");
}

async function ensureTable(queryFn: QueryLike): Promise<void> {
  if (tableReady) return;
  await queryFn(`
    CREATE TABLE IF NOT EXISTS ari_desktop_auth_tickets (
      token_hash CHAR(64) PRIMARY KEY,
      user_phone VARCHAR(50) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);
  await queryFn(`CREATE INDEX IF NOT EXISTS idx_ari_desktop_auth_tickets_expiry ON ari_desktop_auth_tickets(expires_at)`);
  tableReady = true;
}

export async function createDesktopAuthTicket(
  userPhone: string,
  queryFn: QueryLike = query as QueryLike,
): Promise<string> {
  await ensureTable(queryFn);
  const ticket = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + TICKET_TTL_MS);
  await queryFn(
    `INSERT INTO ari_desktop_auth_tickets (token_hash, user_phone, expires_at) VALUES ($1, $2, $3)`,
    [ticketHash(ticket), userPhone, expiresAt.toISOString()],
  );
  void queryFn(`DELETE FROM ari_desktop_auth_tickets WHERE expires_at < NOW()`).catch(() => {});
  return ticket;
}

export async function consumeDesktopAuthTicket(
  ticket: string,
  queryFn: QueryLike = query as QueryLike,
): Promise<string | null> {
  if (!/^[a-f0-9]{64}$/i.test(ticket)) return null;
  await ensureTable(queryFn);
  const result = await queryFn<{ user_phone: string }>(
    `DELETE FROM ari_desktop_auth_tickets
      WHERE token_hash = $1 AND expires_at > NOW()
      RETURNING user_phone`,
    [ticketHash(ticket)],
  );
  return result.rows[0]?.user_phone || null;
}

export function resetDesktopAuthTableForTests(): void {
  tableReady = false;
}
