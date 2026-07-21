// dashboard/app/api/team/[name]/chats/[chatId]/send/route.ts
//
// POST — current user sends a message in a chat thread.
//        Body: { text }
//
// Flow (May 2026 update — used to fan out to WhatsApp immediately,
// but that was too noisy. Now WhatsApp is a *fallback*):
//   1. Verify caller is a member of the chat.
//   2. Persist the message (sent_via='dashboard').
//   3. Return immediately. Recipients see the message next time they
//      open the dashboard.
//   4. The bot's team-chat-unread-notifier cron checks every 5 minutes
//      for messages older than 45 min that the recipient hasn't read,
//      and sends a single consolidated WhatsApp notification then.
//      One notification per (chat, member) per batch — never spam.
import { NextResponse } from "next/server";
import { getCurrentUserPhone } from "@/lib/session";
import { resolveTeamAdmin } from "@/lib/sprint";
import { recordMessage } from "@/lib/team-chat";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { name: string; chatId: string } }) {
  try {
    const userPhone = await getCurrentUserPhone();
    if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
    const teamName = decodeURIComponent(params.name);
    const adminPhone = await resolveTeamAdmin(teamName, userPhone);
    if (!adminPhone) return NextResponse.json({ ok: false, error: "team not found" }, { status: 404 });

    const chatId = Number(params.chatId);
    if (!Number.isInteger(chatId)) return NextResponse.json({ ok: false, error: "invalid chat id" }, { status: 400 });

    let body: { text?: string } = {};
    try { body = await req.json(); } catch { /* validate next */ }
    const text = String(body.text || "").trim();
    if (!text) return NextResponse.json({ ok: false, error: "text required" }, { status: 400 });
    if (text.length > 4000) return NextResponse.json({ ok: false, error: "text too long" }, { status: 400 });

    // Verify membership + pull chat meta in one go
    const access = await query<{ from_name: string | null }>(
      `SELECT (SELECT member_name FROM team_chat_members WHERE chat_id = c.id AND member_phone = $2 LIMIT 1) AS from_name
         FROM team_chats c
         JOIN team_chat_members m ON m.chat_id = c.id
        WHERE c.id = $1 AND c.team_admin_phone = $3 AND m.member_phone = $2`,
      [chatId, userPhone, adminPhone]
    );
    if (access.rows.length === 0) return NextResponse.json({ ok: false, error: "no access" }, { status: 403 });
    const fromName = access.rows[0].from_name;

    // Persist — and that's it. WhatsApp delivery is handled by the
    // unread-notifier cron job at the 45-minute threshold.
    const msg = await recordMessage(chatId, {
      fromPhone: userPhone,
      fromName,
      text,
      sentVia: "dashboard",
    });
    if (!msg) return NextResponse.json({ ok: false, error: "could not record message" }, { status: 500 });

    return NextResponse.json({ ok: true, message: msg });
  } catch {
    return NextResponse.json({ ok: false, error: "The team message could not be sent." }, { status: 500 });
  }
}
