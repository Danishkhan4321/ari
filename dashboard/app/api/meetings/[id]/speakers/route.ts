import { NextResponse } from "next/server";
import { getCurrentUserPhone } from "@/lib/session";
import { desktopMeetingFetch, safeDesktopResponse } from "@/lib/manual-meetings";
import { resolveMeetingAccess } from "@/lib/meeting-access";

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const phone = await getCurrentUserPhone();
  if (!phone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
  const payload = await request.json().catch(() => null) as { speakerId?: string; name?: string } | null;
  if (!/^[A-Z]+$/.test(payload?.speakerId || "")) {
    return NextResponse.json({ ok: false, error: "invalid speaker" }, { status: 400 });
  }
  try {
    const access = await resolveMeetingAccess(params.id, phone);
    if (!access.ok) {
      return NextResponse.json(
        { ok: false, error: access.status === 400 ? "invalid id" : "Meeting not found." },
        { status: access.status },
      );
    }
    const { body, status } = await safeDesktopResponse(await desktopMeetingFetch(
      `/internal/desktop/meetings/${access.meetingId}/speakers/${payload!.speakerId}`,
      access.ownerPhone,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: payload?.name }) },
    ));
    return NextResponse.json(body, { status });
  } catch (error) {
    return NextResponse.json({ ok: false, error: "Speaker rename is unavailable." }, { status: Number((error as { status?: number }).status) || 502 });
  }
}
