'use strict';

const { materializeMeeting } = require('./meeting-renderer');

const TRANSITIONS = Object.freeze({
  captured: ['uploading', 'cancelled'],
  uploading: ['transcribing', 'failed'],
  transcribing: ['generating_report', 'failed'],
  generating_report: ['completed', 'failed'],
  failed: ['uploading', 'transcribing', 'generating_report'],
});

const PATCH_COLUMNS = Object.freeze({
  processingStage: 'processing_stage',
  processing_stage: 'processing_stage',
  processingErrorCode: 'processing_error_code',
  processing_error_code: 'processing_error_code',
  processingErrorMessage: 'processing_error_message',
  processing_error_message: 'processing_error_message',
  recordingObjectKey: 'recording_object_key',
  recording_object_key: 'recording_object_key',
  recordingMimeType: 'recording_mime_type',
  recording_mime_type: 'recording_mime_type',
  assemblyaiTranscriptId: 'assemblyai_transcript_id',
  assemblyai_transcript_id: 'assemblyai_transcript_id',
  processingAttempts: 'processing_attempts',
  processing_attempts: 'processing_attempts',
});

function requireText(value, label, maxLength) {
  const text = String(value || '').trim();
  if (!text || text.length > maxLength) {
    throw new TypeError(`${label} must be between 1 and ${maxLength} characters`);
  }
  return text;
}

function requireMeetingId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new TypeError('meetingId must be a positive integer');
  return id;
}

function statusForStage(stage) {
  if (stage === 'completed') return 'completed';
  if (stage === 'failed' || stage === 'cancelled') return stage;
  return 'processing';
}

