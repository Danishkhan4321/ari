import { NextResponse } from "next/server";

import { query, withTransaction, type TransactionClient } from "@/lib/db";
import {
  buildMeetingTaskValidationFailure,
  findSuggestedTaskDeadline,
  findUniqueFullNameMatch,
  isMeetingTaskCreationReady,
  normalizeHumanText,
  normalizeSuggestedTasks,
  parseMeetingTaskPayload,
  parsePostgresIntegerId as parseMeetingId,
  partitionMeetingTaskSelections,
  planMeetingTaskSelections,
  type MeetingTaskIndexedError,
  type SuggestedMeetingTask,
} from "@/lib/meeting-tasks";
import { getCurrentUserPhone } from "@/lib/session";
import { meetingIdentityCandidates } from "@/lib/meeting-phone";

export const dynamic = "force-dynamic";

type MeetingRow = {
  id: number;
  title: string | null;
  status: string | null;
  processing_stage: string | null;
  suggested_tasks: unknown;
  action_items: unknown;
};

type TeamMemberRow = {
  team_name: string;
  member_phone: string;
  member_name: string | null;
};

type LinkRow = {
  suggestion_index: number;
  task_id: number;
  title: string;
  assigned_to: string | null;
  team_name: string | null;
};

type Candidate = {
  assignee: string;
  name: string | null;
  teamNames: string[];
  isCurrentUser: boolean;
};

type CreatedResult = {
  suggestionIndex: number;
  taskId: number;
  status: "created" | "existing";
};

class MeetingTaskRequestError extends Error {
  constructor(readonly status: number, message: string, readonly errors?: readonly MeetingTaskIndexedError[]) {
    super(message);
  }
}

function phoneDigits(value: string): string {
  return value.replace(/\D/g, "");
}

function parseRetainedArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeMeetingTitle(value: string | null): string {
  const normalized = normalizeHumanText(String(value || "").replace(/[\u0000-\u001f\u007f]/g, " "));
  return normalized.slice(0, 200) || "Untitled meeting";
}

function buildCandidates(userPhone: string, members: readonly TeamMemberRow[]): Candidate[] {
  const currentDigits = phoneDigits(userPhone);
  const byPhone = new Map<string, Candidate>();
  byPhone.set(currentDigits, { assignee: currentDigits, name: null, teamNames: [], isCurrentUser: true });

  for (const member of members) {
    const assignee = phoneDigits(member.member_phone);
    if (!/^\d{8,15}$/.test(assignee)) continue;
    const teamName = normalizeHumanText(member.team_name || "");
    if (!teamName) continue;
    const current = byPhone.get(assignee) || {
      assignee,
      name: null,
      teamNames: [],
      isCurrentUser: assignee === currentDigits,
    };
    if (!current.name && typeof member.member_name === "string") {
      const name = normalizeHumanText(member.member_name);
      current.name = name.slice(0, 200) || null;
    }
    if (!current.teamNames.includes(teamName)) current.teamNames.push(teamName);
    byPhone.set(assignee, current);
  }
  return [...byPhone.values()].filter((candidate) => /^\d{8,15}$/.test(candidate.assignee));
}

function suggestionsForResponse(suggestions: readonly SuggestedMeetingTask[], candidates: readonly Candidate[]) {
  return suggestions.map((suggestion, suggestionIndex) => {
    const matched = findUniqueFullNameMatch(suggestion.suggestedAssignee, candidates);
    return {
      suggestionIndex,
      ...suggestion,
      suggestedAssigneePhone: matched?.assignee || null,
    };
  });
}

async function loadAdministeredMembers(client: TransactionClient | typeof query, identityCandidates: readonly string[]) {
  const runner = typeof client === "function" ? client : client.query.bind(client);
  const result = await runner<TeamMemberRow>(
    `SELECT team_name, member_phone, member_name
       FROM teams
      WHERE admin_phone = ANY($1::text[])
      ORDER BY LOWER(team_name), member_name, member_phone`,
    [identityCandidates],
  );
  return result.rows;
}

