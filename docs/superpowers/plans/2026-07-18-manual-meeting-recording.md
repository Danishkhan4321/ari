# Manual Meeting Recording Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every provider-backed meeting bot with a manual desktop recorder that captures system and microphone audio on Windows and macOS, transcribes with AssemblyAI, generates a structured report, and propagates speaker renames everywhere.

**Architecture:** Electron owns trusted capture and local files; the loopback Ari backend owns storage, AssemblyAI, report generation, recovery, and canonical meeting data; the existing Next.js Meetings page owns presentation and authenticated user actions. The new path lands before the old bot path is removed, and `meeting_recordings` remains the compatibility boundary for existing consumers.

**Tech Stack:** Electron 43, React/Next.js 14, Node.js/Express, PostgreSQL/JSONB, Swift + ScreenCaptureKit/AVFoundation, Web Audio/MediaRecorder, FFmpeg, AWS S3-compatible storage, AssemblyAI, Zod, Node test runner, TypeScript/tsx tests.

---

## Scope and worktree safety

This is one migration plan, not independent subprojects: capture, processing, rename propagation, and provider removal share the same durable record and cannot be safely shipped in arbitrary order.

The worktree already contains extensive unrelated uncommitted changes. Before every commit:

```powershell
git diff --cached --name-status
git diff --cached
```

Stage new files normally. For a file that was already modified before this work, stage only the meeting-recording hunks with `git add -p -- <path>`. If the staged diff contains branding, agent-runtime, chat-session, or other unrelated changes, unstage it with `git restore --staged -- <path>` and leave the task uncommitted rather than capturing user work.

Do not reset, restore, delete, or reformat unrelated changes. Do not drop provider tables until Task 12's reference gate passes.

## Target file structure

### Backend domain

- `src/services/manual-meetings/meeting-renderer.js` — pure canonical-to-materialized rendering and speaker-name application.
- `src/services/manual-meetings/meeting-repository.js` — all manual meeting persistence, ownership, state transitions, and rename transactions.
- `src/services/manual-meetings/assemblyai-client.js` — submit/poll/cancel and diarization normalization.
- `src/services/manual-meetings/report-generator.js` — structured report prompt, Zod validation, and bounded retry.
- `src/services/manual-meetings/recording-storage.js` — private object upload, verification, signing, and deletion.
- `src/services/manual-meetings/processor.js` — durable processing orchestration and restart recovery.
- `src/routes/desktop-meetings.routes.js` — loopback-only upload, retry, rename, and playback endpoints.
- `src/utils/desktop-internal-auth.js` — loopback and per-launch token checks.

### Desktop capture

- `desktop/src/meeting-capture/session-manager.js` — validated capture state machine, temp paths, chunk writes, finalize/cancel/recovery.
- `desktop/src/meeting-capture/backend-client.js` — streaming upload to the loopback backend.
- `desktop/src/meeting-capture/macos-helper.js` — spawn/control/parse the native helper.
- `desktop/native/macos/Package.swift` — native helper package.
- `desktop/native/macos/Sources/AriMeetingCapture/main.swift` — ScreenCaptureKit + microphone capture executable.
- `desktop/scripts/build-macos-capture.js` — compile/copy helper for packaging.

### Dashboard

- `dashboard/lib/manual-meetings.ts` — shared types, canonical parsing, display helpers, and internal proxy helper.
- `dashboard/app/meetings/meeting-recorder.tsx` — desktop capture controller and recording UI.
- `dashboard/app/meetings/meeting-detail.tsx` — report, transcript, playback, retry, and speaker editor.
- `dashboard/app/api/meetings/[id]/status/route.ts` — owned processing status.
- `dashboard/app/api/meetings/[id]/speakers/route.ts` — authenticated rename proxy.
- `dashboard/app/api/meetings/[id]/retry/route.ts` — authenticated retry proxy.
- `dashboard/app/api/meetings/[id]/recording/route.ts` — authenticated signed playback proxy.

### Schema and verification

- `migrations/24_manual_meeting_recording.js` — additive manual-processing schema.
- `migrations/25_remove_meeting_bot_tables.js` — provider lifecycle table removal after code removal.
- `tests/manual-meeting-*.test.js`, `desktop/tests/meeting-*.test.js`, and `dashboard/tests/manual-meetings.test.ts` — focused behavior.
- `scripts/verify-meeting-bot-removal.js` — tracked-source/provider/env guard.
- `docs/MANUAL-MEETING-RECORDING.md` — permissions, operations, and real-device release gate.

## Task 1: Add the canonical manual-meeting schema

**Files:**
- Create: `migrations/24_manual_meeting_recording.js`
- Create: `src/services/manual-meetings/meeting-renderer.js`
- Create: `tests/manual-meeting-renderer.test.js`
- Modify: `dashboard/lib/db.ts`

- [ ] **Step 1: Write failing renderer tests**

Create tests for stable speaker IDs and complete rename propagation:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { materializeMeeting } = require('../src/services/manual-meetings/meeting-renderer');

test('materializeMeeting applies speaker names to every artifact', () => {
  const canonical = {
    transcriptSegments: [
      { speakerId: 'A', startMs: 0, endMs: 900, text: 'I will send the proposal.' },
      { speakerId: 'B', startMs: 1000, endMs: 1800, text: 'Approved.' },
    ],
    report: {
      summary: 'Speaker A will send the proposal to Speaker B.',
      decisions: ['Speaker B approved the proposal.'],
      actionItems: [{ text: 'Send the proposal', assigneeSpeakerId: 'A', deadline: null }],
      suggestedTasks: [{ title: 'Send proposal', suggestedAssigneeSpeakerId: 'A', reason: 'Speaker A committed to it.' }],
      topics: ['Proposal'],
      reportMarkdown: '# Report\nSpeaker A owns the follow-up; Speaker B approved it.',
    },
  };
  const result = materializeMeeting(canonical, { A: 'Danish', B: 'Priya' });
  assert.match(result.transcript, /Danish: I will send/);
  assert.equal(result.summary, 'Danish will send the proposal to Priya.');
  assert.deepEqual(result.decisions, ['Priya approved the proposal.']);
  assert.equal(result.actionItems[0].assignee, 'Danish');
  assert.equal(result.suggestedTasks[0].suggestedAssignee, 'Danish');
  assert.match(result.reportMarkdown, /Danish owns.*Priya approved/);
});

