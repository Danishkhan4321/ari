"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { WorkspaceSidebar } from "@/components/workspace-sidebar";
import { isTerminalAgentEvent, reduceAgentActivities, type AgentActivity, type AgentEvent } from "@/lib/agent-activity";
import { readJsonResponse } from "@/lib/http";
import { taskStatusLines } from "@/lib/task-status";
import { MAX_CHAT_ATTACHMENTS, validateChatAttachments } from "@/lib/chat-attachments";

type ChatAttachment = { id: string; fileName: string; mimeType: string; url: string };
type Msg = { id: number; role: string; content: string; created_at: string; clientMessageId?: string | null; attachments?: ChatAttachment[] };
type ChatSession = { id: string; title: string | null; isLegacy: boolean; createdAt: string; updatedAt: string };
type QueuedInstruction = { id: string; runId: string; text: string; mode: "queued" | "steering"; createdAt: string; attempts?: number; retryAfter?: number };
type DictationStatus = {
  available: boolean;
  enabled: boolean;
  state: string;
  error?: string | null;
  started?: boolean;
  stopped?: boolean;
};
type DesktopWindow = Window & {
  ariDesktop?: {
    dictation?: {
      getStatus: () => Promise<DictationStatus>;
      start: () => Promise<DictationStatus>;
      stop: () => Promise<DictationStatus>;
    };
  };
};
type StoredSessionRuntime = {
  awaitingReply: boolean;
  activeRequest: string;
  activeRunId: string | null;
  activeClientMessageId: string | null;
  taskStartedAt: number | null;
  queuedInstructions: QueuedInstruction[];
};

const POLL_MS = 5000;
const COMPOSER_MIN_HEIGHT_PX = 42;
const COMPOSER_MAX_HEIGHT_PX = 208;
const SESSION_RUNTIME_STORAGE_KEY = "ari:chat-session-runtime:v1";
const DICTATION_RECORDING_STATES = new Set(["starting", "listening"]);
const DICTATION_PROCESSING_STATES = new Set(["finalizing", "polishing", "pasting"]);

function readStoredRuntimes(): Record<string, StoredSessionRuntime> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SESSION_RUNTIME_STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStoredRuntime(sessionId: string, runtime: StoredSessionRuntime) {
  if (typeof window === "undefined") return;
  const stored = readStoredRuntimes();
  stored[sessionId] = runtime;
  window.localStorage.setItem(SESSION_RUNTIME_STORAGE_KEY, JSON.stringify(stored));
}

function resizeComposerToContent(textarea: HTMLTextAreaElement | null) {
  if (!textarea) return;
  textarea.style.height = "auto";
  const scrollHeight = textarea.scrollHeight;
  const nextHeight = Math.max(COMPOSER_MIN_HEIGHT_PX, Math.min(scrollHeight, COMPOSER_MAX_HEIGHT_PX));
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = scrollHeight > COMPOSER_MAX_HEIGHT_PX ? "auto" : "hidden";
}

