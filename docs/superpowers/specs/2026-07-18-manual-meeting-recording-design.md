# Manual Meeting Recording and Reporting Design

**Date:** 2026-07-18  
**Status:** Approved; ready for implementation planning

## Goal

Remove Ari's provider-backed meeting-bot integration completely and replace it with a manual **Record Meeting** workflow inside the existing Meetings area of the desktop app.

The new workflow must capture both system audio and microphone audio on Windows and macOS, retain the recording, transcribe it with AssemblyAI, and generate:

- A meeting summary
- Key decisions
- Action items
- Suggested tasks and assignees
- A complete meeting report
- A complete speaker-labelled transcript

AssemblyAI speaker labels remain neutral (`Speaker A`, `Speaker B`, and so on) until the user renames them. A rename must update every user-visible and downstream representation of the meeting.

## Product Decisions

The following decisions are approved:

1. Recording is a desktop-app capability. The browser dashboard continues to display meeting history, but it cannot start a recording.
2. Both Windows and macOS must capture system audio and microphone audio.
3. Recordings are retained in Ari's private object storage after processing.
4. Suggested tasks and assignees are report content only. The workflow does not create task-board records automatically.
5. The existing Meetings navigation entry and meeting-history experience remain the feature's home.
6. Historical `meeting_recordings` data remains intact.

## Current-State Audit

The existing meeting feature is not one isolated provider module. It currently includes:

- Recall as the preferred managed bot backend
- AWS/EC2 as a legacy fallback backend
- A legacy Fly machine joiner and meeting recorder
- Recall and AWS callback routes
- Static worker-code routes for EC2 meeting workers
- Auto-join and orphan-sweep jobs
- WhatsApp intents for joining, stopping, and inspecting meeting bots
- Provider health and debug endpoints
- Provider-specific scripts, tests, documentation, marketing copy, dependencies, tables, and environment variables

The audit also found shared features that consume completed meeting records but do not depend on how a meeting was captured. These must remain:

- Meetings dashboard and history
- Recording playback/share support
- Meeting search and minutes
- Agenda and team-calendar projections
- Meeting action proposals
- Entity-context and durable-fact extraction
- MCP meeting retrieval
- Historical meeting billing data where already stored
- Generic calendar events, calendar attendees, and reminders

The `meeting-bot.service.js` module currently mixes reusable transcription, analysis, storage, retrieval, and formatting logic with bot-era naming and assumptions. Its reusable behavior will move behind manual-meeting processing boundaries before the bot-specific implementation is deleted.

## User Experience

### Entry point

The existing **Meetings** navigation button continues to open `/meetings`. The page header gains a primary **Record Meeting** button when it is rendered inside the trusted Ari desktop shell.

When the same page is opened in an ordinary browser, recording controls are unavailable and the page explains that recording requires the Ari desktop app. Existing meeting history remains readable.

### Recording flow

1. The user clicks **Record Meeting**.
2. Ari requests any missing operating-system permissions.
3. Ari verifies that both system audio and microphone audio are available.
4. The user may enter an optional title and start recording.
5. The recording panel shows elapsed time, separate system/microphone level indicators, pause/resume, and stop/cancel controls.
6. Stopping finalizes the local artifact and creates a meeting record immediately.
7. The UI advances through `uploading`, `transcribing`, `generating_report`, and `completed` states.
8. The completed meeting expands into recording playback, summary, decisions, action items, task suggestions, report, speakers, and transcript.

Cancellation before finalization deletes the temporary recording after confirmation. Closing Ari unexpectedly leaves a recoverable local session that can be resumed or discarded on the next launch.

### Speaker renaming

The meeting detail view lists every detected speaker with an editable name field. Initial labels are `Speaker A`, `Speaker B`, and so on.

Saving a rename is atomic. For example, renaming `Speaker A` to `Danish` updates:

- Every transcript segment
- Summary references
- Decisions
- Action items
- Suggested task assignees
- Attendee/speaker lists
- The complete report
- Meeting search, MCP reads, entity context, and other consumers of the materialized meeting columns

Names may be changed repeatedly. The original canonical transcript and report remain intact so a later rename never depends on lossy string reversal.

## Desktop Capture Architecture

The renderer uses one narrow `ariDesktop.meetings` preload API. It never receives provider credentials, storage credentials, unrestricted file paths, or arbitrary process access.

### Windows adapter

Windows uses Electron's display-media request handler to grant system-audio loopback capture for requests originating from Ari's local dashboard. Microphone access is granted only to that same trusted origin.

The renderer combines system and microphone streams with Web Audio, exposes independent level meters, and emits bounded media chunks to the Electron main process. The main process writes chunks incrementally to a session-specific temporary file so long meetings are not retained in renderer memory.

### macOS adapter

