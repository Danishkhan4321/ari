# Manual meeting recording

Meeting recording is initiated by the user from the existing **Meetings** page in the desktop app. Ari never joins a call as a participant and never starts from a calendar event.

## Flow

1. The user clicks **Record Meeting** and grants the operating-system permissions.
2. The desktop app captures system audio and microphone audio into a durable local session.
3. **Stop recording** finalizes the local file and streams it to the loopback-only desktop API.
4. The backend normalizes the audio, stores it in private retained object storage, and submits it to AssemblyAI with speaker labels enabled.
5. Ari generates the summary, decisions, action items, suggested tasks and assignees, and the complete report.
6. The Meetings page polls processing status and displays the recording, report, and transcript.

Suggested tasks are proposals. They are not added to a task board until the user explicitly confirms them through the existing task-confirmation flow.

## Required configuration

```dotenv
ASSEMBLYAI_API_KEY=
R2_ENDPOINT=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=
S3_REGION=auto
```

The Electron main process generates `DESKTOP_INTERNAL_TOKEN` at launch and passes it only to the local backend process. Do not configure or expose that token externally.

## Recovery

- Capture chunks and manifests are written atomically under the desktop app's user-data directory.
- Capture chunks and manifests are written atomically, and a finalized recording remains available for retry after an upload failure in the active desktop session.
- Backend processing is checkpointed by `processing_stage`; startup recovery resumes incomplete uploads, transcriptions, and reports.
- The original retained recording is not removed after processing.

## Speaker names

AssemblyAI speakers begin as `Speaker A`, `Speaker B`, and so on. Renaming a speaker performs an owner-scoped transaction that rematerializes the transcript, summary, decisions, actions, suggested tasks, and full report from canonical speaker IDs.

## Operations

- Processing errors expose a stable error code and a retry control on the meeting detail page.
- Playback uses short-lived signed URLs; retained object references remain private.
- Uploads have declared and observed size limits and require the launch-scoped loopback token plus the authenticated user identity.
- Windows capture uses Electron display-audio loopback plus microphone mixing.
- macOS capture uses the signed ScreenCaptureKit helper and requires Screen Recording and Microphone permissions.

On macOS, run `npm run build:mac-helper --prefix desktop` on a Mac with Xcode before packaging. A release must pass a real-device capture covering permission prompts, system audio, microphone audio, pause/resume, stop, upload, transcription, speaker rename, and playback.