test('materializeMeeting keeps neutral labels when names are absent', () => {
  const result = materializeMeeting({
    transcriptSegments: [{ speakerId: 'A', startMs: 0, endMs: 1, text: 'Hello' }],
    report: { summary: 'Speaker A spoke.', decisions: [], actionItems: [], suggestedTasks: [], topics: [], reportMarkdown: 'Speaker A spoke.' },
  }, {});
  assert.equal(result.transcript, 'Speaker A: Hello');
  assert.equal(result.summary, 'Speaker A spoke.');
});
```

- [ ] **Step 2: Run the focused test and confirm the missing module failure**

Run: `node --test tests/manual-meeting-renderer.test.js`  
Expected: FAIL with `Cannot find module '../src/services/manual-meetings/meeting-renderer'`.

- [ ] **Step 3: Implement the pure renderer**

Export this contract and keep all token replacement boundary-aware so `Speaker A` never changes inside `Speaker AA`:

```js
function speakerLabel(id, names) {
  return String(names?.[id] || `Speaker ${id}`).trim();
}

function replaceSpeakerTokens(value, names) {
  if (typeof value !== 'string') return value;
  return value.replace(/\bSpeaker ([A-Z]+)\b/g, (_, id) => speakerLabel(id, names));
}

function materializeMeeting({ transcriptSegments = [], report = {} }, names = {}) {
  const transcript = transcriptSegments.map((segment) =>
    `${speakerLabel(segment.speakerId, names)}: ${segment.text}`
  ).join('\n\n');
  const actionItems = (report.actionItems || []).map((item) => ({
    ...item,
    text: replaceSpeakerTokens(item.text, names),
    assignee: item.assigneeSpeakerId ? speakerLabel(item.assigneeSpeakerId, names) : null,
  }));
  const suggestedTasks = (report.suggestedTasks || []).map((task) => ({
    ...task,
    title: replaceSpeakerTokens(task.title, names),
    reason: replaceSpeakerTokens(task.reason, names),
    suggestedAssignee: task.suggestedAssigneeSpeakerId
      ? speakerLabel(task.suggestedAssigneeSpeakerId, names) : null,
  }));
  return {
    transcript,
    summary: replaceSpeakerTokens(report.summary || '', names),
    decisions: (report.decisions || []).map((v) => replaceSpeakerTokens(v, names)),
    actionItems,
    suggestedTasks,
    topics: report.topics || [],
    reportMarkdown: replaceSpeakerTokens(report.reportMarkdown || '', names),
    attendees: [...new Set(transcriptSegments.map((s) => speakerLabel(s.speakerId, names)))],
  };
}