function createMeetingRepository({ query, connect } = {}) {
  if (typeof query !== 'function') throw new TypeError('query is required');

  async function createFromCapture({
    captureSessionId,
    userPhone,
    title,
    capturePlatform,
    captureCodec,
  }) {
    const result = await query(
      `INSERT INTO meeting_recordings (
         capture_session_id, user_phone, title, source_type, processing_stage,
         status, capture_platform, capture_codec, created_at, updated_at
       ) VALUES ($1, $2, $3, 'manual_recording', 'captured', 'processing', $4, $5, NOW(), NOW())
       ON CONFLICT (capture_session_id) WHERE capture_session_id IS NOT NULL
       DO UPDATE SET capture_session_id = EXCLUDED.capture_session_id
       RETURNING *`,
      [
        requireText(captureSessionId, 'captureSessionId', 200),
        requireText(userPhone, 'userPhone', 100),
        requireText(title || 'Untitled Meeting', 'title', 500),
        requireText(capturePlatform, 'capturePlatform', 40),
        requireText(captureCodec, 'captureCodec', 160),
      ],
    );
    return result.rows[0];
  }

  async function getOwned(meetingId, userPhone, { forUpdate = false, queryFn = query } = {}) {
    const result = await queryFn(
      `SELECT * FROM meeting_recordings
        WHERE id = $1 AND user_phone = $2${forUpdate ? ' FOR UPDATE' : ''}`,
      [requireMeetingId(meetingId), requireText(userPhone, 'userPhone', 100)],
    );
    return result.rows[0] || null;
  }

  async function transition(meetingId, userPhone, fromStages, patch) {
    const allowedFrom = Array.isArray(fromStages) ? [...new Set(fromStages)] : [fromStages];
    if (!allowedFrom.length || allowedFrom.some((stage) => !TRANSITIONS[stage])) {
      throw new TypeError('fromStages contains an unknown processing stage');
    }
    const target = patch?.processingStage || patch?.processing_stage;
    if (!target || allowedFrom.some((from) => !TRANSITIONS[from].includes(target))) {
      throw new Error(`Invalid meeting transition from ${allowedFrom.join(', ')} to ${target || 'unknown'}`);
    }

    const assignments = [];
    const values = [requireMeetingId(meetingId), requireText(userPhone, 'userPhone', 100), allowedFrom];
    const seenColumns = new Set();
    for (const [key, value] of Object.entries(patch || {})) {
      const column = PATCH_COLUMNS[key];
      if (!column || seenColumns.has(column)) continue;
      seenColumns.add(column);
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    }
    values.push(statusForStage(target));
    assignments.push(`status = $${values.length}`, 'updated_at = NOW()');

    const result = await query(
      `UPDATE meeting_recordings SET ${assignments.join(', ')}
        WHERE id = $1 AND user_phone = $2 AND processing_stage = ANY($3::text[])
        RETURNING *`,
      values,
    );
    if (!result.rows[0]) {
      const error = new Error('Meeting state changed or meeting was not found');
      error.code = 'MEETING_STATE_CONFLICT';
      throw error;
    }
    return result.rows[0];
  }

  async function saveCanonicalTranscript(meetingId, userPhone, transcriptId, segments, durationSeconds) {
    const meeting = await getOwned(meetingId, userPhone);
    if (!meeting) return null;
    const materialized = materializeMeeting(
      { transcriptSegments: segments, report: meeting.canonical_report || {} },
      meeting.speaker_names || {},
    );
    const result = await query(
      `UPDATE meeting_recordings
          SET assemblyai_transcript_id = $3,
              canonical_transcript_segments = $4::jsonb,
              transcript = $5,
              attendees = $6,
              duration_seconds = $7,
              updated_at = NOW()
        WHERE id = $1 AND user_phone = $2
        RETURNING *`,
      [
        requireMeetingId(meetingId),
        requireText(userPhone, 'userPhone', 100),
        requireText(transcriptId, 'transcriptId', 200),
        JSON.stringify(segments || []),
        materialized.transcript,
        materialized.attendees.join(', '),
        Math.max(0, Math.round(Number(durationSeconds) || 0)),
      ],
    );
    return result.rows[0] || null;
  }

  async function saveCanonicalReport(meetingId, userPhone, report) {
    const meeting = await getOwned(meetingId, userPhone);
    if (!meeting) return null;
    const materialized = materializeMeeting(
      { transcriptSegments: meeting.canonical_transcript_segments || [], report },
      meeting.speaker_names || {},
    );
    const result = await query(
      `UPDATE meeting_recordings
          SET canonical_report = $3::jsonb,
              transcript = $4,
              summary = $5,
              decisions = $6,
              action_items = $7,
              suggested_tasks = $8::jsonb,
              topics = $9,
              mom = $10,
              report_markdown = $11,
              attendees = $12,
              updated_at = NOW()
        WHERE id = $1 AND user_phone = $2
        RETURNING *`,
      [requireMeetingId(meetingId), requireText(userPhone, 'userPhone', 100),
        JSON.stringify(report || {}), materialized.transcript, materialized.summary,
        JSON.stringify(materialized.decisions), JSON.stringify(materialized.actionItems),
        JSON.stringify(materialized.suggestedTasks), JSON.stringify(materialized.topics),
        materialized.reportMarkdown, materialized.reportMarkdown,
        materialized.attendees.join(', ')],
    );
    return result.rows[0] || null;
  }

  async function renameSpeaker({ meetingId, userPhone, speakerId, name }) {
    const validatedId = String(speakerId || '').trim();
    if (!/^[A-Z]+$/.test(validatedId)) {
      throw new TypeError('speaker ID must contain uppercase letters only');
    }
    const validatedName = requireText(name, 'speaker name', 80);
    let client;
    const queryFn = typeof connect === 'function'
      ? async (...args) => {
          if (!client) client = await connect();
          return client.query(...args);
        }
      : query;
    let began = false;
    try {
      await queryFn('BEGIN');
      began = true;
      const meeting = await getOwned(meetingId, userPhone, { forUpdate: true, queryFn });
      if (!meeting) {
        const error = new Error('Meeting not found');
        error.code = 'MEETING_NOT_FOUND';
        throw error;
      }
      const speakerNames = { ...(meeting.speaker_names || {}), [validatedId]: validatedName };
      const materialized = materializeMeeting({
        transcriptSegments: meeting.canonical_transcript_segments || [],
        report: meeting.canonical_report || {},
      }, speakerNames);
      const result = await queryFn(
        `UPDATE meeting_recordings
            SET speaker_names = $3::jsonb,
                transcript = $4,
                summary = $5,
                decisions = $6,
                action_items = $7,
                suggested_tasks = $8::jsonb,
                topics = $9,
                mom = $10,
                report_markdown = $11,
                attendees = $12,
                updated_at = NOW()
          WHERE id = $1 AND user_phone = $2
          RETURNING *`,
        [requireMeetingId(meetingId), requireText(userPhone, 'userPhone', 100),
          JSON.stringify(speakerNames), materialized.transcript, materialized.summary,
          JSON.stringify(materialized.decisions), JSON.stringify(materialized.actionItems),
          JSON.stringify(materialized.suggestedTasks), JSON.stringify(materialized.topics),
          materialized.reportMarkdown, materialized.reportMarkdown,
          materialized.attendees.join(', ')],
      );
      await queryFn('COMMIT');
      began = false;
      return result.rows[0];
    } catch (error) {
      if (began) await queryFn('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      if (client && typeof client.release === 'function') client.release();
    }
  }

  async function findRecoverable(limit = 20) {
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
    const result = await query(
      `SELECT * FROM meeting_recordings
        WHERE source_type = 'manual_recording'
          AND processing_stage IN ('uploading', 'transcribing', 'generating_report')
        ORDER BY updated_at ASC
        LIMIT $1`,
      [safeLimit],
    );
    return result.rows;
  }

  async function markFailed(meetingId, userPhone, code, safeMessage) {
    const result = await query(
      `UPDATE meeting_recordings
          SET processing_stage = 'failed', status = 'failed',
              processing_error_code = $3, processing_error_message = $4,
              processing_attempts = processing_attempts + 1, updated_at = NOW()
        WHERE id = $1 AND user_phone = $2
        RETURNING *`,
      [requireMeetingId(meetingId), requireText(userPhone, 'userPhone', 100),
        requireText(code, 'error code', 80), requireText(safeMessage, 'safe error message', 500)],
    );
    return result.rows[0] || null;
  }

  return {
    createFromCapture,
    getOwned,
    transition,
    saveCanonicalTranscript,
    saveCanonicalReport,
    renameSpeaker,
    findRecoverable,
    markFailed,
  };
}

module.exports = { TRANSITIONS, createMeetingRepository };