async function loadLinks(
  client: TransactionClient | typeof query,
  meetingId: number,
  suggestionIndices?: readonly number[],
) {
  const runner = typeof client === "function" ? client : client.query.bind(client);
  const indexFilter = suggestionIndices
    ? ` AND l.suggestion_index IN (${suggestionIndices.map((_, index) => `$${index + 2}`).join(", ")})`
    : "";
  return runner<LinkRow>(
    `SELECT l.suggestion_index, l.task_id, t.title, t.assigned_to, t.team_name
       FROM meeting_task_links l
       JOIN tasks t ON t.id = l.task_id
      WHERE l.meeting_id = $1${indexFilter}
      ORDER BY l.suggestion_index`,
    [meetingId, ...(suggestionIndices || [])],
  );
}

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });
  const meetingId = parseMeetingId(params.id);
  if (!meetingId) return NextResponse.json({ ok: false, error: "Invalid meeting." }, { status: 400 });
  const identityCandidates = meetingIdentityCandidates(userPhone);

  try {
    const meetingResult = await query<MeetingRow>(
      `SELECT id, title, status, processing_stage, suggested_tasks, action_items
         FROM meeting_recordings
        WHERE id = $1 AND (user_phone = ANY($2::text[]) OR team_admin_phone = ANY($2::text[]))
        LIMIT 1`,
      [meetingId, identityCandidates],
    );
    const meeting = meetingResult.rows[0];
    if (!meeting) return NextResponse.json({ ok: false, error: "Meeting not found." }, { status: 404 });

    const [members, links] = await Promise.all([
      loadAdministeredMembers(query, identityCandidates),
      loadLinks(query, meetingId),
    ]);
    const candidates = buildCandidates(userPhone, members);
    const suggestions = normalizeSuggestedTasks(parseRetainedArray(meeting.suggested_tasks)) || [];
    return NextResponse.json({
      ok: true,
      candidates,
      suggestions: suggestionsForResponse(suggestions, candidates),
      tasks: links.rows.map((link) => ({
        suggestionIndex: link.suggestion_index,
        taskId: link.task_id,
        status: "created" as const,
        title: link.title,
        assignedTo: link.assigned_to,
        teamName: link.team_name,
      })),
    });
  } catch (error) {
    console.error("[MeetingTasks] list failed", error instanceof Error ? error.name : "unknown");
    return NextResponse.json({ ok: false, error: "Meeting tasks could not be loaded." }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });
  const meetingId = parseMeetingId(params.id);
  if (!meetingId) return NextResponse.json({ ok: false, error: "Invalid meeting." }, { status: 400 });
  const identityCandidates = meetingIdentityCandidates(userPhone);

  const payload = parseMeetingTaskPayload(await request.json().catch(() => null));
  if (!payload.ok) {
    return NextResponse.json(
      payload.errors
        ? buildMeetingTaskValidationFailure(payload.errors)
        : { ok: false, error: payload.error },
      { status: 400 },
    );
  }

  try {
    const response = await withTransaction(async (client) => {
      // A retained meeting is the shared lock target for every confirmation request.
      // This prevents two requests from inserting tasks before either can link them.
      const meetingResult = await client.query<MeetingRow>(
        `SELECT id, title, status, processing_stage, suggested_tasks, action_items
           FROM meeting_recordings
          WHERE id = $1 AND (user_phone = ANY($2::text[]) OR team_admin_phone = ANY($2::text[]))
          FOR UPDATE`,
        [meetingId, identityCandidates],
      );
      const meeting = meetingResult.rows[0];
      if (!meeting) throw new MeetingTaskRequestError(404, "Meeting not found.");
      if (!isMeetingTaskCreationReady(meeting.processing_stage, meeting.status)) {
        throw new MeetingTaskRequestError(409, "Meeting processing is not complete.");
      }

      const links = await loadLinks(
        client,
        meetingId,
        payload.value.tasks.map((selection) => selection.suggestionIndex),
      );
      const linkedTaskIds = new Map(links.rows.map((link) => [link.suggestion_index, link.task_id]));
      const partitioned = partitionMeetingTaskSelections(payload.value.tasks, linkedTaskIds);
      const results: CreatedResult[] = [...partitioned.existing];
      if (partitioned.pending.length === 0) {
        return { ok: true as const, tasks: results, created: 0 };
      }

      const suggestions = normalizeSuggestedTasks(parseRetainedArray(meeting.suggested_tasks));
      const members = await loadAdministeredMembers(client, identityCandidates);
      const currentDigits = phoneDigits(userPhone);
      const memberships = members.map((member) => ({
        assignee: phoneDigits(member.member_phone),
        teamName: member.team_name,
      }));
      const planned = planMeetingTaskSelections({
        selections: partitioned.pending,
        linkedTaskIds: new Map(),
        suggestions,
        currentAssignee: currentDigits,
        memberships,
      });
      if (planned.errors.length > 0) {
        throw new MeetingTaskRequestError(400, "Some tasks need attention.", planned.errors);
      }

      const actionItems = parseRetainedArray(meeting.action_items);
      const meetingTitle = safeMeetingTitle(meeting.title);
      for (const { selection, suggestion, teamName } of planned.pending) {
        const description = `From meeting: ${meetingTitle}${suggestion.reason ? `\n\n${suggestion.reason}` : ""}`;
        const created = await client.query<{ id: number }>(
          `INSERT INTO tasks
             (user_phone, title, description, status, priority, due_date, assigned_to, assigned_by,
              team_admin_phone, team_name)
           VALUES ($1, $2, $3, 'pending', 'medium', $4, $5, $1, $6, $7)
           RETURNING id`,
          [
            userPhone,
            suggestion.title,
            description,
            findSuggestedTaskDeadline(suggestion.title, actionItems),
            selection.assignee,
            teamName ? userPhone : null,
            teamName,
          ],
        );
        const taskId = created.rows[0].id;
        await client.query(
          `INSERT INTO meeting_task_links
             (meeting_id, suggestion_index, task_id, created_by_phone)
           VALUES ($1, $2, $3, $4)`,
          [meetingId, selection.suggestionIndex, taskId, userPhone],
        );
        results.push({ suggestionIndex: selection.suggestionIndex, taskId, status: "created" });
      }

      return {
        ok: true as const,
        tasks: results,
        created: results.filter((result) => result.status === "created").length,
      };
    });
    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof MeetingTaskRequestError) {
      return NextResponse.json(
        error.errors
          ? buildMeetingTaskValidationFailure(error.errors)
          : { ok: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[MeetingTasks] create failed", error instanceof Error ? error.name : "unknown");
    return NextResponse.json({ ok: false, error: "Meeting tasks could not be created." }, { status: 500 });
  }
}
