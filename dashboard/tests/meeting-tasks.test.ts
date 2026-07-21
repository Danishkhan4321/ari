import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { newDb } from "pg-mem";

import {
  buildMeetingTaskValidationFailure,
  findUniqueFullNameMatch,
  findSuggestedTaskDeadline,
  isMeetingTaskCreationReady,
  normalizeSuggestedTasks,
  parsePostgresIntegerId,
  parseMeetingTaskPayload,
  partitionMeetingTaskSelections,
  planMeetingTaskSelections,
  resolveAdministeredTeamAssignment,
  safeMeetingDeadline,
} from "../lib/meeting-tasks";
import { query, withTransaction } from "../lib/db";

const dashboardRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(dashboardRoot, "..");

test("meeting task payload accepts a bounded normalized selection", () => {
  assert.deepEqual(parseMeetingTaskPayload({
    tasks: [{ suggestionIndex: 2, assignee: "919876543210", teamName: "  Product   Team " }],
  }), {
    ok: true,
    value: { tasks: [{ suggestionIndex: 2, assignee: "919876543210", teamName: "Product Team" }] },
  });
});

test("meeting task payload rejects malformed selections", () => {
  const invalid = [
    null,
    {},
    { tasks: "no" },
    { tasks: [] },
    { tasks: [{ suggestionIndex: -1, assignee: "919876543210" }] },
    { tasks: [{ suggestionIndex: 1.5, assignee: "919876543210" }] },
    { tasks: [{ suggestionIndex: 0, assignee: "1234567" }] },
    { tasks: [{ suggestionIndex: 0, assignee: "1234567890123456" }] },
    { tasks: [{ suggestionIndex: 0, assignee: "+919876543210" }] },
    { tasks: [{ suggestionIndex: 0, assignee: "919876543210", teamName: "x".repeat(101) }] },
    { tasks: [{ suggestionIndex: 0, assignee: "919876543210", extra: true }] },
  ];
  for (const value of invalid) assert.equal(parseMeetingTaskPayload(value).ok, false);
});

test("meeting task payload rejects duplicate indices and more than twenty selections", () => {
  assert.equal(parseMeetingTaskPayload({ tasks: [
    { suggestionIndex: 1, assignee: "919876543210" },
    { suggestionIndex: 1, assignee: "919876543211" },
  ] }).ok, false);
  assert.equal(parseMeetingTaskPayload({ tasks: Array.from({ length: 21 }, (_, suggestionIndex) => ({
    suggestionIndex,
    assignee: "919876543210",
  })) }).ok, false);
});

test("meeting task payload rejects indices above PostgreSQL int32 with an indexed safe error", () => {
  const parsed = parseMeetingTaskPayload({
    tasks: [{ suggestionIndex: 2_147_483_648, assignee: "919876543210" }],
  });
  assert.deepEqual(parsed, {
    ok: false,
    error: "Some tasks need attention.",
    errors: [{ suggestionIndex: 2_147_483_648, error: "Suggestion unavailable." }],
  });
  assert.doesNotMatch(JSON.stringify(parsed), /919876543210|SELECT|INSERT|SQL/i);
});

test("meeting IDs reject values above PostgreSQL int32 before route SQL", () => {
  assert.equal(parsePostgresIntegerId("2147483647"), 2_147_483_647);
  assert.equal(parsePostgresIntegerId("2147483648"), null);
  assert.equal(parsePostgresIntegerId("0"), null);

  const route = fs.readFileSync(path.join(dashboardRoot, "app", "api", "meetings", "[id]", "tasks", "route.ts"), "utf8");
  const parsePosition = route.indexOf("parseMeetingId(params.id)");
  const queryPosition = route.indexOf("query<MeetingRow>");
  assert.ok(parsePosition >= 0 && queryPosition > parsePosition);
  assert.match(route, /Invalid meeting\./);
});

test("meeting task payload rejects every C0 and DEL control in team names", () => {
  for (const codePoint of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
    assert.deepEqual(parseMeetingTaskPayload({
      tasks: [{ suggestionIndex: 0, assignee: "919876543210", teamName: `Product${String.fromCharCode(codePoint)}Team` }],
    }), { ok: false, error: "Select a valid team." });
  }
});

test("full-name matching is normalized, exact, and unique", () => {
  const people = [
    { name: "Alice   Jones", phone: "1" },
    { name: "Bob Smith", phone: "2" },
  ];
  assert.equal(findUniqueFullNameMatch("  ALICE jones ", people)?.phone, "1");
  assert.equal(findUniqueFullNameMatch("Alice", people), null);
  assert.equal(findUniqueFullNameMatch("Bob S", people), null);
  assert.equal(findUniqueFullNameMatch("", people), null);
  assert.equal(findUniqueFullNameMatch("alice jones", [...people, { name: "alice jones", phone: "3" }]), null);
});

