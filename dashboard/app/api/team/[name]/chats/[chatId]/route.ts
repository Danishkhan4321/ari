// dashboard/app/api/team/[name]/chats/[chatId]/route.ts
//
// GET — fetch one chat: meta, members, messages. Also marks read.
import { NextResponse } from "next/server";
import { getCurrentUserPhone } from "@/lib/session";
import { resolveTeamAdmin } from "@/lib/sprint";
import { getChat } from "@/lib/team-chat";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { name: string; chatId: string } }) {
  try {
    const userPhone = await getCurrentUserPhone();
    if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
    const teamName = decodeURIComponent(params.name);
    const adminPhone = await resolveTeamAdmin(teamName, userPhone);
    if (!adminPhone) return NextResponse.json({ ok: false, error: "team not found" }, { status: 404 });

    const chatId = Number(params.chatId);
    if (!Number.isInteger(chatId)) return NextResponse.json({ ok: false, error: "invalid chat id" }, { status: 400 });

    const data = await getChat(adminPhone, chatId, userPhone);
    if (!data) return NextResponse.json({ ok: false, error: "not found or no access" }, { status: 404 });
    return NextResponse.json({ ok: true, ...data, current_user_phone: userPhone });
  } catch {
    return NextResponse.json({ ok: false, error: "Could not load the team chat." }, { status: 500 });
  }
}
