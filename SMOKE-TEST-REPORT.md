# Ari Vertex Gemini Agent Smoke-Test Report

**Test date:** July 19, 2026  
**Application:** Ari desktop and dashboard  
**Agent provider:** Vertex AI  
**Model:** `google:gemini-2.5-flash`  
**Agent flow:** Ari/Agno Gemini flow; Codex was not used for live agent turns  
**Overall verdict:** **NOT PRODUCTION-READY**

## Executive Summary

Basic product CRUD and several direct UI flows work correctly. However, the live agent still has serious problems with contextual natural-language routing, confirmation classification, cancellation, operation latency, run-status accuracy, UI refresh after agent mutations, and tool coverage.

The most important product-reflection issue is that multiple dashboard pages load their data only when the component mounts. When the agent changes PostgreSQL successfully, an already-open CRM, Groups, Tasks, Campaigns, or Analytics page can continue showing stale data until the user reloads or navigates away and back.

The most serious execution issue is that the Stop endpoint can report success while an in-flight mutation continues. During testing, a stopped lead-stage operation subsequently changed the database record to `proposal`.

## Scope

The smoke test covered:

- Live Ari agent requests through Vertex Gemini.
- Natural, indirect, contextual, and slightly vague prompts.
- Tool selection and argument suitability.
- Create, list, update, complete, reopen, archive, restore, and delete operations where supported.
- Persistence verification through PostgreSQL, dashboard APIs, and refreshed UI pages.
- Primary dashboard routes and important tabs/buttons.
- Static comparison of product actions against the 86 registered agent tools.
- Existing automated agent and dashboard test suites.
- Cleanup verification for synthetic smoke-test records.

The following actions were intentionally not completed because they would affect external accounts, disrupt the active session, or touch real user data:

- Completing Google OAuth authorization.
- Signing out of the dashboard.
- Sending real emails, campaigns, or team broadcasts.
- Deleting existing non-test user records.
- Creating an actual microphone or desktop recording.

## Automated Test Results

| Test suite | Result |
|---|---:|
| Agent regression tests | 269/269 passed |
| Dashboard tests | 145/145 passed |
| Dashboard TypeScript check | Passed |
| Golden natural-language intents | 32/34 passed |
| Live NLU intent cases | 19 passed, 4 partial, 1 failed |
| Confirmation/edit classifier | 1/3 passed |
| Live Vertex Gemini agent runs | 25 total |
| Agent-run ledger results | 15 completed, 10 failed |

The ten ledger failures do not all represent failed user operations. Several approval-pending operations were incorrectly stored as `failed`, which is itself a run-state accuracy problem.

### Live-run latency

| Ledger status | Runs | Average | Maximum |
|---|---:|---:|---:|
| Completed | 15 | 43.3 seconds | 128.4 seconds |
| Failed | 10 | 99.6 seconds | 138.8 seconds |

Many simple destructive or confirmation-driven operations took approximately 127–139 seconds.

## UI Route and Button Coverage

All ten primary routes loaded without observed HTTP 4xx/5xx responses or browser console errors during the initial route audit:

- Home/chat
- Contacts
- CRM Groups
- CRM Campaigns
- CRM Activity
- CRM Analytics
- Team
- Meetings
- Tasks
- Settings

The source contains approximately 297 button declarations. Meaningful controls across every major surface were inspected, and representative operations were executed. External, session-ending, and real-data destructive controls were not completed.

### Direct UI results

| Surface | Actions verified | Result |
|---|---|---|
| Contacts | Create, search, edit, archive, archived filter, restore, delete | Passed |
| CRM Groups | Create, rename, archive, archived filter, restore, delete | Passed |
| Tasks | Create through agent, complete, Done filter, reopen, complete again, delete | Passed |
| Campaigns | Open New Campaign modal; validate empty-audience disabled state | Passed |
| CRM Import | Open import modal | Passed |
| Team | Overview, Members, Tasks, Team Chat, Calendar, Broadcasts, Settings tabs | Passed |
| Meetings | History selection, Overview, Transcript, Play availability | Passed |
| Settings | Google connection controls present; connection flow launches | Passed |

The Team page sometimes required additional time before its tabs rendered. Five `/api/team/list` reloads returned HTTP 200 with the expected three teams, so this appeared to be slow sub-data rendering rather than data loss.

## Live Agent CRUD Results

### Reminders

- A vague prompt asking Ari to “keep track” of reviewing notes tomorrow routed to `set_reminder` instead of Tasks. This is reasonable given the wording.
- The reminder was persisted as ID 241.
- Updating it from a separate session using natural reference text called `update_reminder`, but the tool could not match the reminder.
- Natural-language removal entered a very slow approval flow.
- Explicit cancellation by ID succeeded.
- The database retains the expected cancelled historical record.

