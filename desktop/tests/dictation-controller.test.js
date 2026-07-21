'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createDictationController } = require('../src/dictation/controller');

test('delivery refuses a changed foreground target, retains Paste Last, and cleans up on shutdown', async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ari-dictation-test-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const handlers = new Map();
  const ipcMain = { handle: (name, handler) => handlers.set(name, handler), removeHandler: (name) => handlers.delete(name) };
  const sent = [];
  const bounds = [];
  let hideCount = 0;
  let showCount = 0;
  let destroyed = false;
  let browserWindowOptions = null;
  const webContents = {
    id: 44,
    once: (_name, listener) => queueMicrotask(listener),
    send: (...args) => sent.push(args),
  };
  class BrowserWindow {
    constructor(options) { browserWindowOptions = options; this.webContents = webContents; }
    isDestroyed() { return destroyed; }
    loadFile() { return Promise.resolve(); }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setBounds(value) { bounds.push(value); }
    showInactive() { showCount += 1; }
    hide() { hideCount += 1; }
    on() {}
    destroy() { destroyed = true; }
  }
  class Tray {
    setToolTip() {}
    setContextMenu() {}
    on() {}
    destroy() {}
  }
  const hook = new EventEmitter();
  let stopped = false;
  const taps = [];
  hook.start = () => {};
  hook.stop = () => { stopped = true; };
  hook.keyTap = (...args) => taps.push(args);
  const clipboardWrites = [];
  const clipboard = {
    readText: () => 'prior', readHTML: () => '', readRTF: () => '', readBookmark: () => ({}), readImage: () => ({ isEmpty: () => true }),
    writeText: (text) => clipboardWrites.push(text), clear: () => {}, write: () => {},
  };
  const windows = [
    { id: 'target', processId: 10, category: 'chat' },
    { id: 'other', processId: 11, category: 'email' },
  ];
  const controller = createDictationController({
    BrowserWindow, Tray,
    Menu: { buildFromTemplate: (template) => template },
    nativeImage: { createFromPath: () => ({ resize() { return this; } }) },
    clipboard, ipcMain,
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }) },
    systemPreferences: { getMediaAccessStatus: () => 'granted', isTrustedAccessibilityClient: () => true },
    mainWindow: { isDestroyed: () => false, isMinimized: () => false, show() {}, focus() {} },
    backend: {}, hook,
    keys: { Ctrl: 1, CtrlRight: 2, Alt: 3, AltRight: 4, Meta: 5, MetaRight: 6, Shift: 7, ShiftRight: 8, Space: 9, Escape: 10, V: 11, Z: 12 },
    userDataPath, iconPath: 'icon.png', fromLocalDashboard: () => true,
    appContext: { current: async () => windows.shift(), same: (left, right) => left?.id === right?.id },
    platform: 'win32',
  });

  controller.start();
  assert.equal(browserWindowOptions.transparent, true);
  assert.equal(browserWindowOptions.backgroundColor, '#00000000');
  assert.equal(browserWindowOptions.hasShadow, false);
  const started = await handlers.get('desktop:dictation:start')({ sender: { id: 7 } });
  assert.equal(started.started, true);
  assert.ok(sent.some(([, command]) => command.type === 'start'));
  assert.equal(showCount, 0, 'composer dictation must not show the global overlay');
  await handlers.get('dictation:overlay:state')({ sender: webContents }, { state: 'listening' });
  assert.equal(showCount, 0, 'recording state remains inside the composer');
  const stoppedFromDashboard = await handlers.get('desktop:dictation:stop')({ sender: { id: 7 } });
  assert.equal(stoppedFromDashboard.stopped, true);
  assert.ok(sent.some(([, command]) => command.type === 'stop'));
  assert.deepEqual({ width: bounds.at(-1).width, height: bounds.at(-1).height }, { width: 220, height: 58 });
  await handlers.get('dictation:overlay:state')({ sender: webContents }, { state: 'failed', expanded: true, visible: true });
  assert.deepEqual({ width: bounds.at(-1).width, height: bounds.at(-1).height }, { width: 338, height: 64 });
  await handlers.get('dictation:overlay:state')({ sender: webContents }, { state: 'idle', expanded: true, variant: 'ready', visible: true });
  assert.deepEqual({ width: bounds.at(-1).width, height: bounds.at(-1).height }, { width: 366, height: 64 });
  assert.equal(showCount, 2, 'only recovery states may reveal the global overlay');
  await handlers.get('dictation:overlay:state')({ sender: webContents }, { state: 'finalizing', expanded: false, visible: false });
  assert.deepEqual({ width: bounds.at(-1).width, height: bounds.at(-1).height }, { width: 52, height: 52 });
  assert.ok(hideCount >= 1);
  const complete = handlers.get('dictation:overlay:complete');
  const result = await complete({ sender: webContents }, { rawText: 'raw text', text: 'Ready text.' });
  assert.deepEqual(result, { ok: true, pasted: false, copied: true, reason: 'target_changed' });
  assert.equal(clipboardWrites.at(-1), 'Ready text.');
  assert.equal(taps.length, 0);
  assert.equal(controller.publicStatus().lastTranscriptAvailable, true);
  const recent = await handlers.get('desktop:dictation:recent')({ sender: webContents });
  assert.equal(recent.items.length, 1);
  assert.equal(recent.items[0].text, 'Ready text.');
  assert.equal(recent.items[0].pasted, false);
  assert.deepEqual(await handlers.get('desktop:dictation:copy-transcript')({ sender: webContents }, recent.items[0].id), { ok: true });
  await handlers.get('dictation:overlay:dismiss')({ sender: webContents }, { recoveryText: 'Saved after a failed paste.' });
  const recovered = await handlers.get('desktop:dictation:recent')({ sender: webContents });
  assert.equal(recovered.items[0].text, 'Saved after a failed paste.');
  assert.equal(recovered.items[0].pasted, false);

  assert.equal(await controller.pasteLast(), true);
  assert.equal(taps.length, 1);
  await controller.shutdown();
  assert.equal(stopped, true);
  assert.equal(handlers.size, 0);
  assert.equal(destroyed, true);
});
