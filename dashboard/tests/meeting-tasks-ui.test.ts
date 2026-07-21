import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { isTaskSelectionReady, mapMeetingTaskErrors } from "../app/meetings/meeting-tasks";

const dashboardRoot = path.resolve(__dirname, "..");

test("selected meeting tasks are ready only when every selection has an assignee", () => {
  assert.equal(isTaskSelectionReady(new Set<number>(), {}), false);
  assert.equal(isTaskSelectionReady(new Set([0, 2]), { 0: "919876543210", 2: "919876543211" }), true);
  assert.equal(isTaskSelectionReady(new Set([0, 2]), { 0: "919876543210", 2: "" }), false);
});

test("meeting task errors map only safe indexed messages to known suggestion rows", () => {
  assert.deepEqual(mapMeetingTaskErrors([
    { suggestionIndex: 2, error: "Assignment unavailable." },
    { suggestionIndex: 5, error: "x".repeat(301) },
    { suggestionIndex: 9, error: "Unknown row" },
    { suggestionIndex: 1, error: 44 },
  ], new Set([2, 5])), { 2: "Assignment unavailable." });
  assert.deepEqual(mapMeetingTaskErrors(null, new Set([2])), {});
});

test("meeting task confirmation UI covers loading, retry, confirmation, and row results", () => {
  const source = fs.readFileSync(path.join(dashboardRoot, "app", "meetings", "meeting-tasks.tsx"), "utf8");
  for (const contract of [
    "Create selected tasks",
    "Confirm task creation",
    "Retry",
    "View task",
    "Created",
    "Needs assignee",
  ]) assert.match(source, new RegExp(contract));
  assert.match(source, /fetch\(`\/api\/meetings\/\$\{meetingId\}\/tasks`/);
  assert.match(source, /method:\s*"POST"/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /mapMeetingTaskErrors/);
  assert.match(source, /AbortController/);
  assert.match(source, /onTasksChanged/);
  assert.match(source, /href="\/team#tab=tasks"/);
});

test("meetings list selects timestamps and a correlated created task count", () => {
  const source = fs.readFileSync(path.join(dashboardRoot, "app", "api", "meetings", "list", "route.ts"), "utf8");
  assert.match(source, /created_at/);
  assert.match(source, /updated_at/);
  assert.match(source, /meeting_task_links/);
  assert.match(source, /COUNT\s*\(\s*\*\s*\)/i);
  assert.match(source, /created_task_count/);
  assert.match(source, /ORDER BY (?:mr\.)?id DESC/);
  assert.match(source, /LIMIT 100/);
});