test("suggestion normalization accepts canonical own string fields", () => {
  assert.deepEqual(normalizeSuggestedTasks([
    { title: "  Ship   launch notes ", reason: "  Agreed in review  ", suggestedAssignee: " Alice Jones " },
    { title: "Follow up", reason: null, suggestedAssignee: null },
  ]), [
    { title: "Ship launch notes", reason: "Agreed in review", suggestedAssignee: "Alice Jones" },
    { title: "Follow up", reason: null, suggestedAssignee: null },
  ]);
});

test("suggestion normalization strips C0 and DEL controls from every retained string field", () => {
  const controls = `${Array.from({ length: 32 }, (_, index) => String.fromCharCode(index)).join("")}\u007f`;
  const normalized = normalizeSuggestedTasks([{
    title: `Ship${controls}notes`,
    reason: `Agreed${controls}in review`,
    suggestedAssignee: `Alice${controls}Jones`,
  }]);
  assert.deepEqual(normalized, [{
    title: "Ship notes",
    reason: "Agreed in review",
    suggestedAssignee: "Alice Jones",
  }]);
  assert.doesNotMatch(JSON.stringify(normalized), /[\u0000-\u001f\u007f]/);
  assert.equal(normalizeSuggestedTasks([{ title: controls }]), null);
});

test("suggestion normalization rejects malformed and prototype-shaped data", () => {
  const inherited = Object.create({ title: "Inherited title" });
  const invalid = [
    null,
    {},
    [null],
    [["array"]],
    [inherited],
    [{ title: "" }],
    [{ title: "x".repeat(201) }],
    [{ title: "Valid", reason: 4 }],
    [{ title: "Valid", reason: "x".repeat(2001) }],
    [{ title: "Valid", suggestedAssignee: { name: "Alice" } }],
    [{ title: "Valid", constructor: "poison" }],
  ];
  for (const value of invalid) assert.equal(normalizeSuggestedTasks(value), null);
});

test("deadline parsing only accepts explicit safe ISO dates", () => {
  assert.equal(safeMeetingDeadline("2026-07-30"), "2026-07-30T00:00:00.000Z");
  assert.equal(safeMeetingDeadline("2026-07-30T12:30:00+05:30"), "2026-07-30T07:00:00.000Z");
  for (const value of [null, "tomorrow", "2026-02-30", "2026-07-30T12:30:00", 123]) {
    assert.equal(safeMeetingDeadline(value), null);
  }
});

test("suggestion deadlines come only from one exact matching action item", () => {
  const actions = [
    { text: "Ship launch notes", deadline: "2026-07-30" },
    { text: "Call customer", deadline: "tomorrow" },
  ];
  assert.equal(findSuggestedTaskDeadline(" ship   LAUNCH notes ", actions), "2026-07-30T00:00:00.000Z");
  assert.equal(findSuggestedTaskDeadline("Ship", actions), null);
  assert.equal(findSuggestedTaskDeadline("Call customer", actions), null);
  assert.equal(findSuggestedTaskDeadline("Ship launch notes", [...actions, actions[0]]), null);
});

test("linked suggestions are returned as existing and never reserved again", () => {
  const selections = [
    { suggestionIndex: 0, assignee: "919876543210" },
    { suggestionIndex: 1, assignee: "919876543211" },
  ];
  assert.deepEqual(partitionMeetingTaskSelections(selections, new Map([[0, 42]])), {
    existing: [{ suggestionIndex: 0, taskId: 42, status: "existing" }],
    pending: [selections[1]],
  });
});

test("authoritative processing stage gates creation and legacy null stages use status", () => {
  assert.equal(isMeetingTaskCreationReady("completed", "failed"), true);
  assert.equal(isMeetingTaskCreationReady("COMPLETED", "captured"), true);
  for (const stage of ["captured", "failed", "processing", "cancelled", ""]) {
    assert.equal(isMeetingTaskCreationReady(stage, "completed"), false);
  }
  for (const status of ["completed", "done", "complete", "COMPLETED"]) {
    assert.equal(isMeetingTaskCreationReady(null, status), true);
  }
  assert.equal(isMeetingTaskCreationReady(null, "captured"), false);
});

test("existing links are partitioned before changed suggestions or memberships are validated", () => {
  const existingSelection = { suggestionIndex: 4, assignee: "919876543299", teamName: "Deleted team" };
  assert.deepEqual(planMeetingTaskSelections({
    selections: [existingSelection],
    linkedTaskIds: new Map([[4, 88]]),
    suggestions: [],
    currentAssignee: "919876543210",
    memberships: [],
  }), {
    existing: [{ suggestionIndex: 4, taskId: 88, status: "existing" }],
    pending: [],
    errors: [],
  });
});

