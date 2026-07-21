'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { classifyApplication, createAppContext } = require('../src/dictation/app-context');
const { createClipboardPaste } = require('../src/dictation/clipboard-paste');
const { createDictationBackendClient } = require('../src/dictation/backend-client');
const { compactPreview, transcriptText, upsertTurn } = require('../src/dictation/turns');

test('streaming turns replace partials by turn order without duplicating text', () => {
  const turns = new Map();
  assert.equal(upsertTurn(turns, { turn_order: 2, transcript: 'second partial' }), true);
  assert.equal(upsertTurn(turns, { turn_order: 1, transcript: 'first' }), true);
  assert.equal(upsertTurn(turns, { turn_order: 2, transcript: 'second final' }), true);
  assert.equal(upsertTurn(turns, { turn_order: 'bad', transcript: 'ignored' }), false);
  assert.equal(transcriptText(turns), 'first second final');
});

test('streaming turns prefer AssemblyAI formatted utterances on finalized turns', () => {
  const turns = new Map();
  assert.equal(upsertTurn(turns, {
    turn_order: 0,
    transcript: 'namaste team lets start',
    utterance: "Namaste, team. Let's start.",
    turn_is_formatted: true,
  }), true);
  assert.equal(transcriptText(turns), "Namaste, team. Let's start.");
});

test('text-ready preview keeps only the first three words', () => {
  assert.equal(compactPreview('Would you like to try changing the name again?'), 'Would you like\u2026');
  assert.equal(compactPreview('Short text'), 'Short text');
});

test('audio worklet downsamples 48 kHz input into paced 16 kHz PCM16 frames', () => {
  let Processor;
  class AudioWorkletProcessor {
    constructor() { this.port = { postMessage: (message) => this.messages.push(message) }; this.messages = []; }
  }
  const context = {
    AudioWorkletProcessor,
    Int16Array,
    Math,
    registerProcessor: (_name, implementation) => { Processor = implementation; },
    sampleRate: 48_000,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'dictation', 'pcm-worklet.js'), 'utf8'), context);
  const processor = new Processor();
  const samples = new Float32Array(2_400).fill(0.5);
  assert.equal(processor.process([[samples]]), true);
  const frames = processor.messages.filter((message) => message.type === 'audio');
  assert.equal(frames.length, 1);
  assert.equal(new Int16Array(frames[0].buffer).length, 800);
  assert.ok(new Int16Array(frames[0].buffer)[0] > 16_000);
});

test('foreground application context is reduced to category and stable identity', async () => {
  assert.equal(classifyApplication('Slack'), 'chat');
  assert.equal(classifyApplication('Microsoft Outlook'), 'email');
  assert.equal(classifyApplication('Cursor'), 'code');
  assert.equal(classifyApplication('Windows Terminal'), 'terminal');
  assert.equal(classifyApplication('Google Chrome'), 'generic');
  const context = createAppContext({ activeWindow: async () => ({ id: 7, owner: { name: 'Slack', processId: 12 }, title: 'private title' }) });
  assert.deepEqual(await context.current(), { id: '7', processId: 12, category: 'chat' });
  assert.equal(context.same({ id: '7' }, { id: '7' }), true);
  assert.equal(context.same({ id: '7' }, { id: '8' }), false);
});

