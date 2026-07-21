'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  createRecordingStorage,
  parseStorageReference,
} = require('../src/services/manual-meetings/recording-storage');
const {
  createAssemblyAIClient,
  normalizeUtterances,
} = require('../src/services/manual-meetings/assemblyai-client');

test('recording storage uploads privately, verifies, and signs retained audio', async () => {
  const commands = [];
  const s3 = {
    send: async (command) => {
      commands.push(command);
      return command.constructor.name === 'HeadObjectCommand' ? { ContentLength: 42 } : {};
    },
  };
  const signed = [];
  const storage = createRecordingStorage({
    s3,
    bucket: 'private-recordings',
    sign: async (_client, command, options) => {
      signed.push({ command, options });
      return 'https://signed.example/audio';
    },
  });

  const reference = await storage.uploadFile({
    meetingId: 7,
    userPhone: '+919999999999',
    filePath: path.join(__dirname, 'fixtures', 'meeting.m4a'),
    mimeType: 'audio/mp4',
  });
  assert.match(reference, /^s3:\/\/private-recordings\/manual-meetings\/[a-f0-9]{64}\/\d{4}-\d{2}\/7\/[a-f0-9-]+\.m4a$/);
  assert.equal(commands[0].constructor.name, 'PutObjectCommand');
  assert.equal(commands[0].input.Bucket, 'private-recordings');
  assert.equal(commands[0].input.ACL, undefined);

  assert.equal(await storage.verify(reference), true);
  assert.equal(await storage.signRead(reference), 'https://signed.example/audio');
  assert.equal(commands[1].constructor.name, 'HeadObjectCommand');
  assert.equal(signed[0].command.constructor.name, 'GetObjectCommand');
  assert.equal(signed[0].options.expiresIn, 900);
});

test('storage references cannot escape their configured bucket', () => {
  assert.throws(
    () => parseStorageReference('s3://other-bucket/key', 'private-recordings'),
    /configured bucket/,
  );
  assert.throws(
    () => parseStorageReference('https://public.example/audio', 'private-recordings'),
    /storage reference/,
  );
});

test('AssemblyAI submission enables neutral speaker diarization', async () => {
  const calls = [];
  const client = createAssemblyAIClient({
    apiKey: 'test',
    http: async (request) => {
      calls.push(request);
      return { id: 'tx_1', status: 'queued' };
    },
  });

  await client.submit('https://signed.example/meeting.m4a');

  assert.equal(calls[0].body.speaker_labels, true);
  assert.equal(calls[0].body.language_detection, true);
  assert.equal(calls[0].body.speaker_identification, undefined);
  assert.equal(calls[0].timeoutMs, 30_000);
});

test('AssemblyAI polling normalizes letter-labelled utterances', async () => {
  const client = createAssemblyAIClient({
    apiKey: 'test',
    sleep: async () => {},
    http: async () => ({
      id: 'tx_1',
      status: 'completed',
      audio_duration: 3.2,
      utterances: [
        { speaker: 'A', start: 10, end: 1200, text: ' Hello ', confidence: 0.91 },
        { speaker: 'Speaker B', start: 1300, end: 3000, text: 'Done', confidence: 0.88 },
      ],
    }),
  });

  const result = await client.poll('tx_1', { maxAttempts: 2, intervalMs: 0 });
  assert.equal(result.durationSeconds, 3.2);
  assert.deepEqual(result.segments, [
    { speakerId: 'A', startMs: 10, endMs: 1200, text: 'Hello', confidence: 0.91 },
    { speakerId: 'B', startMs: 1300, endMs: 3000, text: 'Done', confidence: 0.88 },
  ]);
});

test('normalizeUtterances drops empty text and does not infer names', () => {
  assert.deepEqual(normalizeUtterances([
    { speaker: 'Danish', start: 0, end: 10, text: 'Hi' },
    { speaker: 'B', text: '   ' },
  ]), [{ speakerId: 'Danish', startMs: 0, endMs: 10, text: 'Hi', confidence: null }]);
});
