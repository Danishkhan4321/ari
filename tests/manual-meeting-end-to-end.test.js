'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const { createDesktopMeetingsRouter } = require('../src/routes/desktop-meetings.routes');
const { createManualMeetingProcessor } = require('../src/services/manual-meetings/processor');
const { materializeMeeting } = require('../src/services/manual-meetings/meeting-renderer');

function memoryRepository() {
  let row;
  function materialize() {
    const rendered = materializeMeeting({
      transcriptSegments: row.canonical_transcript_segments || [],
      report: row.canonical_report || {},
    }, row.speaker_names || {});
    Object.assign(row, {
      transcript: rendered.transcript,
      summary: rendered.summary,
      decisions: JSON.stringify(rendered.decisions),
      action_items: JSON.stringify(rendered.actionItems),
      suggested_tasks: rendered.suggestedTasks,
      report_markdown: rendered.reportMarkdown,
      mom: rendered.reportMarkdown,
      attendees: rendered.attendees.join(', '),
    });
  }
  return {
    async createFromCapture(input) {
      row ||= { id: 1, user_phone: input.userPhone, title: input.title, status: 'processing', processing_stage: 'captured', speaker_names: {} };
      return { ...row };
    },
    async getOwned(id, phone) { return row?.id === id && row.user_phone === phone ? { ...row } : null; },
    async transition(id, phone, from, patch) {
      assert.ok(from.includes(row.processing_stage));
      row.processing_stage = patch.processingStage;
      row.status = patch.processingStage === 'completed' ? 'completed' : 'processing';
      if (patch.recordingObjectKey) row.recording_object_key = patch.recordingObjectKey;
      if (patch.recordingMimeType) row.recording_mime_type = patch.recordingMimeType;
      return { ...row };
    },
    async saveCanonicalTranscript(_id, _phone, transcriptId, segments, durationSeconds) {
      row.assemblyai_transcript_id = transcriptId;
      row.canonical_transcript_segments = segments;
      row.duration_seconds = durationSeconds;
      materialize();
      return { ...row };
    },
    async saveCanonicalReport(_id, _phone, report) { row.canonical_report = report; materialize(); return { ...row }; },
    async renameSpeaker({ meetingId, userPhone, speakerId, name }) {
      if (row?.id !== meetingId || row.user_phone !== userPhone) return null;
      row.speaker_names = { ...row.speaker_names, [speakerId]: name };
      materialize();
      return { ...row };
    },
    async markFailed() { row.processing_stage = 'failed'; return { ...row }; },
    async findRecoverable() { return []; },
  };
}

test('manual recording reaches retained playback, report, and global speaker rename', async (t) => {
  const repo = memoryRepository();
  const storage = {
    async uploadFile({ filePath }) { assert.equal(fs.existsSync(filePath), true); return 's3://private/manual-meetings/1.m4a'; },
    async signRead() { return 'https://signed.example/meeting.m4a'; },
  };
  const processor = createManualMeetingProcessor({
    repo,
    storage,
    transcriber: {
      async submit() { return { id: 'tx_e2e' }; },
      async poll() { return { transcriptId: 'tx_e2e', durationSeconds: 60, segments: [{ speakerId: 'A', startMs: 0, endMs: 1000, text: 'I will ship Friday.' }] }; },
    },
    reportGenerator: { async generate() { return {
      summary: 'Speaker A will ship Friday.',
      decisions: ['Speaker A owns the release.'],
      actionItems: [{ text: 'Ship the release.', assigneeSpeakerId: 'A', deadline: 'Friday' }],
      suggestedTasks: [{ title: 'Ship the release', suggestedAssigneeSpeakerId: 'A', reason: 'Speaker A committed to it.' }],
      topics: ['Release'], openQuestions: [],
      reportMarkdown: '# Overview\nSpeaker A will ship Friday.\n# Decisions\nSpeaker A owns the release.\n# Action items\nSpeaker A: ship.\n# Suggested tasks and assignees\nSpeaker A: ship.\n# Open questions\nNone.\n# Transcript notes\nSpeaker A committed.',
    }; } },
    normalizer: { async normalize({ inputPath }) { return { path: inputPath, mimeType: 'audio/mp4', cleanup: async () => {} }; } },
    afterCompleted: async () => {},
    logger: { warn() {}, error() {} },
  });
  const app = express();
  app.use('/internal/desktop/meetings', createDesktopMeetingsRouter({ token: 'secret', repo, processor, storage, maxBytes: 1024, logger: { error() {} } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/internal/desktop/meetings`;
  const headers = { 'x-ari-desktop-token': 'secret', 'x-ari-user-phone': 'wa_e2e' };

  const upload = await fetch(base, { method: 'POST', headers: { ...headers, 'content-type': 'audio/webm', 'x-ari-capture-session': 'capture-e2e-session' }, body: Buffer.from('audio') });
  assert.equal(upload.status, 202);
  for (let attempts = 0; attempts < 20; attempts += 1) {
    const status = await fetch(`${base}/1/status`, { headers }).then((response) => response.json());
    if (status.meeting?.processing_stage === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const renamedResponse = await fetch(`${base}/1/speakers/A`, { method: 'PATCH', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Priya' }) });
  const renamed = (await renamedResponse.json()).meeting;
  const rendered = [renamed.transcript, renamed.summary, renamed.decisions, renamed.action_items, JSON.stringify(renamed.suggested_tasks), renamed.report_markdown].join('\n');
  assert.match(rendered, /Priya/);
  assert.doesNotMatch(rendered, /Speaker A/);

  const playback = await fetch(`${base}/1/recording`, { headers }).then((response) => response.json());
  assert.equal(playback.url, 'https://signed.example/meeting.m4a');
});