### Tasks

- Creating `ARI_SMOKE_TASK_0719` selected `manage_tasks` and persisted successfully.
- “That ARI smoke report task is finished now” completed the task.
- The completion took approximately 128 seconds and produced a run with `model: null` and no recorded tool results.
- Explicit deletion entered approval and succeeded after confirmation.
- Direct UI complete, reopen, and delete operations also succeeded.

### Contacts

- Creating `ARI Smoke Contact 0719` selected the correct contact tool.
- The name and phone were stored, but the supplied email was not stored.
- Ari correctly disclosed that the email could not be saved.
- Updating company and title failed with `ECONNRESET`.
- The current `manage_contacts` schema cannot accept company, title, email, or other CRM profile fields anyway.
- A supported phone update succeeded.
- Delete succeeded after confirmation.

### CRM Groups

- Create and list selected `manage_contact_groups` and succeeded.
- The group appeared in the API and refreshed Groups UI.
- Delete succeeded after confirmation.
- The assistant rendered the successful deletion response as literal `[object Object]`.

### Teams

- Create and list selected `manage_team` and succeeded.
- The team appeared in PostgreSQL and the dashboard API.
- Delete succeeded after confirmation.
- The record was absent after cleanup.

### Notes

- Create and search selected `manage_notes` and succeeded.
- Delete by title entered approval but then returned “Note not found”; the record remained.
- Retrying with the explicit note ID succeeded.

### Sales Leads

- Lead creation selected `manage_sales` and persisted successfully.
- A vague stage-change prompt eventually moved the lead to `proposal`.
- The request had been stopped earlier, but the mutation still completed. This is a critical cancellation defect.
- Explicit deletion succeeded after confirmation.

## Natural-Language and Tool-Routing Findings

### Incorrect routing

1. Bare `1` after an email list routed to `manage_images` instead of opening the first email.
2. Bare `2` after an inbox list routed to `manage_incidents` with an incident ID of 2.
3. “Can you pull up the meeting recording I made earlier?” routed to `manage_images`.
4. A combined “send an email and schedule a meeting” request selected `schedule_email` instead of `send_email` for the email portion.

### Correct or acceptable routing

- Google/Gmail/Calendar connection requests selected `connect_google`.
- Task, contact, CRM group, team, note, reminder, and sales lead create/list operations generally selected their expected tools.
- Unsupported campaign and group-edit operations usually returned clarification instead of fabricating success.

### Confirmation classifier failures

Gemini produced malformed classifier JSON for two of three live gate cases:

- “hmm ok go ahead i guess” should have been confirmation but was classified as a new request.
- “change the subject to Q3 update” should have edited the pending draft but was classified as a new request.

## Findings by Severity

### Critical

#### C-1: Stop can report success while a mutation continues

The dashboard Stop request returned `{ok:true}`, but the stopped lead-stage operation later changed the database record.

The cancellation route marks the active run cancelled and aborts its controller, but downstream model/tool execution does not consistently honor the signal once work is underway. The endpoint also returns success when no matching active run is found.

Relevant code:

- `dashboard/app/api/chat/stop/route.ts`
- `dashboard/lib/bot-bridge.ts`
- `src/routes/webhook.routes.js`

#### C-2: Open product pages do not reflect agent mutations automatically

Several product surfaces fetch only on component mount and have no shared invalidation, realtime subscription, polling, or agent-completion refresh event.

Examples:

- `dashboard/app/contacts/contacts-content.tsx`
- `dashboard/app/contacts/groups/groups-list.tsx`
- `dashboard/app/tasks/tasks-content.tsx`
- `dashboard/app/contacts/campaigns/campaigns-list.tsx`
- `dashboard/app/contacts/analytics/crm-analytics.tsx`

The mutation can be present in PostgreSQL while the currently open product view remains stale.

### High

#### H-1: Contextual numbered replies lose prior-list context

Short follow-ups such as `1` and `2` can route to unrelated tools. The system prompt contains rules for positional replies, but the live classifier does not apply them reliably.

#### H-2: Confirmation classifier emits malformed JSON

Malformed Gemini output falls back to `new_request`, which can discard or misinterpret an active confirmation/edit flow.

#### H-3: Confirmation-driven operations are extremely slow

Simple delete and follow-up requests frequently took more than two minutes.

#### H-4: Agent-run ledger is not authoritative

Approval-pending requests are frequently recorded as failed with no error code. Some successful fallback mutations contain no model identity and no tool results.

#### H-5: Assistant response normalization is broken

A successful CRM group deletion was displayed as `[object Object]`.

#### H-6: Contact tool drops supported product data