macOS uses a bundled, signed Swift capture helper controlled by the Electron main process. It uses ScreenCaptureKit for system audio and AVFoundation/AVAudioEngine for microphone input, then mixes and writes the recording incrementally.

The app declares meaningful Screen Recording and Microphone usage descriptions. The helper reports explicit permission, device, and capture errors to Electron. Ari does not pretend that microphone-only capture satisfies the requirement when system-audio permission is missing.

The implementation targets macOS 13 Ventura or later. ScreenCaptureKit supplies system audio and AVAudioEngine supplies microphone input across that support range. Packaging must fail if the helper is absent, unsigned when signing is enabled, or incompatible with the macOS 13 deployment target.

### Common capture contract

Both adapters implement the same lifecycle:

```text
prepare -> start -> pause/resume -> stop -> finalize
                  \-> cancel
```

Both return:

- A recording-session ID
- A finalized local artifact managed by Electron
- Duration and byte size
- Capture-source health metadata
- The platform and codec used

The processing layer normalizes the finalized artifact into a consistent retained audio format before storage and transcription. Temporary input artifacts are removed only after the retained object is verified, or after explicit cancellation.

## Security Boundary

- Only the configured local dashboard origin may invoke meeting IPC.
- Every recording action requires a user gesture.
- Electron's general deny-by-default permission policy remains; only the precise audio/display permissions required by this feature are allowed.
- The main process validates recording state transitions and rejects duplicate, out-of-order, or cross-session calls.
- Filenames and titles are sanitized; renderer input never becomes an arbitrary filesystem path.
- A per-launch random internal token authenticates communication between Electron and Ari's loopback backend.
- The upload/processing endpoint binds to loopback and rejects non-loopback requests even with a token.
- API and object-storage credentials stay in the backend process.
- Retained recordings are private objects. Playback uses short-lived signed URLs rather than public bucket URLs.
- The UI shows an unmistakable recording indicator for the entire capture session.

## Processing Architecture

### Submission

After finalization, Electron streams the local file to an authenticated loopback endpoint. The backend:

1. Creates or updates the manual meeting row.
2. Validates size, duration, codec, and the presence of usable audio.
3. Normalizes the recording if required.
4. Uploads the retained object to private R2/S3-compatible storage.
5. Submits a signed recording URL to AssemblyAI.
6. Stores the AssemblyAI transcript ID and advances the meeting state.

The file is streamed rather than buffered in full. Upload progress is reported to the desktop UI.

### Transcription

AssemblyAI pre-recorded transcription is requested with speaker diarization enabled. The canonical response stores ordered utterances with:

- Stable sequential speaker ID
- Start and end times
- Text
- Confidence when available

Provider speaker letters are normalized deterministically to Ari's `Speaker A`, `Speaker B`, and later labels. Ari does not ask the model to invent speaker names.

### Report generation

Ari's existing LLM provider layer receives the complete canonical transcript and returns validated structured JSON:

```json
{
  "summary": "...",
  "decisions": ["..."],
  "actionItems": [
    { "text": "...", "assigneeSpeakerId": "A", "deadline": null }
  ],
  "suggestedTasks": [
    { "title": "...", "suggestedAssigneeSpeakerId": "B", "reason": "..." }
  ],
  "topics": ["..."],
  "reportMarkdown": "..."
}
```

The generation prompt requires canonical speaker tokens and forbids invented names. Output is schema-validated. Invalid or truncated output is retried with bounded attempts; a failed report never discards a successful recording or transcript.

Suggested tasks remain suggestions. No row is inserted into the task board by this workflow.

### Restart recovery

Processing uses persisted states rather than an in-memory-only promise. On backend startup, Ari scans manual meetings in recoverable nonterminal states and resumes from the last durable checkpoint.

This replaces the provider auto-join and orphan-sweep jobs. It is not a meeting-joining scheduler: it only resumes user-initiated recordings that were already finalized.

## Data Model

`meeting_recordings` remains the durable parent table so existing consumers and historical data continue to work. A migration adds manual-processing fields, including:

- `source_type` (`manual_desktop` for the new flow)
- `processing_stage`
- `processing_error_code` and a safe user-facing error message
- `recording_object_key`
- `recording_mime_type`
- `assemblyai_transcript_id`
- `canonical_transcript_segments JSONB`
- `canonical_report JSONB`
- `speaker_names JSONB`
- `suggested_tasks JSONB`
- `report_markdown TEXT`
- Capture platform/codec metadata
- Updated timestamps and retry metadata

The existing `transcript`, `summary`, `action_items`, `decisions`, `mom`, `topics`, `attendees`, `duration_seconds`, `recording_url`, and `status` columns remain as compatibility projections for current consumers.

### Canonical and materialized forms

Canonical fields always use stable speaker IDs. Materialized legacy fields apply the current `speaker_names` map.

