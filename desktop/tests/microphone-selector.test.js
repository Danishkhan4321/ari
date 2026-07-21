'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  candidateScore,
  cleanLabel,
  forgetSelection,
  selectMicrophone,
} = require('../src/dictation/microphone-selector');

function stream(label, deviceId) {
  const track = { label, stopped: false, getSettings: () => ({ deviceId }), stop() { this.stopped = true; } };
  return { label, peak: 0, getAudioTracks: () => [track], getTracks: () => [track], track };
}

test('microphone labels and scores prefer a live physical input over silent or virtual inputs', () => {
  assert.equal(cleanLabel('Default - Microphone Array'), 'Microphone Array');
  assert.ok(candidateScore({ peak: 0.02, label: 'Microphone Array' }) > candidateScore({ peak: 0, label: 'Default - OMEN Cam & Voice', isDefault: true }));
  assert.ok(candidateScore({ peak: 0.02, label: 'Microphone Array' }) > candidateScore({ peak: 0.5, label: 'Virtual Audio Cable' }));
});

test('auto-detect replaces a zero-signal default with a live built-in microphone', async () => {
  forgetSelection();
  const defaultStream = stream('Default - OMEN Cam & Voice', 'omen');
  const arrayStream = stream('Microphone Array (Intel Smart Sound)', 'array');
  const virtualStream = stream('Virtual Audio Cable', 'virtual');
  arrayStream.peak = 0.03;
  virtualStream.peak = 0.4;
  const byId = { array: arrayStream, virtual: virtualStream };
  const requests = [];
  const mediaDevices = {
    async getUserMedia(input) {
      const id = input.audio.deviceId?.exact;
      requests.push(id || 'default');
      return id ? byId[id] : defaultStream;
    },
    async enumerateDevices() {
      return [
        { kind: 'audioinput', deviceId: 'omen', label: 'Microphone (OMEN Cam & Voice)' },
        { kind: 'audioinput', deviceId: 'virtual', label: 'Virtual Audio Cable' },
        { kind: 'audioinput', deviceId: 'array', label: 'Microphone Array (Intel Smart Sound)' },
      ];
    },
  };
  const selected = await selectMicrophone({
    mediaDevices,
    measure: async (candidate) => ({ peak: candidate.peak, rms: candidate.peak / 2 }),
  });
  assert.equal(selected.deviceId, 'array');
  assert.equal(selected.signalDetected, true);
  assert.equal(defaultStream.track.stopped, true);
  assert.equal(virtualStream.track.stopped, false);
  assert.deepEqual(requests, ['default', 'array']);
});

test('auto-detect keeps a working system-default microphone without probing alternatives', async () => {
  forgetSelection();
  const defaultStream = stream('Default - USB Microphone', 'usb');
  defaultStream.peak = 0.02;
  let enumerated = false;
  const selected = await selectMicrophone({
    mediaDevices: {
      getUserMedia: async () => defaultStream,
      enumerateDevices: async () => { enumerated = true; return []; },
    },
    measure: async (candidate) => ({ peak: candidate.peak, rms: 0.01 }),
  });
  assert.equal(selected.deviceId, 'usb');
  assert.equal(selected.isDefault, true);
  assert.equal(enumerated, false);
});

test('auto-detect reuses the last proven microphone without rescanning every dictation', async () => {
  forgetSelection();
  const defaultStream = stream('Default - OMEN Cam & Voice', 'omen');
  const firstArrayStream = stream('Microphone Array', 'array');
  firstArrayStream.peak = 0.03;
  const reusedArrayStream = stream('Microphone Array', 'array');
  const requests = [];
  const mediaDevices = {
    async getUserMedia(input) {
      const id = input.audio.deviceId?.exact;
      requests.push(id || 'default');
      if (!id) return defaultStream;
      return requests.length === 2 ? firstArrayStream : reusedArrayStream;
    },
    async enumerateDevices() {
      return [{ kind: 'audioinput', deviceId: 'array', label: 'Microphone Array' }];
    },
  };
  const measure = async (candidate) => ({ peak: candidate.peak, rms: candidate.peak / 2 });
  await selectMicrophone({ mediaDevices, measure });
  const selected = await selectMicrophone({ mediaDevices, measure });
  assert.equal(selected.deviceId, 'array');
  assert.equal(selected.remembered, true);
  assert.deepEqual(requests, ['default', 'array', 'array']);
});
