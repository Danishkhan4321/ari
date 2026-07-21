"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Candidate = {
  assignee: string;
  name: string | null;
  teamNames: string[];
  isCurrentUser: boolean;
};

type Suggestion = {
  suggestionIndex: number;
  title: string;
  reason: string | null;
  suggestedAssignee: string | null;
  suggestedAssigneePhone: string | null;
};

type TaskResult = {
  suggestionIndex: number;
  taskId: number;
  status: "created" | "existing";
  title?: string;
  assignedTo?: string | null;
  teamName?: string | null;
};

type Assignment = { assignee: string; teamName?: string };
type LoadState = "loading" | "ready" | "error";

export function isTaskSelectionReady(selected: ReadonlySet<number>, assignees: Readonly<Record<number, string>>) {
  return selected.size > 0 && [...selected].every((suggestionIndex) => Boolean(assignees[suggestionIndex]));
}

export function mapMeetingTaskErrors(value: unknown, knownIndices: ReadonlySet<number>): Record<number, string> {
  if (!Array.isArray(value)) return {};
  const mapped: Record<number, string> = {};
  for (const item of value) {
    if (!isRecord(item)) continue;
    const suggestionIndex = item.suggestionIndex;
    const error = item.error;
    if (!Number.isSafeInteger(suggestionIndex) || !knownIndices.has(suggestionIndex as number)) continue;
    if (typeof error !== "string" || !error.trim() || error.length > 300) continue;
    mapped[suggestionIndex as number] = error.trim();
  }
  return mapped;
}

