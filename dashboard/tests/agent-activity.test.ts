import assert from "node:assert/strict";
import test from "node:test";

import { isTerminalAgentEvent, reduceAgentActivities, type AgentEvent } from "../lib/agent-activity";

const event = (overrides: Partial<AgentEvent> = {}): AgentEvent => ({
  id: 1,
  run_id: "run-1",
  event_type: "run.started",
  step: 0,
  tool_name: null,
  summary: "Understanding your request",
  created_at: "2026-07-16T12:00:00.000Z",
  ...overrides,
});

test("turns lifecycle events into safe, readable activity states", () => {
  let activities = reduceAgentActivities([], event());
  activities = reduceAgentActivities(activities, event({
    id: 2,
    event_type: "tool.started",
    tool_name: "create_task",
    summary: "Creating the task",
    step: 1,
  }));
  activities = reduceAgentActivities(activities, event({
    id: 3,
    event_type: "tool.succeeded",
    tool_name: "create_task",
    summary: "Task created",
    step: 1,
  }));

  assert.deepEqual(activities.map(({ label, state }) => ({ label, state })), [
    { label: "Reading between the lines", state: "running" },
    { label: "Task created", state: "success" },
  ]);
});

test("replaces stale activity when a new run starts", () => {
  const previous = reduceAgentActivities([], event({
    event_type: "run.failed",
    summary: "Previous request failed",
  }));
  const current = reduceAgentActivities(previous, event({
    id: 7,
    run_id: "run-2",
    event_type: "run.started",
    summary: "Understanding the new request",
  }));

  assert.equal(current.length, 1);
  assert.equal(current[0].runId, "run-2");
  assert.equal(current[0].label, "Reading between the lines");
});

test("turns generic tool events into concise business-aware progress", () => {
  let activities = reduceAgentActivities([], event());
  activities = reduceAgentActivities(activities, event({
    id: 2,
    event_type: "tool.requested",
    tool_name: "ari_search_leads",
    summary: "Preparing the next action",
    step: 1,
  }));
  activities = reduceAgentActivities(activities, event({
    id: 3,
    event_type: "tool.started",
    tool_name: "ari_search_leads",
    summary: "Running Ari Search Leads",
    step: 1,
  }));

  assert.equal(activities.at(-1)?.label, "Following the deal trail");
  assert.equal(activities.some((activity) => activity.key.includes(":planning:")), false);
});

test("does not duplicate a repeated event", () => {
  const first = reduceAgentActivities([], event());
  const repeated = reduceAgentActivities(first, event());
  assert.deepEqual(repeated, first);
});

test("treats partial and cancelled runs as terminal error states", () => {
  for (const eventType of ["run.partial", "run.cancelled"]) {
    const activities = reduceAgentActivities([], event({
      event_type: eventType,
      summary: eventType === "run.partial" ? "CRM outcome is unknown" : "Stopped",
    }));
    assert.equal(activities.at(-1)?.state, "error");
  }
});

test("waiting runs unblock the composer and render as non-error terminal states", () => {
  const cases = [
    ["run.waiting_for_approval", "Waiting for your approval"],
    ["run.waiting_for_user", "Waiting for you"],
  ] as const;

  for (const [eventType, label] of cases) {
    assert.equal(isTerminalAgentEvent(eventType), true);
    const activities = reduceAgentActivities([], event({
      event_type: eventType,
      summary: null,
    }));
    assert.equal(activities.at(-1)?.state, "waiting");
    assert.equal(activities.at(-1)?.label, label);
  }
  assert.equal(isTerminalAgentEvent("run.progress"), false);
});

test("capacity continuation reopens a partial segment as the same running task", () => {
  let activities = reduceAgentActivities([], event({
    id: 20,
    event_type: "run.partial",
    summary: "Reached the per-segment tool capacity",
  }));
  activities = reduceAgentActivities(activities, event({
    id: 21,
    event_type: "run.continuing",
    summary: "Continuing verified progress (1/3)",
  }));

  assert.equal(isTerminalAgentEvent("run.continuing"), false);
  assert.equal(activities.at(-1)?.state, "running");
  assert.match(activities.at(-1)?.label || "", /Continuing verified progress/);
});
