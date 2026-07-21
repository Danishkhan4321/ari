"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { filterMeetings, isMeetingTerminal, type ManualMeeting } from "@/lib/manual-meetings";
import { MeetingRecorder } from "./meeting-recorder";
import { MeetingDetail } from "./meeting-detail";
import { MeetingHistory } from "./meeting-history";

type PendingSubmission = { meetingId?: number; attempts: number; polling: boolean };
type LoadIntent = "foreground" | "background";
const MAX_PENDING_SUBMISSION_ATTEMPTS = 5;

export function createPendingSubmission(meetingId?: number): PendingSubmission {
  return { meetingId, attempts: 0, polling: true };
}

export function advancePendingSubmission(pendingSubmission: PendingSubmission) {
  if (!pendingSubmission.polling) return { pendingSubmission, timedOut: false };
  const attempts = pendingSubmission.attempts + 1;
  const timedOut = attempts >= MAX_PENDING_SUBMISSION_ATTEMPTS;
  return { pendingSubmission: { ...pendingSubmission, attempts, polling: !timedOut }, timedOut };
}

export function shouldScheduleMeetingPoll({
  hasProcessingMeeting,
  pendingSubmission,
  requestInFlight,
}: {
  hasProcessingMeeting: boolean;
  pendingSubmission: PendingSubmission | null;
  requestInFlight: boolean;
}) {
  if (requestInFlight) return false;
  return hasProcessingMeeting || Boolean(pendingSubmission?.polling);
}

export function resolveMeetingSelection(meetings: ManualMeeting[], current: number | null, pendingSubmission: PendingSubmission | null) {
  if (pendingSubmission) {
    if (pendingSubmission.meetingId != null && meetings.some((meeting) => meeting.id === pendingSubmission.meetingId)) {
      return { selectedId: pendingSubmission.meetingId, pendingSubmission: null };
    }
    if (pendingSubmission.meetingId == null) {
      return { selectedId: meetings[0]?.id ?? null, pendingSubmission: null };
    }
    const selectedId = current != null && meetings.some((meeting) => meeting.id === current) ? current : meetings[0]?.id ?? null;
    return { selectedId, pendingSubmission };
  }
  const selectedId = current != null && meetings.some((meeting) => meeting.id === current) ? current : meetings[0]?.id ?? null;
  return { selectedId, pendingSubmission: null };
}

export function isLatestMeetingRequest(requestId: number, latestRequestId: number) {
  return requestId === latestRequestId;
}

