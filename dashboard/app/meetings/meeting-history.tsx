"use client";

import { meetingStageLabel, type ManualMeeting } from "@/lib/manual-meetings";

type MeetingHistoryProps = {
  meetings: ManualMeeting[];
  selectedId: number | null;
  query: string;
  onQueryChange: (query: string) => void;
  onSelect: (meetingId: number) => void;
  onRetry: () => void;
  loading: boolean;
  error: string | null;
  totalMeetings: number;
};

export function MeetingHistory({
  meetings,
  selectedId,
  query,
  onQueryChange,
  onSelect,
  onRetry,
  loading,
  error,
  totalMeetings,
}: MeetingHistoryProps) {
  return (
    <div className="min-w-0 bg-white lg:border-r lg:border-[#e5e3df]">
      <div className="border-b border-[#e5e3df] px-4 py-4 sm:px-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[13px] font-semibold tracking-[-0.015em] text-[#24211f]">Meeting history</h2>
          {!loading && <span className="text-[10px] tabular-nums text-[#85807a]">{totalMeetings}</span>}
        </div>
        <label className="relative mt-3 block">
          <span className="sr-only">Search meetings</span>
          <svg className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8a8681]" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="m12.5 12.5 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search meetings"
            className="h-9 w-full rounded-[5px] border border-[#d9d7d2] bg-[#faf9f5] pl-9 pr-3 text-[11.5px] text-[#24211f] outline-none placeholder:text-[#9a9690] focus:border-[#a98b75] focus:bg-white focus:ring-2 focus:ring-[#8c5a3c]/10"
          />
        </label>
      </div>

      {error && (
        <div className="flex items-center justify-between gap-3 border-b border-[#ecd5cd] bg-[#fff8f5] px-5 py-3 text-[11px] leading-5 text-[#963f2f]" role="alert">
          <span>{error} {totalMeetings > 0 && "Showing the most recently loaded meetings."}</span>
          <button type="button" onClick={onRetry} className="shrink-0 font-medium underline underline-offset-2">Retry</button>
        </div>
      )}

      <div className="max-h-[620px] overflow-y-auto">
        {loading ? (
          <HistoryState title="Loading meetings…" body="Your recordings and reports will appear here." />
        ) : error && totalMeetings === 0 ? (
          <HistoryState title="Meetings unavailable" body="Retry to load your meeting history." action={<button type="button" onClick={onRetry} className="crm-button mt-4">Retry</button>} />
        ) : totalMeetings === 0 ? (
          <HistoryState title="No meetings yet" body="Record a conversation above to create your first meeting report." />
        ) : meetings.length === 0 ? (
          <HistoryState title="No meetings match your search" body="Try a title, platform, attendee, or status." />
        ) : (
          <ul className="divide-y divide-[#eceae6]">
            {meetings.map((meeting) => {
              const selected = meeting.id === selectedId;
              const platform = meeting.capture_platform || meeting.meeting_platform || (meeting.source_type === "manual_recording" ? "Desktop recording" : "Meeting");
              return (
                <li key={meeting.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(meeting.id)}
                    aria-current={selected ? "true" : undefined}
                    className={`block w-full border-l-[3px] px-4 py-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#8c5a3c]/30 ${selected ? "border-[#8c5a3c] bg-[#fbf6ed]" : "border-transparent bg-white hover:bg-[#faf9f5]"}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="min-w-0 truncate text-[12px] font-medium text-[#24211f]">{meeting.title || "Untitled meeting"}</span>
                      <span className="shrink-0 text-[9.5px] font-medium text-[#746b64]">{meetingStageLabel(meeting.processing_stage || meeting.status)}</span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-[#85807a]">
                      {meeting.created_at && <span>{formatDateTime(meeting.created_at)}</span>}
                      <span>{platform}</span>
                      {meeting.duration_seconds != null && <span>{formatDuration(meeting.duration_seconds)}</span>}
                    </div>
                    <div className="mt-2 text-[9.5px] text-[#77736f]">{meeting.created_task_count || 0} {(meeting.created_task_count || 0) === 1 ? "task" : "tasks"} created</div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function HistoryState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="px-5 py-12 text-center">
      <div className="text-[12px] font-medium text-[#4e4944]">{title}</div>
      <p className="mx-auto mt-1.5 max-w-[260px] text-[10.5px] leading-5 text-[#85807a]">{body}</p>
      {action}
    </div>
  );
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function formatDuration(seconds: number) {
  const totalMinutes = Math.max(0, Math.round(seconds / 60));
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours} hr ${minutes} min` : `${hours} hr`;
}
