import assert from "node:assert/strict";
import test from "node:test";

import { parseTeamTaskInput, parseTeamTaskUpdateInput } from "../lib/team-task";

test("team task create parser accepts complete valid input", () => {
  const result = parseTeamTaskInput({
    assignee: "+91 98765 41201",
    title: "  Review onboarding   handoff ",
    description: "Check the launch checklist.",
    due_at: "2026-07-21T10:30:00.000Z",
    priority: "high",
    status: "in_progress",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.assignee, "919876541201");
    assert.equal(result.value.title, "Review onboarding handoff");
  }
});

test("team task create parser rejects missing required values", () => {
  assert.equal(parseTeamTaskInput({}).ok, false);
  assert.equal(parseTeamTaskInput({ assignee: "12", title: "Task", due_at: "2026-07-21" }).ok, false);
  assert.equal(parseTeamTaskInput({ assignee: "919876541201", title: "", due_at: "2026-07-21" }).ok, false);
  assert.equal(parseTeamTaskInput({ assignee: "919876541201", title: "Task", due_at: "not-a-date" }).ok, false);
});

test("team task update parser accepts partial status and full edits", () => {
  assert.deepEqual(parseTeamTaskUpdateInput({ status: "completed" }), { ok: true, value: { status: "completed" } });
  const edit = parseTeamTaskUpdateInput({
    assignee: "919876541202",
    title: "Prepare launch FAQ",
    description: "",
    due_at: "2026-07-25T12:00:00.000Z",
    priority: "medium",
    status: "pending",
  });
  assert.equal(edit.ok, true);
  if (edit.ok) assert.equal(edit.value.description, null);
});

test("team task update parser rejects invalid or empty changes", () => {
  assert.equal(parseTeamTaskUpdateInput({}).ok, false);
  assert.equal(parseTeamTaskUpdateInput({ priority: "urgent" }).ok, false);
  assert.equal(parseTeamTaskUpdateInput({ status: "blocked" }).ok, false);
  assert.equal(parseTeamTaskUpdateInput({ due_at: "tomorrow-ish" }).ok, false);
});