The CRM product stores email, company, title, LinkedIn URL, and website, but the agent update tool accepts only phone.

### Medium

#### M-1: Dashboard APIs can hide backend failures as empty data

Multiple routes wrap database calls with `catch { return fallback; }`. This can turn a schema, connection, or query failure into a valid HTTP 200 response containing empty lists.

Examples:

- `dashboard/app/api/contacts/list/route.ts`
- `dashboard/app/api/notes/list/route.ts`
- `dashboard/app/api/settings/overview/route.ts`
- `dashboard/app/api/team/[name]/today/route.ts`

#### M-2: Provider/network failures have poor recovery

One live contact update failed with `read ECONNRESET`. The user received a failed action rather than a safe retry or a clear resumable state.

#### M-3: Google Tasks contract mismatch

The tool schema and high-level supported-action expectations mention completion, but the contract description explicitly states that Google Task completion is unsupported.

## Missing Agent Tools and Operations

The project registers 86 agent tools, but some product capabilities have no corresponding tool operation.

| Product area | Existing agent coverage | Missing or incomplete operations |
|---|---|---|
| Contacts | Save, bulk save, list, get, phone update, delete | Update email/company/title/LinkedIn/website; archive; restore |
| CRM Groups | Create, add members, list, delete, workbook sync | Rename/edit; archive; restore; remove individual members |
| Campaigns | No dedicated campaign tool | Create, edit, start, pause, resume, delete, inspect status |
| Ari Tasks | Create, list, complete, assign, delete, follow-up | Edit title/description/due date/priority; reopen |
| Teams | Create, add/remove member, list, delete | Rename; update settings; typed chat/broadcast operations; several UI workspace actions |
| Meetings | Create/search meeting notes, history, action items | Recording lookup/playback; retry processing; speaker rename; create task from recording |
| Google Tasks | List/create; contract is inconsistent | Reliable complete/update/delete coverage |

Primary tool definitions are in:

- `src/services/tool-definitions.js`
- `src/services/agent-tool-contracts.service.js`

## Product-Reflection Root Cause

The statement “Ari says it completed the action, but nothing appears in the product” can arise from multiple independent defects:

1. **Stale mounted UI:** the database changed, but the page did not refetch.
2. **Suppressed API error:** an API query failed but returned an empty fallback with HTTP 200.
3. **Incomplete tool schema:** the model called the correct high-level tool, but the requested fields were not accepted or persisted.
4. **Run/result mismatch:** approval, fallback, or tool-result state was stored incorrectly, allowing the assistant and run ledger to disagree.
5. **Incorrect tool routing:** natural or contextual language selected an unrelated tool.

During this smoke test, successful CRUD changes were visible through fresh API requests and after page reload. Automatic reflection in an already-open page was not reliable.

## Recommended Fix Order

1. Make cancellation authoritative: propagate AbortSignal through provider, agent loop, and every mutating tool; return `not_found` when no matching active run exists; mark uncertain in-flight writes as partial/unknown rather than stopped.
2. Add a shared product-data invalidation mechanism after every successful agent mutation. Use realtime PostgreSQL/Supabase events, an app event bus, or query-cache invalidation.
3. Replace positional-reply classification with deterministic resolution against the last tool result before asking Gemini to select a tool.
4. Enforce structured classifier output with schema validation and a retry/repair pass; never silently convert malformed confirmation output to a new request.
5. Correct run-ledger mapping for `waiting_approval`, `waiting_input`, cancellation, fallback completion, and partial/unknown mutation results.
6. Normalize every tool result before rendering assistant text to prevent `[object Object]`.
7. Bring tool schemas to parity with supported UI actions, beginning with Contacts, Groups, Tasks, Campaigns, Teams, and Meetings.
8. Stop swallowing database exceptions as empty arrays. Return explicit partial/error metadata and log a correlation ID.
9. Add live provider regression cases for numbered follow-ups, pronouns, vague references, confirmation edits, cancellation races, and post-mutation UI visibility.

## Cleanup

The following synthetic records were removed successfully:

- Smoke-test tasks
- Smoke-test contacts
- Smoke-test CRM groups
- Smoke-test teams
- Smoke-test notes
- Smoke-test sales leads

Reminder ID 241 remains only as a cancelled historical record with status `cancelled`, which is the expected result of cancellation rather than deletion.

## Final Assessment

The direct product UI is substantially healthier than the agent integration: direct contact, group, and task CRUD worked, and Team and Meetings surfaces loaded successfully.

The Ari agent is suitable for continued development testing but should not be treated as reliably autonomous yet. Before production use, cancellation, UI invalidation, confirmation classification, run-state correctness, and missing mutating tools need to be addressed.
