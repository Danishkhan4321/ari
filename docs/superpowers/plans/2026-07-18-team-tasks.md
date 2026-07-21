# Team Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fully functional team-scoped Tasks tab with creation, discovery, filtering, editing, reassignment, completion, reopening, and deletion.

**Architecture:** Add explicit team ownership to task rows, expose team-scoped list and mutation APIs, and render a focused client section inside the existing Team tab system. Preserve personal task behavior and include a compatibility path for historical delegated tasks.

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript, PostgreSQL/pg-mem, Tailwind CSS, Node test runner

---

### Task 1: Team task schema and validation

**Files:**
- Create: `migrations/27_team_task_ownership.js`
- Modify: `src/services/task.service.js`
- Modify: `dashboard/lib/db.ts`
- Modify: `dashboard/lib/team-task.ts`
- Test: `dashboard/tests/team-tasks.test.ts`

- [x] Add nullable `team_admin_phone` and `team_name` columns plus a team/status index in both migration and runtime schema paths.
- [x] Extend task parsing with an update parser that accepts title, description, assignee, due date, priority, and status using the same limits as create.
- [x] Add parser tests, run `npm test -- --test-name-pattern="team task"`, and confirm invalid assignees, titles, dates, priorities, and statuses fail.

### Task 2: Team-scoped task APIs

**Files:**
- Modify: `dashboard/app/api/team/[name]/tasks/route.ts`
- Create: `dashboard/app/api/team/[name]/tasks/[id]/route.ts`
- Test: `dashboard/tests/team-workspace.test.ts`

- [x] Add `GET` to return selected-team tasks joined to member names and include legacy tasks assigned by the current user to a selected-team member.
- [x] Write team ownership fields in `POST`:

```sql
INSERT INTO tasks (..., team_admin_phone, team_name)
VALUES (..., $adminPhone, $teamName)
```

- [x] Add authorized `PATCH` for edits/status transitions and `DELETE` for confirmed removal.
- [x] Assert the routes expose GET/POST/PATCH/DELETE and enforce team membership, then run the targeted tests.

### Task 3: Team task interface

**Files:**
- Create: `dashboard/app/team/team-tasks-section.tsx`
- Modify: `dashboard/app/team/team-task-modal.tsx`
- Modify: `dashboard/app/team/team-content.tsx`
- Test: `dashboard/tests/team-workspace.test.ts`

- [x] Add `Tasks` to `TeamTab` and lazy-load the section.
- [x] Build summary metrics, search, assignee/status/priority filters, sort, responsive task rows/cards, and pagination.
- [x] Implement View, Edit/Reassign, Complete/Reopen, and confirmed Delete actions with loading, empty, error, and success states.
- [x] Reuse the task modal for create/edit, validate required fields, and refresh the Tasks section after a successful assignment.
- [x] Run the Team workspace tests and type checker.

### Task 4: Integrated verification

**Files:**
- Verify only

- [x] Run `npm test` in `dashboard` and confirm zero failures.
- [x] Run `npm run typecheck` in `dashboard` and confirm zero errors.
- [x] Run `npm run build` in `dashboard` and confirm exit code 0.
- [x] Open `/team#tab=tasks` and exercise tab navigation, search, each filter, sort, pagination, create validation, view, edit/reassign, status change, delete confirmation/cancel, and responsive layout.
