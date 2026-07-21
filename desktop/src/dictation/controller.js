'use strict';

const path = require('node:path');
const { createAppContext } = require('./app-context');
const { createClipboardPaste } = require('./clipboard-paste');
const { readPreferences, writePreferences } = require('./preferences');
const { createShortcutController, shortcutLabels } = require('./shortcut-controller');
const { createTranscriptHistory } = require('./transcript-history');

const ACTIVE_STATES = new Set(['starting', 'listening', 'finalizing', 'polishing', 'pasting']);
const PROCESSING_STATES = new Set(['finalizing', 'polishing', 'pasting']);
const DASHBOARD_CHANNELS = ['desktop:dictation:status', 'desktop:dictation:start', 'desktop:dictation:stop', 'desktop:dictation:set-enabled', 'desktop:dictation:paste-last', 'desktop:dictation:test-microphone', 'desktop:dictation:recent', 'desktop:dictation:copy-transcript'];
const OVERLAY_CHANNELS = ['dictation:overlay:session', 'dictation:overlay:polish', 'dictation:overlay:retry', 'dictation:overlay:complete', 'dictation:overlay:state', 'dictation:overlay:dismiss', 'dictation:overlay:copy-last'];
const OVERLAY_COMPACT = Object.freeze({ width: 220, height: 58 });
const OVERLAY_PROCESSING = Object.freeze({ width: 52, height: 52 });
const OVERLAY_RECOVERY = Object.freeze({ width: 338, height: 64 });
const OVERLAY_READY = Object.freeze({ width: 366, height: 64 });

