'use strict';

const HOLD_DELAY_MS = 160;

function shortcutLabels(platform = process.platform) {
  return platform === 'darwin'
    ? { pushToTalk: 'Ctrl+Option', handsFree: 'Ctrl+Option+Space', pasteLast: 'Ctrl+Cmd+V' }
    : { pushToTalk: 'Ctrl+Win', handsFree: 'Ctrl+Win+Space', pasteLast: 'Shift+Alt+Z' };
}

function createShortcutController({
  hook,
  keys,
  platform = process.platform,
  onStart = () => {},
  onStop = () => {},
  onCancel = () => {},
  onPasteLast = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!hook || !keys) throw new TypeError('hook and keys are required');
  const modifierKeys = new Set([keys.Ctrl, keys.CtrlRight, keys.Alt, keys.AltRight, keys.Meta, keys.MetaRight, keys.Shift, keys.ShiftRight]);
  const down = new Set();
  let pending = null;
  let mode = 'idle';
  let suppressed = false;

  const has = (...values) => values.some((value) => down.has(value));
  const ctrl = () => has(keys.Ctrl, keys.CtrlRight);
  const alt = () => has(keys.Alt, keys.AltRight);
  const meta = () => has(keys.Meta, keys.MetaRight);
  const shift = () => has(keys.Shift, keys.ShiftRight);
  const pushChord = () => platform === 'darwin' ? ctrl() && alt() : ctrl() && meta();

  function cancelPending() {
    if (pending) clearTimer(pending);
    pending = null;
  }

  function schedulePushToTalk() {
    if (pending || mode !== 'idle' || suppressed) return;
    pending = setTimer(() => {
      pending = null;
      if (!pushChord() || suppressed || mode !== 'idle') return;
      mode = 'push-to-talk';
      onStart('push-to-talk');
    }, HOLD_DELAY_MS);
  }

  function keydown(event) {
    if (down.has(event.keycode)) return;
    down.add(event.keycode);
    if (event.keycode === keys.Escape && mode !== 'idle') {
      cancelPending();
      mode = 'idle';
      suppressed = true;
      onCancel();
      return;
    }
    const pasteChord = platform === 'darwin'
      ? ctrl() && meta() && event.keycode === keys.V
      : shift() && alt() && event.keycode === keys.Z;
    if (pasteChord) {
      cancelPending();
      onPasteLast();
      return;
    }
    if (pushChord() && event.keycode === keys.Space) {
      cancelPending();
      if (mode === 'push-to-talk') {
        mode = 'hands-free';
      } else if (mode === 'hands-free') {
        mode = 'idle';
        onStop();
      } else {
        mode = 'hands-free';
        onStart('hands-free');
      }
      suppressed = true;
      return;
    }
    if (pushChord() && modifierKeys.has(event.keycode)) {
      schedulePushToTalk();
      return;
    }
    if (pending && !modifierKeys.has(event.keycode)) {
      cancelPending();
      suppressed = true;
    }
  }

  function keyup(event) {
    down.delete(event.keycode);
    if (mode === 'push-to-talk' && !pushChord()) {
      mode = 'idle';
      onStop();
    }
    if (pending && !pushChord()) cancelPending();
    if (!ctrl() && !alt() && !meta() && !shift()) suppressed = false;
  }

  function start() {
    hook.on('keydown', keydown);
    hook.on('keyup', keyup);
    hook.start();
  }

  function stop() {
    cancelPending();
    hook.off?.('keydown', keydown);
    hook.off?.('keyup', keyup);
    try { hook.stop(); } catch (_) {}
    down.clear();
    mode = 'idle';
  }

  function reset() {
    cancelPending();
    mode = 'idle';
    suppressed = false;
    down.clear();
  }

  return { labels: shortcutLabels(platform), reset, start, stop, _keydown: keydown, _keyup: keyup, get mode() { return mode; } };
}

module.exports = { HOLD_DELAY_MS, createShortcutController, shortcutLabels };
