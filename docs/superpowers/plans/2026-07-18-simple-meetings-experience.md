# Simple Meetings Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the real Meetings page to match the approved simple preview while preserving desktop recording, transcription, reports, retries, playback, speaker naming, and confirmed task creation.

**Architecture:** Keep the existing Next.js page and desktop bridge. Split display logic into focused recorder, history, result, and task-confirmation components; extend the meeting list payload with timestamps and task-link state; add an idempotent meeting-task endpoint that delegates creation to shared task persistence.

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript, Tailwind CSS, PostgreSQL/pg-mem, Node test runner, existing Electron meeting bridge and Node meeting processor.

---

## File map

- Modify `dashboard/app/meetings/page.tsx`: shared-shell page heading only.
- Modify `dashboard/app/meetings/meetings-content.tsx`: selection, polling, search, loading/error states, responsive master-detail layout.
- Modify `dashboard/app/meetings/meeting-recorder.tsx`: approved compact visual states around the unchanged bridge.
- Modify `dashboard/app/meetings/meeting-detail.tsx`: overview/transcript result UI, playback, retry, and speaker naming.
- Create `dashboard/app/meetings/meeting-history.tsx`: searchable meeting list.
- Create `dashboard/app/meetings/meeting-tasks.tsx`: task review, assignee resolution, confirmation, and created state.
- Modify `dashboard/lib/manual-meetings.ts`: meeting timestamps and linked-task types/helpers.
- Create `dashboard/lib/meeting-tasks.ts`: request validation and normalized assignee matching.
- Create `dashboard/app/api/meetings/[id]/tasks/route.ts`: owned-meeting GET/POST task-link endpoint.
- Create `migrations/28_meeting_task_links.js`: idempotent meeting-to-task provenance.
- Modify `dashboard/lib/db.ts`: pg-mem schema and demo data support.
- Modify `dashboard/app/api/meetings/list/route.ts`: timestamps and created-task counts.
- Modify `dashboard/tests/manual-meetings.test.ts`: UI contract and helper tests.
- Create `dashboard/tests/meeting-tasks.test.ts`: validation, matching, authorization, and idempotency tests.

### Task 1: Lock the new meeting view model with tests

**Files:**
- Modify: `dashboard/tests/manual-meetings.test.ts`
- Modify: `dashboard/lib/manual-meetings.ts`

- [ ] **Step 1: Add failing tests for labels, terminal stages, filtering, and task states**

```ts
import { filterMeetings, isMeetingTerminal, meetingStageLabel } from "../lib/manual-meetings";

test("meeting history filtering searches useful fields", () => {
  const meetings = [{ id: 1, title: "Northstar review", capture_platform: "win32", attendees: "Priya", status: "completed" }] as any;
  assert.equal(filterMeetings(meetings, "priya").length, 1);
  assert.equal(filterMeetings(meetings, "missing").length, 0);
});

test("meeting polling stops at terminal stages", () => {
  assert.equal(isMeetingTerminal("completed"), true);
  assert.equal(isMeetingTerminal("failed"), true);
  assert.equal(isMeetingTerminal("transcribing"), false);
  assert.equal(meetingStageLabel("completed"), "Ready");
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd dashboard && npm test -- --test-name-pattern="meeting history|meeting polling"`

Expected: FAIL because `filterMeetings` and `isMeetingTerminal` are not exported.

- [ ] **Step 3: Implement the shared helpers and extend `ManualMeeting`**

```ts
export type MeetingTaskLink = { suggestionIndex: number; taskId: number; status: "created" | "failed" };

export function isMeetingTerminal(stage?: string | null) {
  return ["completed", "failed", "cancelled"].includes(stage || "");
}

export function filterMeetings(meetings: ManualMeeting[], query: string) {
  const term = query.trim().toLowerCase();
  if (!term) return meetings;
  return meetings.filter(meeting => [meeting.title, meeting.capture_platform, meeting.meeting_platform, meeting.attendees, meeting.processing_stage, meeting.status]
    .some(value => String(value || "").toLowerCase().includes(term)));
}
```

Add `created_at`, `updated_at`, and `created_task_count` to `ManualMeeting`; change completed label to `Ready`.

- [ ] **Step 4: Run the helper tests**

Run: `cd dashboard && npm test -- --test-name-pattern="meeting history|meeting polling"`

Expected: PASS.

### Task 2: Build the approved recorder and master-detail page

**Files:**
- Modify: `dashboard/app/meetings/page.tsx`
- Modify: `dashboard/app/meetings/meetings-content.tsx`
- Modify: `dashboard/app/meetings/meeting-recorder.tsx`
- Create: `dashboard/app/meetings/meeting-history.tsx`
- Modify: `dashboard/tests/manual-meetings.test.ts`

- [ ] **Step 1: Add a failing structural contract test**

