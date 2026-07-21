# Simple Meetings Experience Design

## Goal

Rebuild the Ari Meetings page around one understandable path: record a conversation, wait for processing, review the outcome, and confirm the tasks Ari extracted. Preserve the existing desktop audio capture, retained recording, transcription, report generation, speaker renaming, retry, and task confirmation behavior.

## Approved layout

- Keep the shared Ari workspace sidebar and shell unchanged.
- Use a compact page header: `Meetings` and `Record the conversation. Ari handles everything after.`
- Place a single recorder strip directly below the header.
- Place Meeting history below the recorder with a search field.
- Use a master-detail workspace: meeting history on the left at desktop sizes and the selected meeting result on the right.
- Stack the list and result at narrower widths; retain a usable mobile layout.
- Limit result navigation to `Overview` and `Transcript`.
- The overview contains Summary, Decisions, and Tasks.

## Recording behavior

- The desktop bridge remains the only recording transport.
- The idle state shows title, system/microphone readiness, and Record.
- The active state shows elapsed time, audio levels, Pause/Resume, Stop & process, and Cancel.
- Starting, uploading, submitted, unavailable, and error states use plain, local messages.
- Stop submits the retained audio and selects the newly created meeting while processing continues.

## Meeting history behavior

- Load the existing `/api/meetings/list` endpoint without caching.
- Select the newest meeting after initial load unless the user already selected one.
- Search title, platform, attendees, and status client-side.
- Show title, date/time, duration, processing status, and task count.
- Poll only while at least one meeting is in a nonterminal processing stage.
- Loading, empty, filtered-empty, and error states remain inside the history panel.

## Meeting result behavior

- Processing meetings show one compact progress state.
- Failed meetings show the safe error and Retry processing.
- Completed meetings show Summary, Decisions, extracted tasks, Play recording, Overview, and Transcript.
- Speaker renaming remains available from the transcript because names improve task assignment accuracy.
- Transcript rows show timestamp, speaker, and text.

## Task behavior

- Ari extracts suggested tasks from the existing report generator.
- No task is silently assigned. This preserves the current explicit-confirmation workflow.
- A task row may be `ready`, `needs assignee`, `creating`, `created`, or `failed`.
- The user reviews detected tasks, resolves unmatched assignees, and confirms task creation.
- Creation is idempotent per meeting and suggestion index.
- Created tasks link back to the existing Team task view.
- Speaker names are matched to team members only on a unique normalized name match; ambiguous or missing matches require user selection.

## Accessibility and responsive behavior

- All controls use native buttons, inputs, and tabs with accessible names.
- Visible focus states are retained.
- Status is expressed with text as well as color.
- The master-detail layout stacks below 960px and the shared sidebar follows its existing responsive rules.
- No horizontal scrolling is required at supported widths.

## Non-goals

- Do not replace the desktop recording bridge.
- Do not change transcription or report providers.
- Do not silently create tasks without confirmation.
- Do not redesign the global sidebar, header, Team page, or CRM.

