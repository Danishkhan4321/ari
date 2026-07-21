export const MAX_MEETING_TASKS = 20;
export const MAX_TEAM_NAME_LENGTH = 100;
export const MAX_TASK_TITLE_LENGTH = 200;
export const MAX_TASK_REASON_LENGTH = 2_000;
export const MAX_POSTGRES_INTEGER = 2_147_483_647;

export type MeetingTaskSelection = {
  suggestionIndex: number;
  assignee: string;
  teamName?: string;
};

export type MeetingTaskIndexedError = { suggestionIndex: number; error: string };
export type MeetingTaskPayload = { tasks: MeetingTaskSelection[] };
export type ParsedMeetingTaskPayload =
  | { ok: true; value: MeetingTaskPayload }
  | { ok: false; error: string; errors?: readonly MeetingTaskIndexedError[] };

export type SuggestedMeetingTask = {
  title: string;
  reason: string | null;
  suggestedAssignee: string | null;
};

export type ExistingMeetingTaskResult = {
  suggestionIndex: number;
  taskId: number;
  status: "existing";
};

export type AdministeredMembership = { assignee: string; teamName: string };
export type PlannedMeetingTask = {
  selection: MeetingTaskSelection;
  suggestion: SuggestedMeetingTask;
  teamName: string | null;
};

type NamedCandidate = { name: string | null };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

export function normalizeHumanText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function containsControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

export function normalizeRetainedHumanText(value: string): string {
  return normalizeHumanText(value.replace(/[\u0000-\u001f\u007f]+/g, " "));
}

export function normalizeFullName(value: string): string {
  return normalizeHumanText(value).toLocaleLowerCase("en-US");
}

export function parsePostgresIntegerId(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 && id <= MAX_POSTGRES_INTEGER ? id : null;
}

export function parseMeetingTaskPayload(value: unknown): ParsedMeetingTaskPayload {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["tasks"]) || !Array.isArray(value.tasks)) {
    return { ok: false, error: "Select valid meeting tasks." };
  }
  if (value.tasks.length < 1 || value.tasks.length > MAX_MEETING_TASKS) {
    return { ok: false, error: `Select between 1 and ${MAX_MEETING_TASKS} tasks.` };
  }

  const seen = new Set<number>();
  const tasks: MeetingTaskSelection[] = [];
  for (const raw of value.tasks) {
    if (!isPlainRecord(raw) || !hasOnlyKeys(raw, ["suggestionIndex", "assignee", "teamName"])) {
      return { ok: false, error: "Select valid meeting tasks." };
    }
    const suggestionIndex = raw.suggestionIndex;
    if (!Number.isSafeInteger(suggestionIndex) || (suggestionIndex as number) < 0 || seen.has(suggestionIndex as number)) {
      return { ok: false, error: "Each suggestion must be selected once." };
    }
    if ((suggestionIndex as number) > MAX_POSTGRES_INTEGER) {
      return buildMeetingTaskValidationFailure([
        { suggestionIndex: suggestionIndex as number, error: "Suggestion unavailable." },
      ]);
    }
    if (typeof raw.assignee !== "string" || !/^\d{8,15}$/.test(raw.assignee)) {
      return { ok: false, error: "Select a valid assignee." };
    }

    let teamName: string | undefined;
    if (raw.teamName !== undefined) {
      if (typeof raw.teamName !== "string") return { ok: false, error: "Select a valid team." };
      if (containsControlCharacters(raw.teamName)) return { ok: false, error: "Select a valid team." };
      teamName = normalizeHumanText(raw.teamName);
      if (!teamName || teamName.length > MAX_TEAM_NAME_LENGTH) {
        return { ok: false, error: "Select a valid team." };
      }
    }
    seen.add(suggestionIndex as number);
    tasks.push({ suggestionIndex: suggestionIndex as number, assignee: raw.assignee, ...(teamName ? { teamName } : {}) });
  }
  return { ok: true, value: { tasks } };
}

export function normalizeSuggestedTasks(value: unknown): SuggestedMeetingTask[] | null {
  if (!Array.isArray(value)) return null;
  const tasks: SuggestedMeetingTask[] = [];
  for (const raw of value) {
    if (!isPlainRecord(raw)) return null;
    if (Object.keys(raw).some((key) => ["__proto__", "prototype", "constructor"].includes(key))) return null;
    if (!Object.prototype.hasOwnProperty.call(raw, "title") || typeof raw.title !== "string") return null;
    const title = normalizeRetainedHumanText(raw.title);
    if (!title || title.length > MAX_TASK_TITLE_LENGTH) return null;

    const rawReason = Object.prototype.hasOwnProperty.call(raw, "reason") ? raw.reason : null;
    if (rawReason !== null && rawReason !== undefined && typeof rawReason !== "string") return null;
    const reason = typeof rawReason === "string" ? normalizeRetainedHumanText(rawReason) : null;
    if (reason && reason.length > MAX_TASK_REASON_LENGTH) return null;

    const rawAssignee = Object.prototype.hasOwnProperty.call(raw, "suggestedAssignee")
      ? raw.suggestedAssignee
      : null;
    if (rawAssignee !== null && rawAssignee !== undefined && typeof rawAssignee !== "string") return null;
    const suggestedAssignee = typeof rawAssignee === "string" ? normalizeRetainedHumanText(rawAssignee) : null;
    if (suggestedAssignee && suggestedAssignee.length > 200) return null;
    tasks.push({ title, reason: reason || null, suggestedAssignee: suggestedAssignee || null });
  }
  return tasks;
}