```ts
test("Meetings uses the approved simple information hierarchy", () => {
  const page = fs.readFileSync(path.join(root, "app/meetings/page.tsx"), "utf8");
  const content = fs.readFileSync(path.join(root, "app/meetings/meetings-content.tsx"), "utf8");
  const history = fs.readFileSync(path.join(root, "app/meetings/meeting-history.tsx"), "utf8");
  assert.match(page, /Record the conversation\. Ari handles everything after\./);
  assert.match(content, /MeetingHistory/);
  assert.match(content, /MeetingDetail/);
  assert.match(history, /Search meetings/);
  assert.doesNotMatch(page, /Recordings, transcripts & reports/);
});
```

- [ ] **Step 2: Run the structural test and verify it fails**

Run: `cd dashboard && npm test -- --test-name-pattern="approved simple information hierarchy"`

Expected: FAIL because `meeting-history.tsx` does not exist.

- [ ] **Step 3: Implement page selection and polling**

Use `selectedId` rather than accordion state. After each load, preserve a valid selection or select the submitted/newest meeting.

```ts
const selected = meetings?.find(meeting => meeting.id === selectedId) || null;
const visible = filterMeetings(meetings || [], search);
const processing = meetings?.some(meeting => !isMeetingTerminal(meeting.processing_stage || meeting.status));
```

Render one bordered `grid lg:grid-cols-[minmax(320px,0.42fr)_minmax(0,0.58fr)]` workspace and stack it below the large breakpoint.

- [ ] **Step 4: Restyle the recorder without changing its transport methods**

Keep `start`, `pauseOrResume`, `stop`, and `cancel` intact. Replace only the JSX and classes so idle, recording, paused, uploading, submitted, unavailable, and error states match the approved strip. Use `aria-live="polite"` for recording and upload messages.

- [ ] **Step 5: Implement `MeetingHistory`**

```tsx
export function MeetingHistory({ meetings, selectedId, query, onQueryChange, onSelect }: Props) {
  return <section aria-label="Meeting history">
    <label className="sr-only" htmlFor="meeting-search">Search meetings</label>
    <input id="meeting-search" value={query} onChange={e => onQueryChange(e.target.value)} placeholder="Search meetings" />
    {meetings.map(meeting => <button key={meeting.id} aria-current={meeting.id === selectedId} onClick={() => onSelect(meeting.id)}>{meeting.title || "Untitled meeting"}</button>)}
  </section>;
}
```

- [ ] **Step 6: Run dashboard tests and typecheck**

Run: `cd dashboard && npm test && npm run typecheck`

Expected: PASS.

### Task 3: Rebuild the meeting result around Overview and Transcript

**Files:**
- Modify: `dashboard/app/meetings/meeting-detail.tsx`
- Modify: `dashboard/tests/manual-meetings.test.ts`

- [ ] **Step 1: Add failing result-contract assertions**

```ts
assert.match(detail, /Overview/);
assert.match(detail, /Transcript/);
assert.match(detail, /Decisions/);
assert.match(detail, /MeetingTasks/);
assert.doesNotMatch(detail, /Complete meeting report/);
```

- [ ] **Step 2: Run the result contract and verify it fails**

Run: `cd dashboard && npm test -- --test-name-pattern="Meetings keeps"`

Expected: FAIL on the new hierarchy.

- [ ] **Step 3: Implement the result state machine**

```ts
const [tab, setTab] = useState<"overview" | "transcript">("overview");
const completed = meeting.processing_stage === "completed";
const failed = meeting.processing_stage === "failed";
```

Show processing or retry before tabs. In Overview, render summary, decisions, and `MeetingTasks`. In Transcript, render speaker rename controls and timestamped segments. Keep signed playback behind the existing Play button.

- [ ] **Step 4: Run tests and typecheck**

Run: `cd dashboard && npm test && npm run typecheck`

Expected: PASS.

### Task 4: Add idempotent confirmed task creation

**Files:**
- Create: `migrations/28_meeting_task_links.js`
- Modify: `dashboard/lib/db.ts`
- Create: `dashboard/lib/meeting-tasks.ts`
- Create: `dashboard/app/api/meetings/[id]/tasks/route.ts`
- Create: `dashboard/tests/meeting-tasks.test.ts`

- [ ] **Step 1: Add failing validation and matching tests**

```ts
test("meeting task input rejects duplicate indices and invalid assignees", () => {
  assert.equal(parseMeetingTaskSelection({ tasks: [{ suggestionIndex: 0, assignee: "abc" }] }).ok, false);
});

test("assignee matching requires one exact normalized team-member name", () => {
  assert.equal(matchMeetingAssignee("Aisha Malik", [{ name: "Aisha Malik", phone: "919999999999" }])?.phone, "919999999999");
  assert.equal(matchMeetingAssignee("Aisha", [{ name: "Aisha Malik", phone: "1" }, { name: "Aisha Khan", phone: "2" }]), null);
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd dashboard && npm test -- --test-name-pattern="meeting task|assignee matching"`

Expected: FAIL because `meeting-tasks.ts` does not exist.

- [ ] **Step 3: Add provenance schema**

