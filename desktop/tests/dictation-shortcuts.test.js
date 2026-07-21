'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { UiohookKey } = require('uiohook-napi');
const { createShortcutController, shortcutLabels } = require('../src/dictation/shortcut-controller');

class Hook extends EventEmitter { start() {} stop() {} keyTap() {} }
const event = (keycode) => ({ keycode });

test('Windows push-to-talk starts after the chord settles and stops on release', async () => {
  const hook = new Hook();
  const calls = [];
  const controller = createShortcutController({ hook, keys: UiohookKey, platform: 'win32', onStart: (mode) => calls.push(['start', mode]), onStop: () => calls.push(['stop']) });
  controller.start();
  hook.emit('keydown', event(UiohookKey.Ctrl));
  hook.emit('keydown', event(UiohookKey.Meta));
  await new Promise((resolve) => setTimeout(resolve, 180));
  hook.emit('keyup', event(UiohookKey.Meta));
  assert.deepEqual(calls, [['start', 'push-to-talk'], ['stop']]);
  controller.stop();
});

test('hands-free and Paste Last shortcuts do not become push-to-talk sessions', async () => {
  const hook = new Hook();
  const calls = [];
  const controller = createShortcutController({
    hook, keys: UiohookKey, platform: 'win32',
    onStart: (mode) => calls.push(['start', mode]), onStop: () => calls.push(['stop']), onPasteLast: () => calls.push(['paste']),
  });
  controller.start();
  hook.emit('keydown', event(UiohookKey.Ctrl));
  hook.emit('keydown', event(UiohookKey.Meta));
  hook.emit('keydown', event(UiohookKey.Space));
  hook.emit('keyup', event(UiohookKey.Space));
  hook.emit('keyup', event(UiohookKey.Meta));
  hook.emit('keyup', event(UiohookKey.Ctrl));
  await new Promise((resolve) => setTimeout(resolve, 180));
  hook.emit('keydown', event(UiohookKey.Shift));
  hook.emit('keydown', event(UiohookKey.Alt));
  hook.emit('keydown', event(UiohookKey.Z));
  assert.deepEqual(calls, [['start', 'hands-free'], ['paste']]);
  assert.equal(shortcutLabels('darwin').pushToTalk, 'Ctrl+Option');
  controller.stop();
});