export function MeetingTasks({
  meetingId,
  onTasksChanged,
}: {
  meetingId: number;
  onTasksChanged: () => void | Promise<void>;
}) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [taskResults, setTaskResults] = useState<Record<number, TaskResult>>({});
  const [assignments, setAssignments] = useState<Record<number, Assignment>>({});
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const loadGeneration = useRef(0);
  const loadController = useRef<AbortController | null>(null);
  const postController = useRef<AbortController | null>(null);
  const submitting = useRef(false);
  const createButtonRef = useRef<HTMLButtonElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);

  const loadTasks = useCallback(async () => {
    const generation = ++loadGeneration.current;
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setLoadState("loading");
    setError(null);
    setRowErrors({});

    try {
      const response = await fetch(`/api/meetings/${meetingId}/tasks`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const body = await readResponse(response);
      if (!response.ok || body.ok !== true) throw new Error(safeError(body.error, "Meeting tasks could not be loaded."));
      const loadedCandidates = parseCandidates(body.candidates);
      const loadedSuggestions = parseSuggestions(body.suggestions);
      const loadedTasks = parseTaskResults(body.tasks, "created");
      if (!loadedCandidates || !loadedSuggestions || !loadedTasks) throw new Error("Meeting tasks could not be loaded.");
      if (controller.signal.aborted || generation !== loadGeneration.current) return;

      const byAssignee = new Map(loadedCandidates.map((candidate) => [candidate.assignee, candidate]));
      const defaults: Record<number, Assignment> = {};
      for (const suggestion of loadedSuggestions) {
        if (!suggestion.suggestedAssigneePhone) continue;
        const candidate = byAssignee.get(suggestion.suggestedAssigneePhone);
        if (!candidate) continue;
        defaults[suggestion.suggestionIndex] = assignmentForCandidate(candidate);
      }
      setCandidates(loadedCandidates);
      setSuggestions(loadedSuggestions);
      setTaskResults(Object.fromEntries(loadedTasks.map((task) => [task.suggestionIndex, task])));
      setAssignments(defaults);
      setSelected(new Set());
      setLoadState("ready");
    } catch (cause) {
      if (controller.signal.aborted || generation !== loadGeneration.current) return;
      setError(errorMessage(cause, "Meeting tasks could not be loaded."));
      setLoadState("error");
    } finally {
      if (loadController.current === controller) loadController.current = null;
    }
  }, [meetingId]);

  useEffect(() => {
    void loadTasks();
    return () => {
      loadGeneration.current += 1;
      loadController.current?.abort();
      loadController.current = null;
    };
  }, [loadTasks]);

  useEffect(() => () => {
    postController.current?.abort();
    postController.current = null;
    submitting.current = false;
  }, []);

  useEffect(() => {
    if (!confirmOpen) return;
    cancelButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting.current) closeDialog();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [confirmOpen]);

  const suggestionByIndex = useMemo(
    () => new Map(suggestions.map((suggestion) => [suggestion.suggestionIndex, suggestion])),
    [suggestions],
  );
  const candidateByAssignee = useMemo(
    () => new Map(candidates.map((candidate) => [candidate.assignee, candidate])),
    [candidates],
  );
  const rowIndices = useMemo(
    () => [...new Set([...suggestions.map((item) => item.suggestionIndex), ...Object.keys(taskResults).map(Number)])].sort((a, b) => a - b),
    [suggestions, taskResults],
  );
  const selectedAssignees = Object.fromEntries(
    Object.entries(assignments).map(([suggestionIndex, assignment]) => [Number(suggestionIndex), assignment.assignee]),
  );
  const selectionReady = isTaskSelectionReady(selected, selectedAssignees)
    && [...selected].every((suggestionIndex) => isAssignmentReady(assignments[suggestionIndex], candidateByAssignee));
  const selectedPayload = [...selected].flatMap((suggestionIndex) => {
    const assignment = assignments[suggestionIndex];
    return assignment && isAssignmentReady(assignment, candidateByAssignee)
      ? [{ suggestionIndex, assignee: assignment.assignee, ...(assignment.teamName ? { teamName: assignment.teamName } : {}) }]
      : [];
  });

  function closeDialog() {
    if (submitting.current) return;
    setConfirmOpen(false);
    requestAnimationFrame(() => createButtonRef.current?.focus());
  }

  function toggleSelection(suggestionIndex: number) {
    if (taskResults[suggestionIndex] || creating) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(suggestionIndex)) next.delete(suggestionIndex);
      else next.add(suggestionIndex);
      return next;
    });
    setRowErrors((current) => withoutKey(current, suggestionIndex));
  }

  function changeAssignee(suggestionIndex: number, assignee: string) {
    const candidate = candidateByAssignee.get(assignee);
    setAssignments((current) => ({
      ...current,
      [suggestionIndex]: candidate ? assignmentForCandidate(candidate) : { assignee: "" },
    }));
    setRowErrors((current) => withoutKey(current, suggestionIndex));
  }

  function changeTeam(suggestionIndex: number, teamName: string) {
    setAssignments((current) => ({
      ...current,
      [suggestionIndex]: { ...current[suggestionIndex], teamName: teamName || undefined },
    }));
    setRowErrors((current) => withoutKey(current, suggestionIndex));
  }

  async function createTasks() {
    if (submitting.current || !selectionReady || selectedPayload.length !== selected.size) return;
    submitting.current = true;
    setCreating(true);
    setError(null);
    setRowErrors({});
    const controller = new AbortController();
    postController.current = controller;

    try {
      const response = await fetch(`/api/meetings/${meetingId}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tasks: selectedPayload }),
        signal: controller.signal,
      });
      const body = await readResponse(response);
      if (!response.ok || body.ok !== true) {
        const mapped = mapMeetingTaskErrors(body.errors, new Set(selected));
        if (Object.keys(mapped).length > 0) setRowErrors(mapped);
        throw new Error(safeError(body.error, "Meeting tasks could not be created."));
      }
      const results = parseTaskResults(body.tasks);
      if (!results) throw new Error("Meeting tasks could not be created.");
      if (controller.signal.aborted) return;
      setTaskResults((current) => {
        const next = { ...current };
        for (const result of results) next[result.suggestionIndex] = result;
        return next;
      });
      setSelected(new Set());
      setConfirmOpen(false);
      await Promise.resolve(onTasksChanged()).catch(() => undefined);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(errorMessage(cause, "Meeting tasks could not be created."));
        setConfirmOpen(false);
      }
    } finally {
      if (postController.current === controller) postController.current = null;
      if (!controller.signal.aborted) setCreating(false);
      submitting.current = false;
    }
  }

  if (loadState === "loading") {
    return <p className="text-[11px] text-[#68635e]" role="status">Loading task suggestions…</p>;
  }

  if (loadState === "error") {
    return (
      <div className="border-l-2 border-[#b85d4a] pl-3" role="alert">
        <p className="text-[10.5px] leading-5 text-[#963f2f]">{error}</p>
        <button type="button" onClick={() => void loadTasks()} className="mt-2 text-[11px] font-medium text-[#7c4d34] underline underline-offset-2">Retry</button>
      </div>
    );
  }

  if (rowIndices.length === 0) {
    return <p className="text-[11px] text-[#68635e]">No task suggestions were detected.</p>;
  }

  return (
    <div className="min-w-0">
      <p className="mb-4 text-[10.5px] leading-5 text-[#68635e]">These suggestions require confirmation before any tasks are created or assigned.</p>
      <ul className="divide-y divide-[#eceae6] border-y border-[#eceae6]">
        {rowIndices.map((suggestionIndex) => {
          const suggestion = suggestionByIndex.get(suggestionIndex);
          const result = taskResults[suggestionIndex];
          const assignment = assignments[suggestionIndex];
          const candidate = assignment ? candidateByAssignee.get(assignment.assignee) : undefined;
          const needsTeam = Boolean(candidate && !candidate.isCurrentUser && candidate.teamNames.length > 1);
          const needsAssignee = !result && !isAssignmentReady(assignment, candidateByAssignee);
          return (
            <li key={suggestionIndex} className="min-w-0 py-4">
              <div className="flex min-w-0 items-start gap-3">
                {result ? (
                  <span className="mt-0.5 inline-flex shrink-0 rounded-full bg-[#e9f4ea] px-2 py-0.5 text-[9.5px] font-semibold text-[#35623c]">Created</span>
                ) : (
                  <input
                    type="checkbox"
                    checked={selected.has(suggestionIndex)}
                    onChange={() => toggleSelection(suggestionIndex)}
                    disabled={creating}
                    aria-label={`Select ${suggestion?.title || "suggested task"}`}
                    className="mt-1 h-3.5 w-3.5 shrink-0 accent-[#8c5a3c]"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="break-words text-[12px] font-medium text-[#35312e]">{suggestion?.title || result?.title || "Created meeting task"}</div>
                  {suggestion?.reason && <p className="mt-1 break-words text-[10.5px] leading-5 text-[#68635e]">{suggestion.reason}</p>}
                  {suggestion?.suggestedAssignee && <p className="mt-1 text-[10px] text-[#77716b]">Detected speaker: {suggestion.suggestedAssignee}</p>}

                  {result ? (
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px]">
                      <span className="text-[#68635e]">{resultAssigneeLabel(result, candidateByAssignee)}</span>
                      <a href="/team#tab=tasks" className="font-medium text-[#7c4d34] underline underline-offset-2">View task</a>
                    </div>
                  ) : (
                    <div className="mt-3 grid min-w-0 gap-2 sm:grid-cols-2">
                      <label className="min-w-0 text-[9.5px] font-medium uppercase tracking-[0.06em] text-[#68635e]">
                        Assignee
                        <select
                          value={assignment?.assignee || ""}
                          onChange={(event) => changeAssignee(suggestionIndex, event.target.value)}
                          disabled={creating}
                          className="mt-1 h-8 w-full min-w-0 rounded-[4px] border border-[#d9d7d2] bg-white px-2 text-[10.5px] normal-case tracking-normal text-[#35312e] outline-none focus:border-[#9b765f] focus:ring-2 focus:ring-[#8c5a3c]/10"
                        >
                          <option value="">Select assignee</option>
                          {candidates.map((option) => <option key={option.assignee} value={option.assignee}>{candidateLabel(option)}</option>)}
                        </select>
                      </label>
                      {needsTeam && candidate && (
                        <label className="min-w-0 text-[9.5px] font-medium uppercase tracking-[0.06em] text-[#68635e]">
                          Team
                          <select
                            value={assignment?.teamName || ""}
                            onChange={(event) => changeTeam(suggestionIndex, event.target.value)}
                            disabled={creating}
                            className="mt-1 h-8 w-full min-w-0 rounded-[4px] border border-[#d9d7d2] bg-white px-2 text-[10.5px] normal-case tracking-normal text-[#35312e] outline-none focus:border-[#9b765f] focus:ring-2 focus:ring-[#8c5a3c]/10"
                          >
                            <option value="">Select team</option>
                            {candidate.teamNames.map((teamName) => <option key={teamName} value={teamName}>{teamName}</option>)}
                          </select>
                        </label>
                      )}
                    </div>
                  )}
                  {needsAssignee && <p className="mt-2 text-[10px] font-medium text-[#9a513f]">Needs assignee</p>}
                  {rowErrors[suggestionIndex] && <p className="mt-2 text-[10.5px] leading-5 text-[#963f2f]" role="alert">{rowErrors[suggestionIndex]}</p>}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {error && <p className="mt-3 border-l-2 border-[#b85d4a] pl-3 text-[10.5px] leading-5 text-[#963f2f]" role="alert">{error}</p>}
      <button
        ref={createButtonRef}
        type="button"
        disabled={!selectionReady || creating}
        onClick={() => setConfirmOpen(true)}
        className="mt-4 inline-flex min-h-8 items-center justify-center rounded-[5px] bg-[#6f4935] px-3 text-[11px] font-medium text-white transition-colors hover:bg-[#5e3d2d] disabled:cursor-not-allowed disabled:opacity-45"
      >
        {creating ? "Creating tasks…" : "Create selected tasks"}
      </button>

      {confirmOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-[#24211f]/35 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDialog(); }}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-meeting-task-title"
            aria-describedby="confirm-meeting-task-description"
            className="max-h-[min(80vh,520px)] w-full max-w-md overflow-y-auto rounded-[7px] border border-[#d9d7d2] bg-[#fffdfa] p-5 shadow-xl sm:p-6"
          >
            <h4 id="confirm-meeting-task-title" className="text-[15px] font-semibold text-[#24211f]">Confirm task creation</h4>
            <p id="confirm-meeting-task-description" className="mt-2 text-[11px] leading-5 text-[#68635e]">
              Create {selected.size} {selected.size === 1 ? "task" : "tasks"} with these assignees?
            </p>
            <ul className="mt-4 divide-y divide-[#eceae6] border-y border-[#eceae6]">
              {selectedPayload.map((selection) => {
                const suggestion = suggestionByIndex.get(selection.suggestionIndex);
                const candidate = candidateByAssignee.get(selection.assignee);
                return (
                  <li key={selection.suggestionIndex} className="py-3 text-[11px]">
                    <div className="break-words font-medium text-[#35312e]">{suggestion?.title || "Suggested task"}</div>
                    <div className="mt-1 text-[#68635e]">{candidate ? candidateLabel(candidate, selection.teamName) : "Selected team member"}</div>
                  </li>
                );
              })}
            </ul>
            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button ref={cancelButtonRef} type="button" onClick={closeDialog} disabled={creating} className="min-h-9 rounded-[5px] border border-[#cfcac4] bg-white px-3 text-[11px] font-medium text-[#4f4944] disabled:opacity-50">Cancel</button>
              <button type="button" onClick={() => void createTasks()} disabled={creating} className="min-h-9 rounded-[5px] bg-[#6f4935] px-3 text-[11px] font-medium text-white disabled:cursor-wait disabled:opacity-60">{creating ? "Creating tasks…" : "Create tasks"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function assignmentForCandidate(candidate: Candidate): Assignment {
  if (candidate.isCurrentUser) return { assignee: candidate.assignee };
  return {
    assignee: candidate.assignee,
    ...(candidate.teamNames.length === 1 ? { teamName: candidate.teamNames[0] } : {}),
  };
}

function isAssignmentReady(assignment: Assignment | undefined, candidates: ReadonlyMap<string, Candidate>) {
  if (!assignment?.assignee) return false;
  const candidate = candidates.get(assignment.assignee);
  if (!candidate) return false;
  if (candidate.isCurrentUser) return true;
  if (candidate.teamNames.length === 1) return assignment.teamName === candidate.teamNames[0];
  return Boolean(assignment.teamName && candidate.teamNames.includes(assignment.teamName));
}

function candidateLabel(candidate: Candidate, selectedTeam?: string) {
  const identity = candidate.name || (candidate.isCurrentUser ? "You" : "Team member");
  if (candidate.isCurrentUser) return candidate.name ? `${candidate.name} (you)` : identity;
  const teams = selectedTeam || candidate.teamNames.join(" / ");
  return teams ? `${identity} · ${teams}` : identity;
}

function resultAssigneeLabel(result: TaskResult, candidates: ReadonlyMap<string, Candidate>) {
  const candidate = result.assignedTo ? candidates.get(result.assignedTo) : undefined;
  return candidate ? candidateLabel(candidate, result.teamName || undefined) : "Assigned";
}

function parseCandidates(value: unknown): Candidate[] | null {
  if (!Array.isArray(value)) return null;
  const candidates: Candidate[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.assignee !== "string" || !/^\d{8,15}$/.test(item.assignee)) return null;
    if (item.name !== null && typeof item.name !== "string") return null;
    if (!Array.isArray(item.teamNames) || item.teamNames.some((team) => typeof team !== "string" || !team.trim())) return null;
    if (typeof item.isCurrentUser !== "boolean") return null;
    candidates.push({
      assignee: item.assignee,
      name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : null,
      teamNames: [...new Set(item.teamNames.map((team) => String(team).trim()))],
      isCurrentUser: item.isCurrentUser,
    });
  }
  return candidates;
}

function parseSuggestions(value: unknown): Suggestion[] | null {
  if (!Array.isArray(value)) return null;
  const suggestions: Suggestion[] = [];
  for (const item of value) {
    if (!isRecord(item) || !Number.isSafeInteger(item.suggestionIndex) || (item.suggestionIndex as number) < 0) return null;
    if (typeof item.title !== "string" || !item.title.trim()) return null;
    if (item.reason !== null && typeof item.reason !== "string") return null;
    if (item.suggestedAssignee !== null && typeof item.suggestedAssignee !== "string") return null;
    if (item.suggestedAssigneePhone !== null && (typeof item.suggestedAssigneePhone !== "string" || !/^\d{8,15}$/.test(item.suggestedAssigneePhone))) return null;
    suggestions.push({
      suggestionIndex: item.suggestionIndex as number,
      title: item.title.trim(),
      reason: typeof item.reason === "string" && item.reason.trim() ? item.reason.trim() : null,
      suggestedAssignee: typeof item.suggestedAssignee === "string" && item.suggestedAssignee.trim() ? item.suggestedAssignee.trim() : null,
      suggestedAssigneePhone: typeof item.suggestedAssigneePhone === "string" ? item.suggestedAssigneePhone : null,
    });
  }
  return suggestions;
}

function parseTaskResults(value: unknown, fallbackStatus?: "created"): TaskResult[] | null {
  if (!Array.isArray(value)) return null;
  const tasks: TaskResult[] = [];
  for (const item of value) {
    if (!isRecord(item) || !Number.isSafeInteger(item.suggestionIndex) || !Number.isSafeInteger(item.taskId)) return null;
    const status = item.status === "created" || item.status === "existing" ? item.status : fallbackStatus;
    if (!status) return null;
    tasks.push({
      suggestionIndex: item.suggestionIndex as number,
      taskId: item.taskId as number,
      status,
      ...(typeof item.title === "string" ? { title: item.title } : {}),
      ...(typeof item.assignedTo === "string" || item.assignedTo === null ? { assignedTo: item.assignedTo } : {}),
      ...(typeof item.teamName === "string" || item.teamName === null ? { teamName: item.teamName } : {}),
    });
  }
  return tasks;
}

function withoutKey(value: Record<number, string>, key: number) {
  const next = { ...value };
  delete next[key];
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readResponse(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json().catch(() => ({}));
  return isRecord(body) ? body : {};
}

function safeError(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() && value.length <= 300 ? value.trim() : fallback;
}

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error ? safeError(cause.message, fallback) : fallback;
}