module.exports = { materializeMeeting, replaceSpeakerTokens, speakerLabel };
```

- [ ] **Step 4: Add the additive migration and demo-schema compatibility**

The migration must add, with `IF NOT EXISTS`, the exact fields from the design: `source_type`, `processing_stage`, `processing_error_code`, `processing_error_message`, `recording_object_key`, `recording_mime_type`, `assemblyai_transcript_id`, `canonical_transcript_segments JSONB`, `canonical_report JSONB`, `speaker_names JSONB DEFAULT '{}'`, `suggested_tasks JSONB`, `report_markdown`, `capture_platform`, `capture_codec`, `processing_attempts`, `updated_at`, and a unique `capture_session_id`. Add indexes on `(user_phone, processing_stage)` and `assemblyai_transcript_id`.

Use the same columns in `dashboard/lib/db.ts`'s pg-mem schema so dashboard tests exercise the real shape.

- [ ] **Step 5: Run tests and migration syntax checks**

Run:

```powershell
node --test tests/manual-meeting-renderer.test.js
node -e "require('./migrations/24_manual_meeting_recording.js')"
npm test --prefix dashboard -- --test-name-pattern="meetings"
```

Expected: renderer tests PASS; migration loads without throwing; existing dashboard meeting tests PASS.

- [ ] **Step 6: Commit isolated new files**

```powershell
git add migrations/24_manual_meeting_recording.js src/services/manual-meetings/meeting-renderer.js tests/manual-meeting-renderer.test.js
git add -p -- dashboard/lib/db.ts
git diff --cached --name-status
git commit -m "feat: add canonical manual meeting schema"
```

## Task 2: Add repository ownership, state transitions, and atomic rename

**Files:**
- Create: `src/services/manual-meetings/meeting-repository.js`
- Create: `tests/manual-meeting-repository.test.js`

- [ ] **Step 1: Write failing repository tests with a query stub**

Cover idempotent creation by `capture_session_id`, allowed transitions, rejected cross-user reads, and a rename transaction that updates `speaker_names`, every compatibility column, `suggested_tasks`, and `report_markdown`.

```js
test('renameSpeaker materializes every compatibility column in one transaction', async () => {
  const db = createRecordingDbStub();
  const repo = createMeetingRepository({ query: db.query });
  const updated = await repo.renameSpeaker({ meetingId: 7, userPhone: 'wa_1', speakerId: 'A', name: 'Danish' });
  assert.equal(updated.speaker_names.A, 'Danish');
  assert.match(updated.transcript, /Danish:/);
  assert.match(updated.summary, /Danish/);
  assert.equal(db.commands[0], 'BEGIN');
  assert.equal(db.commands.at(-1), 'COMMIT');
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `node --test tests/manual-meeting-repository.test.js`  
Expected: FAIL because `meeting-repository.js` does not exist.

- [ ] **Step 3: Implement a dependency-injected repository**

Export `createMeetingRepository({ query })` with:

```js
createFromCapture({ captureSessionId, userPhone, title, capturePlatform, captureCodec })
getOwned(meetingId, userPhone, { forUpdate = false } = {})
transition(meetingId, userPhone, fromStages, patch)
saveCanonicalTranscript(meetingId, userPhone, transcriptId, segments, durationSeconds)
saveCanonicalReport(meetingId, userPhone, report)
renameSpeaker({ meetingId, userPhone, speakerId, name })
findRecoverable(limit = 20)
markFailed(meetingId, userPhone, code, safeMessage)
```

Validate speaker IDs with `/^[A-Z]+$/`, names as trimmed 1–80 character display strings, and transitions against an explicit map:

```js
const TRANSITIONS = {
  captured: ['uploading', 'cancelled'],
  uploading: ['transcribing', 'failed'],
  transcribing: ['generating_report', 'failed'],
  generating_report: ['completed', 'failed'],
  failed: ['uploading', 'transcribing', 'generating_report'],
};
```

Use `BEGIN`, `SELECT ... FOR UPDATE`, `materializeMeeting`, one `UPDATE`, `COMMIT`, and `ROLLBACK` for rename.

- [ ] **Step 4: Run repository and renderer tests**

Run: `node --test tests/manual-meeting-renderer.test.js tests/manual-meeting-repository.test.js`  
Expected: all PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/services/manual-meetings/meeting-repository.js tests/manual-meeting-repository.test.js
git commit -m "feat: add durable manual meeting repository"
```

## Task 3: Add private recording storage and AssemblyAI diarization

**Files:**
- Create: `src/services/manual-meetings/recording-storage.js`
- Create: `src/services/manual-meetings/assemblyai-client.js`
- Create: `tests/manual-meeting-external-services.test.js`

- [ ] **Step 1: Write failing external-service contract tests**

Use injected HTTP/S3 clients. Assert that storage uses private `PutObject`, verifies with `HeadObject`, and signs `GetObject`; assert AssemblyAI sends `speaker_labels: true`, language detection, and normalizes utterances to `{speakerId,startMs,endMs,text,confidence}`.

```js
test('AssemblyAI submission enables neutral speaker diarization', async () => {
  const calls = [];
  const client = createAssemblyAIClient({
    apiKey: 'test',
    http: async (request) => { calls.push(request); return { id: 'tx_1', status: 'queued' }; },
  });
  await client.submit('https://signed.example/meeting.m4a');
  assert.equal(calls[0].body.speaker_labels, true);
  assert.equal(calls[0].body.language_detection, true);
  assert.equal(calls[0].body.speaker_identification, undefined);
});
```

- [ ] **Step 2: Run and confirm missing-module failure**

Run: `node --test tests/manual-meeting-external-services.test.js`  
Expected: FAIL for missing modules.

- [ ] **Step 3: Implement storage with a generic configuration**

Read `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET_NAME` (or equivalent existing generic `S3_*` aliases). Store references as `s3://<bucket>/<key>`, never public URLs. Export:

```js
createRecordingStorage({ s3, bucket, endpoint })
uploadFile({ meetingId, userPhone, filePath, mimeType })
verify(reference)
signRead(reference, expiresInSeconds = 900)
delete(reference)
```

Generate keys as `manual-meetings/<sha256-user>/<yyyy-mm>/<meeting-id>/<uuid>.m4a` and stream with `fs.createReadStream`.

- [ ] **Step 4: Implement AssemblyAI submit and poll**

Use `https://api.assemblyai.com/v2/transcript`, a 30-second HTTP timeout per request, and bounded polling. `normalizeUtterances` must use AssemblyAI letters without name inference:

```js
function normalizeUtterances(utterances = []) {
  return utterances.map((u) => ({
    speakerId: String(u.speaker || 'A').replace(/^Speaker\s+/i, ''),
    startMs: Number(u.start || 0),
    endMs: Number(u.end || 0),
    text: String(u.text || '').trim(),
    confidence: Number.isFinite(u.confidence) ? u.confidence : null,
  })).filter((u) => u.text);
}
```

- [ ] **Step 5: Run focused tests**

Run: `node --test tests/manual-meeting-external-services.test.js`  
Expected: all PASS without network access.

- [ ] **Step 6: Commit**

```powershell
git add src/services/manual-meetings/recording-storage.js src/services/manual-meetings/assemblyai-client.js tests/manual-meeting-external-services.test.js
git commit -m "feat: add manual meeting storage and transcription clients"
```

## Task 4: Generate and validate the complete report

**Files:**
- Create: `src/services/manual-meetings/report-generator.js`
- Create: `tests/manual-meeting-report.test.js`

- [ ] **Step 1: Write failing schema and retry tests**

Require summary, decisions, action items, suggested tasks, topics, and nonempty Markdown report. Assert unknown speaker IDs and invented names are rejected, and malformed first output is retried once.

```js
test('report keeps canonical speaker IDs and all required sections', async () => {
  const generator = createReportGenerator({ llm: fakeLlm(validReport) });
  const report = await generator.generate({
    title: 'Planning',
    transcriptSegments: [{ speakerId: 'A', text: 'I will ship Friday.', startMs: 0, endMs: 10 }],
  });
  assert.equal(report.actionItems[0].assigneeSpeakerId, 'A');
  assert.ok(report.summary);
  assert.ok(report.reportMarkdown.includes('#'));
  assert.ok(Array.isArray(report.suggestedTasks));
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `node --test tests/manual-meeting-report.test.js`  
Expected: FAIL for missing module.

- [ ] **Step 3: Implement Zod validation and a canonical prompt**

Define the exact output schema in code. The prompt must say: use only `Speaker <ID>` tokens found in the transcript; never infer personal names; suggested tasks are proposals only; `reportMarkdown` must include overview, decisions, action items, suggested tasks/assignees, open questions, and transcript notes.

Call the existing `llm-provider.chatCompletion`, parse a fenced or plain JSON object, validate, and retry at most once with the validation errors. Export `createReportGenerator({ llm })` and `reportSchema`.

- [ ] **Step 4: Run report tests**

Run: `node --test tests/manual-meeting-report.test.js`  
Expected: all PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/services/manual-meetings/report-generator.js tests/manual-meeting-report.test.js
git commit -m "feat: generate structured manual meeting reports"
```

## Task 5: Build durable processing and restart recovery

**Files:**
- Create: `src/services/manual-meetings/processor.js`
- Create: `tests/manual-meeting-processor.test.js`
- Modify: `src/index.js`

- [ ] **Step 1: Write failing state-machine tests**

Test the happy path, storage failure, AssemblyAI failure, report-only retry, duplicate resume, and startup recovery. Use injected repository/storage/transcriber/report/normalizer dependencies.

```js
test('processor persists each checkpoint and completes once', async () => {
  const deps = fixtureDependencies();
  const processor = createManualMeetingProcessor(deps);
  await processor.process({ meetingId: 4, userPhone: 'wa_1', localPath: 'fixture.webm', mimeType: 'audio/webm' });
  assert.deepEqual(deps.repo.stages, ['uploading', 'transcribing', 'generating_report', 'completed']);
  assert.equal(deps.storage.uploads, 1);
  assert.equal(deps.report.calls, 1);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `node --test tests/manual-meeting-processor.test.js`  
Expected: FAIL for missing processor.

- [ ] **Step 3: Implement normalization and durable orchestration**

Use the bundled FFmpeg path to normalize input to 48 kHz AAC `.m4a` in a unique temp directory. Never build shell strings; use `spawn(ffmpegPath, args)`. Persist the storage reference before submitting AssemblyAI, persist the transcript ID before polling, persist canonical segments before report generation, and delete only normalized temporary files in `finally`.

`startRecovery()` must query `findRecoverable(20)`, deduplicate active meeting IDs in a bounded `Set`, and resume from the stored `processing_stage`. It must not create a cron job or inspect calendars.

- [ ] **Step 4: Wire recovery after database initialization**

In `src/index.js`, start the processor only when `ARI_DESKTOP_INTERNAL_TOKEN` and `ASSEMBLYAI_API_KEY` exist:

```js
const manualMeetingProcessor = require('./services/manual-meetings/processor');
// after DB/schema startup
manualMeetingProcessor.startRecovery().catch((error) =>
  logger.error(`Manual meeting recovery failed: ${error.message}`)
);
```

Do not remove old bot startup code yet; removal occurs after the new end-to-end route is green.

- [ ] **Step 5: Run tests**

Run: `node --test tests/manual-meeting-processor.test.js tests/manual-meeting-*.test.js`  
Expected: all manual meeting backend tests PASS.

- [ ] **Step 6: Commit safely**

```powershell
git add src/services/manual-meetings/processor.js tests/manual-meeting-processor.test.js
git add -p -- src/index.js
git diff --cached
git commit -m "feat: process and recover manual meetings"
```

## Task 6: Add loopback-only upload and meeting actions API

**Files:**
- Create: `src/utils/desktop-internal-auth.js`
- Create: `src/routes/desktop-meetings.routes.js`
- Create: `tests/desktop-meetings-routes.test.js`
- Modify: `src/index.js`

- [ ] **Step 1: Write failing auth and route tests**

Cover missing/wrong token, non-loopback address, missing user phone, oversized upload, duplicate capture ID, successful streamed upload, cross-user rename, retry, and playback signing.

```js
test('desktop meeting routes require both loopback and launch token', async () => {
  const app = createRouteHarness({ token: 'secret', remoteAddress: '203.0.113.2' });
  const response = await app.post('/internal/desktop/meetings').set('x-ari-desktop-token', 'secret');
  assert.equal(response.status, 403);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `node --test tests/desktop-meetings-routes.test.js`  
Expected: FAIL for missing route/auth modules.

- [ ] **Step 3: Implement strict internal auth**

Accept only `127.0.0.1`, `::1`, or IPv4-mapped loopback. Compare tokens with `crypto.timingSafeEqual` after verifying equal length. Require `x-ari-user-phone` and sanitize it to the application's existing phone format.

- [ ] **Step 4: Implement streaming endpoints**

Mount before any body parser that consumes audio:

```text
POST  /internal/desktop/meetings
POST  /internal/desktop/meetings/:id/retry
PATCH /internal/desktop/meetings/:id/speakers/:speakerId
GET   /internal/desktop/meetings/:id/recording
```

For upload, stream `req` to a unique file under `os.tmpdir()/ari-manual-meetings`, enforce the declared and observed byte limit (default 2 GiB), abort cleanly on disconnect, create idempotently by `x-ari-capture-session`, start processing, and return `{ok:true, meetingId, processingStage}`.

- [ ] **Step 5: Mount the router and run route tests**

Run: `node --test tests/desktop-meetings-routes.test.js tests/manual-meeting-*.test.js`  
Expected: all PASS.

- [ ] **Step 6: Commit safely**

```powershell
git add src/utils/desktop-internal-auth.js src/routes/desktop-meetings.routes.js tests/desktop-meetings-routes.test.js
git add -p -- src/index.js
git diff --cached
git commit -m "feat: add secure desktop meeting API"
```

## Task 7: Add Electron capture-session persistence and backend upload

**Files:**
- Create: `desktop/src/meeting-capture/session-manager.js`
- Create: `desktop/src/meeting-capture/backend-client.js`
- Create: `desktop/tests/meeting-session-manager.test.js`
- Create: `desktop/tests/meeting-backend-client.test.js`
- Modify: `desktop/src/config.js`

- [ ] **Step 1: Write failing desktop service tests**

Use temporary directories and fake HTTP. Test valid transitions, bounded chunk writes, duplicate stop idempotency, cancel cleanup, recoverable manifests, low-disk refusal, and streamed request bodies.

```js
test('finalize is idempotent and preserves a recoverable manifest', async () => {
  const manager = createSessionManager({ root: tempDir, minFreeBytes: 1 });
  const session = await manager.prepare({ platform: 'win32', codec: 'webm-opus' });
  await manager.start(session.id);
  await manager.writeChunk(session.id, Buffer.from('audio'));
  const first = await manager.stop(session.id);
  const second = await manager.stop(session.id);
  assert.deepEqual(second, first);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test --prefix desktop -- --test-name-pattern="meeting"`  
Expected: FAIL for missing meeting-capture modules.

- [ ] **Step 3: Implement the session manager**

Persist `<session-id>.json` manifests atomically beside the recording. Use states `prepared`, `recording`, `paused`, `finalizing`, `finalized`, `uploading`, `submitted`, `cancelled`, `failed`. Generate IDs with `crypto.randomUUID`, sanitize metadata, serialize writes per session, and expose `recover()` for nonterminal manifests.

- [ ] **Step 4: Implement streaming backend upload**

Use Node `http.request`/`https.request`, `fs.createReadStream`, `Content-Length`, `Content-Type`, `x-ari-desktop-token`, `x-ari-user-phone`, and `x-ari-capture-session`. Emit byte progress and parse a bounded JSON response. Never expose the internal token to the renderer.

- [ ] **Step 5: Add runtime values**

In `desktop/src/config.js`, carry `desktopPhone`, `backendUrl`, capture directory, and internal token availability without logging the token.

- [ ] **Step 6: Run tests and commit new files**

Run: `npm test --prefix desktop -- --test-name-pattern="meeting"`  
Expected: all meeting desktop service tests PASS.

```powershell
git add desktop/src/meeting-capture desktop/tests/meeting-session-manager.test.js desktop/tests/meeting-backend-client.test.js
git add -p -- desktop/src/config.js
git commit -m "feat: persist and upload desktop meeting captures"
```

## Task 8: Expose a secure Electron meeting IPC surface

**Files:**
- Modify: `desktop/src/main.js`
- Modify: `desktop/src/preload.js`
- Create: `desktop/tests/meeting-ipc.test.js`

- [ ] **Step 1: Write failing IPC contract tests**

Assert preload exposes only `capabilities`, `prepare`, `start`, `writeChunk`, `pause`, `resume`, `stop`, `cancel`, and `onProgress`; assert main rejects calls outside the local dashboard and rejects chunks for another session.

- [ ] **Step 2: Run and confirm failure**

Run: `npm test --prefix desktop -- --test-name-pattern="meeting IPC"`  
Expected: FAIL because `ariDesktop.meetings` does not exist.

- [ ] **Step 3: Generate and propagate a per-launch token**

At boot, create `crypto.randomBytes(32).toString('hex')`, assign it to `runtime.childEnv.ARI_DESKTOP_INTERNAL_TOKEN`, and pass the same child environment to backend and dashboard. Never place it in `additionalArguments`, preload, renderer globals, or logs.

- [ ] **Step 4: Replace blanket media denial with origin-scoped checks**

Keep denial as default. Permit `media` requests only when `classifyUrl(requestingOrigin, runtime.dashboardUrl) === 'local'`. Add `setPermissionCheckHandler` and `setPermissionRequestHandler`; all nonmedia permissions remain false.

- [ ] **Step 5: Register IPC and preload methods**

Every handler first checks `fromLocalDashboard(event)`. `stop` finalizes and asks `backend-client` to upload; return `{meetingId, processingStage}`. Progress events use a fixed channel and preload returns an unsubscribe function.

- [ ] **Step 6: Run the desktop suite**

Run: `npm test --prefix desktop`  
Expected: existing and new Electron tests PASS.

- [ ] **Step 7: Commit only meeting hunks**

```powershell
git add desktop/tests/meeting-ipc.test.js
git add -p -- desktop/src/main.js desktop/src/preload.js
git diff --cached
git commit -m "feat: expose secure meeting recording IPC"
```

## Task 9: Implement Windows system-plus-microphone capture

**Files:**
- Create: `dashboard/app/meetings/windows-recorder.ts`
- Create: `dashboard/tests/windows-recorder.test.ts`
- Modify: `desktop/src/main.js`

- [ ] **Step 1: Write failing recorder tests with fake MediaStreams**

Test display and microphone acquisition, separate level callbacks, mixed destination use, five-second chunk delivery, pause/resume, track cleanup, and failure when either source has no audio track.

- [ ] **Step 2: Run and confirm failure**

Run: `npm test --prefix dashboard -- --test-name-pattern="Windows meeting recorder"`  
Expected: FAIL for missing module.

- [ ] **Step 3: Implement the renderer recorder**

Call:

```ts
const system = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
const microphone = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
```

Discard/stop the display video track after audio acquisition. Connect both audio sources to an `AudioContext` destination and to separate `AnalyserNode`s. Use the first supported MIME type from `audio/webm;codecs=opus` and `audio/webm`; call `mediaRecorder.start(5000)`. Send each nonempty `ArrayBuffer` through `ariDesktop.meetings.writeChunk` sequentially.

- [ ] **Step 4: Configure Electron loopback**

Use `session.defaultSession.setDisplayMediaRequestHandler`. Verify local origin and user gesture, obtain screen sources with `desktopCapturer.getSources({types:['screen']})`, choose the primary display, and call `callback({video: source, audio: 'loopback'})`. Reject every other origin.

- [ ] **Step 5: Run dashboard and desktop tests**

```powershell
npm test --prefix dashboard -- --test-name-pattern="Windows meeting recorder"
npm test --prefix desktop -- --test-name-pattern="meeting"
```

Expected: all focused tests PASS.

- [ ] **Step 6: Commit**

```powershell
git add dashboard/app/meetings/windows-recorder.ts dashboard/tests/windows-recorder.test.ts
git add -p -- desktop/src/main.js
git commit -m "feat: capture Windows system and microphone audio"
```

## Task 10: Implement the macOS native capture helper

**Files:**
- Create: `desktop/native/macos/Package.swift`
- Create: `desktop/native/macos/Sources/AriMeetingCapture/main.swift`
- Create: `desktop/src/meeting-capture/macos-helper.js`
- Create: `desktop/scripts/build-macos-capture.js`
- Create: `desktop/tests/macos-helper.test.js`
- Modify: `desktop/package.json`

- [ ] **Step 1: Write failing Node wrapper tests**

Use a fake child process. Assert JSON-line parsing for `ready`, `levels`, `paused`, `resumed`, `finalized`, and `error`; stdin commands for pause/resume/stop/cancel; timeout/exit handling; and no arbitrary executable path from renderer input.

- [ ] **Step 2: Run and confirm failure**

Run: `npm test --prefix desktop -- --test-name-pattern="macOS capture helper"`  
Expected: FAIL for missing wrapper.

- [ ] **Step 3: Implement the Swift helper as an explicit state machine**

`Package.swift` declares macOS 13. `main.swift` must:

- Parse only `--output <main-process-generated-path>`.
- Request/check Screen Recording and microphone permission.
- Select the main display with `SCShareableContent` and exclude Ari's own process audio.
- Configure `SCStreamConfiguration.capturesAudio = true`, 48 kHz, stereo.
- Capture microphone with `AVAudioEngine` on macOS 13/14 and mix system/mic PCM by timestamp.
- Write incrementally to a CAF/PCM artifact suitable for backend FFmpeg normalization.
- Emit one JSON object per stdout line; diagnostics go to stderr without recording content.
- Accept `pause`, `resume`, `stop`, and `cancel` JSON commands on stdin.
- Remove output on cancel and finalize atomically on stop.

- [ ] **Step 4: Implement the Node wrapper and build script**

Resolve the helper from development `.build/release` or packaged `process.resourcesPath`. The build script runs `swift build -c release --package-path desktop/native/macos` only on macOS and copies the binary into `desktop/build/native/macos/ari-meeting-capture`.

Add `premac` and `build:mac` chaining plus Electron Builder `extraResources`. Add `NSScreenCaptureUsageDescription` and `NSMicrophoneUsageDescription` to `extendInfo`.

- [ ] **Step 5: Run what is verifiable on each platform**

Windows/local:

```powershell
npm test --prefix desktop -- --test-name-pattern="macOS capture helper"
```

Expected: Node wrapper tests PASS with fake process.

macOS runner:

```bash
node desktop/scripts/build-macos-capture.js
swift test --package-path desktop/native/macos
file desktop/build/native/macos/ari-meeting-capture
```

Expected: Swift build/tests PASS; `file` reports a macOS Mach-O executable.

- [ ] **Step 6: Commit**

```powershell
git add desktop/native/macos desktop/src/meeting-capture/macos-helper.js desktop/scripts/build-macos-capture.js desktop/tests/macos-helper.test.js
git add -p -- desktop/package.json
git commit -m "feat: capture macOS system and microphone audio"
```

## Task 11: Build the Meetings recording and report UI

**Files:**
- Create: `dashboard/lib/manual-meetings.ts`
- Create: `dashboard/app/meetings/meeting-recorder.tsx`
- Create: `dashboard/app/meetings/meeting-detail.tsx`
- Create: `dashboard/app/api/meetings/[id]/status/route.ts`
- Create: `dashboard/app/api/meetings/[id]/speakers/route.ts`
- Create: `dashboard/app/api/meetings/[id]/retry/route.ts`
- Create: `dashboard/app/api/meetings/[id]/recording/route.ts`
- Create: `dashboard/tests/manual-meetings.test.ts`
- Modify: `dashboard/app/api/meetings/list/route.ts`
- Modify: `dashboard/app/meetings/meetings-content.tsx`
- Modify: `dashboard/app/meetings/page.tsx`

- [ ] **Step 1: Write failing UI/data tests**

Cover desktop capability detection, browser desktop-only message, recording states, both source meters, status polling cleanup, all report sections, neutral labels, rename request, retry visibility, signed playback, and task suggestions not invoking task APIs.

- [ ] **Step 2: Run and confirm failure**

Run: `npm test --prefix dashboard -- --test-name-pattern="manual meetings"`  
Expected: FAIL for missing UI/API modules.

- [ ] **Step 3: Add strict shared types and internal proxying**

Define `ProcessingStage`, `TranscriptSegment`, `CanonicalReport`, `SpeakerNames`, and `ManualMeeting`. The server-only proxy reads `BOT_INTERNAL_URL` and `ARI_DESKTOP_INTERNAL_TOKEN`; it forwards the authenticated phone and never serializes the token to client code.

- [ ] **Step 4: Add authenticated routes**

`status` reads the owned row directly. `speakers`, `retry`, and `recording` authenticate with `getCurrentUserPhone` and proxy to the loopback backend. Validate numeric ID, speaker ID, name length, and JSON body. Return generic user-safe errors.

- [ ] **Step 5: Build the recorder component**

Render the primary **Record Meeting** button in the existing Meetings header. Inside desktop: title input, start, elapsed time, separate system/mic meters, pause/resume, stop, cancel, upload progress, and processing stage. Outside desktop: `Recording is available in the Ari desktop app.`

Windows uses `windows-recorder.ts`; macOS capture is controlled entirely through preload. Always unsubscribe progress listeners and stop media tracks on unmount/error.

- [ ] **Step 6: Build meeting detail and rename UI**

Render playback, summary, decisions, action items, suggested tasks/assignees, report Markdown, and timestamped transcript. Speaker editor saves one name at a time, disables during save, refreshes the meeting response, and proves the new name appears in every section without a page reload.

- [ ] **Step 7: Expand list API fields without breaking legacy rows**

Select new fields with nullable defaults. Parse legacy JSON text defensively. Keep historical rows rendering through the same component even when `source_type` and canonical fields are null.

- [ ] **Step 8: Run dashboard checks**

```powershell
npm test --prefix dashboard
npm run typecheck --prefix dashboard
npm run build --prefix dashboard
```

Expected: tests PASS, typecheck PASS, production build PASS.

- [ ] **Step 9: Commit only meeting hunks**

```powershell
git add dashboard/lib/manual-meetings.ts dashboard/app/meetings/meeting-recorder.tsx dashboard/app/meetings/meeting-detail.tsx dashboard/app/api/meetings/[id] dashboard/tests/manual-meetings.test.ts
git add -p -- dashboard/app/api/meetings/list/route.ts dashboard/app/meetings/meetings-content.tsx dashboard/app/meetings/page.tsx
git diff --cached
git commit -m "feat: add manual recording to Meetings"
```

## Task 12: Preserve downstream meeting consumers and remove bot entry points

**Files:**
- Modify: `src/services/meeting-actions.service.js`
- Modify: `src/services/entity-context.service.js`
- Modify: `src/services/inngest-functions.service.js`
- Modify: `src/mcp/tool-registry.js`
- Modify: `src/controllers/webhook.controller.js`
- Modify: `src/services/tool-definitions.js`
- Modify: `src/services/tool-schemas.js`
- Modify: `src/index.js`
- Modify: `src/routes/webhook.routes.js`
- Test: `tests/meeting-actions.test.js`
- Test: `tests/entity-context.test.js`
- Test: `tests/mcp-platform.test.js`
- Create: `tests/meeting-bot-entrypoints-removed.test.js`

- [ ] **Step 1: Add regression tests for retained consumers**

Use a completed manual row with renamed compatibility fields. Assert meeting action proposals use materialized assignees, entity context reads the renamed report, MCP meeting reads still work, and no tool/intent advertises joining or stopping a bot.

- [ ] **Step 2: Run tests to expose old entry points**

Run:

```powershell
node --test tests/meeting-bot-entrypoints-removed.test.js tests/entity-context.test.js tests/mcp-platform.test.js
```

Expected: removal test FAIL on current meeting-bot commands/routes; retained consumer tests identify any schema assumptions.

- [ ] **Step 3: Remove join/stop/status/autojoin command routing**

Delete meeting URL join detection, confirmation contexts, `handleMeetingBot` join/stop/force-stop/status branches, auto-join preference commands, and meeting-bot tool definitions. Keep read-only meeting history/search/minutes and generic calendar scheduling.

Move any retained recording share/signing and read-only meeting formatting call sites from `meeting-bot.service.js` to the new repository, renderer, and recording-storage modules. Remove the Attendee/Recall meeting completion branch from `inngest-functions.service.js`; retain unrelated Inngest email or automation functions.

- [ ] **Step 4: Remove provider startup and routes**

Delete `/health/meeting`, `/health/meeting-sweep`, `/webhook/recall`, AWS callback/check/static/debug routes, provider bootstrap calls, provider recovery, auto-join startup, and orphan-sweep startup. Mount and start only the new desktop manual-processing route/recovery.

- [ ] **Step 5: Update retained consumers only where tests require**

Read materialized compatibility fields; do not make downstream features parse canonical JSON directly. Ensure task proposals remain suggestions and `MEETING_ACTIONS_AUTO` is no longer consulted.

- [ ] **Step 6: Run backend regression tests**

```powershell
node --test tests/meeting-bot-entrypoints-removed.test.js tests/entity-context.test.js tests/mcp-platform.test.js tests/manual-meeting-*.test.js
```

Expected: all PASS; calendar attendee behavior remains covered by existing calendar tests.

- [ ] **Step 7: Commit meeting-only hunks**

Stage with `git add -p` for every pre-dirty file, inspect the cached diff, and commit only if no unrelated hunks are staged:

```powershell
git commit -m "refactor: switch meeting consumers to manual recordings"
```

## Task 13: Delete provider code, jobs, scripts, tests, and lifecycle tables

This task removes the remaining Recall, AWS/EC2 meeting, and Fly meeting-joiner implementations after the manual path and retained consumers are green.

**Files:**
- Delete: `src/services/meeting-recall.service.js`
- Delete: `src/services/meeting-aws.service.js`
- Delete: `src/services/meeting-backend.js`
- Delete: `src/services/meeting-bot.service.js`
- Delete: `src/services/meeting-billing.service.js`
- Delete: `src/services/meeting-joiner.service.js`
- Delete: `src/services/meeting-recorder.service.js`
- Delete: `src/services/assemblyai-voice.service.js`
- Delete: `src/scripts/meeting-worker.js`
- Delete: `src/jobs/meeting-auto-join.job.js`
- Delete: `src/jobs/meeting-orphan-sweep.job.js`
- Delete: `src/handlers/meeting-bot.handler.js`
- Delete: `src/services/meeting-adapters/`
- Delete: `scripts/recall-join-test.js`
- Delete: `scripts/inspect-meeting-debug.js`
- Delete: `tests/meeting-recall.test.js`
- Delete: `tests/meeting-backend.test.js`
- Create: `migrations/25_remove_meeting_bot_tables.js`
- Modify: `scripts/bootstrap-schema.js`
- Modify: `package.json`
- Modify: lockfiles through `npm install --package-lock-only`

- [ ] **Step 1: Prove every deletion candidate has zero retained imports**

Run:

```powershell
$targets = 'meeting-recall|meeting-aws|meeting-backend|meeting-joiner|meeting-recorder|meeting-auto-join|meeting-orphan-sweep|meeting-bot.handler|meeting-worker'
git grep -n -E $targets -- ':!docs/**' ':!tests/meeting-bot-entrypoints-removed.test.js'
```

Expected: only the files being deleted and provider-removal documentation. If a retained runtime consumer appears, stop and move that behavior to the manual modules before deletion.

- [ ] **Step 2: Delete the provider files and bootstrap entries**

Delete exactly the paths above. Preserve `meeting-actions.service.js`, `meeting-minutes.service.js`, `meeting-minutes.handler.js`, and generic meeting utilities still covered by downstream tests.

- [ ] **Step 3: Remove provider-only packages**

After a global import scan, remove `@aws-sdk/client-ec2`, `@aws-sdk/client-ecs`, and `@deepgram/sdk` if they have no nonmeeting consumer. Keep `@aws-sdk/client-s3`, presigner, FFmpeg, PostgreSQL, and LLM packages.

Run: `npm install --package-lock-only`  
Expected: lockfile updates without install errors.

- [ ] **Step 4: Add the lifecycle-table migration**

`25_remove_meeting_bot_tables.js` drops only provider lifecycle tables that exist and have zero remaining runtime readers: `meeting_recall_bots`, `meeting_aws_instances`, `meeting_health_state`, `meeting_sessions`, `meeting_vexabot`, and `attendee_meetings`. Use `DROP TABLE IF EXISTS`; never drop `meeting_recordings`, calendar tables, action links, or entity facts.

- [ ] **Step 5: Run full backend tests**

Run: `npm test`  
Expected: all backend tests PASS with no missing-module startup failures.

- [ ] **Step 6: Commit deletions only after cached review**

```powershell
git add -A -- src/services/meeting-recall.service.js src/services/meeting-aws.service.js src/services/meeting-backend.js src/services/meeting-bot.service.js src/services/meeting-billing.service.js src/services/meeting-joiner.service.js src/services/meeting-recorder.service.js src/services/assemblyai-voice.service.js src/services/meeting-adapters src/scripts/meeting-worker.js src/jobs/meeting-auto-join.job.js src/jobs/meeting-orphan-sweep.job.js src/handlers/meeting-bot.handler.js scripts/recall-join-test.js scripts/inspect-meeting-debug.js tests/meeting-recall.test.js tests/meeting-backend.test.js migrations/25_remove_meeting_bot_tables.js
git add -p -- scripts/bootstrap-schema.js package.json package-lock.json
git diff --cached --name-status
git commit -m "refactor: remove meeting bot providers"
```

## Task 14: Clean environment, documentation, and product claims

**Files:**
- Modify: `.env.example`
- Modify: `.env` (local ignored file; never stage)
- Modify: `src/utils/env-check.js`
- Modify: `DESIGN.md`
- Modify: `PRD.md`
- Modify: `README.md`
- Replace: `docs/MEETING-BOT-OPS.md` with `docs/MANUAL-MEETING-RECORDING.md`
- Modify: relevant `website/app/preview-nudge/**` meeting pages
- Modify: `website/lib/features-data.ts`
- Create: `scripts/verify-meeting-bot-removal.js`
- Create: `tests/meeting-provider-removal.test.js`

- [ ] **Step 1: Write the failing removal guard**

The script scans tracked text files and fails on provider names, provider env keys, bot callback paths, auto-join claims, and deleted module names. Give it an allowlist for the approved design/implementation-plan historical documents and migration filename only; do not allow runtime or marketing references.

```js
const forbidden = [
  /Recall\.ai|RECALL_API_KEY|ATTENDEE_API|SKRIBBY_/i,
  /AWS_MEETING_|MEETING_BOT_BACKEND|MEETING_BOT_WEBHOOK_SECRET/,
  /meeting-recall|meeting-aws|meeting-joiner|meeting-auto-join|meeting-orphan-sweep/,
  /\/webhook\/(recall|aws-meeting)/,
  /auto-joins? (your )?(meeting|call)/i,
];
```

- [ ] **Step 2: Run and confirm it reports current stale references**

Run: `node scripts/verify-meeting-bot-removal.js`  
Expected: FAIL with a file/line list.

- [ ] **Step 3: Remove exact obsolete environment settings**

Remove every key listed in the design spec from `.env.example`, runtime validation, deployment config, and local `.env`. Keep `ASSEMBLYAI_API_KEY`, generic `R2_*`/`S3_*`, general LLM keys, and nonmeeting `AWS_REGION` consumers. Add concise manual recording comments and no secrets.

- [ ] **Step 4: Rewrite docs and marketing copy**

Describe manual desktop recording, permission requirements, retained private audio, AssemblyAI, speaker rename, and task suggestions. Remove claims that Ari joins Google Meet/Zoom/Teams/Webex or connects a calendar to auto-attend.

- [ ] **Step 5: Run the guard and product checks**

```powershell
node scripts/verify-meeting-bot-removal.js
node --test tests/meeting-provider-removal.test.js
npm test --prefix website
```

Expected: removal guard PASS; provider-removal test PASS; website tests PASS (or, if no website test script exists, `npm run build --prefix website` PASS).

- [ ] **Step 6: Commit tracked cleanup without staging `.env`**

Stage only tracked meeting-related hunks, verify `git diff --cached --name-only` does not include `.env`, then:

```powershell
git commit -m "docs: replace meeting bot with manual recording"
```

## Task 15: Cross-platform verification and completion audit

**Files:**
- Modify: `docs/MANUAL-MEETING-RECORDING.md`
- Create: `docs/verification/manual-meeting-windows.md`
- Create: `docs/verification/manual-meeting-macos.md`

- [ ] **Step 1: Run the complete automated suite**

```powershell
npm test
npm test --prefix dashboard
npm run typecheck --prefix dashboard
npm run build --prefix dashboard
npm test --prefix desktop
npm run smoke --prefix desktop
node scripts/verify-meeting-bot-removal.js
```

Expected: every command exits 0. Record exact command output and any intentionally unavailable platform gate.

- [ ] **Step 2: Run the Windows real-audio gate**

On Windows with valid AssemblyAI/storage/LLM credentials:

1. Play the phrase `WINDOWS SYSTEM AUDIO ALPHA` through system output.
2. Speak `WINDOWS MICROPHONE BRAVO` into the microphone.
3. Pause/resume once, stop, and wait for completion.
4. Verify retained playback includes both phrases.
5. Verify transcript, summary, decisions, action items, task suggestions, and report are present.
6. Rename every speaker and verify a fresh API read plus meeting search uses the new names.
7. Restart during a second transcription and verify recovery without duplicate rows.

Write observed meeting ID, timestamps, pass/fail per assertion, and sanitized error output to `docs/verification/manual-meeting-windows.md`.

- [ ] **Step 3: Run the macOS real-audio gate**

Repeat Step 2 on macOS 13+ with phrases `MAC SYSTEM AUDIO ALPHA` and `MAC MICROPHONE BRAVO`. Confirm Screen Recording and Microphone permission recovery and helper packaging. Record evidence in `docs/verification/manual-meeting-macos.md`.

- [ ] **Step 4: Perform the requirement-by-requirement audit**

For all 12 acceptance criteria in the design spec, cite one or more authoritative artifacts: test output, real-device verification file, runtime API response, database row, provider-removal guard, or source path. Any missing real-device gate means cross-platform completion is not yet proven.

- [ ] **Step 5: Inspect final worktree preservation**

Run:

```powershell
git status --short
git diff --stat
git log --oneline -15
```

Expected: unrelated pre-existing changes remain; no secret file is staged; all new meeting work is accounted for; no destructive reset occurred.

- [ ] **Step 6: Commit verification evidence after both platforms pass**

```powershell
git add docs/MANUAL-MEETING-RECORDING.md docs/verification/manual-meeting-windows.md docs/verification/manual-meeting-macos.md
git commit -m "test: verify manual meetings across desktop platforms"
```

Do not claim the feature complete until both real-device evidence files contain passing results.