Speaker rename runs in one database transaction:

1. Lock the meeting row and verify ownership.
2. Validate the requested speaker ID and display name.
3. Update `speaker_names`.
4. Render all materialized fields from the canonical transcript and canonical report.
5. Update search/downstream projections.
6. Commit and return the refreshed meeting.

This makes rename propagation deterministic and prevents partial updates.

## API and IPC Surface

The implementation introduces small, purpose-specific interfaces rather than exposing filesystem or provider primitives.

### Desktop preload

- `meetings.capabilities()`
- `meetings.prepare()`
- `meetings.start(options)`
- `meetings.pause(sessionId)`
- `meetings.resume(sessionId)`
- `meetings.stop(sessionId)`
- `meetings.cancel(sessionId)`
- Progress/status subscriptions with explicit unsubscribe functions

### Dashboard API

- List and retrieve owned meetings
- Retrieve processing status
- Rename a speaker
- Retry an allowed failed stage
- Request a short-lived recording playback URL

### Internal loopback API

- Create a manual recording upload
- Stream/finalize the captured artifact
- Resume processing by meeting ID

All ownership checks use the authenticated Ari desktop user. A user may not retrieve or rename a meeting merely by knowing its numeric ID.

## Removal Plan

The following provider-backed surfaces are removed after their imports and consumers are enumerated:

- Recall service, backend selection, webhook, health reporting, join script, and tests
- AWS/EC2 meeting launcher, worker, callbacks, worker polling, static worker routes, debug endpoints, and tests
- Fly meeting joiner and recovery behavior
- Attendee and Skribby provider remnants
- Meeting recorder browser automation and provider adapters used only by remote joining
- Auto-join and provider orphan-sweep jobs
- WhatsApp meeting-bot join/stop/status commands and tool schemas
- Provider-specific bootstrap-schema entries
- Provider-specific operational scripts and runbooks
- Website and dashboard copy claiming Ari joins meetings automatically
- Provider-only dependencies
- Provider lifecycle tables after a zero-reference audit

Provider lifecycle table removal must not touch `meeting_recordings` or generic calendar tables. The migration may drop only tables proved to be provider lifecycle state.

### Environment cleanup

Remove unused provider-specific variables from tracked examples, runtime checks, deployment files, and the local untracked `.env`. The removal set is:

- `RECALL`, `RECALL_API_KEY`, `RECALL_REGION`, `RECALL_WEBHOOK_SECRET`, `RECALL_ROMANIZE_TRANSCRIPT`, `RECALL_TRANSCRIPT_PROVIDER`, `RECALL_TRANSCRIPT_MODEL`, `RECALL_TRANSCRIPT_LANGUAGES`, and `RECALL_TRANSCRIPT_LANGUAGE`
- `ATTENDEE_API_URL`, `ATTENDEE_API_KEY`, and `ATTENDEE_WEBHOOK_SECRET`
- `SKRIBBY_API_KEY`, `SKRIBBY_TRANSCRIPTION_MODEL`, and `SKRIBBY_TRANSCRIPTION_CREDENTIAL_ID`
- `AWS_MEETING_AMI_ID`, `AWS_MEETING_INSTANCE_TYPE`, `AWS_MEETING_KEY_NAME`, `AWS_MEETING_SECURITY_GROUP`, `AWS_MEETING_SUBNET_ID`, and `AWS_S3_RECORDINGS_BUCKET`
- `MEETING_BOT_BACKEND`, `MEETING_BOT_NAME`, `MEETING_BOT_IMAGE`, and `MEETING_BOT_WEBHOOK_SECRET`
- `FLY_API_TOKEN`, `FLY_APP_NAME`, and `FLY_REGION`
- `ENABLE_MEETING_AUTO_JOIN`, `MAX_MEETING_DURATION_MINUTES`, `MEETING_ENABLE_VIDEO`, and `MEETING_RECORDING_MODE`
- `MEETING_AAI_MODELS`, `MEETING_BOOST_PARAM`, `MEETING_LANG_CODE`, `MEETING_LANG_CODES`, `MEETING_WORD_BOOST`, and `MEETING_ACTIONS_AUTO`
- `DEEPGRAM_API_KEY`, after the reusable processing code no longer contains the Deepgram fallback

Retain variables that still have verified non-bot consumers:

- `ASSEMBLYAI_API_KEY`
- Generic private object-storage credentials and bucket configuration
- General LLM provider keys
- Shared AWS settings used by non-meeting services

If an old meeting-named storage variable becomes generic infrastructure for retained recordings, replace it with a generic recording-storage name and provide a deliberate migration path. Do not silently keep a provider-era variable under a misleading name.

## Technical References