export function ChatClient({ userPhone }: { userPhone: string }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [awaitingReply, setAwaitingReply] = useState(false);
  const [activities, setActivities] = useState<AgentActivity[]>([]);
  const [liveDraft, setLiveDraft] = useState("");
  const [activeRequest, setActiveRequest] = useState("");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeClientMessageId, setActiveClientMessageId] = useState<string | null>(null);
  const [taskStartedAt, setTaskStartedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dictationState, setDictationState] = useState("idle");
  const [dictationBusy, setDictationBusy] = useState(false);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionLoadAttempt, setSessionLoadAttempt] = useState(0);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [previewAttachment, setPreviewAttachment] = useState<ChatAttachment | null>(null);
  const [homeView, setHomeView] = useState(true);
  const [queuedInstructions, setQueuedInstructions] = useState<QueuedInstruction[]>([]);
  const lastIdRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const visibleRef = useRef(true);
  const submittingRef = useRef(false);
  const activeClientMessageIdRef = useRef<string | null>(null);

  useEffect(() => { activeClientMessageIdRef.current = activeClientMessageId; }, [activeClientMessageId]);

  useEffect(() => {
    if (!selectedSessionId) return;
    writeStoredRuntime(selectedSessionId, {
      awaitingReply,
      activeRequest,
      activeRunId,
      activeClientMessageId,
      taskStartedAt,
      queuedInstructions,
    });
  }, [activeClientMessageId, activeRequest, activeRunId, awaitingReply, queuedInstructions, selectedSessionId, taskStartedAt]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setSessionsLoading(true);
      setError(null);
      try {
        const response = await fetch("/api/chat/sessions", { cache: "no-store" });
        const data = await readJsonResponse<{ sessions?: ChatSession[]; error?: string }>(response);
        if (!response.ok || cancelled) throw new Error(data?.error || "Could not load sessions.");
        const loaded = data?.sessions || [];
        setSessions(loaded);
        const requested = new URLSearchParams(window.location.search).get("session");
        const selected = loaded.find((item) => item.id === requested) || loaded[0];
        if (selected) {
          selectSession(selected.id);
          return;
        }
        const createdResponse = await fetch("/api/chat/sessions", { method: "POST" });
        const createdData = await readJsonResponse<{ session?: ChatSession; error?: string }>(createdResponse);
        if (!createdResponse.ok || !createdData?.session || cancelled) throw new Error(createdData?.error || "Could not create a session.");
        setSessions([createdData.session]);
        selectSession(createdData.session.id, true);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Could not load sessions.");
      } finally {
        if (!cancelled) setSessionsLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [sessionLoadAttempt]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled || !visibleRef.current || !selectedSessionId) return;
      try {
        const query = new URLSearchParams({ sessionId: selectedSessionId });
        if (lastIdRef.current) query.set("since", String(lastIdRef.current));
        const url = `/api/chat/messages?${query.toString()}`;
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return;
        const incoming = ((await res.json()) as { messages?: Msg[] }).messages ?? [];
        if (incoming.length === 0) return;
        setHomeView(false);
        setMsgs((previous) => {
          const incomingClientIds = new Set(incoming.flatMap((m) => m.clientMessageId ? [m.clientMessageId] : []));
          const localAttachments = new Map(previous.filter((m) => m.id < 0 && m.clientMessageId && m.attachments?.length).map((m) => [m.clientMessageId as string, m.attachments]));
          const cleaned = previous.filter((m) => !(m.id < 0 && m.clientMessageId && incomingClientIds.has(m.clientMessageId)));
          const seen = new Set(cleaned.map((m) => m.id));
          const merged = [...cleaned];
          for (const message of incoming) if (!seen.has(message.id)) merged.push({ ...message, attachments: message.attachments?.length ? message.attachments : message.clientMessageId ? localAttachments.get(message.clientMessageId) : undefined });
          return merged.sort((a, b) => a.id - b.id);
        });
        lastIdRef.current = Math.max(lastIdRef.current, ...incoming.map((m) => m.id));
        if (incoming.some((m) => m.role === "assistant" && (!activeClientMessageIdRef.current || m.clientMessageId === activeClientMessageIdRef.current))) {
          setAwaitingReply(false);
          setActivities([]); setLiveDraft("");
          setActiveRequest("");
          setActiveRunId(null);
          setActiveClientMessageId(null);
          setTaskStartedAt(null);
        }
      } catch {
        // The next poll retries without interrupting the conversation.
      }
    };
    void tick();
    const handle = setInterval(tick, POLL_MS);
    const onVisibility = () => { visibleRef.current = !document.hidden; if (!document.hidden) void tick(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { cancelled = true; clearInterval(handle); document.removeEventListener("visibilitychange", onVisibility); };
  }, [selectedSessionId]);

  useEffect(() => {
    const toggleSidebar = () => setSidebarVisible((visible) => !visible);
    const focusComposer = () => requestAnimationFrame(() => composerRef.current?.focus());
    window.addEventListener("ari:toggle-sidebar", toggleSidebar);
    window.addEventListener("ari:focus-composer", focusComposer);
    return () => {
      window.removeEventListener("ari:toggle-sidebar", toggleSidebar);
      window.removeEventListener("ari:focus-composer", focusComposer);
    };
  }, []);

  useEffect(() => {
    const bridge = (window as DesktopWindow).ariDesktop?.dictation;
    if (!bridge) return;
    let cancelled = false;
    const sync = async () => {
      try {
        const status = await bridge.getStatus();
        if (!cancelled) setDictationState(status.state || "idle");
      } catch {
        if (!cancelled) setDictationState("idle");
      }
    };
    void sync();
    if (!DICTATION_RECORDING_STATES.has(dictationState) && !DICTATION_PROCESSING_STATES.has(dictationState)) {
      return () => { cancelled = true; };
    }
    const interval = window.setInterval(sync, 600);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [dictationState]);

  useEffect(() => {
    if (!selectedSessionId) return;
    const source = new EventSource(`/api/chat/activity?sessionId=${encodeURIComponent(selectedSessionId)}`);
    const onActivity = (message: MessageEvent<string>) => {
      try {
        const event = JSON.parse(message.data) as AgentEvent;
        setActivities((current) => reduceAgentActivities(current, event));
        setAwaitingReply(!isTerminalAgentEvent(event.event_type));
      } catch {
        // Malformed progress data should never break chat.
      }
    };
    source.addEventListener("activity", onActivity as EventListener);
    return () => source.close();
  }, [selectedSessionId]);

  // Live push stream (bot in-process bus → SSE): assistant text deltas render
  // as a streaming draft; model preambles and narrator lines feed the same
  // activity panel as the durable feed. The polled activity stream above
  // stays as the fallback — the reducer dedupes by event id/key.
  useEffect(() => {
    if (!selectedSessionId) return;
    const source = new EventSource("/api/chat/stream");
    const onRunEvent = (message: MessageEvent<string>) => {
      try {
        const entry = JSON.parse(message.data) as {
          seq: number; ts: number; runId?: string; type: string;
          step?: number | null; toolName?: string | null; summary?: string | null;
        };
        if (entry.type === "assistant.delta") {
          setLiveDraft((current) => (current + (entry.summary || "")).slice(0, 8000));
          return;
        }
        if (entry.type === "assistant.delta.discard") {
          setLiveDraft("");
          return;
        }
        if (entry.type === "run.finished") {
          setLiveDraft("");
        }
        const mapped: AgentEvent = {
          id: entry.seq,
          run_id: entry.runId || "live",
          event_type: entry.type,
          step: entry.step ?? null,
          tool_name: entry.toolName ?? null,
          summary: entry.summary ?? null,
          created_at: new Date(entry.ts || Date.now()).toISOString(),
        };
        setActivities((current) => reduceAgentActivities(current, mapped));
        if (isTerminalAgentEvent(entry.type)) setAwaitingReply(false);
      } catch {
        // Live progress must never break chat.
      }
    };
    source.addEventListener("run", onRunEvent as EventListener);
    return () => source.close();
  }, [selectedSessionId]);

  // Last-resort spinner recovery. Terminal events (run.finished) and arriving
  // assistant replies both clear `awaitingReply`, but neither happens if the
  // backend dies mid-turn — the UI then spins forever (observed: 73 minutes).
  // The agent's own ceiling is 5 minutes, so anything past ~6 is definitively
  // gone rather than slow.
  useEffect(() => {
    if (!awaitingReply || !taskStartedAt) return;
    const STALE_AFTER_MS = 6 * 60 * 1000;
    const remaining = Math.max(0, taskStartedAt + STALE_AFTER_MS - Date.now());
    const timer = window.setTimeout(() => {
      setAwaitingReply(false);
      setActivities([]);
      setLiveDraft("");
      setActiveRequest("");
      setActiveRunId(null);
      setActiveClientMessageId(null);
      setTaskStartedAt(null);
      setError("Ari stopped responding to that request. It may have completed in the background — check the page, then try again.");
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [awaitingReply, taskStartedAt]);

  const visibleMessages = msgs;
  const recentSessions = useMemo(() => sessions.slice(0, 100), [sessions]);
  const selectedSession = useMemo(() => sessions.find((item) => item.id === selectedSessionId) || null, [sessions, selectedSessionId]);
  const conversationTitle = useMemo(
    () => selectedSession?.title || msgs.find((message) => message.role === "user")?.content || "Session",
    [msgs, selectedSession],
  );
  const renamingSession = useMemo(
    () => renamingSessionId === null ? null : sessions.find((item) => item.id === renamingSessionId) || null,
    [sessions, renamingSessionId],
  );
  const showHome = homeView && !awaitingReply;

  useLayoutEffect(() => {
    resizeComposerToContent(composerRef.current);
  }, [input]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [visibleMessages.length, awaitingReply, activities.length]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    const attachmentsToSend = attachments;
    if ((!text && attachmentsToSend.length === 0) || submittingRef.current || !selectedSessionId) return;
    if (awaitingReply) {
      if (attachmentsToSend.length > 0) {
        setError("Wait for the current step to finish before queuing a document. Text instructions can be queued now.");
        return;
      }
      const instruction: QueuedInstruction = {
        id: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        text,
        mode: "queued",
        createdAt: new Date().toISOString(),
      };
      setQueuedInstructions((current) => [...current, instruction]);
      setInput("");
      setError(null);
      setHomeView(false);
      return;
    }
    submittingRef.current = true;
    setSending(true);
    setError(null);
    setHomeView(false);
    const optimisticContent = text || `Attached: ${attachmentsToSend.map((file) => file.name).join(", ")}`;
    const uploadedAttachments = attachmentsToSend.map((file, index) => ({
      id: `local-${Date.now()}-${index}`,
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      url: URL.createObjectURL(file),
    }));
    const clientMessageId = crypto.randomUUID();
    setMsgs((previous) => [...previous, { id: -Date.now(), role: "user", content: optimisticContent, created_at: new Date().toISOString(), clientMessageId, attachments: uploadedAttachments }]);
    setSessions((current) => current.map((session) => session.id === selectedSessionId && !session.title ? { ...session, title: optimisticContent.slice(0, 120), updatedAt: new Date().toISOString() } : session));
    setInput("");
    setAttachments([]);
    setAwaitingReply(true);
    setActivities([]); setLiveDraft("");
    setActiveRequest(text || `Review ${attachmentsToSend.map((file) => file.name).join(", ")}`);
    setTaskStartedAt(Date.now());
    const runId = crypto.randomUUID();
    setActiveRunId(runId);
    setActiveClientMessageId(clientMessageId);
    try {
      const formData = new FormData();
      formData.set("text", text);
      formData.set("runId", runId);
      formData.set("sessionId", selectedSessionId);
      formData.set("clientMessageId", clientMessageId);
      attachmentsToSend.forEach((file) => formData.append("attachments", file));
      const res = await fetch("/api/chat/send", {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const data = await readJsonResponse<{ error?: string }>(res);
        setError(data?.error || "Ari could not send that message. Please try again.");
        setAttachments(attachmentsToSend);
        setAwaitingReply(false);
        setActiveRunId(null);
        setActiveClientMessageId(null);
        setTaskStartedAt(null);
      }
    } catch {
      setError("The local service is unavailable. Your message was not sent.");
      setAttachments(attachmentsToSend);
      setAwaitingReply(false);
      setActiveRunId(null);
      setActiveClientMessageId(null);
      setTaskStartedAt(null);
    } finally {
      submittingRef.current = false;
      setSending(false);
    }
  }

  async function dispatchQueuedInstruction(instruction: QueuedInstruction) {
    const sessionId = selectedSessionId;
    if (!sessionId || submittingRef.current) return;
    submittingRef.current = true;
    setSending(true);
    setError(null);
    setQueuedInstructions((current) => current.filter((item) => item.id !== instruction.id));
    setMsgs((previous) => [...previous, {
      id: -Date.now(),
      role: "user",
      content: instruction.text,
      created_at: new Date().toISOString(),
      clientMessageId: instruction.id,
    }]);
    setAwaitingReply(true);
    setActivities([]); setLiveDraft("");
    setActiveRequest(instruction.text);
    setTaskStartedAt(Date.now());
    setActiveRunId(instruction.runId);
    setActiveClientMessageId(instruction.id);
    try {
      const response = await fetch("/api/chat/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: instruction.text,
          runId: instruction.runId,
          sessionId,
          clientMessageId: instruction.id,
        }),
      });
      if (!response.ok) {
        const body = await readJsonResponse<{ error?: string }>(response);
        throw new Error(body?.error || "Ari is still finishing the previous step.");
      }
    } catch (cause) {
      setMsgs((previous) => previous.filter((message) => message.clientMessageId !== instruction.id || message.id >= 0));
      const attempts = (instruction.attempts || 0) + 1;
      setQueuedInstructions((current) => [{ ...instruction, attempts, retryAfter: Date.now() + 2000 }, ...current.filter((item) => item.id !== instruction.id)]);
      setAwaitingReply(false);
      setActiveRunId(null);
      setActiveClientMessageId(null);
      setTaskStartedAt(null);
      if (attempts >= 120) {
        setError(cause instanceof Error ? cause.message : "The queued instruction could not be started.");
      }
    } finally {
      submittingRef.current = false;
      setSending(false);
    }
  }

  useEffect(() => {
    if (awaitingReply || sending || submittingRef.current || !selectedSessionId) return;
    const next = queuedInstructions[0];
    if (!next || (next.attempts || 0) >= 120) return;
    const baseDelay = next.mode === "steering" ? 250 : 600;
    const delay = Math.max(baseDelay, Number(next.retryAfter || 0) - Date.now());
    const timer = window.setTimeout(() => void dispatchQueuedInstruction(next), delay);
    return () => window.clearTimeout(timer);
    // dispatchQueuedInstruction intentionally uses the current selected session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitingReply, queuedInstructions, selectedSessionId, sending]);

  async function steerQueuedInstruction(instructionId: string) {
    setQueuedInstructions((current) => {
      const selected = current.find((item) => item.id === instructionId);
      return selected ? [{ ...selected, mode: "steering", attempts: 0, retryAfter: undefined }, ...current.filter((item) => item.id !== instructionId)] : current;
    });
    await stopActiveRun();
  }

  function deleteQueuedInstruction(instructionId: string) {
    setQueuedInstructions((current) => current.filter((item) => item.id !== instructionId));
  }

  async function stopActiveRun() {
    const runId = activeRunId;
    setAwaitingReply(false);
    setActivities([]); setLiveDraft("");
    setActiveRequest("");
    setTaskStartedAt(null);
    setActiveRunId(null);
    setActiveClientMessageId(null);
    if (!runId) return;
    try {
      const response = await fetch("/api/chat/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId, sessionId: selectedSessionId }),
      });
      // 404 means the run had already finished — the cleared display is
      // correct and no warning is needed. Anything else non-OK means the
      // stop may not have reached the run at all.
      if (!response.ok && response.status !== 404) {
        setError("The stop request could not be delivered — the run may still be finishing in the background.");
      }
    } catch {
      // Stopping the local display still lets the user continue working.
    }
  }

  async function startNewSession() {
    setError(null);
    try {
      const response = await fetch("/api/chat/sessions", { method: "POST" });
      const data = await readJsonResponse<{ session?: ChatSession; error?: string }>(response);
      if (!response.ok || !data?.session) throw new Error(data?.error || "Could not create a new session.");
      setSessions((current) => [data.session as ChatSession, ...current]);
      selectSession(data.session.id, true);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Could not create a new session.");
    }
  }

  function retrySessionLoading() {
    setSessions([]);
    setSelectedSessionId(null);
    setSessionsLoading(true);
    setError(null);
    setSessionLoadAttempt((attempt) => attempt + 1);
  }

  function selectSession(sessionId: string, empty = false) {
    if (selectedSessionId) {
      writeStoredRuntime(selectedSessionId, {
        awaitingReply,
        activeRequest,
        activeRunId,
        activeClientMessageId,
        taskStartedAt,
        queuedInstructions,
      });
    }
    const stored = readStoredRuntimes()[sessionId];
    lastIdRef.current = 0;
    setMsgs([]);
    setActivities([]); setLiveDraft("");
    setAwaitingReply(stored?.awaitingReply || false);
    setActiveRequest(stored?.activeRequest || "");
    setTaskStartedAt(stored?.taskStartedAt || null);
    setActiveRunId(stored?.activeRunId || null);
    setActiveClientMessageId(stored?.activeClientMessageId || null);
    setQueuedInstructions(Array.isArray(stored?.queuedInstructions) ? stored.queuedInstructions : []);
    setSelectedSessionId(sessionId);
    setHomeView(empty);
    setError(null);
    window.history.replaceState(null, "", `/chat?session=${encodeURIComponent(sessionId)}`);
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  function showRecent(sessionId: string) {
    if (sessionId !== selectedSessionId) selectSession(sessionId);
  }

  function openRenameChat(sessionId: string) {
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) return;
    setRenamingSessionId(sessionId);
    setRenameTitle(session.title || "New session");
    setRenameError(null);
  }

  async function saveChatTitle(event: React.FormEvent) {
    event.preventDefault();
    if (!renamingSession || renaming) return;
    setRenaming(true);
    setRenameError(null);
    try {
      const response = await fetch("/api/chat/title", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: renamingSession.id, title: renameTitle }),
      });
      const data = await readJsonResponse<{ title?: string; error?: string }>(response);
      if (!response.ok || !data?.title) {
        setRenameError(data?.error || "Could not rename this session.");
        return;
      }
      setSessions((current) => current.map((session) => session.id === renamingSession.id ? { ...session, title: data.title as string } : session));
      setRenamingSessionId(null);
    } catch {
      setRenameError("Could not rename this session.");
    } finally {
      setRenaming(false);
    }
  }

  function usePrompt(prompt: string) {
    setInput(prompt);
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  function addAttachments(incoming: File[]) {
    const next = [...attachments, ...incoming].slice(0, MAX_CHAT_ATTACHMENTS + 1);
    const attachmentError = validateChatAttachments(next);
    if (attachmentError) {
      setError(attachmentError);
      return;
    }
    setError(null);
    setAttachments(next);
  }

  function removeAttachment(index: number) {
    setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }

  async function toggleVoiceInput() {
    const bridge = (window as DesktopWindow).ariDesktop?.dictation;
    if (!bridge) {
      setError("Flowtype is available in the Ari desktop app.");
      return;
    }
    setDictationBusy(true);
    setError(null);
    try {
      if (DICTATION_RECORDING_STATES.has(dictationState)) {
        const status = await bridge.stop();
        setDictationState(status.stopped ? "finalizing" : status.state || "idle");
        return;
      }
      composerRef.current?.focus();
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const status = await bridge.start();
      setDictationState(status.state || "idle");
      if (!status.started) setError(status.error || "Flowtype could not start. Check the microphone in Settings.");
    } catch (voiceError) {
      setDictationState("idle");
      setError(voiceError instanceof Error ? voiceError.message : "Flowtype could not start.");
    } finally {
      setDictationBusy(false);
    }
  }

  return (
    <div className="ari-chat-shell ari-product-canvas relative isolate flex h-screen min-h-[640px] flex-col overflow-hidden bg-ari-product-canvas text-ari-text">
      <div className="ari-chat-frame ari-product-frame relative z-10 flex min-h-0 flex-1 overflow-hidden">
        <WorkspaceSidebar
          userPhone={userPhone}
          expanded={sidebarVisible}
          onNewSession={startNewSession}
          sessions={recentSessions}
          onSelectSession={showRecent}
          onRenameSession={openRenameChat}
        />

        <main className="ari-chat-main flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {!showHome && <div className="ari-chat-panel-header flex h-14 shrink-0 items-center border-b border-ari-border px-5 sm:px-7">
            <span title={conversationTitle} className="max-w-[min(75vw,720px)] truncate text-[14px] font-medium tracking-[-0.015em] text-ari-ink">{conversationTitle}</span>
          </div>}
          <div ref={scrollRef} className="ari-chat-scroll min-h-0 flex-1 overflow-y-auto">
            <div className="ari-chat-conversation mx-auto flex min-h-full w-full max-w-[1080px] flex-col px-5 pb-8 pt-10 sm:px-8 sm:pt-12">
              {showHome ? <HomeWelcome onChoose={usePrompt} /> : (
                <div className="space-y-6">
                  {visibleMessages.map((message) => <ConversationMessage key={message.id} message={message} onPreview={setPreviewAttachment} />)}
                  {activities.length > 0 && <AgentActivityPanel activities={activities} onStop={stopActiveRun} />}
                  {awaitingReply && liveDraft && (
                    <div className="ari-chat-bubble-assistant max-w-[85%] whitespace-pre-wrap rounded-2xl bg-ari-subtle px-4 py-3 text-[14px] leading-relaxed text-ari-text">
                      {liveDraft}
                      <span className="ari-live-dot ml-1 inline-block align-middle" />
                    </div>
                  )}
                  {awaitingReply && activities.length === 0 && !liveDraft && <ThinkingRow prompt={activeRequest} onStop={stopActiveRun} />}
                </div>
              )}
            </div>
          </div>
          <div className="ari-chat-composer-wrap shrink-0 px-4 pb-6 pt-3 sm:px-6">
            <div className="mx-auto w-full max-w-[920px]">
              {error && <div role="alert" className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"><span>{error}</span>{!selectedSessionId && !sessionsLoading && <button type="button" onClick={retrySessionLoading} aria-label="Retry session loading" className="shrink-0 rounded-md border border-red-200 bg-white px-2.5 py-1 font-semibold text-red-700 transition hover:bg-red-100">Retry</button>}</div>}
              {queuedInstructions.length > 0 && <QueuedInstructionTray instructions={queuedInstructions} onSteer={steerQueuedInstruction} onDelete={deleteQueuedInstruction} />}
              <form
                onSubmit={send}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  if (!sending && !awaitingReply) addAttachments(Array.from(event.dataTransfer.files));
                }}
                className="ari-chat-composer overflow-hidden rounded-[16px] transition"
              >
                <input ref={attachmentInputRef} type="file" multiple disabled={sending || awaitingReply || sessionsLoading || !selectedSessionId} className="sr-only" onChange={(event) => {
                  addAttachments(Array.from(event.target.files || []));
                  event.currentTarget.value = "";
                }} />
                {attachments.length > 0 && <div className="flex flex-wrap gap-1.5 px-4 pt-3" aria-label="Attached documents">
                  {attachments.map((file, index) => <span key={`${file.name}-${file.lastModified}-${index}`} className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-[#e4e0e8] bg-[#f8f7f9] py-1 pl-2 pr-1 text-[12px] text-[#514b58]">
                    <DocumentIcon />
                    <span className="max-w-[230px] truncate">{file.name}</span>
                    <button type="button" onClick={() => removeAttachment(index)} aria-label={`Remove ${file.name}`} className="grid h-5 w-5 place-items-center rounded-md text-[#746d7b] transition hover:bg-white hover:text-[#312b36]">×</button>
                  </span>)}
                </div>}
                <textarea ref={composerRef} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} placeholder={sessionsLoading ? "Preparing your Ari session..." : awaitingReply ? "Add an instruction for Ari to do next" : selectedSessionId ? "Ask Ari to do anything" : "Retry session loading to continue"} aria-label="Message Ari" maxLength={5000} rows={1} disabled={sending || sessionsLoading || !selectedSessionId} className="block max-h-[208px] min-h-[54px] w-full resize-none overflow-y-hidden bg-transparent px-5 pb-2 pt-4 text-[15px] leading-6 tracking-[-0.005em] outline-none placeholder:text-[#938b9d] disabled:opacity-60" />
                <div className="flex items-center justify-between px-3.5 pb-3">
                  <div className="flex items-center gap-1.5">
                    <button type="button" onClick={() => attachmentInputRef.current?.click()} disabled={sending || awaitingReply || sessionsLoading || !selectedSessionId} aria-label="Attach documents" title="Attach documents" className="grid h-9 w-9 place-items-center rounded-full text-[#625a6b] transition hover:bg-ari-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ari-focus disabled:cursor-not-allowed disabled:opacity-50"><PlusIcon /></button>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void toggleVoiceInput()}
                      disabled={dictationBusy || DICTATION_PROCESSING_STATES.has(dictationState) || sending || sessionsLoading || !selectedSessionId}
                      aria-label={DICTATION_RECORDING_STATES.has(dictationState) ? "Stop Flowtype" : "Start Flowtype"}
                      aria-pressed={DICTATION_RECORDING_STATES.has(dictationState)}
                      title={DICTATION_RECORDING_STATES.has(dictationState) ? "Stop Flowtype" : DICTATION_PROCESSING_STATES.has(dictationState) ? "Flowtype is transcribing" : "Speak with Flowtype"}
                      className={`grid h-9 w-9 shrink-0 place-items-center rounded-full border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ari-focus disabled:cursor-not-allowed disabled:opacity-55 ${DICTATION_RECORDING_STATES.has(dictationState) ? "border-[#dec51f] bg-ari-accent text-ari-ink shadow-[0_5px_14px_rgba(222,197,31,0.25)]" : "border-ari-border bg-white text-ari-muted hover:border-[#dec51f] hover:bg-ari-nav hover:text-ari-ink"}`}
                    >
                      {dictationBusy || DICTATION_PROCESSING_STATES.has(dictationState) ? <Spinner /> : <MicrophoneIcon recording={DICTATION_RECORDING_STATES.has(dictationState)} />}
                    </button>
                    {awaitingReply && !input.trim() && attachments.length === 0 ? <button type="button" onClick={stopActiveRun} aria-label="Stop task" title="Stop task" className="ari-chat-send grid h-9 w-9 shrink-0 place-items-center rounded-full text-ari-ink transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ari-focus"><StopIcon /></button> : <button type="submit" disabled={sending || sessionsLoading || !selectedSessionId || (!input.trim() && attachments.length === 0)} aria-label={awaitingReply ? "Queue instruction" : "Send message"} className="ari-chat-send grid h-9 w-9 shrink-0 place-items-center rounded-full text-ari-ink transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ari-focus disabled:cursor-not-allowed disabled:shadow-none">{sending ? <Spinner /> : <ArrowUpIcon />}</button>}
                  </div>
                </div>
              </form>
            </div>
          </div>
        </main>
      </div>
      {renamingSession && <div className="fixed inset-0 z-50 grid place-items-center bg-[#241f2c]/20 px-4" role="dialog" aria-modal="true" aria-labelledby="rename-chat-title">
        <form onSubmit={saveChatTitle} className="w-full max-w-[420px] rounded-2xl border border-[#e2dee7] bg-white p-6 shadow-[0_24px_70px_rgba(39,31,50,0.18)]">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 id="rename-chat-title" className="text-[18px] font-semibold tracking-[-0.025em] text-[#302a35]">Rename session</h2>
              <p className="mt-1 text-[13px] text-[#766f7c]">Keep it short and recognizable.</p>
            </div>
            <button type="button" onClick={() => setRenamingSessionId(null)} aria-label="Close rename dialog" className="grid h-7 w-7 place-items-center rounded-md text-[#766f7c] transition hover:bg-[#f3f1f5] hover:text-[#302a35]">×</button>
          </div>
          <input autoFocus value={renameTitle} onChange={(event) => setRenameTitle(event.target.value)} maxLength={120} aria-label="Session title" className="mt-5 h-11 w-full rounded-xl border border-ari-border bg-white px-3 text-[14px] text-ari-text outline-none transition focus:border-[#dec51f] focus:ring-2 focus:ring-[#f7dd2a]/20" />
          {renameError && <p role="alert" className="mt-2 text-xs text-red-700">{renameError}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" onClick={() => setRenamingSessionId(null)} className="h-9 rounded-lg border border-ari-border px-3.5 text-[13px] font-medium text-ari-muted transition hover:bg-ari-subtle">Cancel</button>
            <button type="submit" disabled={renaming || !renameTitle.trim()} className="h-9 rounded-lg bg-[#302a35] px-4 text-[13px] font-semibold text-white transition hover:bg-[#1f1b24] disabled:cursor-not-allowed disabled:opacity-45">{renaming ? "Saving…" : "Save"}</button>
          </div>
        </form>
      </div>}
      {previewAttachment && <FilePreviewDialog attachment={previewAttachment} onClose={() => setPreviewAttachment(null)} />}
    </div>
  );
}