test('clipboard paste restores prior common formats', async () => {
  const writes = [];
  const clipboard = {
    readImage: () => ({ isEmpty: () => true }), readText: () => 'before', readHTML: () => '<b>before</b>', readRTF: () => '', readBookmark: () => ({}),
    writeText: (value) => writes.push(['text', value]), clear: () => writes.push(['clear']), write: (value) => writes.push(['restore', value]),
  };
  const hook = { keyTap: (...args) => writes.push(['tap', ...args]) };
  const keys = { V: 47, Ctrl: 29, Meta: 3675 };
  const service = createClipboardPaste({ clipboard, hook, keys, platform: 'win32', restoreDelayMs: 1 });
  assert.equal(await service.paste('dictated'), true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(writes[0], ['text', 'dictated']);
  assert.deepEqual(writes[1], ['tap', 47, [29]]);
  assert.equal(writes.at(-1)[0], 'restore');
});

test('dictation backend client keeps launch credentials private and loopback-only', async () => {
  const calls = [];
  const client = createDictationBackendClient({
    backendUrl: 'http://127.0.0.1:43100', internalToken: 'launch', userPhone: '+12345',
    fetchImpl: async (url, options) => { calls.push({ url: String(url), options }); return new Response(JSON.stringify({ ok: true, text: 'done' }), { status: 200 }); },
  });
  await client.polish({ rawText: 'raw' });
  assert.equal(calls[0].options.headers['x-ari-desktop-token'], 'launch');
  assert.doesNotMatch(calls[0].options.body, /launch/);
  await client.retry(Buffer.from('audio'), { mimeType: 'audio/webm;codecs=opus', appCategory: 'chat' });
  assert.equal(calls[1].options.headers['content-type'], 'application/octet-stream');
  assert.equal(calls[1].options.headers['x-ari-audio-mime-type'], 'audio/webm;codecs=opus');
  assert.throws(() => createDictationBackendClient({ backendUrl: 'https://example.com', internalToken: 'x', userPhone: 'y' }), /loopback/);
});

test('dictation overlay uses a dedicated preload and never contains the AssemblyAI API key', () => {
  const root = path.join(__dirname, '..', 'src', 'dictation');
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'overlay.html'), 'utf8');
  const overlay = fs.readFileSync(path.join(root, 'overlay.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'overlay.css'), 'utf8');
  assert.match(preload, /ariDictation/);
  assert.doesNotMatch(`${preload}\n${overlay}`, /ASSEMBLYAI_API_KEY/);
  assert.match(overlay, /ForceEndpoint/);
  assert.match(overlay, /Terminate/);
  assert.match(overlay, /audioWorklet/);
  assert.match(overlay, /MAX_QUEUED_AUDIO_FRAMES = 200/);
  assert.ok(overlay.indexOf('new AudioWorkletNode') < overlay.indexOf('await configPromise'));
  assert.ok(overlay.indexOf('session.recorder.stop()') < overlay.indexOf("session.stream?.getTracks().forEach((track) => track.stop())"));
  assert.match(overlay, /Promise\.race\(\[finalTurn, delay\(4000\)\]\)/);
  assert.match(overlay, /finalTurnSettleTimer = setTimeout/);
  assert.ok(html.indexOf('microphone-selector.js') < html.indexOf('overlay.js'));
  assert.match(overlay, /microphoneSelector\.selectMicrophone/);
  assert.match(overlay, /session\.maxLevel < 0\.01/);
  assert.doesNotMatch(overlay, /session\.microphoneLabel \? `\$\{session\.microphoneLabel\}/);
  assert.match(overlay, /expanded: Boolean\(expanded\)/);
  assert.match(overlay, /variant: expanded && state === 'success' \? 'ready'/);
  assert.doesNotMatch(overlay, /setUi\('starting', 'Starting'/);
  assert.match(overlay, /setUi\('finalizing', 'Transcribing', 'Completing the transcript', \{ visible: true \}\)/);
  assert.match(html, /id="elapsed"/);
  assert.match(html, /id="waveform"/);
  assert.match(html, /id="processing-indicator"/);
  assert.match(overlay, /function startElapsedTimer/);
  assert.match(overlay, /function drawWaveform/);
  assert.match(overlay, /requestAnimationFrame\(drawWaveform\)/);
  assert.match(css, /--ari-yellow: #f7dd2a/);
  assert.match(css, /--ari-ink: #0a0a0a/);
  assert.match(css, /data-state="finalizing".*processing-indicator/s);
  assert.match(css, /data-state="finalizing".*\.orb.*opacity: 0/s);
  assert.match(css, /@keyframes processing-spin/);
  assert.match(css, /font-feature-settings: "tnum" 1, "zero" 0/);
  assert.match(css, /linear-gradient\(180deg, #121212 0%, #050505 100%\)/);
  assert.match(css, /height: 29px/);
  assert.match(css, /data-has-preview="true"/);
  assert.match(css, /max-width: 100%/);
  assert.match(css, /overflow: hidden/);
  assert.match(css, /box-shadow: inset 0 1px rgba\(255, 255, 255, \.08\)/);
  assert.match(css, /backdrop-filter: none/);
  assert.doesNotMatch(css, /0 8px 20px|0 2px 4px/);
  assert.doesNotMatch(css, /#7c4d91|#a56a8a/i);
});