- Electron `session.setDisplayMediaRequestHandler` documents Windows system-audio loopback capture: <https://www.electronjs.org/docs/latest/api/session>
- Apple ScreenCaptureKit captures screen and audio content: <https://developer.apple.com/documentation/screencapturekit>
- Apple's capture sample covers system audio, microphone configuration, and permission behavior: <https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos>
- AssemblyAI speaker diarization returns ordered utterances with sequential speaker letters: <https://www.assemblyai.com/docs/pre-recorded-audio/label-speakers>

## Error Handling

Every failure maps to a stable error code and an actionable user message.

- Missing desktop capability: explain that recording requires the desktop app.
- Permission denied: identify Screen Recording/system audio or microphone permission and offer OS-specific remediation.
- Missing source: do not start when either required source is unavailable.
- Silent source: show separate level warnings during recording and validate audio before upload.
- Low disk: refuse to start or stop safely before exhausting disk space.
- App crash: preserve and recover the finalized or recoverable partial session.
- Upload/storage failure: retain the local file and offer retry.
- AssemblyAI failure: preserve the retained recording and retry transcription without re-upload when possible.
- Report failure: preserve recording and transcript and retry only report generation.
- Rename conflict/invalid name: reject the transaction without changing any materialized field.
- Cancellation: stop capture, revoke streams/processes, and remove temporary artifacts.

Retries are bounded and idempotent. Duplicate stop, upload, or processing requests must not create duplicate meeting rows or reports.

## Compatibility and Preservation

- Existing meeting-history rows continue rendering even when they have no canonical manual-recording fields.
- Existing meeting search, minutes, MCP, agenda, calendar, action proposal, and entity-context consumers continue reading compatible columns.
- Calendar scheduling and ordinary attendee handling are unrelated and remain.
- Existing Ari branding and theme edits in the dirty worktree are preserved.
- The work does not deploy, push, or modify unrelated features.

## Verification Strategy

### Static dependency and removal audit

- Enumerate imports and call sites before deleting each module.
- Search tracked source, tests, scripts, docs, examples, workflows, and marketing copy for Recall, Attendee, Skribby, AWS meeting, joiner, auto-join, callback, and obsolete meeting-bot references.
- Verify provider-only packages are absent from manifests and lockfiles.
- Verify runtime environment validation no longer requests removed variables.
- Verify no startup path imports a removed job or service.

Generic English uses such as calendar `attendees` are not provider references and must not be removed.

### Automated tests

- Windows capture lifecycle and media-chunk persistence
- macOS Swift helper compilation and capture lifecycle tests on a macOS runner
- Trusted-origin and permission-policy tests
- Start, pause, resume, stop, cancel, duplicate-call, and crash-recovery tests
- Streaming upload and storage verification
- AssemblyAI request, polling, diarization normalization, and failure tests
- Structured report validation and retry tests
- Speaker rename propagation across every materialized artifact
- Ownership and cross-user rejection tests
- Legacy meeting-row compatibility tests
- Existing dashboard, backend, Electron, meeting actions, entity context, MCP, agenda, and team-calendar regression suites

### End-to-end release gate

Run the following on a real Windows machine and a real supported macOS machine with production-equivalent permissions and test credentials:

1. Play a known phrase through system audio.
2. Speak a different known phrase through the microphone.
3. Record, pause/resume, and stop from the Meetings page.
4. Confirm the retained recording plays both sources.
5. Confirm AssemblyAI returns speaker-labelled utterances containing both phrases.
6. Confirm summary, decisions, action items, task suggestions, and full report are present.
7. Rename each detected speaker and verify the new names appear everywhere, including a fresh API read and downstream meeting search.
8. Restart Ari during a second processing run and verify recovery completes without duplicate rows.

The feature is not considered cross-platform complete until both real-platform gates pass. CI compilation alone is insufficient proof of system-audio capture.

## Acceptance Criteria

The implementation is complete when:

1. The existing Meetings entry contains a working manual **Record Meeting** flow in the Ari desktop app.
2. Windows and macOS capture both system audio and microphone audio.
3. Recordings are written incrementally, retained privately, and playable through signed access.
4. AssemblyAI produces a complete diarized transcript with neutral speaker labels.
5. Ari generates the summary, decisions, action items, suggested tasks/assignees, and complete meeting report.
6. Renaming any speaker updates every transcript and report artifact and every compatibility projection atomically.
7. Suggested tasks are not automatically inserted into the task board.
8. Failed upload, transcription, report, and interrupted-processing stages can recover without re-recording.
9. Recall, Attendee, Skribby, AWS/EC2 meeting joining, Fly joining, provider webhooks, provider jobs, commands, code, dependencies, docs, marketing claims, and unused environment variables are absent.
10. Historical meeting records and verified downstream meeting features continue to work.
11. Automated suites pass and the real Windows and macOS end-to-end release gates pass.
12. Unrelated uncommitted work remains preserved.