function createDictationController({
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  clipboard,
  ipcMain,
  screen,
  systemPreferences,
  mainWindow,
  backend,
  hook,
  keys,
  userDataPath,
  iconPath,
  fromLocalDashboard,
  appContext = createAppContext(),
  platform = process.platform,
} = {}) {
  const supported = platform === 'win32' || platform === 'darwin';
  const preferencesPath = path.join(userDataPath, 'dictation-preferences.json');
  const transcriptHistory = createTranscriptHistory(path.join(userDataPath, 'dictation-transcripts.json'));
  const latestTranscript = transcriptHistory.list()[0];
  let preferences = readPreferences(preferencesPath);
  let state = 'idle';
  let target = null;
  let lastRawText = '';
  let lastText = latestTranscript?.text || '';
  let overlay = null;
  let overlayReady = null;
  let overlayExpanded = false;
  let overlayVariant = 'default';
  let tray = null;
  let shortcutController = null;
  let hookStarted = false;
  let lastError = null;
  let overlaySuppressed = false;

  const paste = hook && keys
    ? createClipboardPaste({ clipboard, hook, keys, platform })
    : {
        copy: (text) => { const value = String(text || ''); if (!value) return false; clipboard.writeText(value); return true; },
        paste: async (text) => { const value = String(text || ''); if (!value) return false; clipboard.writeText(value); return false; },
      };

  function accessibilityTrusted(prompt = false) {
    if (platform !== 'darwin') return true;
    try { return systemPreferences.isTrustedAccessibilityClient(prompt); } catch (_) { return false; }
  }

  function microphoneStatus() {
    try { return systemPreferences.getMediaAccessStatus('microphone'); } catch (_) { return 'unknown'; }
  }

  function publicStatus() {
    return {
      available: supported && Boolean(backend && hook && keys),
      enabled: preferences.enabled === true,
      state,
      platform,
      accessibility: accessibilityTrusted(false) ? 'granted' : 'denied',
      microphone: microphoneStatus(),
      shortcuts: shortcutLabels(platform),
      lastTranscriptAvailable: Boolean(lastText),
      error: lastError,
    };
  }

  function updateTray() {
    if (!tray) return;
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Ari', click: () => showMainWindow() },
      { type: 'separator' },
      {
        label: 'Enable Flowtype',
        type: 'checkbox',
        checked: preferences.enabled === true,
        click: (item) => setEnabled(item.checked),
      },
      { label: 'Paste Last Flowtype Transcript', enabled: Boolean(lastText), click: () => pasteLast() },
      { type: 'separator' },
      { label: 'Quit Ari', role: 'quit' },
    ]));
  }

  function showMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  function createOverlay() {
    if (overlay && !overlay.isDestroyed()) return overlay;
    overlay = new BrowserWindow({
      width: OVERLAY_COMPACT.width,
      height: OVERLAY_COMPACT.height,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      hasShadow: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, 'preload.js'),
      },
    });
    overlay.setAlwaysOnTop(true, 'floating');
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    overlayReady = new Promise((resolve) => overlay.webContents.once('did-finish-load', resolve));
    void overlay.loadFile(path.join(__dirname, 'overlay.html'));
    overlay.on('closed', () => {
      overlay = null;
      overlayReady = null;
      overlayExpanded = false;
      overlayVariant = 'default';
    });
    return overlay;
  }

  function positionOverlay({ expanded = overlayExpanded, variant, show = true } = {}) {
    const win = createOverlay();
    overlayExpanded = Boolean(expanded);
    if (!overlayExpanded) overlayVariant = 'default';
    else if (variant === 'ready' || variant === 'recovery') overlayVariant = variant;
    const size = overlayExpanded
      ? overlayVariant === 'ready' ? OVERLAY_READY : OVERLAY_RECOVERY
      : PROCESSING_STATES.has(state) ? OVERLAY_PROCESSING : OVERLAY_COMPACT;
    const point = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(point);
    const x = Math.round(display.workArea.x + (display.workArea.width - size.width) / 2);
    const y = Math.round(display.workArea.y + display.workArea.height - size.height - 16);
    win.setBounds({ x, y, width: size.width, height: size.height }, false);
    if (show) win.showInactive();
  }

  async function sendOverlay(command) {
    const win = createOverlay();
    await overlayReady;
    if (!win.isDestroyed()) win.webContents.send('dictation:command', command);
  }

  async function begin(mode, { showOverlay = true } = {}) {
    if (!preferences.enabled || ACTIVE_STATES.has(state)) return false;
    state = 'starting';
    lastError = null;
    overlaySuppressed = !showOverlay;
    target = await appContext.current();
    if (showOverlay) positionOverlay({ expanded: false });
    else {
      createOverlay();
      overlay.hide();
    }
    await sendOverlay({ type: 'start', mode, appCategory: target?.category || 'generic' });
    updateTray();
    return true;
  }

  function finish() {
    if (!ACTIVE_STATES.has(state)) return false;
    void sendOverlay({ type: 'stop' });
    return true;
  }

  function cancel() {
    if (!ACTIVE_STATES.has(state)) return false;
    state = 'cancelled';
    void sendOverlay({ type: 'cancel' });
    shortcutController?.reset();
    updateTray();
    return true;
  }

  async function pasteLast() {
    if (!lastText) return false;
    await paste.paste(lastText);
    return true;
  }

  function saveRecoveryTranscript(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    lastRawText = text;
    lastText = text;
    const latest = transcriptHistory.list()[0];
    if (latest?.text === text) return latest;
    try { return transcriptHistory.add({ text, pasted: false }); } catch (_) { return null; }
  }

  function hookAvailable(prompt = false) {
    if (!supported || !backend || !hook || !keys) return false;
    return accessibilityTrusted(prompt);
  }

  function startHook({ prompt = false } = {}) {
    if (hookStarted || !preferences.enabled) return;
    if (!hookAvailable(prompt)) {
      lastError = platform === 'darwin' ? 'Accessibility permission is required for Flowtype shortcuts.' : 'Flowtype shortcuts are unavailable.';
      updateTray();
      return;
    }
    try {
      shortcutController = createShortcutController({
        hook, keys, platform,
        onStart: (mode) => void begin(mode),
        onStop: () => finish(),
        onCancel: () => cancel(),
        onPasteLast: () => void pasteLast(),
      });
      shortcutController.start();
      hookStarted = true;
      lastError = null;
    } catch (_) {
      lastError = 'Flowtype shortcuts could not be started.';
      hookStarted = false;
    }
    updateTray();
  }

  function stopHook() {
    if (!hookStarted) return;
    shortcutController?.stop();
    shortcutController = null;
    hookStarted = false;
  }

  function setEnabled(enabled) {
    preferences = writePreferences(preferencesPath, { enabled: Boolean(enabled) });
    if (preferences.enabled) startHook({ prompt: true });
    else {
      cancel();
      stopHook();
      state = 'idle';
      overlay?.hide();
    }
    updateTray();
    return publicStatus();
  }

  function assertOverlay(event) {
    if (!overlay || overlay.isDestroyed() || event.sender.id !== overlay.webContents.id) throw new Error('Flowtype overlay access denied');
  }

  function assertDashboard(event) {
    if (!fromLocalDashboard(event)) throw new Error('Flowtype settings are unavailable outside Ari');
  }

  function registerIpc() {
    ipcMain.handle('desktop:dictation:status', async (event) => { assertDashboard(event); return publicStatus(); });
    ipcMain.handle('desktop:dictation:start', async (event) => {
      assertDashboard(event);
      const status = publicStatus();
      if (!status.available) return { ...status, started: false };
      if (!preferences.enabled) setEnabled(true);
      // Composer dictation uses the same capture/transcription pipeline but
      // stays inside the text box. The floating shortcut overlay is reserved
      // for global Ctrl/Wispr-style dictation and recovery states.
      const started = await begin('hands-free', { showOverlay: false });
      return { ...publicStatus(), started };
    });
    ipcMain.handle('desktop:dictation:stop', async (event) => {
      assertDashboard(event);
      const stopped = finish();
      return { ...publicStatus(), stopped };
    });
    ipcMain.handle('desktop:dictation:set-enabled', async (event, enabled) => { assertDashboard(event); return setEnabled(enabled); });
    ipcMain.handle('desktop:dictation:paste-last', async (event) => { assertDashboard(event); return { ok: await pasteLast() }; });
    ipcMain.handle('desktop:dictation:recent', async (event) => {
      assertDashboard(event);
      return { ok: true, items: transcriptHistory.list() };
    });
    ipcMain.handle('desktop:dictation:copy-transcript', async (event, transcriptId) => {
      assertDashboard(event);
      const item = transcriptHistory.find(transcriptId);
      return { ok: Boolean(item && paste.copy(item.text)) };
    });
    ipcMain.handle('desktop:dictation:test-microphone', async (event) => {
      assertDashboard(event);
      positionOverlay({ expanded: false });
      await sendOverlay({ type: 'test-microphone' });
      return { ok: true };
    });

    ipcMain.handle('dictation:overlay:session', async (event) => { assertOverlay(event); return backend.session(); });
    ipcMain.handle('dictation:overlay:polish', async (event, input = {}) => {
      assertOverlay(event);
      return backend.polish({
        rawText: input.rawText,
        languageCodes: input.languageCodes,
        appCategory: target?.category || 'generic',
      });
    });
    ipcMain.handle('dictation:overlay:retry', async (event, audio, mimeType) => {
      assertOverlay(event);
      return backend.retry(audio, { mimeType, appCategory: target?.category || 'generic' });
    });
    ipcMain.handle('dictation:overlay:complete', async (event, input = {}) => {
      assertOverlay(event);
      const rawText = String(input.rawText || '').trim();
      const text = String(input.text || '').trim();
      if (!text) return { ok: false, pasted: false, error: 'No transcript was returned.' };
      lastRawText = rawText || text;
      lastText = text;
      state = 'pasting';
      const current = await appContext.current();
      const unchanged = appContext.same(target, current);
      let pasted = false;
      let reason = unchanged ? 'paste_blocked' : 'target_changed';
      try {
        if (unchanged) pasted = await paste.paste(text);
        else paste.copy(text);
      } catch (_) {
        try { paste.copy(text); } catch (_) {}
      }
      try { transcriptHistory.add({ text, pasted }); } catch (_) {}
      state = 'idle';
      target = null;
      shortcutController?.reset();
      updateTray();
      return { ok: true, pasted, copied: !pasted, reason: pasted ? null : reason };
    });
    ipcMain.handle('dictation:overlay:state', async (event, nextState) => {
      assertOverlay(event);
      const allowed = new Set(['starting', 'listening', 'finalizing', 'polishing', 'pasting', 'failed', 'cancelled', 'idle']);
      const requestedState = typeof nextState === 'object' ? nextState?.state : nextState;
      const expanded = typeof nextState === 'object' && nextState?.expanded === true;
      const variant = typeof nextState === 'object' ? nextState?.variant : undefined;
      const visibility = typeof nextState === 'object' ? nextState?.visible : undefined;
      if (allowed.has(requestedState)) state = requestedState;
      const isRecovery = requestedState === 'failed' || variant === 'recovery' || variant === 'ready';
      if (overlaySuppressed && !isRecovery) {
        positionOverlay({ expanded, variant, show: false });
        overlay.hide();
      } else {
        positionOverlay({ expanded, variant, show: visibility === true });
        if (visibility === false) overlay.hide();
      }
      updateTray();
      return publicStatus();
    });
    ipcMain.handle('dictation:overlay:dismiss', async (event, input = {}) => {
      assertOverlay(event);
      saveRecoveryTranscript(input?.recoveryText);
      state = 'idle';
      target = null;
      overlay.hide();
      overlaySuppressed = false;
      shortcutController?.reset();
      updateTray();
      return true;
    });
    ipcMain.handle('dictation:overlay:copy-last', async (event, rawText) => {
      assertOverlay(event);
      const recoveryText = String(rawText || '').trim();
      if (recoveryText) saveRecoveryTranscript(recoveryText);
      updateTray();
      return paste.copy(lastText || lastRawText);
    });
  }

  function unregisterIpc() {
    for (const channel of [...DASHBOARD_CHANNELS, ...OVERLAY_CHANNELS]) ipcMain.removeHandler(channel);
  }

  function createTray() {
    if (tray) return;
    let image = nativeImage.createFromPath(iconPath);
    if (platform === 'darwin') image = image.resize({ width: 18, height: 18 });
    tray = new Tray(image);
    tray.setToolTip('Ari');
    tray.on('double-click', showMainWindow);
    updateTray();
  }

  function start() {
    createOverlay();
    createTray();
    registerIpc();
    if (preferences.enabled) startHook({ prompt: platform === 'darwin' });
    return publicStatus();
  }

  async function shutdown() {
    stopHook();
    unregisterIpc();
    try { overlay?.webContents.send('dictation:command', { type: 'cancel' }); } catch (_) {}
    overlay?.destroy();
    overlay = null;
    tray?.destroy();
    tray = null;
  }

  return {
    begin, cancel, finish, ownsWebContents: (webContents) => Boolean(overlay && !overlay.isDestroyed() && webContents?.id === overlay.webContents.id),
    pasteLast, publicStatus, setEnabled, showMainWindow, shutdown, start,
  };
}

module.exports = { ACTIVE_STATES, createDictationController };
