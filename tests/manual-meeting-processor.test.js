'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createAudioNormalizer,
  createManualMeetingProcessor,
} = require('../src/services/manual-meetings/processor');

function fixtureDependencies(overrides = {}) {
  const meeting = {
    id: 4,
    user_phone: 'wa_1',
    title: 'Planning',
    processing_stage: 'captured',
    recording_object_key: null,
    recording_mime_type: null,
    assemblyai_transcript_id: null,
    canonical_transcript_segments: null,
  };
  const deps = {
    repo: {
      stages: [],
      async getOwned() { return { ...meeting }; },
      async transition(_id, _phone, _from, patch) {
        const target = patch.processingStage || patch.processing_stage;
        this.stages.push(target);
        meeting.processing_stage = target;
        if (patch.recordingObjectKey) meeting.recording_object_key = patch.recordingObjectKey;
        if (patch.recordingMimeType) meeting.recording_mime_type = patch.recordingMimeType;
        return { ...meeting };
      },
      async saveCanonicalTranscript(_id, _phone, transcriptId, segments, durationSeconds) {
        meeting.assemblyai_transcript_id = transcriptId;
        meeting.canonical_transcript_segments = segments;
        meeting.duration_seconds = durationSeconds;
        return { ...meeting };
      },
      async saveCanonicalReport(_id, _phone, report) {
        meeting.canonical_report = report;
        return { ...meeting };
      },
      async markFailed(_id, _phone, code, message) {
        meeting.processing_stage = 'failed';
        meeting.processing_error_code = code;
        meeting.processing_error_message = message;
        this.stages.push('failed');
        return { ...meeting };
      },
      async findRecoverable() { return []; },
    },
    storage: {
      uploads: 0,
      async uploadFile() { this.uploads += 1; return 's3://private/recording.m4a'; },
      async signRead() { return 'https://signed.example/recording.m4a'; },
    },
    transcriber: {
      submissions: 0,
      polls: 0,
      async submit() { this.submissions += 1; return { id: 'tx_1' }; },
      async poll() {
        this.polls += 1;
        return {
          transcriptId: 'tx_1',
          durationSeconds: 12,
          segments: [{ speakerId: 'A', startMs: 0, endMs: 1000, text: 'Ship Friday.' }],
        };
      },
    },
    reportGenerator: {
      calls: 0,
      async generate() {
        this.calls += 1;
        return {
          summary: 'Speaker A will ship Friday.', decisions: [], actionItems: [],
          suggestedTasks: [], topics: [], openQuestions: [], reportMarkdown: '# Report',
        };
      },
    },
    normalizer: {
      calls: 0,
      cleanups: 0,
      async normalize() {
        this.calls += 1;
        return { path: 'normalized.m4a', mimeType: 'audio/mp4', cleanup: async () => { this.cleanups += 1; } };
      },
    },
    afterCompleted: async () => {},
    logger: { info() {}, warn() {}, error() {} },
  };
  Object.assign(deps, overrides);
  return { deps, meeting };
}

test('processor persists each checkpoint and completes once', async () => {
  const { deps } = fixtureDependencies();
  let indexed = 0;
  deps.afterCompleted = async () => { indexed += 1; };
  const processor = createManualMeetingProcessor(deps);
  await processor.process({ meetingId: 4, userPhone: 'wa_1', localPath: 'fixture.webm', mimeType: 'audio/webm' });

  assert.deepEqual(deps.repo.stages, ['uploading', 'transcribing', 'generating_report', 'completed']);
  assert.equal(deps.storage.uploads, 1);
  assert.equal(deps.transcriber.submissions, 1);
  assert.equal(deps.reportGenerator.calls, 1);
  assert.equal(deps.normalizer.cleanups, 1);
  assert.equal(indexed, 1);
});

test('processor records a safe failure and still cleans normalized output', async () => {
  const { deps, meeting } = fixtureDependencies();
  deps.storage.uploadFile = async () => { throw Object.assign(new Error('secret endpoint detail'), { safeCode: 'STORAGE_FAILED' }); };
  const processor = createManualMeetingProcessor(deps);

  await assert.rejects(
    processor.process({ meetingId: 4, userPhone: 'wa_1', localPath: 'fixture.webm', mimeType: 'audio/webm' }),
    /secret endpoint detail/,
  );
  assert.equal(meeting.processing_error_code, 'STORAGE_FAILED');
  assert.equal(meeting.processing_error_message, 'Meeting processing failed. You can retry safely.');
  assert.equal(deps.normalizer.cleanups, 1);
});

