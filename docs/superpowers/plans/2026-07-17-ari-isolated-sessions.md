# Ari Isolated Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Ari session a durable, context-isolated thread, prevent duplicate user submissions, and expose a local Electron right-click action that copies the selected session's sanitized log path.

**Architecture:** Persist explicit session UUIDs and scope messages, model history, transient workflow state, agent runs, polling, and logs to that UUID. Carry the session through the dashboard bridge with `AsyncLocalStorage`, claim every client submission idempotently, and let Electron own the dev-only native context menu and clipboard write.

**Tech Stack:** Next.js 14, React 18, TypeScript, Node.js, Express, PostgreSQL/node-pg-migrate, Electron, Node test runner, `tsx` tests.

**Dirty-worktree constraint:** The active repository already contains extensive user-owned uncommitted changes, including the chat and backend files this feature must extend. During execution, use the diff-checkpoint steps below and do not commit implementation files automatically; committing whole files would also capture unrelated user work.

---

## File Map

- Create `migrations/19_chat_sessions.js`: additive session, submission, message, and run schema.
- Create `dashboard/lib/chat-session-store.ts`: session ownership, listing, creation, legacy migration, rename, and log-file initialization.
- Create `dashboard/lib/chat-session-attachment-store.ts`: persist attachment metadata and enforce session ownership when files are reopened.
- Create `dashboard/app/api/chat/sessions/route.ts`: authenticated session list/create API.
- Create `dashboard/app/api/chat/attachments/[id]/route.ts`: stream a selected session's local attachment after ownership validation.
- Modify `dashboard/app/api/chat/messages/route.ts`: require and filter by session UUID.
- Modify `dashboard/app/api/chat/title/route.ts`: rename session records instead of first-message records.
- Modify `dashboard/app/api/chat/send/route.ts`: require session and client-message IDs.
- Modify `dashboard/app/api/chat/activity/route.ts`: stream only the selected session's run events.
- Modify `dashboard/lib/bot-bridge.ts`: forward session identity to the bot.
- Modify `dashboard/app/chat/chat-client.tsx`: select real sessions, create new sessions, scope polling/runs, and block duplicate submits synchronously.
- Modify `dashboard/components/recent-chats.tsx`: use UUID session records and trigger the Electron context menu on right-click.
- Retire `dashboard/lib/chat-sessions.ts` and its time-gap grouping tests from the active chat path.
- Create `src/services/chat-session-context.js`: request-local session context and session-aware state keys.
- Create `src/services/chat-submission.service.js`: validate session ownership and idempotently claim inbound dashboard submissions.
- Modify `src/routes/webhook.routes.js`: validate/claim session submissions and run processing inside session context.
- Modify `src/services/ai.service.js`: session-scoped message persistence, caches, and context reads.
- Modify `src/controllers/webhook.controller.js`: session-scope transient maps and preserve one logical inbound user write.
- Modify `src/services/agent-run.service.js`: persist session/client identity on agent runs.
- Modify `src/services/turn-trace.service.js`: write isolated sanitized session JSONL files.
- Create `desktop/src/session-debug.js`: validate UUIDs, resolve log paths, and decide whether debug UI is enabled.
- Modify `desktop/src/config.js`: inject the Electron session-log directory into child services.
- Modify `desktop/src/preload.js`: expose only the session context-menu IPC method.
- Modify `desktop/src/main.js`: render the native menu and copy the absolute path.
- Add focused tests under `dashboard/tests`, `tests`, and `desktop/tests`.

### Task 1: Add the durable session schema

**Files:**
- Create: `migrations/19_chat_sessions.js`
- Modify: `dashboard/lib/db.ts`
- Test: `tests/chat-session-migration.test.js`

- [ ] **Step 1: Write the failing migration contract test**

```js
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'migrations', '19_chat_sessions.js'), 'utf8');

test('chat session migration creates durable thread and idempotency storage', () => {
  assert.match(source, /CREATE TABLE IF NOT EXISTS ari_chat_sessions/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS ari_chat_submissions/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS ari_chat_attachments/);
  assert.match(source, /ADD COLUMN IF NOT EXISTS session_id UUID/);
  assert.match(source, /ADD COLUMN IF NOT EXISTS client_message_id UUID/);
  assert.match(source, /WHERE client_message_id IS NOT NULL AND role = 'user'/);
  assert.match(source, /Previous conversations/);
});
```