function QueuedInstructionTray({
  instructions,
  onSteer,
  onDelete,
}: {
  instructions: QueuedInstruction[];
  onSteer: (instructionId: string) => void;
  onDelete: (instructionId: string) => void;
}) {
  return <div className="mb-2 space-y-1.5" aria-label="Queued instructions">
    {instructions.map((instruction) => <div key={instruction.id} className="flex items-center gap-3 rounded-[14px] border border-ari-border bg-ari-subtle px-4 py-2.5 shadow-[0_1px_2px_rgba(38,8,5,0.04)]">
      <span className="text-[13px] text-[#746d7b]" aria-hidden="true">↳</span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-ari-text">{instruction.text}</span>
      {instruction.mode === "steering" ? <span className="shrink-0 text-[11px] font-medium text-ari-ink">Steering…</span> : <button type="button" onClick={() => onSteer(instruction.id)} className="shrink-0 rounded-md px-2 py-1 text-[11px] font-medium text-ari-muted transition hover:bg-white hover:text-ari-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ari-focus">↪ Steer</button>}
      <button type="button" onClick={() => onDelete(instruction.id)} aria-label={`Delete queued instruction: ${instruction.text}`} title="Delete queued instruction" className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-ari-muted transition hover:bg-white hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ari-focus"><TrashIcon /></button>
    </div>)}
  </div>;
}

