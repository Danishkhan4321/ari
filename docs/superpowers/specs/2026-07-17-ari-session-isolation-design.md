# Ari Session Isolation and Idempotent Messaging Design

**Date:** 2026-07-17  
**Status:** Approved for planning

## Purpose

Ari must treat every session as a real, independent conversation thread. Starting a new session creates an empty history and fresh AI context. Opening an existing session resumes only that session's messages and context.

The same change must prevent one user submission, especially a slow document upload, from being persisted or rendered multiple times.

## Current Failure

The current dashboard does not persist sessions. The **New session** action only changes client-side display state. `groupMessagesIntoSessions` later reconstructs sessions from a 45-minute inactivity gap, while backend context queries load recent messages by phone number. Two sessions started close together therefore merge and share context.

Document requests are also persisted on more than one processing path. The first save happens before document processing and another can happen after the caption is routed through the agent. The existing 15-second content-based duplicate guard fails whenever document processing takes longer than 15 seconds, producing repeated user bubbles from one submission.

## Product Semantics

- A session is a thread with a stable UUID.
- Each session owns its message history, title, attachments, active agent run, and model context.
- **New session** creates a new thread immediately, even before its first message.
- A new session starts with no messages or summaries from any other session.
- Selecting an existing session restores only that session.
- Two sessions may contain identical prompts; they remain separate valid messages.
- A single logical submission may appear at most once in its session.
- Session isolation applies to Ari's dashboard and Electron desktop app, which share the dashboard chat surface.
- In a local Electron development run, right-clicking a session exposes **Copy session log path** for that thread.
- WhatsApp and other external channels retain their existing history behavior unless they explicitly adopt session IDs later.

## Recommended Architecture

### Session records

Create an `ari_chat_sessions` table with:

- `id UUID PRIMARY KEY`
- `user_phone VARCHAR NOT NULL`
- `title VARCHAR(120)`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `archived_at TIMESTAMPTZ NULL`

Index sessions by `(user_phone, updated_at DESC)`. All session reads and writes must also match the authenticated user's normalized phone number.

### Session-aware messages

Extend `conversation_history` with nullable fields:

- `session_id UUID REFERENCES ari_chat_sessions(id)`
- `client_message_id UUID NULL`

Add an index on `(user_phone, session_id, id)` and a partial unique index on `(user_phone, session_id, client_message_id)` where `client_message_id IS NOT NULL AND role = 'user'`. Assistant messages keep the session ID but leave `client_message_id` null, allowing one turn to produce both an intermediate acknowledgement and a final response.

`session_id` remains nullable for legacy WhatsApp and other channel messages. Dashboard and desktop messages always require a valid session ID.

Assistant messages are associated with the same session through request-scoped execution context. The client message ID identifies the logical inbound turn and makes retries idempotent.

### Request-scoped context

When the dashboard bridge starts processing a message, it establishes request-scoped context containing:

- authenticated user identity
- session ID
- client message ID
- run ID
- source channel

All asynchronous processing spawned for that turn inherits this context. History writes, context reads, progress events, cancellation, and attachment handling use the session ID from this context instead of a mutable global "active session" value. This prevents two windows or concurrent sessions from crossing streams.

### API behavior

Add session endpoints:

- `POST /api/chat/sessions` creates and returns a new empty session.
- `GET /api/chat/sessions` lists the authenticated user's recent sessions.
- `GET /api/chat/messages?sessionId=<uuid>&since=<id>` returns only messages belonging to that session.
- Rename operations target a session ID rather than the first message ID.

Change message submission:

- `POST /api/chat/send` requires `sessionId` and `clientMessageId` for dashboard and desktop requests.
- The dashboard-to-bot bridge forwards `session_id`, `client_message_id`, and `run_id`.
- The backend validates that the session belongs to the authenticated user before accepting or returning data.

### Client behavior

On initial load, the client lists real session records. It selects the requested session, the most recently used session, or creates a new empty session when none exists.

Pressing **New session** calls the creation endpoint, selects the returned session, clears transient composer/run state, and updates the URL with the session ID. It does not infer a boundary from message timestamps.

The composer generates one `clientMessageId` per logical submission. A synchronous in-flight ref closes the small gap before React's `sending` state rerenders, preventing Enter, button, or event-repeat paths from launching the same submission twice.

Polling, optimistic reconciliation, titles, recent-session navigation, attachments, progress events, and stop actions are all scoped to the selected session. A response from a background session must not be inserted into the currently visible session.

### Local session debug logs

The current global `logs/agent-turns.jsonl` file mixes unrelated users and turns. Session-aware dashboard and desktop turns instead append sanitized JSONL records to one file per session:

`<ARI_SESSION_LOG_DIR>/<session-id>.jsonl`

Electron injects `ARI_SESSION_LOG_DIR` into the local backend using a directory under Electron's application logs folder. The session creation path creates the directory and an empty file so the path is valid before the first turn. Each record includes the session ID, turn ID, client message ID, run ID, timestamps, routing decisions, sanitized activity, outcome, and error details. It must not include another session's events. Existing secret-key redaction and size limits remain in force.

