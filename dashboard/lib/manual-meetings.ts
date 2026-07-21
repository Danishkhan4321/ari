export type TranscriptSegment = {
  speakerId: string;
  startMs: number;
  endMs: number;
  text: string;
  confidence?: number | null;
};

export type SuggestedTask = {
  title: string;
  suggestedAssigneeSpeakerId: string | null;
  suggestedAssignee?: string | null;
  reason: string;
};

export type MeetingTaskLink = {
  suggestionIndex: number;
  taskId: number;
  status: "created" | "failed";
};

export type ManualMeeting = {
  id: number;
  title: string;
  status: string;
  created_at?: string | null;
  updated_at?: string | null;
  created_task_count?: number;
  processing_stage?: string | null;
  processing_error_message?: string | null;
  source_type?: string | null;
  duration_seconds: number | null;
  meeting_platform: string | null;
  capture_platform?: string | null;
  summary: string | null;
  transcript: string | null;
  action_items: string | null;
  decisions: string | null;
  mom: string | null;
  topics: string | null;
  attendees: string | null;
  recording_url: string | null;
  recording_object_key?: string | null;
  recording_mime_type?: string | null;
  canonical_transcript_segments?: TranscriptSegment[] | null;
  canonical_report?: Record<string, unknown> | null;
  speaker_names?: Record<string, string> | null;
  suggested_tasks?: SuggestedTask[] | null;
  report_markdown?: string | null;
};

export function parseJsonValue<T>(value: T | string | null | undefined, fallback: T): T {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export function meetingStageLabel(stage: string | null | undefined) {
  const labels: Record<string, string> = {
    captured: "Captured",
    uploading: "Uploading recording",
    transcribing: "Transcribing speakers",
    generating_report: "Generating report",
    completed: "Ready",
    failed: "Needs attention",
    cancelled: "Cancelled",
  };
  return labels[stage || ""] || stage || "Processing";
}

export function isMeetingTerminal(stage: string | null | undefined) {
  return stage === "completed" || stage === "failed" || stage === "cancelled";
}

export function filterMeetings(meetings: ManualMeeting[], query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return meetings;

  return meetings.filter((meeting) => [
    meeting.title,
    meeting.capture_platform,
    meeting.meeting_platform,
    meeting.attendees,
    meeting.processing_stage,
    meeting.status,
  ].some((value) => value?.toLowerCase().includes(normalizedQuery)));
}

export async function desktopMeetingFetch(path: string, userPhone: string, init: RequestInit = {}) {
  const backend = process.env.BOT_INTERNAL_URL || process.env.APP_BASE_URL || "http://127.0.0.1:43100";
  const token = process.env.ARI_DESKTOP_INTERNAL_TOKEN;
  if (!token) throw Object.assign(new Error("Desktop meeting recording is not configured."), { status: 503 });
  return fetch(`${backend}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      ...init.headers,
      "x-ari-desktop-token": token,
      "x-ari-user-phone": userPhone,
    },
    signal: init.signal || AbortSignal.timeout(30_000),
  });
}

export async function safeDesktopResponse(response: Response) {
  const body = await response.json().catch(() => ({ ok: false, error: "Invalid meeting service response." }));
  return { body, status: response.status };
}
