// dashboard/app/api/meetings/list/route.ts
// GET /api/meetings/list — meeting recordings owned by the user OR
// where the user is the team admin (so team meetings show up too).
import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { meetingIdentityCandidates } from "@/lib/meeting-phone";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";

export type MeetingRow = {
  id: number;
  title: string;
  status: string;
  duration_seconds: number | null;
  meeting_platform: string | null;
  summary: string | null;
  transcript: string | null;
  action_items: string | null;
  decisions: string | null;
  mom: string | null;
  topics: string | null;
  share_token: string | null;
  attendees: string | null;
  recording_url: string | null;
  source_type: string | null;
  processing_stage: string | null;
  processing_error_message: string | null;
  recording_object_key: string | null;
  recording_mime_type: string | null;
  canonical_transcript_segments: unknown[] | null;
  canonical_report: Record<string, unknown> | null;
  speaker_names: Record<string, string> | null;
  suggested_tasks: unknown[] | null;
  report_markdown: string | null;
  capture_platform: string | null;
  created_at: string | null;
  updated_at: string | null;
  created_task_count: number;
};

export async function GET() {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
  const identityCandidates = meetingIdentityCandidates(userPhone);

  try {
    const r = await query<MeetingRow>(
      `SELECT mr.id, mr.title, mr.status, mr.duration_seconds, mr.meeting_platform,
              mr.summary, mr.transcript, mr.action_items, mr.decisions, mr.mom, mr.topics,
              mr.share_token, mr.attendees, mr.recording_url, mr.source_type,
              mr.processing_stage, mr.processing_error_message, mr.recording_object_key,
              mr.recording_mime_type, mr.canonical_transcript_segments, mr.canonical_report,
              mr.speaker_names, mr.suggested_tasks, mr.report_markdown, mr.capture_platform,
              mr.created_at, mr.updated_at,
              COALESCE(task_counts.created_task_count, 0)::int AS created_task_count
         FROM meeting_recordings mr
         LEFT JOIN (
           SELECT meeting_id, COUNT(*)::int AS created_task_count
             FROM meeting_task_links
            GROUP BY meeting_id
         ) task_counts ON task_counts.meeting_id = mr.id
        WHERE mr.user_phone = ANY($1::text[]) OR mr.team_admin_phone = ANY($1::text[])
        ORDER BY mr.id DESC
        LIMIT 100`,
      [identityCandidates]
    );
    return NextResponse.json({ ok: true, meetings: r.rows });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Unable to load meetings right now. Please try again." },
      { status: 500 }
    );
  }
}