The Electron preload exposes a narrow session-debug IPC method. When a user right-clicks a session name in the sidebar, the renderer asks the main process to show a native context menu. In an unpackaged local/dev run, the menu contains **Copy session log path**. Selecting it validates the session ID as a UUID, resolves the path inside the configured session-log directory, and copies the absolute path through Electron's clipboard API.

The main process accepts this request only from Ari's local dashboard origin. It rejects path separators, arbitrary filenames, and requests outside the configured log root. Packaged/production builds do not expose the menu item unless an explicit local debug override is enabled. The renderer never receives general filesystem or clipboard access.

## Exactly-Once User Persistence

The backend owns duplicate prevention; the UI guard is only a first line of defense.

The accepted inbound turn inserts the user message once using the unique client-message key. Later document and agent paths do not save that user message again. They only append assistant output and activity for the same session. A retry with the same client message ID returns success without reprocessing or reinserting the turn.

This replaces the current time-and-content heuristic for dashboard messages. Identical prompts sent intentionally as different turns use different client message IDs and are allowed.

## Context Isolation

Every dashboard/desktop context query must include both `user_phone` and `session_id`. Cache keys must include the session ID. Thread summaries, clarification state, tool follow-ups, pending actions, and recent-message lookups must not fall back to phone-only history for a session-aware request.

Starting a new session creates an empty model context. Persistent user-level facts that are explicitly part of Ari's memory system may still be available as user memory, but conversational turns, summaries, pending clarifications, and tool results from other sessions are excluded. This distinction must be visible in tests.

## Migration and Compatibility

The migration is additive and idempotent. Existing `conversation_history` rows remain readable with `session_id = NULL`.

The migration creates one **Previous conversations** legacy session for each user who already has unscoped history and assigns that user's existing rows to it. This preserves all local history without pretending that time gaps represent trustworthy session boundaries. Every new dashboard or desktop turn uses an explicitly created session instead.

External-channel calls without a session ID continue using current phone-scoped behavior. No existing WhatsApp data is deleted.

## Failure Handling

- If session creation fails, keep the current session selected and show a retryable error.
- If a send references a missing or foreign session, reject it without processing.
- If the user switches sessions while a run continues, retain that run under its originating session and show its result there.
- If polling returns a message for another session, ignore it for the active view.
- If a request is retried after an uncertain network result, reuse its client message ID so the server can return the existing outcome safely.
- Cancellation includes both session and run identity.
- If the local session log cannot be created or copied, message processing continues and the UI shows a small non-blocking error.

## Testing

### Unit tests

- Session creation returns a unique empty thread.
- Session listing and message reads enforce ownership.
- Context queries never return messages from another session for the same phone number.
- Cache keys and pending clarification state are session-scoped.
- Repeating a request with one client message ID inserts one user message.
- Reusing identical text with different client message IDs inserts two intentional messages.
- A document turn that takes more than 15 seconds still saves its prompt once.
- Session trace writes go only to the matching session log and retain secret redaction.

### Client tests

- Rapid Enter key events trigger one submission.
- Enter plus send-button interaction triggers one submission.
- **New session** immediately switches to an empty thread.
- Sessions created seconds apart remain separate.
- Switching sessions during a run does not mix progress or messages.
- Reopening a session restores its own title, messages, and attachments.
- Right-clicking a session in a local Electron run offers **Copy session log path**.
- The copied absolute path resolves to that session's JSONL file.
- The debug menu item is absent in a normal packaged/production build.

### Integration tests

- Create session A, converse, create session B immediately, and verify B receives no conversation context from A.
- Return to A and verify its follow-up context remains intact.
- Upload an Excel file with a caption and verify one user bubble, one processing run, and session-scoped assistant output.
- Retry the same network request and verify exactly-once processing.
- Run two sessions concurrently and verify their log files contain no cross-session turn IDs or events.

## Acceptance Criteria

1. Every click on **New session** creates a distinct persisted thread ID.
2. A new session displays no messages from any existing session.
3. AI prompts for a session contain no conversational history, summary, pending clarification, or tool output from another session.
4. Selecting an old session restores only that session and continues with its context.
5. One submission produces one user message, including slow Excel/document requests.
6. Identical text sent intentionally in separate turns or sessions remains valid.
7. Desktop and web dashboard behavior is consistent.
8. Existing WhatsApp history continues to work and no existing history is deleted.
9. In a local Electron run, right-clicking any session can copy the absolute path of that session's sanitized JSONL log.
10. Session-log copying cannot resolve a path outside the configured log directory and is unavailable by default in production builds.

## Non-Goals

- Sharing one session across different users.
- Merging sessions.
- Automatically carrying conversational summaries into new sessions.
- Redesigning the chat interface.
- Changing user-level long-term memory semantics beyond clearly separating it from conversation history.
- Providing general filesystem browsing or arbitrary clipboard access to the renderer.
