"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ManualMeeting, parseJsonValue, TranscriptSegment, isMeetingTerminal, meetingStageLabel } from "@/lib/manual-meetings";
import { MeetingTasks } from "./meeting-tasks";

type ResultTab = "overview" | "transcript";
type MeetingOperation = "rename" | "retry" | "playback";
const SPEAKER_ID_PATTERN = /^[A-Z]+$/;

export function MeetingDetail({ meeting, onUpdated, onTasksChanged }: { meeting: ManualMeeting; onUpdated: (meeting: ManualMeeting) => void; onTasksChanged: () => void | Promise<void> }) {
  return <MeetingResult key={meeting.id} meeting={meeting} onUpdated={onUpdated} onTasksChanged={onTasksChanged} />;
}

function MeetingResult({ meeting, onUpdated, onTasksChanged }: { meeting: ManualMeeting; onUpdated: (meeting: ManualMeeting) => void; onTasksChanged: () => void | Promise<void> }) {
  const segments = parseSegments(meeting.canonical_transcript_segments);
  const speakerNames = parseSpeakerNames(meeting.speaker_names);
  const decisions = parseDecisionItems(meeting.decisions);
  const speakerIds = useMemo(() => [...new Set(segments.map((segment) => segment.speakerId))], [segments]);
  const requestGuardRef = useRef<ReturnType<typeof createMeetingRequestGuard> | null>(null);
  const dirtySpeakerIdsRef = useRef(new Set<string>());

  const [activeTab, setActiveTab] = useState<"overview" | "transcript">("overview");
  const [names, setNames] = useState<Record<string, string>>(speakerNames);
  const [busySpeaker, setBusySpeaker] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [playbackBusy, setPlaybackBusy] = useState(false);
  const [playback, setPlayback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setupMeetingRequestGuard(requestGuardRef), []);
  useEffect(() => {
    setNames((current) => mergeSpeakerNames(current, parseSpeakerNames(meeting.speaker_names), dirtySpeakerIdsRef.current));
  }, [meeting.speaker_names]);

  const stage = (meeting.processing_stage || meeting.status || "processing").toLowerCase();
  const completed = stage === "completed";
  const failed = stage === "failed";
  const cancelled = stage === "cancelled";
  const hasRecording = Boolean(meeting.recording_object_key || meeting.recording_url);
  const processingError = safeApiError(meeting.processing_error_message, "Meeting processing encountered an error.");

  async function rename(speakerId: string) {
    const meetingId = meeting.id;
    const requestGuard = requestGuardRef.current;
    if (!requestGuard) return;
    const request = requestGuard.begin("rename");
    setBusySpeaker(speakerId);
    setError(null);
    try {
      const response = await fetch(`/api/meetings/${meetingId}/speakers`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ speakerId, name: getSpeakerName(names, speakerId) }),
        signal: request.signal,
      });
      const body = await readResponse(response);
      if (!response.ok || !isRecord(body.meeting)) throw new Error(safeApiError(body.error, "Could not rename speaker."));
      if (request.accepts()) {
        const updatedMeeting = body.meeting as ManualMeeting;
        dirtySpeakerIdsRef.current.delete(speakerId);
        setNames((current) => mergeSpeakerNames(current, parseSpeakerNames(updatedMeeting.speaker_names ?? meeting.speaker_names), dirtySpeakerIdsRef.current));
        onUpdated(updatedMeeting);
      }
    } catch (cause) {
      if (request.accepts()) setError(errorMessage(cause, "Could not rename speaker."));
    } finally {
      if (request.accepts()) setBusySpeaker(null);
      request.finish();
    }
  }

  async function retry() {
    const meetingId = meeting.id;
    const requestGuard = requestGuardRef.current;
    if (!requestGuard) return;
    const request = requestGuard.begin("retry");
    setRetrying(true);
    setError(null);
    try {
      const response = await fetch(`/api/meetings/${meetingId}/retry`, { method: "POST", signal: request.signal });
      const body = await readResponse(response);
      if (!response.ok) throw new Error(safeApiError(body.error, "Could not retry meeting processing."));
      if (request.accepts()) {
        onUpdated({ ...meeting, processing_stage: normalizeRetryProcessingStage(body.processingStage), status: "processing" });
      }
    } catch (cause) {
      if (request.accepts()) setError(errorMessage(cause, "Could not retry meeting processing."));
    } finally {
      if (request.accepts()) setRetrying(false);
      request.finish();
    }
  }

  async function play() {
    const meetingId = meeting.id;
    const requestGuard = requestGuardRef.current;
    if (!requestGuard) return;
    const request = requestGuard.begin("playback");
    setPlaybackBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/meetings/${meetingId}/recording`, { cache: "no-store", signal: request.signal });
      const body = await readResponse(response);
      if (!response.ok || typeof body.url !== "string" || !body.url) {
        throw new Error(safeApiError(body.error, "Recording is unavailable."));
      }
      if (request.accepts()) setPlayback(body.url);
    } catch (cause) {
      if (request.accepts()) setError(errorMessage(cause, "Recording is unavailable."));
    } finally {
      if (request.accepts()) setPlaybackBusy(false);
      request.finish();
    }
  }

  return (
    <article className="min-w-0 text-[#24211f]" aria-label={`Meeting result for ${meeting.title || "Untitled meeting"}`}>
      <header className="border-b border-[#e5e3df] px-4 py-5 sm:px-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2 className="break-words text-[17px] font-semibold tracking-[-0.02em]">{meeting.title || "Untitled meeting"}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] text-[#68635e]" aria-label="Meeting completion metadata">
              <span className="font-medium text-[#625c57]">{meetingStageLabel(stage)}</span>
              {meeting.created_at && <span>{formatDateTime(meeting.created_at)}</span>}
              {meeting.duration_seconds != null && <span>{formatDuration(meeting.duration_seconds)}</span>}
              {(meeting.capture_platform || meeting.meeting_platform) && <span>{meeting.capture_platform || meeting.meeting_platform}</span>}
            </div>
          </div>
          {hasRecording && (
            <button
              type="button"
              onClick={play}
              disabled={playbackBusy}
              aria-label="Play meeting recording"
              className="inline-flex h-8 shrink-0 items-center justify-center gap-2 rounded-[5px] border border-[#cfcac4] bg-white px-3 text-[11px] font-medium text-[#4f4944] transition-colors hover:bg-[#faf9f5] disabled:cursor-wait disabled:opacity-60"
            >
              <span aria-hidden="true">&#9654;</span>
              {playbackBusy ? "Loading\u2026" : "Play"}
            </button>
          )}
        </div>
        {playback && <audio className="mt-4 w-full" src={playback} controls autoPlay aria-label="Meeting recording playback" />}
      </header>

      {!completed ? (
        <div className="px-4 py-5 sm:px-6">
          <div className={`border-l-2 px-3 py-1 ${failed ? "border-[#b85d4a]" : "border-[#9b765f]"}`} role="status" aria-live="polite">
            <div className="text-[12px] font-medium">{meetingStageLabel(stage)}</div>
            <p className="mt-1 text-[10.5px] leading-5 text-[#68635e]">
              {failed
                ? "Meeting processing did not finish."
                : cancelled
                  ? "Meeting processing was cancelled. No result was generated."
                  : "Ari is preparing the meeting result. This pane will update as processing advances."}
            </p>
            {failed && <p className="mt-2 text-[10.5px] leading-5 text-[#963f2f]">{processingError}</p>}
            {failed && (
              <button
                type="button"
                onClick={retry}
                disabled={retrying}
                className="mt-3 text-[11px] font-medium text-[#7c4d34] underline underline-offset-2 disabled:cursor-wait disabled:opacity-60"
              >
                {retrying ? "Retrying\u2026" : "Retry processing"}
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="border-b border-[#e5e3df] px-4 sm:px-6">
            <div className="flex gap-6" role="tablist" aria-label="Meeting result views">
              <TabButton tab="overview" activeTab={activeTab} onSelect={setActiveTab}>Overview</TabButton>
              <TabButton tab="transcript" activeTab={activeTab} onSelect={setActiveTab}>Transcript</TabButton>
            </div>
          </div>

          <div
            id="meeting-overview-panel"
            role="tabpanel"
            aria-labelledby="meeting-overview-tab"
            tabIndex={activeTab === "overview" ? 0 : -1}
            hidden={activeTab !== "overview"}
            className="space-y-7 px-4 py-6 outline-none sm:px-6"
          >
              <ResultSection title="Summary">
                <p className="whitespace-pre-wrap break-words text-[12px] leading-6 text-[#4f4944]">{meeting.summary || "No summary is available for this meeting."}</p>
              </ResultSection>

              <ResultSection title="Decisions">
                {decisions.length > 0 ? (
                  <ul className="space-y-3">
                    {decisions.map((decision, index) => (
                      <li key={`${decision}-${index}`} className="flex gap-3 text-[12px] leading-5 text-[#4f4944]">
                        <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#9b765f]" aria-hidden="true" />
                        <span className="break-words">{decision}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-[11px] text-[#68635e]">No decisions were detected.</p>}
              </ResultSection>

              <ResultSection title="Suggested tasks">
                <MeetingTasks meetingId={meeting.id} onTasksChanged={onTasksChanged} />
              </ResultSection>
          </div>

          <div
            id="meeting-transcript-panel"
            role="tabpanel"
            aria-labelledby="meeting-transcript-tab"
            tabIndex={activeTab === "transcript" ? 0 : -1}
            hidden={activeTab !== "transcript"}
            className="space-y-6 px-4 py-6 outline-none sm:px-6"
          >
              {speakerIds.length > 0 && (
                <section aria-labelledby="meeting-speakers-heading">
                  <h3 id="meeting-speakers-heading" className="text-[12px] font-semibold">Name speakers</h3>
                  <p className="mt-1 text-[10.5px] leading-5 text-[#68635e]">Naming speakers makes the transcript clearer and improves suggested task assignment.</p>
                  <div className="mt-3 grid gap-2 xl:grid-cols-2">
                    {speakerIds.map((speakerId) => (
                      <div key={speakerId} className="flex min-w-0 items-end gap-2 border-b border-[#e5e3df] pb-2">
                        <label className="min-w-0 flex-1 text-[9.5px] font-medium uppercase tracking-[0.08em] text-[#68635e]">
                          Speaker {speakerId}
                          <input
                            value={getSpeakerName(names, speakerId)}
                            onChange={(event) => {
                              dirtySpeakerIdsRef.current.add(speakerId);
                              setNames((current) => ({ ...current, [speakerId]: event.target.value }));
                            }}
                            placeholder={`Name Speaker ${speakerId}`}
                            maxLength={80}
                            disabled={busySpeaker === speakerId}
                            aria-busy={busySpeaker === speakerId}
                            className="mt-1 block h-8 w-full rounded-[4px] border border-[#d9d7d2] bg-white px-2 text-[11px] normal-case tracking-normal text-[#24211f] outline-none focus:border-[#9b765f] focus:ring-2 focus:ring-[#8c5a3c]/10 disabled:cursor-wait disabled:bg-[#f3f1ed] disabled:text-[#68635e]"
                          />
                        </label>
                        <button
                          type="button"
                          disabled={busySpeaker === speakerId || !getSpeakerName(names, speakerId).trim()}
                          onClick={() => rename(speakerId)}
                          className="h-8 px-1 text-[10.5px] font-medium text-[#7c4d34] disabled:opacity-40"
                        >
                          {busySpeaker === speakerId ? "Saving\u2026" : "Save"}
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <section aria-labelledby="meeting-transcript-heading">
                <h3 id="meeting-transcript-heading" className="text-[12px] font-semibold">Transcript</h3>
                <div className="mt-3 max-h-[460px] overflow-y-auto border-y border-[#e5e3df] py-1 pr-2" aria-label="Meeting transcript" tabIndex={0}>
                  {segments.length > 0 ? (
                    <ol className="divide-y divide-[#efede9]">
                      {segments.map((segment, index) => (
                        <li key={`${segment.speakerId}-${segment.startMs}-${index}`} className="grid gap-1 py-4 sm:grid-cols-[64px_minmax(0,1fr)] sm:gap-3">
                          <time className="text-[10px] tabular-nums text-[#68635e]">{formatTimestamp(segment.startMs)}</time>
                          <div className="min-w-0">
                            <div className="text-[10.5px] font-semibold text-[#625c57]">{getSpeakerName(names, segment.speakerId).trim() || `Speaker ${segment.speakerId}`}</div>
                            <p className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-6 text-[#4f4944]">{segment.text}</p>
                          </div>
                        </li>
                      ))}
                    </ol>
                  ) : meeting.transcript ? (
                    <p className="whitespace-pre-wrap break-words px-1 py-4 text-[12px] leading-6 text-[#4f4944]">{meeting.transcript}</p>
                  ) : (
                    <p className="px-1 py-4 text-[11px] text-[#68635e]">No transcript is available for this meeting.</p>
                  )}
                </div>
              </section>
          </div>
        </>
      )}

      {error && <div className="mx-4 mb-5 border-l-2 border-[#b85d4a] px-3 text-[10.5px] leading-5 text-[#963f2f] sm:mx-6" role="alert">{error}</div>}
    </article>
  );
}

function TabButton({ tab, activeTab, onSelect, children }: { tab: ResultTab; activeTab: ResultTab; onSelect: (tab: ResultTab) => void; children: React.ReactNode }) {
  const active = tab === activeTab;
  function moveFocus(nextTab: ResultTab) {
    onSelect(nextTab);
    requestAnimationFrame(() => document.getElementById(`meeting-${nextTab}-tab`)?.focus());
  }

  return (
    <button
      type="button"
      id={`meeting-${tab}-tab`}
      role="tab"
      aria-selected={active}
      aria-controls={`meeting-${tab}-panel`}
      tabIndex={active ? 0 : -1}
      onClick={() => onSelect(tab)}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          moveFocus(tab === "overview" ? "transcript" : "overview");
        } else if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          moveFocus(event.key === "Home" ? "overview" : "transcript");
        }
      }}
      className={`border-b-2 py-3 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8c5a3c]/20 ${active ? "border-[#8c5a3c] text-[#5f3c29]" : "border-transparent text-[#68635e] hover:text-[#4f4944]"}`}
    >{children}</button>
  );
}

function ResultSection({ title, children }: { title: string; children: React.ReactNode }) {
  const id = `meeting-${title.toLowerCase().replaceAll(" ", "-")}-heading`;
  return (
    <section aria-labelledby={id}>
      <h3 id={id} className="mb-3 text-[12px] font-semibold">{title}</h3>
      {children}
    </section>
  );
}

export function parseDecisionItems(value: string | null | undefined): string[] {
  if (!value?.trim()) return [];
  const parsed = parseJsonValue<unknown>(value, value);
  const source = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.decisions)
      ? parsed.decisions
      : [parsed];

  return source.flatMap((item) => {
    if (typeof item === "string") return item.trim() ? [item.trim()] : [];
    if (!isRecord(item)) return [];
    const text = [item.text, item.decision, item.title].find((candidate) => typeof candidate === "string" && candidate.trim());
    return typeof text === "string" ? [text.trim()] : [];
  });
}

export function normalizeRetryProcessingStage(value: unknown) {
  if (typeof value !== "string") return "transcribing";
  const stage = value.trim().toLowerCase();
  return stage && !isMeetingTerminal(stage) ? stage : "transcribing";
}

export function createMeetingRequestGuard() {
  let disposed = false;
  const active = new Map<MeetingOperation, AbortController>();

  return {
    begin(operation: MeetingOperation) {
      active.get(operation)?.abort();
      const controller = new AbortController();
      if (disposed) controller.abort();
      else active.set(operation, controller);

      return {
        signal: controller.signal,
        accepts: () => !disposed && !controller.signal.aborted && active.get(operation) === controller,
        finish: () => {
          if (active.get(operation) === controller) active.delete(operation);
        },
      };
    },
    dispose() {
      disposed = true;
      active.forEach((controller) => controller.abort());
      active.clear();
    },
  };
}

export function setupMeetingRequestGuard(ref: { current: ReturnType<typeof createMeetingRequestGuard> | null }) {
  const setupGuard = createMeetingRequestGuard();
  ref.current = setupGuard;
  return () => {
    setupGuard.dispose();
    if (ref.current === setupGuard) ref.current = null;
  };
}

function parseSegments(value: ManualMeeting["canonical_transcript_segments"]): TranscriptSegment[] {
  const parsed = parseJsonValue<unknown>(value, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    if (!isRecord(item) || typeof item.speakerId !== "string" || !SPEAKER_ID_PATTERN.test(item.speakerId) || typeof item.text !== "string") return [];
    return [{
      speakerId: item.speakerId,
      text: item.text,
      startMs: typeof item.startMs === "number" ? item.startMs : 0,
      endMs: typeof item.endMs === "number" ? item.endMs : 0,
      confidence: typeof item.confidence === "number" ? item.confidence : null,
    }];
  });
}

export function parseSpeakerNames(value: unknown): Record<string, string> {
  const parsed = parseJsonValue<unknown>(value, {});
  if (!isRecord(parsed)) return {};
  return Object.fromEntries(Object.keys(parsed).flatMap((speakerId) => {
    if (!SPEAKER_ID_PATTERN.test(speakerId) || !Object.prototype.hasOwnProperty.call(parsed, speakerId)) return [];
    const name = parsed[speakerId];
    return typeof name === "string" ? [[speakerId, name] as [string, string]] : [];
  }));
}

export function getSpeakerName(names: Record<string, string>, speakerId: string) {
  if (!SPEAKER_ID_PATTERN.test(speakerId) || !Object.prototype.hasOwnProperty.call(names, speakerId)) return "";
  const value: unknown = names[speakerId];
  return typeof value === "string" ? value : "";
}

export function mergeSpeakerNames(current: Record<string, string>, incoming: Record<string, string>, dirtySpeakerIds: ReadonlySet<string>) {
  const merged = parseSpeakerNames(incoming);
  for (const speakerId of dirtySpeakerIds) {
    if (!SPEAKER_ID_PATTERN.test(speakerId)) continue;
    const localName = getSpeakerName(current, speakerId);
    if (localName || Object.prototype.hasOwnProperty.call(current, speakerId)) merged[speakerId] = localName;
  }
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readResponse(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => ({}));
  return isRecord(body) ? body : {};
}

function safeApiError(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() && value.length <= 300 ? value : fallback;
}

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error ? safeApiError(cause.message, fallback) : fallback;
}

function formatTimestamp(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
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
