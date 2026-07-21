'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveRecordingPlayback } = require('../src/services/manual-meetings/recording-playback');

test('prefers the retained private object reference', async () => {
  const calls = [];
  const result = await resolveRecordingPlayback(
    { recording_object_key: 's3://private/manual-meetings/1.m4a', recording_url: 'https://old.example/file' },
    { storage: { signRead: async (...args) => { calls.push(args); return 'signed'; } } },
  );
  assert.equal(result, 'signed');
  assert.deepEqual(calls, [['s3://private/manual-meetings/1.m4a', 3600]]);
});

test('keeps historical HTTPS recordings playable', async () => {
  const result = await resolveRecordingPlayback(
    { recording_url: 'https://archive.example/meeting.webm' },
    { env: {} },
  );
  assert.equal(result, 'https://archive.example/meeting.webm');
});

test('rejects non-HTTPS historical recording URLs', async () => {
  await assert.rejects(
    resolveRecordingPlayback({ recording_url: 'http://archive.example/meeting.webm' }, { env: {} }),
    /must use HTTPS/,
  );
});
