"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createWindowsMeetingRecorder } from "./windows-recorder";

type Progress = {
  phase?: string;
  ratio?: number;
  meetingId?: number;
  sessionId?: string;
  processingStage?: string;
  levels?: { system?: number; microphone?: number };
};

type MeetingBridge = {
  capabilities(): Promise<{ supported: boolean; platform: string; systemAudio: boolean; microphone: boolean }>;
  prepare(metadata: { title?: string; codec: string }): Promise<{ id: string }>;
  start(id: string): Promise<unknown>;
  writeChunk(id: string, chunk: ArrayBuffer): Promise<unknown>;
  pause(id: string): Promise<unknown>;
  resume(id: string): Promise<unknown>;
  stop(id: string): Promise<{ meetingId?: number; processingStage?: string }>;
  cancel(id: string): Promise<unknown>;
  onProgress(listener: (progress: Progress) => void): () => void;
};

type DesktopWindow = Window & { ariDesktop?: { meetings?: MeetingBridge } };
type RecorderState = "unavailable" | "idle" | "starting" | "recording" | "paused" | "uploading" | "submitted" | "error";
type RecorderOperation = "starting" | "pausing" | "resuming" | "stopping" | "cancelling";
type SubmissionIdentity = { sessionId?: string | null; meetingId?: number };

export function progressMatchesActiveSession(progressSessionId: string | undefined, activeSessionId: string | null, activeSessionCount: number) {
  if (!activeSessionId) return false;
  if (progressSessionId) return progressSessionId === activeSessionId;
  return activeSessionCount === 1;
}

export function createSubmissionGate() {
  const sessions = new Set<string>();
  const meetings = new Set<number>();
  return {
    claim({ sessionId, meetingId }: SubmissionIdentity) {
      if (!sessionId && meetingId == null) return false;
      const alreadyClaimed = Boolean((sessionId && sessions.has(sessionId)) || (meetingId != null && meetings.has(meetingId)));
      if (sessionId) sessions.add(sessionId);
      if (meetingId != null) meetings.add(meetingId);
      return !alreadyClaimed;
    },
  };
}

