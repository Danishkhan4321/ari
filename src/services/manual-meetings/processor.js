'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

function createAudioNormalizer({
  ffmpegPath: executable = ffmpegPath,
  spawnImpl = spawn,
  makeTempDir = (prefix) => fs.promises.mkdtemp(prefix),
  removeDir = (directory) => fs.promises.rm(directory, { recursive: true, force: true }),
} = {}) {
  async function normalize({ inputPath }) {
    const sourcePath = path.resolve(String(inputPath || ''));
    if (!inputPath) throw new TypeError('inputPath is required');
    const tempDirectory = await makeTempDir(path.join(os.tmpdir(), 'ari-meeting-normalize-'));
    const outputPath = path.join(tempDirectory, 'normalized.m4a');
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', sourcePath,
      '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', outputPath,
    ];
    try {
      await new Promise((resolve, reject) => {
        const child = spawnImpl(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr?.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
        child.once('error', reject);
        child.once('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Audio normalization failed${stderr ? `: ${stderr}` : ''}`));
        });
      });
    } catch (error) {
      await removeDir(tempDirectory).catch(() => {});
      error.safeCode = error.safeCode || 'AUDIO_NORMALIZATION_FAILED';
      throw error;
    }
    return {
      path: outputPath,
      mimeType: 'audio/mp4',
      cleanup: () => removeDir(tempDirectory),
    };
  }
  return { normalize };
}

