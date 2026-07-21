import assert from "node:assert/strict";
import test from "node:test";

import { taskStatusLines, taskStatusTheme } from "../lib/task-status";

test("selects a concise status voice from the request domain", () => {
  assert.equal(taskStatusTheme("Review my pipeline and follow up with Priya"), "crm");
  assert.equal(taskStatusTheme("Prepare me for tomorrow's meeting"), "meetings");
  assert.equal(taskStatusTheme("Summarize the team's handoffs"), "team");
  assert.equal(taskStatusTheme("Draft a reply to this email"), "communication");
  assert.equal(taskStatusTheme("Plan my tasks for today"), "personal");
  assert.equal(taskStatusTheme("Help me sort this out"), "general");
});

test("uses restrained, task-related copy instead of generic loading language", () => {
  assert.deepEqual(taskStatusLines("Show my open deals"), [
    "Following the deal trail",
    "Reading the pipeline signals",
    "Lining up the next move",
  ]);
  assert.doesNotMatch(taskStatusLines("Do this").join(" "), /loading|understanding your request|please wait/i);
});