- [ ] **Step 2: Run the test and verify the missing migration fails**

Run: `node --test tests/chat-session-migration.test.js`

Expected: FAIL with `ENOENT` for `migrations/19_chat_sessions.js`.

- [ ] **Step 3: Create the additive migration**

```js
'use strict';
const { randomUUID } = require('node:crypto');

exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS ari_chat_sessions (
      id UUID PRIMARY KEY,
      user_phone VARCHAR(50) NOT NULL,
      title VARCHAR(120),
      is_legacy BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      archived_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_ari_chat_sessions_user_updated
      ON ari_chat_sessions(user_phone, updated_at DESC);
    ALTER TABLE conversation_history ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES ari_chat_sessions(id);
    ALTER TABLE conversation_history ADD COLUMN IF NOT EXISTS client_message_id UUID;
    CREATE INDEX IF NOT EXISTS idx_conversation_history_session
      ON conversation_history(user_phone, session_id, id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_user_client_message
      ON conversation_history(user_phone, session_id, client_message_id)
      WHERE client_message_id IS NOT NULL AND role = 'user';
    CREATE TABLE IF NOT EXISTS ari_chat_submissions (
      user_phone VARCHAR(50) NOT NULL,
      session_id UUID NOT NULL REFERENCES ari_chat_sessions(id) ON DELETE CASCADE,
      client_message_id UUID NOT NULL,
      run_id VARCHAR(100) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'queued',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_phone, session_id, client_message_id)
    );
    CREATE TABLE IF NOT EXISTS ari_chat_attachments (
      id UUID PRIMARY KEY,
      user_phone VARCHAR(50) NOT NULL,
      session_id UUID NOT NULL REFERENCES ari_chat_sessions(id) ON DELETE CASCADE,
      client_message_id UUID NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      mime_type VARCHAR(150) NOT NULL,
      local_path TEXT NOT NULL,
      size_bytes BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ari_chat_attachments_turn
      ON ari_chat_attachments(user_phone, session_id, client_message_id);
    ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES ari_chat_sessions(id);
    ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS client_message_id UUID;
    CREATE INDEX IF NOT EXISTS idx_agent_runs_session_started ON agent_runs(user_phone, session_id, started_at DESC);
  `);

  const users = await pgm.db.query(`
    SELECT DISTINCT user_phone FROM conversation_history
     WHERE user_phone IS NOT NULL AND session_id IS NULL
  `);
  for (const row of users.rows) {
    const id = randomUUID();
    await pgm.db.query(
      `INSERT INTO ari_chat_sessions (id, user_phone, title, is_legacy)
       VALUES ($1, $2, 'Previous conversations', TRUE)`,
      [id, row.user_phone],
    );
    await pgm.db.query(
      `UPDATE conversation_history SET session_id = $1
        WHERE user_phone = $2 AND session_id IS NULL`,
      [id, row.user_phone],
    );
  }
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    DROP TABLE IF EXISTS ari_chat_submissions;
    DROP TABLE IF EXISTS ari_chat_attachments;
    DROP INDEX IF EXISTS uq_conversation_user_client_message;
    DROP INDEX IF EXISTS idx_conversation_history_session;
    ALTER TABLE conversation_history DROP COLUMN IF EXISTS client_message_id;
    ALTER TABLE conversation_history DROP COLUMN IF EXISTS session_id;
    ALTER TABLE agent_runs DROP COLUMN IF EXISTS client_message_id;
    ALTER TABLE agent_runs DROP COLUMN IF EXISTS session_id;
    DROP TABLE IF EXISTS ari_chat_sessions;
  `);
};
```

Extend the `pg-mem` demo schema in `dashboard/lib/db.ts` with the same session columns and tables so dashboard tests and demo mode use the production shape.

- [ ] **Step 4: Run the migration test and backend test suite**

Run: `node --test tests/chat-session-migration.test.js`

Expected: PASS.

Run: `npm test`

Expected: existing backend tests PASS; unrelated pre-existing failures must be recorded before proceeding.

- [ ] **Step 5: Record the schema diff checkpoint**

```bash
git diff --check -- migrations/19_chat_sessions.js dashboard/lib/db.ts tests/chat-session-migration.test.js
git status --short -- migrations/19_chat_sessions.js dashboard/lib/db.ts tests/chat-session-migration.test.js
```

### Task 2: Build the authenticated session store and APIs