function HomeWelcome({ onChoose }: { onChoose: (prompt: string) => void }) {
  const prompts = [
    { label: "Review CRM and follow-ups", prompt: "Review my CRM pipeline and follow-ups, then suggest the next actions." },
    { label: "Create an email campaign", prompt: "Help me create an email campaign for the right contact group." },
    { label: "Summarize a meeting", prompt: "Summarize my latest meeting and identify decisions, action items, and next steps." },
    { label: "Plan team priorities", prompt: "Review my team's work and help me plan today's priorities." },
  ];
  return (
    <div className="ari-home-welcome mx-auto my-auto flex w-full flex-col items-center px-5 py-12 text-center sm:py-16">
      <div className="ari-home-mark mb-7 grid h-12 w-12 place-items-center rounded-full bg-ari-accent text-ari-ink" aria-hidden="true"><AriBoltIcon /></div>
      <h1 className="max-w-[640px] text-[30px] font-medium leading-[1.16] tracking-[-0.04em] text-ari-ink sm:text-[36px]">What should we work on today?</h1>
      <p className="mt-3 max-w-md text-[13px] leading-5 text-ari-muted">Choose a starting point or ask Ari to coordinate work across your team.</p>
      <div className="mt-10 grid w-full max-w-[820px] gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {prompts.map((item, index) => <button type="button" key={item.label} onClick={() => onChoose(item.prompt)} className="ari-home-prompt-card flex min-h-[136px] flex-col items-center justify-center rounded-[14px] px-5 py-5 text-center text-[13px] font-medium leading-[1.45] text-ari-ink transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ari-focus"><HomeActionIcon index={index} /><span className="mt-5">{item.label}</span></button>)}
      </div>
    </div>
  );
}

