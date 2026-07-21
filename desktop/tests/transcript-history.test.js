'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTranscriptHistory, MAX_TRANSCRIPTS } = require('../src/dictation/transcript-history');

test('transcript history persists only the 10 most recent bounded entries', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ari-transcripts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'history.json');
  let sequence = 0;
  const history = createTranscriptHistory(filePath, {
    createId: () => `item-${sequence}`,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, sequence++)).toISOString(),
  });

  for (let index = 0; index < 12; index += 1) history.add({ text: `Transcript ${index}`, pasted: index % 2 === 0 });
  assert.equal(history.list().length, MAX_TRANSCRIPTS);
  assert.equal(history.list()[0].text, 'Transcript 11');
  assert.equal(history.list().at(-1).text, 'Transcript 2');

  const reloaded = createTranscriptHistory(filePath);
  assert.deepEqual(reloaded.list(), history.list());
  assert.equal(reloaded.find(history.list()[0].id)?.pasted, false);
});

test('transcript history ignores corrupt files and invalid entries', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ari-transcripts-corrupt-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'history.json');
  fs.writeFileSync(filePath, '{not-json');
  const history = createTranscriptHistory(filePath, { createId: () => 'valid', now: () => '2026-07-20T00:00:00.000Z' });
  assert.deepEqual(history.list(), []);
  assert.equal(history.add({ text: '  Recovered text.  ', pasted: false })?.text, 'Recovered text.');
});