test("only missing links receive safe indexed suggestion and assignment errors", () => {
  const planned = planMeetingTaskSelections({
    selections: [
      { suggestionIndex: 0, assignee: "919876543299", teamName: "Deleted team" },
      { suggestionIndex: 1, assignee: "919876543299", teamName: "Deleted team" },
      { suggestionIndex: 2, assignee: "919876543210" },
      { suggestionIndex: 9, assignee: "919876543210" },
    ],
    linkedTaskIds: new Map([[0, 42]]),
    suggestions: [
      { title: "Existing", reason: null, suggestedAssignee: null },
      { title: "Needs assignment", reason: null, suggestedAssignee: null },
      { title: "Otherwise valid", reason: null, suggestedAssignee: null },
    ],
    currentAssignee: "919876543210",
    memberships: [],
  });
  assert.deepEqual(planned.existing, [{ suggestionIndex: 0, taskId: 42, status: "existing" }]);
  assert.deepEqual(planned.pending, []);
  assert.deepEqual(planned.errors, [
    { suggestionIndex: 1, error: "Assignment unavailable." },
    { suggestionIndex: 9, error: "Suggestion unavailable." },
  ]);
  assert.deepEqual(buildMeetingTaskValidationFailure(planned.errors), {
    ok: false,
    error: "Some tasks need attention.",
    errors: planned.errors,
  });
  assert.doesNotMatch(JSON.stringify(planned.errors), /919876543299|Deleted team|SELECT|INSERT|SQL/i);
});

test("team assignment requires an exact team and rejects cross-team ambiguity", () => {
  const memberships = [
    { assignee: "919876543211", teamName: "Product" },
    { assignee: "919876543211", teamName: "product" },
  ];
  assert.deepEqual(resolveAdministeredTeamAssignment(
    { assignee: "919876543211", currentAssignee: "919876543210", teamName: "Product" },
    memberships,
  ), { teamName: "Product" });
  assert.equal(resolveAdministeredTeamAssignment(
    { assignee: "919876543211", currentAssignee: "919876543210" },
    memberships,
  ), null);
  assert.deepEqual(resolveAdministeredTeamAssignment(
    { assignee: "919876543210", currentAssignee: "919876543210" },
    memberships,
  ), { teamName: null });
  assert.equal(resolveAdministeredTeamAssignment(
    { assignee: "919876543212", currentAssignee: "919876543210" },
    [{ assignee: "919876543212", teamName: "   " }],
  ), null);
});