export function findUniqueFullNameMatch<T extends NamedCandidate>(name: unknown, candidates: readonly T[]): T | null {
  if (typeof name !== "string") return null;
  const normalized = normalizeFullName(name);
  if (!normalized) return null;
  const matches = candidates.filter((candidate) =>
    typeof candidate.name === "string" && normalizeFullName(candidate.name) === normalized,
  );
  return matches.length === 1 ? matches[0] : null;
}

function isValidIsoCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function safeMeetingDeadline(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return isValidIsoCalendarDate(normalized) ? `${normalized}T00:00:00.000Z` : null;
  }
  const match = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(normalized);
  if (!match || !isValidIsoCalendarDate(match[1])) return null;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function findSuggestedTaskDeadline(title: string, value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const normalizedTitle = normalizeFullName(title);
  const matches = value.filter((raw) =>
    isPlainRecord(raw)
      && Object.prototype.hasOwnProperty.call(raw, "text")
      && typeof raw.text === "string"
      && normalizeFullName(raw.text) === normalizedTitle,
  );
  if (matches.length !== 1) return null;
  return safeMeetingDeadline((matches[0] as Record<string, unknown>).deadline);
}

export function partitionMeetingTaskSelections<T extends Pick<MeetingTaskSelection, "suggestionIndex">>(
  selections: readonly T[],
  linkedTaskIds: ReadonlyMap<number, number>,
): { existing: ExistingMeetingTaskResult[]; pending: T[] } {
  const existing: ExistingMeetingTaskResult[] = [];
  const pending: T[] = [];
  for (const selection of selections) {
    const taskId = linkedTaskIds.get(selection.suggestionIndex);
    if (taskId === undefined) pending.push(selection);
    else existing.push({ suggestionIndex: selection.suggestionIndex, taskId, status: "existing" });
  }
  return { existing, pending };
}

export function isMeetingTaskCreationReady(processingStage: string | null, status: string | null): boolean {
  if (processingStage !== null) return processingStage.trim().toLowerCase() === "completed";
  return ["completed", "done", "complete"].includes(status?.trim().toLowerCase() || "");
}

export function buildMeetingTaskValidationFailure(errors: readonly MeetingTaskIndexedError[]) {
  return {
    ok: false as const,
    error: "Some tasks need attention.",
    errors,
  };
}

export function planMeetingTaskSelections({
  selections,
  linkedTaskIds,
  suggestions,
  currentAssignee,
  memberships,
}: {
  selections: readonly MeetingTaskSelection[];
  linkedTaskIds: ReadonlyMap<number, number>;
  suggestions: readonly SuggestedMeetingTask[] | null;
  currentAssignee: string;
  memberships: readonly AdministeredMembership[];
}): {
  existing: ExistingMeetingTaskResult[];
  pending: PlannedMeetingTask[];
  errors: MeetingTaskIndexedError[];
} {
  const partitioned = partitionMeetingTaskSelections(selections, linkedTaskIds);
  const pending: PlannedMeetingTask[] = [];
  const errors: MeetingTaskIndexedError[] = [];

  for (const selection of partitioned.pending) {
    const suggestion = suggestions?.[selection.suggestionIndex];
    if (!suggestion) {
      errors.push({ suggestionIndex: selection.suggestionIndex, error: "Suggestion unavailable." });
      continue;
    }
    const assignment = resolveAdministeredTeamAssignment(
      { assignee: selection.assignee, currentAssignee, teamName: selection.teamName },
      memberships,
    );
    if (!assignment) {
      errors.push({ suggestionIndex: selection.suggestionIndex, error: "Assignment unavailable." });
      continue;
    }
    pending.push({ selection, suggestion, teamName: assignment.teamName });
  }

  return { existing: partitioned.existing, pending: errors.length === 0 ? pending : [], errors };
}

export function resolveAdministeredTeamAssignment(
  selection: { assignee: string; currentAssignee: string; teamName?: string },
  memberships: readonly AdministeredMembership[],
): { teamName: string | null } | null {
  const assigneeMemberships = memberships.flatMap((membership) => {
    const teamName = normalizeRetainedHumanText(membership.teamName);
    return membership.assignee === selection.assignee && teamName && teamName.length <= MAX_TEAM_NAME_LENGTH
      ? [{ ...membership, teamName }]
      : [];
  });
  if (selection.teamName) {
    const teams = new Map(
      assigneeMemberships
        .filter((membership) => membership.teamName === selection.teamName)
        .map((membership) => [membership.teamName, membership.teamName]),
    );
    return teams.size === 1 ? { teamName: [...teams.values()][0] } : null;
  }
  if (selection.assignee === selection.currentAssignee) return { teamName: null };
  const teams = new Map(
    assigneeMemberships.map((membership) => [membership.teamName, membership.teamName]),
  );
  return teams.size === 1 ? { teamName: [...teams.values()][0] } : null;
}
