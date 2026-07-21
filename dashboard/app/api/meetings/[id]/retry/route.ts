import { NextResponse } from "next/server";
import { getCurrentUserPhone } from "@/lib/session";
import { desktopMeetingFetch, safeDesktopResponse } from "@/lib/manual-meetings";
import { resolveMeetingAccess } from "@/lib/meeting-access";

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const phone = await getCurrentUserPhone();
  if (!phone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
  try {
    const access = await resolveMeetingAccess(params.id, phone);
    if (!access.ok) {
      return NextResponse.json(
        { ok: false, error: access.status === 400 ? "invalid id" : "Meeting not found." },
        { status: access.status },
      );
    }
    const { body, status } = await safeDesktopResponse(await desktopMeetingFetch(
      `/internal/desktop/meetings/${access.meetingId}/retry`,
      access.ownerPhone,
      { method: "POST" },
    ));
    return NextResponse.json(body, { status });
  } catch (error) {
    return NextResponse.json({ ok: false, error: "Meeting retry is unavailable." }, { status: Number((error as { status?: number }).status) || 502 });
  }
}