test("meeting task link migration enforces idempotency and referential cleanup", () => {
  const migration = fs.readFileSync(path.join(repositoryRoot, "migrations", "28_meeting_task_links.js"), "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS meeting_task_links/i);
  assert.match(migration, /PRIMARY KEY\s*\(meeting_id\s*,\s*suggestion_index\)/i);
  assert.match(migration, /meeting_id[\s\S]*REFERENCES meeting_recordings\s*\(id\)[\s\S]*ON DELETE CASCADE/i);
  assert.match(migration, /task_id[\s\S]*REFERENCES tasks\s*\(id\)[\s\S]*ON DELETE CASCADE/i);
  assert.match(migration, /suggestion_index INTEGER NOT NULL CHECK\s*\(suggestion_index >= 0\)/i);
  assert.match(migration, /idx_meeting_task_links_task_id/i);
  assert.match(migration, /intentionally not reversible/i);
});

test("demo database mirrors meeting task links and exports a transaction boundary", () => {
  const db = fs.readFileSync(path.join(dashboardRoot, "lib", "db.ts"), "utf8");
  assert.match(db, /CREATE TABLE meeting_task_links/i);
  assert.match(db, /FOREIGN KEY\s*\(meeting_id\)[\s\S]*meeting_recordings\s*\(id\)[\s\S]*ON DELETE CASCADE/i);
  assert.match(db, /FOREIGN KEY\s*\(task_id\)[\s\S]*tasks\s*\(id\)[\s\S]*ON DELETE CASCADE/i);
  assert.match(db, /PRIMARY KEY\s*\(meeting_id\s*,\s*suggestion_index\)/i);
  assert.match(db, /export async function withTransaction/);
});

test("pg-mem exercises ownership, task-link commit, rollback restore, and link uniqueness", async () => {
  const memory = newDb();
  memory.public.none(`
    CREATE TABLE meeting_recordings (
      id SERIAL PRIMARY KEY,
      user_phone TEXT,
      team_admin_phone TEXT
    );
    CREATE TABLE tasks (id SERIAL PRIMARY KEY, title TEXT NOT NULL);
    INSERT INTO meeting_recordings (id, user_phone, team_admin_phone)
    VALUES (1, '919876543210', '919876543211');
  `);
  const migration = require(path.join(repositoryRoot, "migrations", "28_meeting_task_links.js")) as {
    up: (pgm: { db: { query: (sql: string) => Promise<void> } }) => Promise<void>;
  };
  await migration.up({ db: { query: async (sql) => memory.public.none(sql) } });
  const MemoryPool = memory.adapters.createPg().Pool;
  const pool = new MemoryPool() as unknown as Pool;
  const previousPool = global.__ari_pg_pool;
  global.__ari_pg_pool = pool;
  try {
    const owned = await query<{ id: number }>(
      "SELECT id FROM meeting_recordings WHERE id = $1 AND (user_phone = $2 OR team_admin_phone = $2)",
      [1, "919876543210"],
    );
    const administered = await query<{ id: number }>(
      "SELECT id FROM meeting_recordings WHERE id = $1 AND (user_phone = $2 OR team_admin_phone = $2)",
      [1, "919876543211"],
    );
    const stranger = await query<{ id: number }>(
      "SELECT id FROM meeting_recordings WHERE id = $1 AND (user_phone = $2 OR team_admin_phone = $2)",
      [1, "919876543299"],
    );
    assert.deepEqual([owned.rowCount, administered.rowCount, stranger.rowCount], [1, 1, 0]);

    await withTransaction(async (client) => {
      const task = await client.query<{ id: number }>("INSERT INTO tasks (title) VALUES ($1) RETURNING id", ["Committed"]);
      await client.query(
        "INSERT INTO meeting_task_links (meeting_id, suggestion_index, task_id, created_by_phone) VALUES (1, 0, $1, $2)",
        [task.rows[0].id, "919876543210"],
      );
    });
    assert.equal((await query<{ count: string }>("SELECT COUNT(*)::text AS count FROM tasks")).rows[0].count, "1");
    assert.equal((await query<{ count: string }>("SELECT COUNT(*)::text AS count FROM meeting_task_links")).rows[0].count, "1");

    // pg-mem's pg adapter parses transaction statements but does not apply SQL ROLLBACK.
    // Its documented O(1) backup is the executable rollback primitive for this emulator.
    const rollbackPoint = memory.backup();
    await assert.rejects(withTransaction(async (client) => {
      const task = await client.query<{ id: number }>("INSERT INTO tasks (title) VALUES ($1) RETURNING id", ["Rolled back"]);
      await client.query(
        "INSERT INTO meeting_task_links (meeting_id, suggestion_index, task_id, created_by_phone) VALUES (1, 1, $1, $2)",
        [task.rows[0].id, "919876543210"],
      );
      throw new Error("force rollback");
    }), /force rollback/);
    rollbackPoint.restore();
    assert.equal((await query<{ count: string }>("SELECT COUNT(*)::text AS count FROM tasks")).rows[0].count, "1");
    assert.equal((await query<{ count: string }>("SELECT COUNT(*)::text AS count FROM meeting_task_links")).rows[0].count, "1");

    await assert.rejects(query(
      "INSERT INTO meeting_task_links (meeting_id, suggestion_index, task_id, created_by_phone) VALUES (1, 0, 1, $1)",
      ["919876543210"],
    ));
  } finally {
    global.__ari_pg_pool = previousPool;
    await pool.end();
  }
});

test("meeting task route scopes ownership, completion, membership, and idempotency", () => {
  const route = fs.readFileSync(path.join(dashboardRoot, "app", "api", "meetings", "[id]", "tasks", "route.ts"), "utf8");
  assert.match(route, /getCurrentUserPhone/);
  assert.match(route, /meetingIdentityCandidates/);
  assert.match(route, /user_phone = ANY\(\$2::text\[\]\) OR team_admin_phone = ANY\(\$2::text\[\]\)/);
  assert.match(route, /FOR UPDATE/);
  assert.match(route, /isMeetingTaskCreationReady\(meeting\.processing_stage, meeting\.status\)/);
  assert.match(route, /meeting_task_links/);
  assert.match(route, /withTransaction/);
  assert.match(route, /admin_phone = ANY\(\$1::text\[\]\)/);
  assert.doesNotMatch(route, /callBotInternal|whatsapp/i);
  assert.match(route, /partitionMeetingTaskSelections/);
  assert.match(route, /status: "created"/);
  assert.match(route, /buildMeetingTaskValidationFailure\(error\.errors\)/);
  assert.match(route, /buildMeetingTaskValidationFailure\(payload\.errors\)/);
});
