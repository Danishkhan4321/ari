// dashboard/app/api/notes/list/route.ts
// GET ?q=… — returns notes, reading list items, and KB entries.
import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const term = `%${q}%`;
  // 42P01 = the bot has not lazily created this table yet — genuinely empty.
  // Every other database failure surfaces as 503 instead of a fake empty list.
  const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch (error) {
      if ((error as { code?: string })?.code === "42P01") return fallback;
      throw error;
    }
  };
  try {
  const [notes, reading, kb] = await Promise.all([
    safe(async () => (await query(
      q ? `SELECT id, topic, content, source FROM notes
            WHERE user_phone = $1 AND (LOWER(COALESCE(topic,'')) LIKE $2 OR LOWER(COALESCE(content,'')) LIKE $2)
            ORDER BY id DESC LIMIT 200`
        : `SELECT id, topic, content, source FROM notes WHERE user_phone = $1 ORDER BY id DESC LIMIT 200`,
      q ? [userPhone, term] : [userPhone]
    )).rows, []),
    safe(async () => (await query(
      q ? `SELECT id, url, title, summary, category, status FROM reading_list
            WHERE user_phone = $1 AND (LOWER(COALESCE(title,'')) LIKE $2 OR LOWER(COALESCE(summary,'')) LIKE $2)
            ORDER BY id DESC LIMIT 200`
        : `SELECT id, url, title, summary, category, status FROM reading_list WHERE user_phone = $1 ORDER BY id DESC LIMIT 200`,
      q ? [userPhone, term] : [userPhone]
    )).rows, []),
    safe(async () => (await query(
      q ? `SELECT id, title, content, category, tags, created_by_name FROM knowledge_base
            WHERE team_admin_phone = $1 AND (LOWER(COALESCE(title,'')) LIKE $2 OR LOWER(COALESCE(content,'')) LIKE $2)
            ORDER BY id DESC LIMIT 200`
        : `SELECT id, title, content, category, tags, created_by_name FROM knowledge_base WHERE team_admin_phone = $1 ORDER BY id DESC LIMIT 200`,
      q ? [userPhone, term] : [userPhone]
    )).rows, []),
  ]);
  return NextResponse.json({ ok: true, notes, reading, kb });
  } catch (error) {
    const correlationId = crypto.randomUUID();
    console.error(`[notes/list] ${correlationId} database failure:`, error);
    return NextResponse.json({ ok: false, error: "database_unavailable", correlationId }, { status: 503 });
  }
}
