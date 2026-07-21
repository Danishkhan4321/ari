import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Team uses the shared minimal workspace shell and logical navigation", () => {
  const page = read("app/team/page.tsx");
  const content = read("app/team/team-content.tsx");
  assert.match(page, /showHeader=\{false\}/);
  assert.match(page, /team-page/);
  for (const label of ["Overview", "Members", "Tasks", "Team Chat", "Calendar", "Broadcasts", "Settings"]) {
    assert.match(content, new RegExp(`label:.*"${label}"`), label);
  }
});

test("Team tasks expose team-scoped list and protected mutation APIs", () => {
  const listApi = read("app/api/team/[name]/tasks/route.ts");
  const itemApi = read("app/api/team/[name]/tasks/[id]/route.ts");
  assert.match(listApi, /export async function GET/);
  assert.match(listApi, /export async function POST/);
  assert.match(listApi, /team_admin_phone/);
  assert.match(listApi, /resolveTeamAdmin/);
  assert.match(itemApi, /export async function PATCH/);
  assert.match(itemApi, /export async function DELETE/);
  assert.match(itemApi, /selected assignee is not in this team/i);
  assert.match(itemApi, /permission to delete this task/i);
});

test("Team task workspace includes discovery and complete lifecycle controls", () => {
  const content = read("app/team/team-tasks-section.tsx");
  for (const control of ["Search tasks", "Filter by assignee", "Filter by status", "Filter by priority", "Sort tasks", "Assign task", "View", "Edit", "Complete", "Reopen", "Delete task?"]) {
    assert.match(content, new RegExp(control, "i"), control);
  }
  assert.match(content, /CrmPagination/);
  assert.match(content, /CrmConfirm/);
  assert.match(content, /xl:hidden/);
  assert.match(content, /hidden overflow-x-auto xl:block/);
  assert.match(content, /Tasks unavailable/);
  assert.match(content, /No team tasks yet/);
});

test("Team member management includes complete searchable CRUD controls", () => {
  const content = read("app/team/team-content.tsx");
  const api = read("app/api/team/[name]/members/route.ts");
  for (const control of ["Search members", "Filter by role", "Sort members", "Add member", "Bulk invite", "Edit member", "Remove member", "View member"]) {
    assert.match(content, new RegExp(control, "i"), control);
  }
  assert.match(content, /CrmConfirm/);
  assert.match(content, /CrmPagination/);
  assert.match(api, /export async function POST/);
  assert.match(api, /export async function PATCH/);
  assert.match(api, /export async function DELETE/);
  assert.match(api, /ALLOWED_ROLES/);
});

test("Team overview exposes operational status and realistic demo data", () => {
  const content = read("app/team/team-content.tsx");
  const today = read("app/api/team/[name]/today/route.ts");
  const db = read("lib/db.ts");
  for (const metric of ["Members", "Standups today", "Pending approvals", "Open work"]) {
    assert.match(content, new RegExp(metric), metric);
  }
  assert.match(today, /Daily product standup/);
  assert.match(db, /Customer demo/);
  assert.match(db, /CREATE TABLE polls/);
  assert.match(db, /CREATE TABLE leave_requests/);
  assert.match(db, /CREATE TABLE incidents/);
});

test("Team forms expose validation and backend-connected task and invitation flows", () => {
  const content = read("app/team/team-content.tsx");
  const task = read("app/team/team-task-modal.tsx");
  const bulk = read("app/team/bulk-invite-modal.tsx");
  assert.match(content, /A member name is required/);
  assert.match(content, /name and phone are required|Name \+ phone required/);
  assert.match(task, /Assignee, title, and due date are required/);
  assert.match(task, /method: task \? "PATCH" : "POST"/);
  assert.match(bulk, /No valid rows yet/);
  assert.match(bulk, /members\/bulk/);
});