export function MeetingsContent() {
  const [meetings, setMeetings] = useState<ManualMeeting[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [pendingSubmissionState, setPendingSubmissionState] = useState<PendingSubmission | null>(null);
  const pendingSubmission = useRef<PendingSubmission | null>(null);
  const selectedIdRef = useRef<number | null>(null);
  const requestSequence = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const requestInFlight = useRef(false);

  const updatePendingSubmission = useCallback((next: PendingSubmission | null) => {
    pendingSubmission.current = next;
    setPendingSubmissionState(next);
  }, []);

  const load = useCallback(async (intent: LoadIntent = "foreground") => {
    if (requestInFlight.current) {
      if (intent === "background") return;
      requestController.current?.abort();
    }
    const requestId = ++requestSequence.current;
    const controller = new AbortController();
    requestController.current = controller;
    requestInFlight.current = true;
    try {
      const response = await fetch("/api/meetings/list", { cache: "no-store", signal: controller.signal });
      const body = await response.json() as { meetings?: ManualMeeting[]; error?: string };
      if (!isLatestMeetingRequest(requestId, requestSequence.current)) return;
      if (!response.ok || !body.meetings) throw new Error(body.error || "Could not load meetings.");

      const loadedMeetings = body.meetings;
      const selection = resolveMeetingSelection(loadedMeetings, selectedIdRef.current, pendingSubmission.current);
      const advanced = selection.pendingSubmission ? advancePendingSubmission(selection.pendingSubmission) : null;
      const nextPending = advanced?.pendingSubmission || null;
      updatePendingSubmission(nextPending);
      selectedIdRef.current = selection.selectedId;
      setMeetings(loadedMeetings);
      setSelectedId(selection.selectedId);
      if (advanced?.timedOut) {
        setError("The submitted meeting is taking longer to appear. Retry to refresh its status.");
      } else if (nextPending && !nextPending.polling) {
        setError((current) => current || "Submitted meeting refresh is paused. Retry when you are ready.");
      } else {
        setError(null);
      }
    } catch (cause) {
      if (!isLatestMeetingRequest(requestId, requestSequence.current) || controller.signal.aborted) return;
      const pending = pendingSubmission.current;
      if (pending) updatePendingSubmission({ ...pending, polling: false });
      const message = cause instanceof Error ? cause.message : "Could not load meetings.";
      setError(pending ? `${message} Submitted meeting refresh is paused; retry to continue.` : message);
      setMeetings((current) => current || []);
    } finally {
      if (isLatestMeetingRequest(requestId, requestSequence.current)) {
        requestInFlight.current = false;
        requestController.current = null;
      }
    }
  }, [updatePendingSubmission]);

  useEffect(() => {
    void load("foreground");
    return () => {
      requestSequence.current += 1;
      requestController.current?.abort();
    };
  }, [load]);
  useEffect(() => {
    const hasProcessingMeeting = meetings?.some((meeting) => {
      const stage = meeting.processing_stage || meeting.status;
      return Boolean(stage) && !isMeetingTerminal(stage);
    }) || false;
    if (!hasProcessingMeeting && !pendingSubmissionState?.polling) return;
    const timer = window.setInterval(() => {
      if (shouldScheduleMeetingPoll({
        hasProcessingMeeting,
        pendingSubmission: pendingSubmission.current,
        requestInFlight: requestInFlight.current,
      })) void load("background");
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [load, meetings, pendingSubmissionState]);

  const submitted = useCallback((meetingId?: number) => {
    updatePendingSubmission(createPendingSubmission(meetingId));
    if (meetingId != null) {
      selectedIdRef.current = meetingId;
      setSelectedId(meetingId);
    }
    void load("foreground");
  }, [load, updatePendingSubmission]);

  const retryLoad = useCallback(() => {
    const pending = pendingSubmission.current;
    if (pending) updatePendingSubmission({ ...pending, attempts: 0, polling: true });
    void load("foreground");
  }, [load, updatePendingSubmission]);

  const tasksChanged = useCallback(() => load("foreground"), [load]);

  const selectMeeting = useCallback((meetingId: number) => {
    selectedIdRef.current = meetingId;
    setSelectedId(meetingId);
  }, []);

  function updateMeeting(updated: ManualMeeting) {
    setMeetings((current) => (current || []).map((meeting) => meeting.id === updated.id ? { ...meeting, ...updated } : meeting));
  }

  const filteredMeetings = useMemo(() => filterMeetings(meetings || [], query), [meetings, query]);
  const selectedMeeting = meetings?.find((meeting) => meeting.id === selectedId) || null;

  return (
    <div className="mt-6 space-y-6">
      <MeetingRecorder onSubmitted={submitted} />

      <section className="overflow-hidden rounded-[7px] border border-[#d9d7d2] bg-white shadow-[0_1px_2px_rgba(38,33,31,0.03)] lg:grid lg:grid-cols-[minmax(280px,42%)_minmax(0,58%)]" aria-label="Meeting history workspace">
        <MeetingHistory
          meetings={filteredMeetings}
          selectedId={selectedId}
          query={query}
          onQueryChange={setQuery}
          onSelect={selectMeeting}
          onRetry={retryLoad}
          loading={meetings === null}
          error={error}
          totalMeetings={meetings?.length || 0}
        />

        <div className="min-w-0 border-t border-[#e5e3df] bg-[#fffdfa] lg:border-t-0">
          {meetings === null ? (
            <DetailState title="Preparing meeting details" body="Select a meeting when your history has loaded." />
          ) : error && meetings.length === 0 ? (
            <DetailState title="Meetings unavailable" body={error} />
          ) : meetings.length === 0 ? (
            <DetailState title="Your meeting report will appear here" body="Record a meeting to generate a transcript, decisions, action items, and report." />
          ) : selectedMeeting ? (
            <MeetingDetail meeting={selectedMeeting} onUpdated={updateMeeting} onTasksChanged={tasksChanged} />
          ) : (
            <DetailState title="Select a meeting" body="Choose a meeting from the history to review its complete report." />
          )}
        </div>
      </section>
    </div>
  );
}

function DetailState({ title, body }: { title: string; body: string }) {
  return (
    <div className="grid min-h-[260px] place-items-center px-6 py-14 text-center lg:min-h-[480px]">
      <div>
        <div className="text-[13px] font-medium text-[#4e4944]">{title}</div>
        <p className="mx-auto mt-2 max-w-sm text-[10.5px] leading-5 text-[#85807a]">{body}</p>
      </div>
    </div>
  );
}