function createManualMeetingProcessor({
  repo,
  storage,
  transcriber,
  reportGenerator,
  normalizer = createAudioNormalizer(),
  afterCompleted = async () => {},
  logger = console,
  maxActive = 100,
} = {}) {
  for (const [name, dependency] of Object.entries({ repo, storage, transcriber, reportGenerator, normalizer })) {
    if (!dependency) throw new TypeError(`${name} is required`);
  }
  const active = new Map();

  function safeFailureCode(error) {
    return String(error?.safeCode || 'MEETING_PROCESSING_FAILED').slice(0, 80);
  }

  async function execute({ meetingId, userPhone, localPath, mimeType, stopAfterUpload = false }) {
    let normalized;
    try {
      let meeting = await repo.getOwned(meetingId, userPhone);
      if (!meeting) {
        const error = new Error('Meeting not found');
        error.safeCode = 'MEETING_NOT_FOUND';
        throw error;
      }
      if (meeting.processing_stage === 'completed') return meeting;

      if (localPath && ['captured', 'failed'].includes(meeting.processing_stage)) {
        meeting = await repo.transition(meetingId, userPhone, [meeting.processing_stage], {
          processingStage: 'uploading',
          processingErrorCode: null,
          processingErrorMessage: null,
          recordingMimeType: mimeType,
        });
        normalized = await normalizer.normalize({ inputPath: localPath, mimeType });
        const reference = await storage.uploadFile({
          meetingId,
          userPhone,
          filePath: normalized.path,
          mimeType: normalized.mimeType,
        });
        meeting = await repo.transition(meetingId, userPhone, ['uploading'], {
          processingStage: 'transcribing',
          recordingObjectKey: reference,
          recordingMimeType: normalized.mimeType,
        });
      } else if (meeting.processing_stage === 'failed') {
        if (Array.isArray(meeting.canonical_transcript_segments) && meeting.canonical_transcript_segments.length) {
          meeting = await repo.transition(meetingId, userPhone, ['failed'], { processingStage: 'generating_report' });
        } else if (meeting.recording_object_key) {
          meeting = await repo.transition(meetingId, userPhone, ['failed'], { processingStage: 'transcribing' });
        } else {
          const error = new Error('The retained recording is unavailable; record or upload the meeting again.');
          error.safeCode = 'RECORDING_UNAVAILABLE';
          throw error;
        }
      } else if (meeting.processing_stage === 'uploading') {
        if (!meeting.recording_object_key) {
          const error = new Error('The interrupted upload must be retried from the desktop recording.');
          error.safeCode = 'UPLOAD_RETRY_REQUIRED';
          throw error;
        }
        meeting = await repo.transition(meetingId, userPhone, ['uploading'], { processingStage: 'transcribing' });
      }

      if (stopAfterUpload && meeting.processing_stage === 'transcribing' && meeting.recording_object_key) {
        return meeting;
      }

      if (meeting.processing_stage === 'transcribing') {
        let transcriptId = meeting.assemblyai_transcript_id;
        if (!transcriptId) {
          const audioUrl = await storage.signRead(meeting.recording_object_key, 900);
          const submission = await transcriber.submit(audioUrl);
          transcriptId = submission.id;
          meeting = await repo.saveCanonicalTranscript(meetingId, userPhone, transcriptId, [], 0);
        }
        const transcription = await transcriber.poll(transcriptId);
        meeting = await repo.saveCanonicalTranscript(
          meetingId,
          userPhone,
          transcription.transcriptId || transcriptId,
          transcription.segments,
          transcription.durationSeconds,
        );
        meeting = await repo.transition(meetingId, userPhone, ['transcribing'], { processingStage: 'generating_report' });
      }

      if (meeting.processing_stage === 'generating_report') {
        const report = await reportGenerator.generate({
          title: meeting.title,
          transcriptSegments: meeting.canonical_transcript_segments || [],
        });
        await repo.saveCanonicalReport(meetingId, userPhone, report);
        meeting = await repo.transition(meetingId, userPhone, ['generating_report'], { processingStage: 'completed' });
        await afterCompleted({ meetingId, userPhone, meeting }).catch((error) => {
          logger.warn(`Meeting downstream indexing failed (non-fatal): ${error.message}`);
        });
      }
      return meeting;
    } catch (error) {
      if (error?.safeCode !== 'MEETING_NOT_FOUND') {
        await repo.markFailed(
          meetingId,
          userPhone,
          safeFailureCode(error),
          error?.safeCode === 'RECORDING_UNAVAILABLE' || error?.safeCode === 'UPLOAD_RETRY_REQUIRED'
            ? error.message
            : 'Meeting processing failed. You can retry safely.',
        ).catch((markError) => logger.error(`Could not persist meeting failure: ${markError.message}`));
      }
      throw error;
    } finally {
      if (normalized?.cleanup) {
        await normalized.cleanup().catch((error) => logger.warn(`Could not clean normalized meeting audio: ${error.message}`));
      }
    }
  }

  function runOnce(input) {
    const id = Number(input.meetingId);
    if (active.has(id)) return active.get(id);
    if (active.size >= maxActive) {
      const error = new Error('Meeting processor is at capacity');
      error.safeCode = 'MEETING_PROCESSOR_BUSY';
      return Promise.reject(error);
    }
    const promise = execute(input).finally(() => active.delete(id));
    active.set(id, promise);
    return promise;
  }

  function process(input) {
    if (!input?.localPath) throw new TypeError('localPath is required for a new recording');
    return runOnce(input);
  }

  function ingest(input) {
    if (!input?.localPath) throw new TypeError('localPath is required for recording ingestion');
    return runOnce({ ...input, stopAfterUpload: true });
  }

  function resume({ meetingId, userPhone }) {
    return runOnce({ meetingId, userPhone });
  }

  function retry({ meetingId, userPhone, localPath, mimeType }) {
    return localPath
      ? runOnce({ meetingId, userPhone, localPath, mimeType })
      : resume({ meetingId, userPhone });
  }

  async function startRecovery() {
    const meetings = await repo.findRecoverable(20);
    return Promise.allSettled(meetings.map((meeting) => resume({
      meetingId: meeting.id,
      userPhone: meeting.user_phone,
    })));
  }

  return { process, ingest, resume, retry, startRecovery, activeCount: () => active.size };
}

let defaultProcessor;
function getDefaultProcessor() {
  if (!defaultProcessor) {
    const { pool, query } = require('../../config/database');
    const { createMeetingRepository } = require('./meeting-repository');
    const { createRecordingStorage } = require('./recording-storage');
    const { createAssemblyAIClient } = require('./assemblyai-client');
    const { createReportGenerator } = require('./report-generator');
    defaultProcessor = createManualMeetingProcessor({
      repo: createMeetingRepository({ query, connect: () => pool.connect() }),
      storage: createRecordingStorage(),
      transcriber: createAssemblyAIClient(),
      reportGenerator: createReportGenerator(),
      afterCompleted: ({ meetingId, userPhone }) => {
        const entityContext = require('../entity-context.service');
        return entityContext.processMeeting(userPhone, meetingId);
      },
      logger: require('../../utils/logger'),
    });
  }
  return defaultProcessor;
}

module.exports = {
  createAudioNormalizer,
  createManualMeetingProcessor,
  process: (input) => getDefaultProcessor().process(input),
  ingest: (input) => getDefaultProcessor().ingest(input),
  resume: (input) => getDefaultProcessor().resume(input),
  retry: (input) => getDefaultProcessor().retry(input),
  startRecovery: () => getDefaultProcessor().startRecovery(),
};
