'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const path = require('node:path');
const { createMacOSCaptureHelper } = require('../src/meeting-capture/macos-helper');

function fakeProcess() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => child.emit('exit', null, 'SIGTERM');
  return child;
}

test('macOS capture helper parses events and sends bounded commands', async () => {
  const child = fakeProcess();
  const calls = [];
  const helper = createMacOSCaptureHelper({
    executablePath: path.resolve('fixed-helper'),
    spawnImpl: (file, args, options) => { calls.push({ file, args, options }); return child; },
    readyTimeoutMs: 1000,
  });
  const commandLines = [];
  child.stdin.on('data', (chunk) => commandLines.push(chunk.toString()));
  const started = helper.start({ outputPath: path.resolve('capture.caf') });
  child.stdout.write('{"type":"ready"}\n');
  const session = await started;
  const received = [];
  session.events.on('event', (event) => received.push(event.type));
  child.stdout.write('{"type":"levels","system":0.4,"microphone":0.2}\n');
  child.stdout.write('{"type":"paused"}\n');
  child.stdout.write('{"type":"resumed"}\n');
  helper.pause(); helper.resume();
  const stopping = helper.stop(session.events);
  child.stdout.write('{"type":"finalized","bytes":42}\n');
  await stopping;
  helper.cancel();
  assert.deepEqual(received, ['levels', 'paused', 'resumed', 'finalized']);
  assert.deepEqual(commandLines.map((line) => JSON.parse(line).type), ['pause', 'resume', 'stop', 'cancel']);
  assert.equal(calls[0].file, path.resolve('fixed-helper'));
  assert.deepEqual(calls[0].args, ['--output', path.resolve('capture.caf')]);
  assert.equal(calls[0].options.shell, false);
});

test('macOS capture helper fails on timeout and early exit', async () => {
  const timedOut = fakeProcess();
  const timeoutHelper = createMacOSCaptureHelper({ executablePath: path.resolve('fixed'), spawnImpl: () => timedOut, readyTimeoutMs: 5 });
  await assert.rejects(timeoutHelper.start({ outputPath: path.resolve('capture.caf') }), /did not become ready/);

  const exited = fakeProcess();
  const exitHelper = createMacOSCaptureHelper({ executablePath: path.resolve('fixed'), spawnImpl: () => exited, readyTimeoutMs: 1000 });
  const start = exitHelper.start({ outputPath: path.resolve('capture.caf') });
  exited.emit('exit', 2, null);
  await assert.rejects(start, /exited/);
});
