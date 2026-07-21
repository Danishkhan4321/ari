'use strict';

exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE meeting_recordings
      ADD COLUMN IF NOT EXISTS source_type TEXT,
      ADD COLUMN IF NOT EXISTS processing_stage TEXT,
      ADD COLUMN IF NOT EXISTS processing_error_code TEXT,
      ADD COLUMN IF NOT EXISTS processing_error_message TEXT,
      ADD COLUMN IF NOT EXISTS recording_object_key TEXT,
      ADD COLUMN IF NOT EXISTS recording_mime_type TEXT,
      ADD COLUMN IF NOT EXISTS assemblyai_transcript_id TEXT,
      ADD COLUMN IF NOT EXISTS canonical_transcript_segments JSONB,
      ADD COLUMN IF NOT EXISTS canonical_report JSONB,
      ADD COLUMN IF NOT EXISTS speaker_names JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS suggested_tasks JSONB,
      ADD COLUMN IF NOT EXISTS report_markdown TEXT,
      ADD COLUMN IF NOT EXISTS capture_platform TEXT,
      ADD COLUMN IF NOT EXISTS capture_codec TEXT,
      ADD COLUMN IF NOT EXISTS processing_attempts INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS capture_session_id TEXT,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

    UPDATE meeting_recordings
       SET source_type = COALESCE(source_type, 'legacy_recording'),
           processing_stage = COALESCE(
             processing_stage,
             CASE WHEN status = 'failed' THEN 'failed' ELSE 'completed' END
           );

    ALTER TABLE meeting_recordings
      ALTER COLUMN source_type SET DEFAULT 'manual_recording',
      ALTER COLUMN source_type SET NOT NULL,
      ALTER COLUMN processing_stage SET DEFAULT 'captured',
      ALTER COLUMN processing_stage SET NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS uq_meeting_recordings_capture_session
      ON meeting_recordings(capture_session_id)
      WHERE capture_session_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_meeting_recordings_owner_stage
      ON meeting_recordings(user_phone, processing_stage);
    CREATE INDEX IF NOT EXISTS idx_meeting_recordings_assemblyai_transcript
      ON meeting_recordings(assemblyai_transcript_id)
      WHERE assemblyai_transcript_id IS NOT NULL;
  `);
};

exports.down = async () => {
  throw new Error(
    '25_manual_meeting_recording is intentionally not reversible because meeting recordings and reports must be retained.',
  );
};