```sql
CREATE TABLE IF NOT EXISTS meeting_task_links (
  meeting_id BIGINT NOT NULL REFERENCES meeting_recordings(id) ON DELETE CASCADE,
  suggestion_index INTEGER NOT NULL,
  task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_by_phone TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (meeting_id, suggestion_index)
);
```

Mirror this table in pg-mem initialization.

- [ ] **Step 4: Implement input validation and unique-name matching**

Accept at most 20 rows, nonnegative unique `suggestionIndex` values, task titles up to 200 characters, and 8–15 digit assignee phones. Normalize member names with lowercase and collapsed whitespace; return a match only when exactly one full normalized name matches.

- [ ] **Step 5: Implement owned-meeting GET/POST endpoint**

GET returns existing links. POST:

1. verifies current session;
2. locks the owned completed meeting;
3. validates that each index exists in `suggested_tasks`;
4. verifies selected assignees belong to the resolved team when team assignment is requested;
5. inserts tasks and `meeting_task_links` in one transaction;
6. treats an existing `(meeting_id, suggestion_index)` as a successful idempotent result;
7. returns created task IDs and safe row-level errors.

```ts
return NextResponse.json({ ok: true, tasks: links, created: created.length });
```

- [ ] **Step 6: Run focused API tests**

Run: `cd dashboard && npm test -- --test-name-pattern="meeting task|assignee matching|idempotent"`

Expected: PASS.

### Task 5: Connect task confirmation to the meeting result

**Files:**
- Create: `dashboard/app/meetings/meeting-tasks.tsx`
- Modify: `dashboard/app/meetings/meeting-detail.tsx`
- Modify: `dashboard/lib/manual-meetings.ts`
- Modify: `dashboard/tests/manual-meetings.test.ts`

- [ ] **Step 1: Add a failing task UI contract**

```ts
test("meeting task UI includes review, confirmation, and retry states", () => {
  const tasks = fs.readFileSync(path.join(root, "app/meetings/meeting-tasks.tsx"), "utf8");
  assert.match(tasks, /Create selected tasks/);
  assert.match(tasks, /Confirm task creation/);
  assert.match(tasks, /Retry/);
  assert.match(tasks, /View task/);
});
```

- [ ] **Step 2: Run the contract and verify it fails**

Run: `cd dashboard && npm test -- --test-name-pattern="meeting task UI"`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement review and confirmation states**

Load existing links when a completed meeting opens. Show created rows as immutable success rows. For pending suggestions, provide a checkbox and assignee selector when no unique match exists. Disable creation until every selected row has an assignee.

```tsx
<button disabled={!selected.length || busy} onClick={() => setConfirmOpen(true)}>Create selected tasks</button>
```

The confirmation dialog states how many tasks will be created and who will receive them. POST only after confirmation. Keep failed rows available for Retry.

- [ ] **Step 4: Refresh meeting task counts after success**

Call `onUpdated` or a dedicated `onTasksChanged` callback so history counts update without reloading the page.

- [ ] **Step 5: Run dashboard tests and typecheck**

Run: `cd dashboard && npm test && npm run typecheck`

Expected: PASS.

### Task 6: Extend list data and verify all states

**Files:**
- Modify: `dashboard/app/api/meetings/list/route.ts`
- Modify: `dashboard/tests/manual-meetings.test.ts`

- [ ] **Step 1: Add failing list-query assertions**

```ts
assert.match(route, /created_at/);
assert.match(route, /created_task_count/);
assert.match(route, /meeting_task_links/);
```

- [ ] **Step 2: Extend the list query**

Select `created_at`, `updated_at`, and a correlated count from `meeting_task_links`. Keep ownership and the 100-row limit unchanged.

```sql
(SELECT COUNT(*)::int FROM meeting_task_links mtl WHERE mtl.meeting_id = meeting_recordings.id) AS created_task_count
```

- [ ] **Step 3: Run the complete automated verification**

Run: `cd dashboard && npm test && npm run typecheck && npm run build`

Expected: all tests pass, TypeScript exits 0, and Next.js production build completes.

- [ ] **Step 4: Run backend meeting regression tests**

Run: `node --test tests/manual-meeting-*.test.js tests/meeting-actions.test.js`

Expected: PASS with no recorder, transcript, report, rename, retry, playback, or confirmation regression.

- [ ] **Step 5: Browser QA at `http://127.0.0.1:43102/meetings`**

Verify Record, Pause, Resume, Stop & process, Cancel, Retry, Search, meeting selection, Overview, Transcript, Play, speaker Save, task selection, confirmation Cancel/Create, Retry, and View task. Check loading, empty, filtered-empty, processing, failed, and completed fixtures. Check desktop, stacked tablet, and mobile widths; confirm no horizontal overflow.

## Self-review

- Spec coverage: recorder, system and microphone state, transcription, summary, decisions, tasks, task confirmation, playback, retry, search, responsive states, and backend integration are covered.
- Placeholder scan: no deferred implementation markers remain.
- Type consistency: `suggestionIndex`, `created_task_count`, `MeetingTaskLink`, and the `overview | transcript` tab union are used consistently.

