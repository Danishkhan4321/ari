import assert from "node:assert/strict";
import test from "node:test";

import { parseTeamTaskInput } from "../lib/team-task";

test("team task input preserves title, optional description, due time, priority and status", () => {
  const parsed = parseTeamTaskInput({
    assignee: "+91 98765 43210",
    title: "Review launch plan",
    description: "Add comments before the team call.",
    due_at: "2026-07-12T14:30:00.000Z",
    priority: "high",
    status: "in_progress",
  });

  assert.deepEqual(parsed, {
    ok: true,
    value: {
      assignee: "919876543210",
      title: "Review launch plan",
      description: "Add comments before the team call.",
      dueAt: "2026-07-12T14:30:00.000Z",
      priority: "high",
      status: "in_progress",
    },
  });
});

test("team task input rejects invalid assignees and dates", () => {
  assert.equal(parseTeamTaskInput({ assignee: "12", title: "Test", due_at: "bad" }).ok, false);
});