test('ingest verifies retained storage before accepting background processing', async () => {
  const { deps } = fixtureDependencies();
  const processor = createManualMeetingProcessor(deps);

  const meeting = await processor.ingest({ meetingId: 4, userPhone: 'wa_1', localPath: 'fixture.webm', mimeType: 'audio/webm' });

  assert.equal(meeting.processing_stage, 'transcribing');
  assert.equal(meeting.recording_object_key, 's3://private/recording.m4a');
  assert.equal(deps.storage.uploads, 1);
  assert.equal(deps.transcriber.submissions, 0);
  assert.equal(deps.normalizer.cleanups, 1);
});

test('retry with a saved transcript regenerates only the report', async () => {
  const { deps, meeting } = fixtureDependencies();
  meeting.processing_stage = 'failed';
  meeting.recording_object_key = 's3://private/recording.m4a';
  meeting.assemblyai_transcript_id = 'tx_1';
  meeting.canonical_transcript_segments = [{ speakerId: 'A', text: 'Ship Friday.', startMs: 0, endMs: 10 }];
  const processor = createManualMeetingProcessor(deps);

  await processor.retry({ meetingId: 4, userPhone: 'wa_1' });

  assert.deepEqual(deps.repo.stages, ['generating_report', 'completed']);
  assert.equal(deps.storage.uploads, 0);
  assert.equal(deps.transcriber.polls, 0);
  assert.equal(deps.reportGenerator.calls, 1);
});

test('duplicate active processing shares one upload', async () => {
  const { deps } = fixtureDependencies();
  let releaseUpload;
  deps.storage.uploadFile = async function uploadFile() {
    this.uploads += 1;
    await new Promise((resolve) => { releaseUpload = resolve; });
    return 's3://private/recording.m4a';
  };
  const processor = createManualMeetingProcessor(deps);
  const first = processor.process({ meetingId: 4, userPhone: 'wa_1', localPath: 'fixture.webm', mimeType: 'audio/webm' });
  while (!releaseUpload) await new Promise((resolve) => setImmediate(resolve));
  const second = processor.process({ meetingId: 4, userPhone: 'wa_1', localPath: 'fixture.webm', mimeType: 'audio/webm' });
  releaseUpload();
  await Promise.all([first, second]);
  assert.equal(deps.storage.uploads, 1);
});

test('startup recovery resumes persisted work without a cron job', async () => {
  const { deps, meeting } = fixtureDependencies();
  meeting.processing_stage = 'generating_report';
  meeting.canonical_transcript_segments = [{ speakerId: 'A', text: 'Ship.', startMs: 0, endMs: 1 }];
  deps.repo.findRecoverable = async () => [{ ...meeting }];
  const processor = createManualMeetingProcessor(deps);

  const results = await processor.startRecovery();

  assert.equal(results.length, 1);
  assert.deepEqual(deps.repo.stages, ['completed']);
});

test('audio normalizer spawns ffmpeg with arguments and never a shell string', async () => {
  const calls = [];
  const fakeChild = {
    stderr: { on() {} },
    once(event, callback) { if (event === 'close') queueMicrotask(() => callback(0)); return this; },
  };
  const normalizer = createAudioNormalizer({
    ffmpegPath: 'ffmpeg-test',
    spawnImpl: (file, args, options) => { calls.push({ file, args, options }); return fakeChild; },
    makeTempDir: async () => 'C:\\safe-temp\\ari-meeting-1',
    removeDir: async () => {},
  });

  const result = await normalizer.normalize({ inputPath: 'C:\\recordings\\source.webm' });
  assert.equal(calls[0].file, 'ffmpeg-test');
  assert.equal(Array.isArray(calls[0].args), true);
  assert.equal(calls[0].options.shell, false);
  assert.ok(calls[0].args.includes('48000'));
  assert.equal(result.path, 'C:\\safe-temp\\ari-meeting-1\\normalized.m4a');
});