function ConversationMessage({ message, onPreview }: { message: Msg; onPreview: (attachment: ChatAttachment) => void }) {
  const isUser = message.role === "user";
  return (
    <article id={`message-${message.id}`} className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      {isUser ? (
        <div className="max-w-[72%]">
          <div className="ari-message-user rounded-[18px] rounded-br-[6px] px-4 py-2.5 font-sans text-[14px] leading-5 text-ari-text">
            <div className="whitespace-pre-wrap break-words">{message.content}</div>
            {message.attachments?.length ? <div className="mt-2 flex flex-wrap gap-2">{message.attachments.map((attachment) => <AttachmentCard key={attachment.id} attachment={attachment} onPreview={onPreview} />)}</div> : null}
          </div>
        </div>
      ) : (
        <div className="ari-message-assistant flex max-w-[680px] items-start px-1 py-1">
          <div className="min-w-0 pt-0.5 font-sans">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-[12px] font-semibold tracking-[-0.01em]">Ari</span>
            </div>
            <div className="ari-markdown text-[14px] leading-6 text-[#302a35]">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}

function AttachmentCard({ attachment, onPreview }: { attachment: ChatAttachment; onPreview: (attachment: ChatAttachment) => void }) {
  return <button type="button" onClick={() => onPreview(attachment)} className="flex max-w-full items-center gap-2 rounded-lg border border-ari-border bg-white px-2.5 py-2 text-left text-ari-text transition hover:border-ari-border-strong hover:bg-ari-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ari-focus">
    <DocumentIcon />
    <span className="min-w-0"><span className="block max-w-[220px] truncate text-[12px] font-medium">{attachment.fileName}</span><span className="block text-[10px] text-ari-muted">Attached document</span></span>
  </button>;
}

function FilePreviewDialog({ attachment, onClose }: { attachment: ChatAttachment; onClose: () => void }) {
  const isPdf = attachment.mimeType === "application/pdf";
  const isImage = attachment.mimeType.startsWith("image/");
  return <div className="fixed inset-0 z-[60] grid place-items-center bg-[#241f2c]/30 p-4" role="dialog" aria-modal="true" aria-label={`Preview ${attachment.fileName}`} onMouseDown={onClose}>
    <section className="flex max-h-[82vh] w-full max-w-[760px] flex-col overflow-hidden rounded-2xl border border-[#e2dee7] bg-white shadow-[0_24px_70px_rgba(39,31,50,0.22)]" onMouseDown={(event) => event.stopPropagation()}>
      <header className="flex items-center justify-between border-b border-ari-border px-5 py-3.5"><div className="min-w-0"><p className="truncate text-[14px] font-semibold text-ari-text">{attachment.fileName}</p><p className="mt-0.5 text-[11px] text-ari-muted">Document preview</p></div><button type="button" onClick={onClose} aria-label="Close preview" className="grid h-8 w-8 place-items-center rounded-lg text-ari-muted hover:bg-ari-subtle">×</button></header>
      <div className="min-h-0 flex-1 overflow-auto bg-ari-subtle p-4">
        {isPdf ? <iframe title={attachment.fileName} src={attachment.url} className="h-[62vh] w-full rounded-lg border border-ari-border bg-white" /> : isImage ? <img src={attachment.url} alt={attachment.fileName} className="mx-auto max-h-[62vh] rounded-lg bg-white object-contain" /> : <div className="grid min-h-[260px] place-items-center rounded-xl border border-dashed border-ari-border-strong bg-white p-8 text-center"><div><DocumentIcon /><p className="mt-3 text-[14px] font-semibold text-ari-text">Spreadsheet ready to open</p><p className="mt-1 max-w-sm text-[12px] leading-5 text-ari-muted">Open this workbook in Excel or another spreadsheet app to view and edit its sheets.</p></div></div>}
      </div>
      <footer className="flex justify-end border-t border-[#ece9ef] px-5 py-3"><a href={attachment.url} download={attachment.fileName} className="rounded-lg bg-[#302a35] px-3.5 py-2 text-[12px] font-semibold text-white hover:bg-[#1f1b24]">Open file</a></footer>
    </section>
  </div>;
}

function AgentActivityPanel({ activities, onStop }: { activities: AgentActivity[]; onStop: () => void }) {
  const current = activities.at(-1);
  const previous = activities.filter((activity) => activity !== current).slice(-3);
  const [expanded, setExpanded] = useState(true);
  if (!current) return null;
  const running = current.state === "running";
  const statusLabel = current.state === "success"
    ? "Completed"
    : current.state === "waiting" ? current.label : "Stopped";

  return (
    <section className="ari-agent-progress max-w-[650px]" aria-live="polite" aria-label={running ? "Ari activity in progress" : `Ari activity ${statusLabel.toLowerCase()}`}>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} className="ari-agent-progress-summary inline-flex items-center gap-1.5 rounded-md py-1 text-left text-[13px] text-ari-muted transition hover:text-ari-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ari-focus">{running && <span className="ari-live-dot" />}<span>{running ? "Working" : statusLabel}</span><ChevronIcon expanded={expanded} /></button>
        <span className="text-[#d7d2db]">&middot;</span>
        <span className="text-[11px] text-[#9b94a1]">{previous.filter((activity) => activity.state === "success").length} step{previous.filter((activity) => activity.state === "success").length === 1 ? "" : "s"} complete</span>
        {running && <button type="button" onClick={onStop} className="ml-auto rounded-md px-2 py-1 text-[11px] font-medium text-ari-muted transition hover:bg-ari-nav hover:text-ari-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ari-focus">Stop</button>}
      </div>
      {expanded && <div className="ari-agent-progress-body mt-3 border-t border-[#ece9ef] pt-3">
        <div className="ari-agent-live flex items-start gap-2.5 rounded-lg px-2.5 py-2">
          <span className="ari-activity-glyph grid h-6 w-6 shrink-0 place-items-center rounded-md" aria-hidden="true">{running ? <AriActivityIcon /> : <ActivityMark state={current.state} />}</span>
          <div className="min-w-0 flex-1"><p className="text-[12.5px] font-medium tracking-[-0.01em] text-[#413a49]">{current.label}</p>{running && <LiveSignal />}</div>
        </div>
        {previous.length > 0 && <div className="mt-2 space-y-1.5 border-l border-dashed border-[#ddd8e1] pl-4">
          {previous.map((activity) => <div key={`${activity.key}:${activity.eventId}`} className="flex items-center gap-2 text-[11px] text-ari-muted"><ActivityMark state={activity.state} /><span>{activity.label}</span></div>)}
        </div>}
      </div>}
    </section>
  );
}

function ActivityMark({ state }: { state: AgentActivity["state"] }) {
  if (state === "running") return <Spinner />;
  const waiting = state === "waiting";
  return <span className={`grid h-4 w-4 shrink-0 place-items-center rounded-full text-[9px] font-bold ${state === "success" || waiting ? "bg-ari-accent text-ari-ink" : "bg-red-500 text-white"}`}>{state === "success" ? "✓" : waiting ? "…" : "!"}</span>;
}

function ThinkingRow({ prompt, onStop }: { prompt: string; onStop: () => void }) {
  const lines = useMemo(() => taskStatusLines(prompt), [prompt]);
  const [lineIndex, setLineIndex] = useState(0);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    setLineIndex(0);
    const handle = window.setInterval(() => setLineIndex((current) => (current + 1) % lines.length), 3600);
    return () => window.clearInterval(handle);
  }, [lines]);

  return (
    <section className="ari-agent-progress max-w-[650px]" aria-live="polite" aria-atomic="true">
      <div className="flex items-center gap-2"><button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} className="ari-agent-progress-summary inline-flex items-center gap-1.5 rounded-md py-1 text-left text-[13px] text-ari-muted transition hover:text-ari-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ari-focus"><span className="ari-live-dot" /><span>Working</span><ChevronIcon expanded={expanded} /></button><button type="button" onClick={onStop} className="ml-auto rounded-md px-2 py-1 text-[11px] font-medium text-ari-muted transition hover:bg-ari-nav hover:text-ari-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ari-focus">Stop</button></div>
      {expanded && <div className="ari-agent-progress-body mt-3 border-t border-[#ece9ef] pt-3"><div className="ari-agent-live flex items-start gap-2.5 rounded-lg px-2.5 py-2"><span className="ari-activity-glyph grid h-6 w-6 shrink-0 place-items-center rounded-md" aria-hidden="true"><AriActivityIcon /></span><div className="min-w-0 flex-1"><p className="text-[12.5px] font-medium tracking-[-0.01em] text-[#413a49]">{lines[lineIndex]}</p><LiveSignal /></div></div></div>}
    </section>
  );
}

