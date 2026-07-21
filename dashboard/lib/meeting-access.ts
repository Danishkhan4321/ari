import { query } from "@/lib/db";
import { meetingIdentityCandidates } from "@/lib/meeting-phone";

export { meetingIdentityCandidates } from "@/lib/meeting-phone";

export type MeetingAccessRow = {
  user_phone: string;
  team_admin_phone: string | null;
};

export type MeetingAccessResolution =
  | { ok: true; meetingId: number; ownerPhone: string }
  | { ok: false; status: 400 | 404 };

export function parseMeetingAccessId(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= 2_147_483_647 ? parsed : null;
}

export function canViewerAccessMeeting(viewerPhone: string, meeting: MeetingAccessRow): boolean {
  const candidates = new Set(meetingIdentityCandidates(viewerPhone));
  return candidates.has(meeting.user_phone) || (
    typeof meeting.team_admin_phone === "string" && candidates.has(meeting.team_admin_phone)
  );
}

export async function resolveMeetingAccess(
  rawMeetingId: string,
  viewerPhone: string,
): Promise<MeetingAccessResolution> {
  const meetingId = parseMeetingAccessId(rawMeetingId);
  if (!meetingId) return { ok: false, status: 400 };
  const candidates = meetingIdentityCandidates(viewerPhone);
  if (candidates.length === 0) return { ok: false, status: 404 };

  const result = await query<{ user_phone: string }>(
    `SELECT user_phone
       FROM meeting_recordings
      WHERE id = $1
        AND (user_phone = ANY($2::text[]) OR team_admin_phone = ANY($2::text[]))
      LIMIT 1`,
    [meetingId, candidates],
  );
  const ownerPhone = result.rows[0]?.user_phone;
  return typeof ownerPhone === "string" && ownerPhone.length > 0
    ? { ok: true, meetingId, ownerPhone }
    : { ok: false, status: 404 };
}