export function MeetingRecorder({ onSubmitted }: { onSubmitted: (meetingId?: number) => void }) {
  const [bridge, setBridge] = useState<MeetingBridge | null>(null);
  const [platform, setPlatform] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [state, setState] = useState<RecorderState>("unavailable");
  const [operation, setOperation] = useState<RecorderOperation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [levels, setLevels] = useState({ system: 0, microphone: 0 });
  const [seconds, setSeconds] = useState(0);
  const mounted = useRef(true);
  const bridgeRef = useRef<MeetingBridge | null>(null);
  const platformRef = useRef<string | null>(null);
  const operationRef = useRef<RecorderOperation | null>(null);
  const sessionId = useRef<string | null>(null);
  const windowsRecorder = useRef<ReturnType<typeof createWindowsMeetingRecorder> | null>(null);
  const submissionGate = useRef(createSubmissionGate());

  const emitSubmitted = useCallback((captureId: string | null, meetingId?: number) => {
    if (!mounted.current || !submissionGate.current.claim({ sessionId: captureId, meetingId })) return false;
    if (sessionId.current === captureId) sessionId.current = null;
    windowsRecorder.current = null;
    setError(null);
    setState("submitted");
    onSubmitted(meetingId);
    return true;
  }, [onSubmitted]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const meetings = (window as DesktopWindow).ariDesktop?.meetings;
    if (!meetings) return;
    let disposed = false;
    let unsubscribe = () => {};
    bridgeRef.current = meetings;
    setBridge(meetings);

    meetings.capabilities().then((capabilities) => {
      if (disposed || !mounted.current) return;
      if (!capabilities.supported) return;
      platformRef.current = capabilities.platform;
      setPlatform(capabilities.platform);
      setState("idle");
      unsubscribe = meetings.onProgress((progress) => {
        if (disposed || !mounted.current) return;
        const activeSessionId = sessionId.current;
        if (!progressMatchesActiveSession(progress.sessionId, activeSessionId, activeSessionId ? 1 : 0)) return;
        if (progress.levels) setLevels({ system: progress.levels.system || 0, microphone: progress.levels.microphone || 0 });
        if (progress.phase === "uploading") setState("uploading");
        if (progress.phase === "submitted") emitSubmitted(sessionId.current, progress.meetingId);
      });
    }).catch(() => {
      if (!disposed && mounted.current) setState("unavailable");
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [emitSubmitted]);

  useEffect(() => () => {
    const id = sessionId.current;
    sessionId.current = null;
    if (platformRef.current === "win32") {
      void windowsRecorder.current?.cancel().catch(() => undefined);
    } else if (id && bridgeRef.current) {
      void bridgeRef.current.cancel(id).catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    if (state !== "recording") return;
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [state]);

  function beginOperation(next: RecorderOperation) {
    if (operationRef.current) return false;
    operationRef.current = next;
    setOperation(next);
    return true;
  }

  function finishOperation(next: RecorderOperation) {
    if (operationRef.current !== next) return;
    operationRef.current = null;
    if (mounted.current) setOperation(null);
  }

  async function start() {
    if (!bridge || !platform || sessionId.current || !beginOperation("starting")) return;
    setError(null);
    setSeconds(0);
    setState("starting");
    let preparedSessionId: string | null = null;
    try {
      if (platform === "win32") {
        const recorder = createWindowsMeetingRecorder({
          mediaDevices: navigator.mediaDevices,
          AudioContextCtor: window.AudioContext,
          MediaRecorderCtor: window.MediaRecorder,
          meetings: bridge,
        });
        windowsRecorder.current = recorder;
        const result = await recorder.start({
          title: title.trim() || undefined,
          onLevels: (next) => { if (mounted.current) setLevels(next); },
        });
        if (!mounted.current) {
          await recorder.cancel().catch(() => undefined);
          return;
        }
        sessionId.current = result.sessionId;
      } else {
        const prepared = await bridge.prepare({ title: title.trim() || undefined, codec: "caf-pcm" });
        preparedSessionId = prepared.id;
        if (!mounted.current) {
          await bridge.cancel(prepared.id).catch(() => undefined);
          return;
        }
        sessionId.current = prepared.id;
        await bridge.start(prepared.id);
        if (!mounted.current) {
          await bridge.cancel(prepared.id).catch(() => undefined);
          sessionId.current = null;
          return;
        }
      }
      setState("recording");
    } catch (cause) {
      if (preparedSessionId) await bridge.cancel(preparedSessionId).catch(() => undefined);
      else if (platform === "win32") await windowsRecorder.current?.cancel().catch(() => undefined);
      sessionId.current = null;
      windowsRecorder.current = null;
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : "Could not start meeting recording.");
        setState("error");
      }
    } finally {
      finishOperation("starting");
    }
  }

  async function pauseOrResume() {
    const id = sessionId.current;
    if (!bridge || !id || (state !== "recording" && state !== "paused")) return;
    const nextOperation = state === "recording" ? "pausing" : "resuming";
    if (!beginOperation(nextOperation)) return;
    try {
      if (state === "recording") {
        if (platform === "win32") {
          if (!windowsRecorder.current) throw new Error("The local recorder is unavailable.");
          await windowsRecorder.current.pause();
        } else await bridge.pause(id);
        if (mounted.current && sessionId.current === id) setState("paused");
      } else {
        if (platform === "win32") {
          if (!windowsRecorder.current) throw new Error("The local recorder is unavailable.");
          await windowsRecorder.current.resume();
        } else await bridge.resume(id);
        if (mounted.current && sessionId.current === id) setState("recording");
      }
      if (mounted.current) setError(null);
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : `Could not ${state === "recording" ? "pause" : "resume"} recording. Stop or discard this capture safely.`);
        setState("error");
      }
    } finally {
      finishOperation(nextOperation);
    }
  }

  async function stop() {
    const id = sessionId.current;
    if (!bridge || !id || !beginOperation("stopping")) return;
    setError(null);
    setState("uploading");
    try {
      let result: { meetingId?: number; processingStage?: string };
      if (platform === "win32") {
        if (!windowsRecorder.current) throw new Error("The local recorder is unavailable.");
        result = await windowsRecorder.current.stop() as { meetingId?: number; processingStage?: string };
      } else result = await bridge.stop(id);
      if (!mounted.current) return;
      emitSubmitted(id, result.meetingId);
      if (sessionId.current === id) sessionId.current = null;
    } catch (cause) {
      if (mounted.current && sessionId.current === id) {
        setError(cause instanceof Error ? cause.message : "The recording could not be submitted.");
        setState("error");
      }
    } finally {
      finishOperation("stopping");
    }
  }

  async function cancel() {
    const id = sessionId.current;
    if (!bridge || !id || !beginOperation("cancelling")) return;
    try {
      if (platform === "win32") {
        if (!windowsRecorder.current) throw new Error("The local recorder is unavailable.");
        await windowsRecorder.current.cancel();
      } else await bridge.cancel(id);
      if (!mounted.current) return;
      if (sessionId.current === id) sessionId.current = null;
      windowsRecorder.current = null;
      setError(null);
      setState("idle");
      setSeconds(0);
      setLevels({ system: 0, microphone: 0 });
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : "Could not discard the local recording.");
        setState("error");
      }
    } finally {
      finishOperation("cancelling");
    }
  }

  if (state === "unavailable") {
    return (
      <div className="flex items-center gap-3 rounded-[7px] border border-[#e5e3df] bg-white px-4 py-3 text-[11px] text-[#77736f]" role="status" aria-live="polite">
        <RecordIcon muted />
        <span>Record Meeting is available in the Ari desktop app on Windows and macOS.</span>
      </div>
    );
  }

  const active = ["starting", "recording", "paused", "uploading"].includes(state);
  const retainedError = state === "error" && sessionId.current != null;
  const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const stateLabel = operation === "pausing" ? "Pausing" : operation === "resuming" ? "Resuming" : operation === "cancelling" ? "Cancelling" : state === "uploading" ? "Uploading safely" : state === "starting" ? "Preparing audio" : state === "paused" ? "Paused" : state === "recording" ? "Recording" : state === "submitted" ? "Recording submitted" : state === "error" ? "Recorder needs attention" : "Recorder ready";
  const busy = operation !== null;

  return (
    <div className="rounded-[7px] border border-[#d9d7d2] bg-white px-4 py-3 shadow-[0_1px_2px_rgba(38,33,31,0.03)] sm:px-5">
      <span className="sr-only" role="status" aria-live="polite">{stateLabel}</span>

      {!active && !retainedError ? (
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <RecordIcon />
            <div className="min-w-0">
              <div className="text-[12.5px] font-semibold tracking-[-0.015em] text-[#24211f]">Start a meeting</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-[#77736f]">
                <span>System audio + microphone</span>
                <span className="inline-flex items-center gap-1 text-[#4e6e5f]"><span className="h-1.5 w-1.5 rounded-full bg-[#249469]" />{platform === "win32" ? "Windows recorder ready" : platform === "darwin" ? "Mac recorder ready" : "Recorder ready"}</span>
              </div>
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
            <label className="min-w-0 flex-1">
              <span className="sr-only">Meeting title (optional)</span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={500} placeholder="Meeting title (optional)" className="h-9 w-full min-w-0 rounded-[5px] border border-[#d9d7d2] bg-[#faf9f5] px-3 text-[11.5px] text-[#24211f] outline-none placeholder:text-[#9a9690] focus:border-[#a98b75] focus:bg-white focus:ring-2 focus:ring-[#8c5a3c]/10 sm:w-[240px]" />
            </label>
            <button type="button" onClick={start} disabled={busy} className="crm-button crm-button-primary shrink-0">Record</button>
          </div>
        </div>
      ) : active ? (
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <div className="flex items-center gap-3">
              <span className={`h-2.5 w-2.5 rounded-full ${state === "paused" ? "bg-[#b88649]" : state === "uploading" ? "bg-[#5d7890]" : "bg-[#b4483d]"}`} />
              <div>
                <div className="text-[11.5px] font-medium text-[#24211f]">{stateLabel}</div>
                <div className="mt-0.5 font-mono text-[10px] tabular-nums text-[#77736f]">{elapsed}</div>
              </div>
            </div>
            <AudioLevel label="System" value={levels.system} />
            <AudioLevel label="Microphone" value={levels.microphone} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {(state === "recording" || state === "paused") && <button type="button" onClick={pauseOrResume} disabled={busy} className="crm-button">{state === "paused" ? "Resume" : "Pause"}</button>}
            {(state === "recording" || state === "paused") && <button type="button" onClick={stop} disabled={busy} className="crm-button crm-button-primary">Stop &amp; process</button>}
            {state !== "uploading" && <button type="button" onClick={cancel} disabled={busy} className="crm-button">Cancel</button>}
          </div>
        </div>
      ) : null}

      {state === "submitted" && <div className="mt-3 border-t border-[#eceae6] pt-3 text-[10.5px] text-[#397158]">Recording submitted. Transcription and the meeting report are being generated.</div>}
      {error && <div className="mt-3 border-t border-[#ecd5cd] pt-3 text-[10.5px] text-[#963f2f]" role="alert">{error}</div>}
      {state === "error" && sessionId.current && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" onClick={stop} disabled={busy} className="crm-button crm-button-primary">Retry upload</button>
          <button type="button" onClick={cancel} disabled={busy} className="crm-button">Discard local recording</button>
        </div>
      )}
    </div>
  );
}

function AudioLevel({ label, value }: { label: string; value: number }) {
  return <div className="flex items-center gap-2 text-[10px] text-[#77736f]"><span>{label}</span><span className="h-1.5 w-16 overflow-hidden rounded-full bg-[#ebe8e2]"><span className="block h-full rounded-full bg-[#7d6758]" style={{ width: `${Math.max(3, Math.min(100, value * 100))}%` }} /></span></div>;
}

function RecordIcon({ muted = false }: { muted?: boolean }) {
  return (
    <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full border ${muted ? "border-[#e1dfda] bg-[#faf9f5] text-[#85807a]" : "border-[#ead9ce] bg-[#fff7f1] text-[#9b4d3d]"}`} aria-hidden="true">
      <span className="h-2.5 w-2.5 rounded-full bg-current" />
    </span>
  );
}