function LiveSignal() { return <span className="ari-live-signal mt-2 flex h-1.5 w-24 items-center gap-1" aria-hidden="true"><i /><i /><i /><i /></span>; }
function ChevronIcon({ expanded }: { expanded: boolean }) { return <svg className={`h-3 w-3 transition-transform ${expanded ? "rotate-90" : ""}`} viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>; }

function Spinner() { return <span className="inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-ari-nav-active border-t-[#dec51f]" />; }
function AriBoltIcon() { return <svg width="21" height="21" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m11.5 2.4-7.1 8h4.9l-1 7.2 7.3-8.6h-5.1l1-6.6Z" fill="currentColor" /></svg>; }
function MicrophoneIcon({ recording }: { recording: boolean }) { return recording ? <span className="block h-2.5 w-2.5 rounded-[3px] bg-current" aria-hidden="true" /> : <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.25" y="1.75" width="5.5" height="8" rx="2.75" stroke="currentColor" strokeWidth="1.3" /><path d="M3.5 7.75a4.5 4.5 0 0 0 9 0M8 12.25v2M5.75 14.25h4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>; }
function HomeActionIcon({ index }: { index: number }) {
  const common = { width: 26, height: 26, viewBox: "0 0 28 28", fill: "none", "aria-hidden": true } as const;
  if (index === 0) return <svg {...common}><rect x="5" y="4.5" width="18" height="19" rx="3" stroke="currentColor" strokeWidth="1.35" /><circle cx="11" cy="11" r="2.2" stroke="currentColor" strokeWidth="1.35" /><path d="M7.8 18c.55-2.2 1.7-3.3 3.2-3.3s2.65 1.1 3.2 3.3M17 10h3.5M17 14h3.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" /><path d="M18.5 18h2.5" stroke="#dec51f" strokeWidth="2" strokeLinecap="round" /></svg>;
  if (index === 1) return <svg {...common}><rect x="3.5" y="6" width="21" height="15.5" rx="3" stroke="currentColor" strokeWidth="1.35" /><path d="m5 8 9 7 9-7" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" /><circle cx="22" cy="20.5" r="3.5" fill="white" stroke="#dec51f" strokeWidth="1.4" /></svg>;
  if (index === 2) return <svg {...common}><circle cx="10" cy="10" r="3" stroke="currentColor" strokeWidth="1.35" /><circle cx="19" cy="11" r="2.5" stroke="currentColor" strokeWidth="1.35" /><path d="M4.5 21c.7-4 2.55-6 5.5-6s4.8 2 5.5 6M16 20.5c.4-3.1 1.8-4.65 4.2-4.65 1.2 0 2.25.45 3.15 1.35" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" /><path d="M19.5 5.5h4v3" stroke="#dec51f" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  return <svg {...common}><rect x="5" y="3.5" width="18" height="21" rx="3" stroke="currentColor" strokeWidth="1.35" /><path d="m9 10 1.5 1.5L13 9M15.5 10h3.5M9 17l1.5 1.5L13 16M15.5 17H19" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" /><circle cx="21.5" cy="21" r="3" fill="white" stroke="#dec51f" strokeWidth="1.35" /></svg>;
}
function PlusIcon() { return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round"/></svg>; }
function StopIcon() { return <span aria-hidden="true" className="h-3 w-3 rounded-[3px] bg-current" />; }
function TrashIcon() { return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 4.5h9M6 4.5v-1h4v1m-5.5 0 .5 8h6l.5-8M6.75 6.5v4M9.25 6.5v4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /></svg>; }
function DocumentIcon() { return <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 2.5h5l3 3V13a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 4 13V3a.5.5 0 0 1 .5-.5Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round"/><path d="M9 2.75V5.5h2.75M6 8h4M6 10.5h4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function AriActivityIcon() { return <svg width="15" height="15" viewBox="0 0 18 18" fill="none"><path d="M3 4.25h3.15L9 7.1l2.85-2.85H15M3 13.75h3.15L9 10.9l2.85 2.85H15" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round"/><circle cx="3" cy="4.25" r="1.15" fill="white" stroke="currentColor" strokeWidth="1.2"/><circle cx="15" cy="13.75" r="1.15" fill="white" stroke="currentColor" strokeWidth="1.2"/><path className="ari-activity-core" d="m9 6.5 2.5 2.5L9 11.5 6.5 9 9 6.5Z" fill="currentColor"/></svg>; }
function ArrowUpIcon() { return <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M8 13V3M4.5 6.5 8 3l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