**Files:**
- Create: `dashboard/lib/chat-session-store.ts`
- Create: `dashboard/lib/chat-session-attachment-store.ts`
- Create: `dashboard/app/api/chat/sessions/route.ts`
- Create: `dashboard/app/api/chat/attachments/[id]/route.ts`
- Modify: `dashboard/app/api/chat/messages/route.ts`
- Modify: `dashboard/app/api/chat/title/route.ts`
- Test: `dashboard/tests/chat-session-store.test.ts`

- [ ] **Step 1: Write failing store tests with an injected query function**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { createChatSessionStore } from "../lib/chat-session-store";

test("creates a distinct empty session for every request", async () => {
  const calls: unknown[][] = [];
  const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  const store = createChatSessionStore({
    idFactory: () => ids.shift()!,
    queryFn: async (_sql, params = []) => { calls.push(params); return { rows: [] } as never; },
    ensureLogFile: async () => undefined,
  });
  const first = await store.createSession("+919999999999");
  const second = await store.createSession("+919999999999");
  assert.notEqual(first.id, second.id);
  assert.equal(calls.length, 2);
});

test("session ownership check includes both user and session", async () => {
  let params: unknown[] = [];
  const store = createChatSessionStore({
    idFactory: crypto.randomUUID,
    queryFn: async (_sql, values = []) => { params = values; return { rows: [{ id: values[1] }] } as never; },
    ensureLogFile: async () => undefined,
  });
  await store.requireOwnedSession("+919999999999", "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(params, ["+919999999999", "11111111-1111-4111-8111-111111111111"]);
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `npm test --prefix dashboard -- --test-name-pattern="session"`

Expected: FAIL because `chat-session-store.ts` does not exist.

- [ ] **Step 3: Implement the store interface**

```ts
export type ChatSessionRecord = {
  id: string;
  title: string | null;
  isLegacy: boolean;
  createdAt: string;
  updatedAt: string;
};

export function createChatSessionStore({ queryFn = query, idFactory = randomUUID, ensureLogFile = ensureSessionLogFile } = {}) {
  async function createSession(userPhone: string): Promise<ChatSessionRecord> {
    const id = idFactory();
    const result = await queryFn(
      `INSERT INTO ari_chat_sessions (id, user_phone) VALUES ($1, $2)
       RETURNING id, title, is_legacy, created_at, updated_at`,
      [id, userPhone],
    );
    await ensureLogFile(id);
    return mapSession(result.rows[0]);
  }

  async function requireOwnedSession(userPhone: string, sessionId: string) {
    if (!isUuid(sessionId)) throw new ChatSessionError("invalid session", 400);
    const result = await queryFn(
      `SELECT id, title, is_legacy, created_at, updated_at
         FROM ari_chat_sessions
        WHERE user_phone = $1 AND id = $2 AND archived_at IS NULL`,
      [userPhone, sessionId],
    );
    if (!result.rows[0]) throw new ChatSessionError("session not found", 404);
    return mapSession(result.rows[0]);
  }

  return { createSession, listSessions, requireOwnedSession, renameSession };
}
```

`listSessions` orders by `updated_at DESC`; `renameSession` validates a trimmed title of 1-120 characters and updates only `(user_phone, id)`.

- [ ] **Step 4: Add session list/create and scoped message APIs**

`GET /api/chat/sessions` returns `{ ok: true, sessions }`. `POST /api/chat/sessions` creates `{ ok: true, session }`. Both obtain the user via `getCurrentUserPhone()`.

Change messages SQL to:

```sql
SELECT id, role, content, created_at
  FROM conversation_history
 WHERE (user_phone = $1 OR user_phone = $2)
   AND session_id = $3
   AND ($4::bigint IS NULL OR id > $4)
 ORDER BY id ASC
 LIMIT 200
```

Require `sessionId`, call `requireOwnedSession`, and return 400/404 rather than falling back to phone-wide history. Rename by `sessionId` in the title route.

Persist every successfully staged file in `ari_chat_attachments` using the selected `sessionId` and `clientMessageId`. The messages route maps matching rows to `{ id, fileName, mimeType, url: "/api/chat/attachments/<id>" }`. The attachment GET route selects by attachment ID and authenticated user phone, verifies that the referenced session is owned by that user, then streams `local_path` with `Content-Type` and a safe `Content-Disposition` filename. It never accepts a filesystem path from the request.

- [ ] **Step 5: Run store, API-source, type, and dashboard tests**

Run: `npm test --prefix dashboard`

Expected: PASS.

Run: `npm run typecheck --prefix dashboard`

Expected: PASS.

- [ ] **Step 6: Record the session API diff checkpoint**

```bash
git diff --check -- dashboard/lib/chat-session-store.ts dashboard/lib/chat-session-attachment-store.ts dashboard/app/api/chat/sessions/route.ts dashboard/app/api/chat/attachments/[id]/route.ts dashboard/app/api/chat/messages/route.ts dashboard/app/api/chat/title/route.ts dashboard/tests/chat-session-store.test.ts
git status --short -- dashboard/lib/chat-session-store.ts dashboard/lib/chat-session-attachment-store.ts dashboard/app/api/chat/sessions/route.ts dashboard/app/api/chat/attachments/[id]/route.ts dashboard/app/api/chat/messages/route.ts dashboard/app/api/chat/title/route.ts dashboard/tests/chat-session-store.test.ts
```

### Task 3: Replace time-gap grouping with real session selection

**Files:**
- Modify: `dashboard/app/chat/chat-client.tsx`
- Modify: `dashboard/components/recent-chats.tsx`
- Modify: `dashboard/tests/agent-chat-workspace.test.ts`
- Modify: `dashboard/tests/chat-sessions.test.ts`

- [ ] **Step 1: Replace source-shape assertions with real-session expectations**

```ts
assert.match(chat, /\/api\/chat\/sessions/);
assert.match(chat, /selectedSessionId/);
assert.match(chat, /clientMessageId/);
assert.match(chat, /submittingRef\.current/);
assert.doesNotMatch(chat, /groupMessagesIntoSessions|SESSION_GAP_MS|viewStartId|sessionBounds/);
assert.match(recent, /onContextMenu/);
assert.match(recent, /showSessionContextMenu/);
```

Keep `chat-sessions.test.ts` as historical helper coverage, but remove `groupMessagesIntoSessions` from the active chat client. The store tests become the source of truth for real thread identity.

- [ ] **Step 2: Run the workspace tests and verify failure**

Run: `npm test --prefix dashboard -- --test-name-pattern="chat"`

Expected: FAIL on missing real-session state and remaining `groupMessagesIntoSessions` usage.

- [ ] **Step 3: Implement explicit session state and loading**

Use these client types and state:

```ts
type ChatSession = { id: string; title: string | null; isLegacy: boolean; createdAt: string; updatedAt: string };
const [sessions, setSessions] = useState<ChatSession[]>([]);
const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
const selectedSessionRef = useRef<string | null>(null);
const submittingRef = useRef(false);
```

Initial load fetches `/api/chat/sessions`; it selects `?session=<uuid>`, otherwise the newest session, otherwise POSTs a new session. Session selection clears visible messages and transient run state, updates `selectedSessionRef`, resets `lastIdRef`, writes `/chat?session=<uuid>`, and fetches only `/api/chat/messages?sessionId=<uuid>`.

`startNewSession` POSTs `/api/chat/sessions`, prepends the returned record, and selects it immediately. Remove all timestamp grouping and message-boundary state.

- [ ] **Step 4: Add synchronous submit idempotency**

```ts
async function send(event: React.FormEvent) {
  event.preventDefault();
  if (submittingRef.current || !selectedSessionId) return;
  const clientMessageId = crypto.randomUUID();
  submittingRef.current = true;
  setSending(true);
  try {
    const formData = new FormData();
    formData.set("sessionId", selectedSessionId);
    formData.set("clientMessageId", clientMessageId);
    formData.set("runId", crypto.randomUUID());
    formData.set("text", input.trim());
    attachments.forEach((file) => formData.append("attachments", file));
    await fetch("/api/chat/send", { method: "POST", body: formData });
  } finally {
    submittingRef.current = false;
    setSending(false);
  }
}
```

Keep one optimistic row keyed by `clientMessageId`, and reconcile it only against messages returned for the same selected session. Poll URLs and the activity `EventSource` include `sessionId`.

- [ ] **Step 5: Change recent items to session UUIDs**

`RecentChatsList` accepts `ChatSession` records, selects by string UUID, and renames by session UUID. Do not derive sidebar entries from user message content. Title fallback is `"New session"` until the first user message updates the session title.

- [ ] **Step 6: Run dashboard tests and typecheck**

Run: `npm test --prefix dashboard`

Expected: PASS.

Run: `npm run typecheck --prefix dashboard`

Expected: PASS.

- [ ] **Step 7: Record the client session diff checkpoint**

```bash
git diff --check -- dashboard/app/chat/chat-client.tsx dashboard/components/recent-chats.tsx dashboard/tests/agent-chat-workspace.test.ts
git status --short -- dashboard/app/chat/chat-client.tsx dashboard/components/recent-chats.tsx dashboard/tests/agent-chat-workspace.test.ts
```

### Task 4: Carry session identity through the backend and isolate model context

**Files:**
- Create: `src/services/chat-session-context.js`
- Create: `src/services/chat-submission.service.js`
- Modify: `dashboard/app/api/chat/send/route.ts`
- Modify: `dashboard/lib/bot-bridge.ts`
- Modify: `src/routes/webhook.routes.js`
- Modify: `src/services/ai.service.js`
- Modify: `src/controllers/webhook.controller.js`
- Test: `tests/chat-session-context.test.js`
- Test: `tests/chat-submission.test.js`

- [ ] **Step 1: Write failing request-context and claim tests**

```js
test('async chat context survives awaited work and scopes state keys', async () => {
  await runWithChatSession({ sessionId: SESSION, clientMessageId: CLIENT, runId: RUN, source: 'dashboard' }, async () => {
    await Promise.resolve();
    assert.equal(currentChatSession().sessionId, SESSION);
    assert.equal(conversationStateKey('+919999999999'), `+919999999999:${SESSION}`);
  });
  assert.equal(currentChatSession(), null);
});

test('claiming one client message twice processes it once', async () => {
  const service = createChatSubmissionService({ queryFn: fakeInsertOnce });
  assert.equal((await service.claim(input)).claimed, true);
  assert.equal((await service.claim(input)).claimed, false);
});
```

- [ ] **Step 2: Run focused backend tests and verify failure**

Run: `node --test tests/chat-session-context.test.js tests/chat-submission.test.js`

Expected: FAIL because both services are missing.

- [ ] **Step 3: Implement `AsyncLocalStorage` session context**

```js
'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const storage = new AsyncLocalStorage();

function runWithChatSession(context, callback) {
  const value = Object.freeze({
    sessionId: context.sessionId,
    clientMessageId: context.clientMessageId,
    runId: context.runId,
    source: context.source || 'dashboard',
  });
  return storage.run(value, callback);
}

function currentChatSession() { return storage.getStore() || null; }
function conversationStateKey(userPhone) {
  const sessionId = currentChatSession()?.sessionId;
  return sessionId ? `${userPhone}:${sessionId}` : String(userPhone);
}

module.exports = { runWithChatSession, currentChatSession, conversationStateKey };
```

- [ ] **Step 4: Implement durable submission claiming and ownership validation**

`chat-submission.service.js` first selects `ari_chat_sessions` by `(user_phone, id)`, then inserts into `ari_chat_submissions ... ON CONFLICT DO NOTHING RETURNING client_message_id`. It returns `{ claimed: false }` for an existing logical request and throws a typed 404 error for a foreign/missing session.

- [ ] **Step 5: Require identity in the dashboard bridge**

The dashboard send route validates UUID `sessionId` and `clientMessageId`, validates `runId`, and forwards all three. `sendThroughBot` sends:

```ts
body: JSON.stringify({
  user_phone: userPhone,
  text,
  attachments,
  session_id: sessionId,
  client_message_id: clientMessageId,
  run_id: runId,
})
```

- [ ] **Step 6: Claim and scope the internal dashboard turn**

In `/internal/dashboard-message`, validate the three IDs, call `claim`, return `{ ok: true, queued: false, duplicate: true }` when already claimed, and key `dashboardRuns` by `${userId}:${sessionId}`. Wrap the fire-and-forget callback:

```js
setImmediate(() => runWithChatSession(
  { sessionId, clientMessageId, runId, source: 'dashboard' },
  () => webhookController.handlePlatformMessage(normalizedMessage),
));
```

Cancellation requires and matches both `session_id` and `run_id`.

- [ ] **Step 7: Scope history writes, reads, and caches**

In `ai.service.js`, read `currentChatSession()`. For session turns, insert `session_id`; set `client_message_id` only for the user role. Use the partial unique index/`ON CONFLICT DO NOTHING`, and update the in-memory history cache only when an insert occurred. Cache keys become `${userPhone}:${sessionId || 'channel'}`.

After the first inserted user row in a non-legacy session, update `ari_chat_sessions.updated_at` and set `title = COALESCE(title, LEFT(content, 120))`. Assistant writes update `updated_at` without replacing an explicit title.

Session-aware `getHistory` and `getRecentContext` use:

```sql
WHERE user_phone = $1 AND session_id = $2
```

Non-session WhatsApp calls retain the current phone/time-gap behavior. Dashboard session calls never fall back to phone-only rows.

Apply the same `session_id` predicate to `summarizeRecentMessages`, `summarizeByTimeframe`, and every direct `conversation_history` query used to build conversational prompts. User-level memory/profile services remain keyed by user phone so explicit long-term facts are available without importing another thread's conversational turns.

- [ ] **Step 8: Scope transient workflow maps**

Create a small `SessionScopedBoundedMap` wrapper that applies `conversationStateKey` to `get`, `set`, `has`, and `delete`. Use it for content-bearing confirmation, list, clarification, document, last-action, and entity-reference maps in `WebhookController`. Keep rate limiting, onboarding, processed-message IDs, and factual contact caches phone-scoped.

- [ ] **Step 9: Run backend and dashboard tests**

Run: `node --test tests/chat-session-context.test.js tests/chat-submission.test.js tests/agent-loop-behavior.test.js tests/file-analysis.test.js`

Expected: PASS.

Run: `npm test --prefix dashboard`

Expected: PASS.

- [ ] **Step 10: Record the backend isolation diff checkpoint**

```bash
git diff --check -- src/services/chat-session-context.js src/services/chat-submission.service.js src/routes/webhook.routes.js src/services/ai.service.js src/controllers/webhook.controller.js dashboard/app/api/chat/send/route.ts dashboard/lib/bot-bridge.ts tests/chat-session-context.test.js tests/chat-submission.test.js
git status --short -- src/services/chat-session-context.js src/services/chat-submission.service.js src/routes/webhook.routes.js src/services/ai.service.js src/controllers/webhook.controller.js dashboard/app/api/chat/send/route.ts dashboard/lib/bot-bridge.ts tests/chat-session-context.test.js tests/chat-submission.test.js
```

### Task 5: Scope agent progress and stop actions to sessions

**Files:**
- Modify: `src/services/agent-run.service.js`
- Modify: `dashboard/app/api/chat/activity/route.ts`
- Modify: `dashboard/app/api/chat/stop/route.ts`
- Modify: `dashboard/lib/agent-activity.ts`
- Test: `tests/agent-run.service.test.js`
- Test: `dashboard/tests/agent-activity.test.ts`

- [ ] **Step 1: Add failing session assertions to run and activity tests**

Assert `startRun` inserts `session_id` and `client_message_id` from current context. Assert the activity route source includes `runs.session_id = $2`, and stop payloads include `sessionId`.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `node --test tests/agent-run.service.test.js`

Run: `npm test --prefix dashboard -- --test-name-pattern="activity"`

Expected: FAIL on missing session fields/filter.

- [ ] **Step 3: Persist and filter run identity**

`agentRunService.startRun` reads the current chat session and inserts both IDs. The SSE route requires an owned `sessionId` and queries:

```sql
SELECT events.id, events.run_id, events.event_type, events.step,
       events.tool_name, events.summary, events.created_at
  FROM agent_run_events events
  JOIN agent_runs runs ON runs.id = events.run_id
 WHERE events.user_phone = $1
   AND runs.session_id = $2
   AND events.id > $3
 ORDER BY events.id ASC
 LIMIT 100
```

The stop API and bridge carry session identity, and the backend run map matches both session and run.

- [ ] **Step 4: Run focused tests and record a diff checkpoint**

Run: `node --test tests/agent-run.service.test.js`

Run: `npm test --prefix dashboard -- --test-name-pattern="activity"`

Expected: PASS.

```bash
git diff --check -- src/services/agent-run.service.js dashboard/app/api/chat/activity/route.ts dashboard/app/api/chat/stop/route.ts dashboard/lib/agent-activity.ts tests/agent-run.service.test.js dashboard/tests/agent-activity.test.ts
git status --short -- src/services/agent-run.service.js dashboard/app/api/chat/activity/route.ts dashboard/app/api/chat/stop/route.ts dashboard/lib/agent-activity.ts tests/agent-run.service.test.js dashboard/tests/agent-activity.test.ts
```

### Task 6: Create one sanitized debug log per session

**Files:**
- Create: `dashboard/lib/chat-session-logs.ts`
- Modify: `src/services/turn-trace.service.js`
- Modify: `tests/turn-trace.test.js`
- Test: `dashboard/tests/chat-session-logs.test.ts`

- [ ] **Step 1: Write failing path-safety and trace-isolation tests**

```ts
test("session log path stays inside configured root", () => {
  assert.equal(resolveSessionLogPath("C:\\logs\\sessions", SESSION), `C:\\logs\\sessions\\${SESSION}.jsonl`);
  assert.throws(() => resolveSessionLogPath("C:\\logs\\sessions", "..\\secrets"));
});
```

```js
test('session turns write only to their own JSONL file', async () => {
  await runWithChatSession({ sessionId: A, clientMessageId: CA, runId: RA }, async () => {
    trace.begin(PHONE, { channel: 'dashboard', text: 'alpha' });
    trace.end(PHONE);
  });
  await runWithChatSession({ sessionId: B, clientMessageId: CB, runId: RB }, async () => {
    trace.begin(PHONE, { channel: 'dashboard', text: 'beta' });
    trace.end(PHONE);
  });
  assert.equal(read(A).length, 1);
  assert.equal(read(B).length, 1);
  assert.equal(read(A)[0].sessionId, A);
});
```

- [ ] **Step 2: Run focused log tests and verify failure**

Run: `node --test tests/turn-trace.test.js`

Run: `npm test --prefix dashboard -- --test-name-pattern="session log"`

Expected: FAIL because log-path/session routing is missing.

- [ ] **Step 3: Implement safe path resolution and empty-file creation**

`chat-session-logs.ts` validates a canonical UUID, resolves `<root>/<uuid>.jsonl`, verifies the result's parent equals the configured root, creates the directory recursively, and opens the file with append mode before closing it. If `ARI_SESSION_LOG_DIR` is unset, creation is a no-op outside Electron local mode.

- [ ] **Step 4: Route turn traces by request-local session**

`turnTrace.begin` includes session/client/run IDs from `currentChatSession`, and active trace keys use `conversationStateKey(userPhone)`. `flush` uses the per-session path when `sessionId` exists and the global log otherwise. Rotation is tracked per output path. The existing sanitizer remains unchanged.

- [ ] **Step 5: Run log tests and record a diff checkpoint**

Run: `node --test tests/turn-trace.test.js`

Run: `npm test --prefix dashboard -- --test-name-pattern="session log"`

Expected: PASS.

```bash
git diff --check -- dashboard/lib/chat-session-logs.ts dashboard/tests/chat-session-logs.test.ts src/services/turn-trace.service.js tests/turn-trace.test.js
git status --short -- dashboard/lib/chat-session-logs.ts dashboard/tests/chat-session-logs.test.ts src/services/turn-trace.service.js tests/turn-trace.test.js
```

### Task 7: Add the local Electron right-click copy-path menu

**Files:**
- Create: `desktop/src/session-debug.js`
- Modify: `desktop/src/config.js`
- Modify: `desktop/src/preload.js`
- Modify: `desktop/src/main.js`
- Modify: `dashboard/components/recent-chats.tsx`
- Test: `desktop/tests/session-debug.test.js`
- Modify: `dashboard/tests/agent-chat-workspace.test.ts`

- [ ] **Step 1: Write failing pure Electron debug tests**

```js
test('resolves only UUID session logs inside the configured root', () => {
  assert.equal(resolveSessionLogPath('C:\\AriLogs\\sessions', SESSION), `C:\\AriLogs\\sessions\\${SESSION}.jsonl`);
  assert.throws(() => resolveSessionLogPath('C:\\AriLogs\\sessions', '..\\secret'));
});

test('debug menu is enabled for unpackaged local runs only by default', () => {
  assert.equal(sessionDebugEnabled({ isPackaged: false, env: {} }), true);
  assert.equal(sessionDebugEnabled({ isPackaged: true, env: {} }), false);
  assert.equal(sessionDebugEnabled({ isPackaged: true, env: { ARI_ENABLE_SESSION_DEBUG: 'true' } }), true);
});
```

- [ ] **Step 2: Run desktop tests and verify failure**

Run: `npm run desktop:test -- --test-name-pattern="session"`

Expected: FAIL because `session-debug.js` is missing.

- [ ] **Step 3: Implement safe Electron helpers and environment injection**

```js
function resolveSessionLogPath(root, sessionId) {
  if (!UUID_RE.test(String(sessionId))) throw new Error('invalid session');
  const base = path.resolve(root);
  const target = path.resolve(base, `${sessionId}.jsonl`);
  if (path.dirname(target) !== base) throw new Error('invalid session log path');
  return target;
}

function sessionDebugEnabled({ isPackaged, env }) {
  return !isPackaged || env.ARI_ENABLE_SESSION_DEBUG === 'true';
}
```

In `boot`, set `runtime.childEnv.ARI_SESSION_LOG_DIR = path.join(app.getPath('logs'), 'sessions')` before starting child services.

- [ ] **Step 4: Expose and handle one narrow IPC operation**

Preload exposes:

```js
debug: Object.freeze({
  showSessionContextMenu: (sessionId) => ipcRenderer.invoke('desktop:session-context-menu', sessionId),
}),
```

Main validates `fromLocalDashboard(event)`, debug enablement, and the UUID. It builds a native `Menu` containing **Copy session log path** whose click handler calls `clipboard.writeText(resolveSessionLogPath(logRoot, sessionId))`.

- [ ] **Step 5: Wire sidebar right-click without exposing filesystem APIs**

In `RecentChatsList`, add:

```tsx
onContextMenu={(event) => {
  event.preventDefault();
  const bridge = (window as typeof window & { ariDesktop?: { debug?: { showSessionContextMenu(id: string): Promise<unknown> } } }).ariDesktop;
  void bridge?.debug?.showSessionContextMenu(item.id);
}}
```

Normal click and double-click rename behavior remain unchanged.

- [ ] **Step 6: Run Electron and dashboard tests and record a diff checkpoint**

Run: `npm run desktop:test`

Run: `npm test --prefix dashboard -- --test-name-pattern="chat"`

Expected: PASS.

```bash
git diff --check -- desktop/src/session-debug.js desktop/src/config.js desktop/src/preload.js desktop/src/main.js desktop/tests/session-debug.test.js dashboard/components/recent-chats.tsx dashboard/tests/agent-chat-workspace.test.ts
git status --short -- desktop/src/session-debug.js desktop/src/config.js desktop/src/preload.js desktop/src/main.js desktop/tests/session-debug.test.js dashboard/components/recent-chats.tsx dashboard/tests/agent-chat-workspace.test.ts
```

### Task 8: Run end-to-end regression and local desktop verification

**Files:**
- Modify only files required by failures discovered in this task.

- [ ] **Step 1: Stop the currently running dev instance cleanly**

Close the Ari window so Electron's existing `before-quit` handler stops its child backend and dashboard. Confirm ports 43100 and 43101 no longer listen before applying the migration.

- [ ] **Step 2: Apply the migration to the configured local database**

Run: `npm run migrate`

Expected: migration 19 completes without deleting existing conversation rows.

- [ ] **Step 3: Run focused test suites**

Run: `node --test tests/chat-session-migration.test.js tests/chat-session-context.test.js tests/chat-submission.test.js tests/turn-trace.test.js tests/agent-run.service.test.js`

Run: `npm test --prefix dashboard`

Run: `npm run typecheck --prefix dashboard`

Run: `npm run desktop:test`

Expected: all commands PASS.

- [ ] **Step 4: Run broader backend regression tests**

Run: `npm test`

Expected: PASS, or only pre-recorded unrelated failures remain unchanged.

- [ ] **Step 5: Launch the desktop app and verify behavior manually**

Run: `npm run desktop:dev`

Verify:

1. Create session A, send a unique context phrase, and receive a response.
2. Click **New session** immediately; session B is empty.
3. Ask session B about the phrase from A; Ari does not know it from conversation history.
4. Return to A; its conversation remains intact.
5. Upload one Excel file with one caption; exactly one user bubble appears.
6. Right-click A in Recent sessions; **Copy session log path** appears.
7. Paste the clipboard path into PowerShell and confirm it exists under Electron's Ari log directory.
8. Open both session JSONL files and confirm each contains only its own session ID.

- [ ] **Step 6: Inspect the final diff without staging user-owned changes**

Run: `git diff --check`

Run: `git status --short`

Do not stage or commit implementation files in this shared dirty worktree. Report the exact feature files changed and keep unrelated pre-existing changes untouched.
