const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, clipboard, desktopCapturer, ipcMain, Menu, nativeImage, screen, shell, session, systemPreferences, Tray } = require('electron');
const { createRuntimeConfig, loadPackagedConfig } = require('./config');
const { ServiceController } = require('./service-controller');
const { classifyUrl } = require('./navigation');
const { CodexRuntime } = require('./codex-runtime');
const { ensureSessionLogPath } = require('./session-debug');
const { createSessionManager } = require('./meeting-capture/session-manager');
const { createBackendClient } = require('./meeting-capture/backend-client');
const { registerMeetingIpc } = require('./meeting-capture/ipc');
const { createDictationBackendClient } = require('./dictation/backend-client');
const { createDictationController } = require('./dictation/controller');
const { loadOrCreateInternalToken, removeInternalToken } = require('./internal-token');
const { exchangeDesktopTicket, googleAuthStartUrl, ticketFromCommandLine, ticketFromDeepLink } = require('./desktop-auth');

const repoRoot = process.env.ARI_REPO_ROOT || path.resolve(__dirname, '..', '..');
const packagedConfigPath = app.isPackaged ? path.join(process.resourcesPath, 'app-config.json') : undefined;
const packagedConfig = app.isPackaged ? loadPackagedConfig(packagedConfigPath) : {};
if (app.isPackaged && !process.env.ARI_DESKTOP_DASHBOARD_URL && !packagedConfig.dashboardUrl) {
  packagedConfig.dashboardUrl = 'https://app.98-89-55-116.sslip.io';
}
const runtime = createRuntimeConfig(repoRoot, {
  packagedConfig,
});
let services = null;
let backendService = null;
let mainWindow = null;
let codexRuntime = null;
let dictationController = null;
let desktopInternalTokenPath = null;
let quitting = false;
let launchInProgress = false;
let pendingAuthTicket = ticketFromCommandLine(process.argv);
let authExchangeInProgress = false;

function nodeCommand() {
  return process.env.ARI_NODE_BINARY || 'node';
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#E8E9EC',
    // Keep the native title bar quiet; Ari's product identity lives in the app UI.
    title: ' ',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'win32' ? {
      titleBarOverlay: {
        color: '#e8e9ec',
        symbolColor: '#706965',
        height: 36,
      },
    } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: !app.isPackaged ? ['--ari-session-debug'] : [],
      devTools: !app.isPackaged
    }
  });

  win.once('ready-to-show', () => win.show());
  win.on('close', (event) => {
    if (quitting || !dictationController) return;
    event.preventDefault();
    win.hide();
  });
  win.on('page-title-updated', (event) => {
    event.preventDefault();
    win.setTitle(' ');
  });
  void win.loadFile(path.join(__dirname, 'startup.html'));

  win.webContents.setWindowOpenHandler(({ url }) => {
    const kind = classifyUrl(url, runtime.dashboardUrl);
    if (kind === 'external') void shell.openExternal(url);
    if (kind === 'local') void win.loadURL(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    const kind = classifyUrl(url, runtime.dashboardUrl);
    if (kind === 'local') return;
    event.preventDefault();
    if (kind === 'external') void shell.openExternal(url);
  });

  return win;
}

async function startLocalServices() {
  if (!runtime.useDemoDatabase) {
    backendService = await services.ensure({
      name: 'Ari backend',
      url: runtime.backendUrl,
      expectedText: 'Ari Bot is running!',
      command: nodeCommand(),
      args: [runtime.backendEntry],
      cwd: runtime.repoRoot,
      env: runtime.childEnv,
      timeoutMs: 60000
    });
  }

  await services.ensure({
    name: 'Ari dashboard',
    url: runtime.dashboardUrl,
    expectedText: 'Ari Dashboard',
    command: nodeCommand(),
    args: [runtime.dashboardEntry, 'dev', '-H', '127.0.0.1', '-p', new URL(runtime.dashboardUrl).port],
    cwd: runtime.dashboardRoot,
    env: {
      ...runtime.childEnv,
      NODE_ENV: 'development',
      ARI_NEXT_DIST_DIR: '.next-desktop'
    },
    timeoutMs: 120000
  });
}

async function launch() {
  if (launchInProgress || !mainWindow || mainWindow.isDestroyed()) return;
  launchInProgress = true;
  await mainWindow.loadFile(path.join(__dirname, 'startup.html'));
  try {
    if (app.isPackaged && runtime.hosted) {
      await session.defaultSession.clearCache();
    }
    if (!runtime.hosted) await startLocalServices();
    await mainWindow.loadURL(runtime.dashboardEntryUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown startup error';
    await mainWindow.loadFile(path.join(__dirname, 'startup.html'), {
      query: { error: message.slice(0, 500) }
    });
  } finally {
    launchInProgress = false;
  }
}

async function completeDesktopAuth(ticket) {
  if (!ticket || authExchangeInProgress) return;
  authExchangeInProgress = true;
  try {
    await exchangeDesktopTicket({
      dashboardUrl: runtime.dashboardUrl,
      ticket,
      cookieStore: session.defaultSession.cookies,
    });
    pendingAuthTicket = null;
    await mainWindow?.loadURL(runtime.dashboardEntryUrl);
    if (dictationController) dictationController.showMainWindow();
    else {
      mainWindow?.show();
      mainWindow?.focus();
    }
  } catch (error) {
    const logPath = path.join(app.getPath('logs'), 'ari-desktop.log');
    fs.appendFile(logPath, `${new Date().toISOString()} [Ari auth] ${String(error?.message || error)}\n`, () => {});
  } finally {
    authExchangeInProgress = false;
  }
}

function acceptAuthDeepLink(rawUrl) {
  const ticket = ticketFromDeepLink(rawUrl);
  if (!ticket) return false;
  pendingAuthTicket = ticket;
  if (app.isReady() && mainWindow) void completeDesktopAuth(ticket);
  return true;
}

async function boot() {
  const logPath = path.join(app.getPath('logs'), 'ari-desktop.log');
  const sessionLogRoot = path.join(app.getPath('logs'), 'sessions');
  const sessionAttachmentRoot = path.join(app.getPath('userData'), 'session-attachments');
  const meetingCaptureRoot = process.env.ARI_DESKTOP_CAPTURE_DIR
    ? runtime.captureDirectory
    : path.join(app.getPath('userData'), 'meeting-recordings');
  const internalIdentity = loadOrCreateInternalToken(app.getPath('userData'));
  const desktopInternalToken = internalIdentity.token;
  desktopInternalTokenPath = internalIdentity.filePath;
  runtime.childEnv.ARI_DESKTOP_INTERNAL_TOKEN = desktopInternalToken;
  runtime.internalTokenAvailable = true;
  codexRuntime = new CodexRuntime({
    repoRoot,
    userDataPath: app.getPath('userData'),
    openExternal: (url) => shell.openExternal(url),
  });
  runtime.childEnv.ARI_DESKTOP_AI_CONFIG = codexRuntime.preferencesPath;
  runtime.childEnv.ARI_CODEX_HOME = codexRuntime.codexHome;
  runtime.childEnv.ARI_CODEX_WORKSPACE = codexRuntime.workspace;
  runtime.childEnv.ARI_SESSION_LOG_DIR = sessionLogRoot;
  runtime.childEnv.ARI_SESSION_ATTACHMENT_DIR = sessionAttachmentRoot;
  services = new ServiceController({
    onLog: (name, line) => {
      fs.appendFile(logPath, `${new Date().toISOString()} [${name}] ${line}\n`, () => {});
    }
  });

  const fromLocalDashboard = (event) => classifyUrl(event.senderFrame.url, runtime.dashboardUrl) === 'local';
  const isLocalMediaRequest = (webContents, requestingOrigin, details = {}) => {
    const origin = requestingOrigin || details.requestingUrl || webContents?.getURL?.() || '';
    return classifyUrl(origin, runtime.dashboardUrl) === 'local'
      || dictationController?.ownsWebContents(webContents) === true;
  };
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin, details) =>
      permission === 'media' && isLocalMediaRequest(webContents, requestingOrigin, details)
  );
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) =>
      callback(permission === 'media' && isLocalMediaRequest(webContents, '', details))
  );
  if (process.platform === 'win32') {
    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
      const requestOrigin = request.securityOrigin || request.frame?.url || '';
      if (request.userGesture !== true || classifyUrl(requestOrigin, runtime.dashboardUrl) !== 'local') {
        callback({});
        return;
      }
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        const primaryId = String(screen.getPrimaryDisplay().id);
        const source = sources.find((candidate) => candidate.display_id === primaryId) || sources[0];
        if (!source) callback({});
        else callback({ video: source, audio: 'loopback' });
      } catch (_) {
        callback({});
      }
    });
  }
  mainWindow = createWindow();

  const fromStartupPage = (event) => event.senderFrame.url.startsWith('file:');
  ipcMain.on('desktop:retry', (event) => {
    if (fromStartupPage(event)) void launch();
  });
  ipcMain.on('desktop:quit', (event) => {
    if (fromStartupPage(event)) app.quit();
  });
  ipcMain.handle('desktop:auth:google', async (event) => {
    if (!fromLocalDashboard(event)) return { ok: false, error: 'Google sign-in is unavailable outside Ari.' };
    try {
      await shell.openExternal(googleAuthStartUrl(runtime.dashboardUrl));
      return { ok: true };
    } catch {
      return { ok: false, error: 'Could not open your browser.' };
    }
  });
  const meetingSessionManager = createSessionManager({ root: meetingCaptureRoot });
  const meetingBackendClient = runtime.desktopPhone
    ? createBackendClient({
        backendUrl: runtime.backendUrl,
        internalToken: desktopInternalToken,
        userPhone: runtime.desktopPhone,
      })
    : { upload: async () => { throw new Error('Desktop meeting identity is not configured.'); } };
  const nativeMacHelper = process.platform === 'darwin'
    ? require('./meeting-capture/macos-helper').createMacOSCaptureHelper()
    : null;
  registerMeetingIpc({
    ipcMain,
    sessionManager: meetingSessionManager,
    backendClient: meetingBackendClient,
    nativeMacHelper,
    fromLocalDashboard,
    available: Boolean(runtime.desktopPhone),
  });
  let inputHook = null;
  let inputKeys = null;
  try {
    const input = require('uiohook-napi');
    inputHook = input.uIOhook;
    inputKeys = input.UiohookKey;
  } catch (_) {}
  const dictationBackend = runtime.desktopPhone
    ? createDictationBackendClient({
        backendUrl: runtime.backendUrl,
        internalToken: desktopInternalToken,
        userPhone: runtime.desktopPhone,
      })
    : null;
  dictationController = createDictationController({
    BrowserWindow,
    Tray,
    Menu,
    nativeImage,
    clipboard,
    ipcMain,
    screen,
    systemPreferences,
    mainWindow,
    backend: dictationBackend,
    hook: inputHook,
    keys: inputKeys,
    userDataPath: app.getPath('userData'),
    iconPath: path.join(__dirname, '..', 'build', 'icon.png'),
    fromLocalDashboard,
  });
  ipcMain.handle('desktop:debug:session-menu', async (event, sessionId) => {
    if (app.isPackaged || !fromLocalDashboard(event)) return false;
    const sessionLogPath = ensureSessionLogPath(sessionLogRoot, sessionId);
    if (!sessionLogPath) return false;
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    Menu.buildFromTemplate([{
      label: 'Copy session log path',
      click: () => clipboard.writeText(sessionLogPath),
    }]).popup({ window: ownerWindow || undefined });
    return true;
  });
  ipcMain.handle('desktop:ai:status', async (event) => {
    if (!fromLocalDashboard(event)) return { available: false, connected: false, provider: 'ari', model: 'auto', error: 'Unavailable outside Ari.' };
    return codexRuntime.status();
  });
  ipcMain.handle('desktop:ai:connect', async (event) => {
    if (!fromLocalDashboard(event)) return { ok: false, error: 'Unavailable outside Ari.' };
    return codexRuntime.connect();
  });
  ipcMain.handle('desktop:ai:disconnect', async (event) => {
    if (!fromLocalDashboard(event)) return { ok: false, error: 'Unavailable outside Ari.' };
    return codexRuntime.disconnect();
  });
  ipcMain.handle('desktop:ai:preference', async (event, patch) => {
    if (!fromLocalDashboard(event)) return { ok: false, error: 'Unavailable outside Ari.' };
    const preferences = codexRuntime.updatePreferences(patch || {});
    return {
      ok: true,
      provider: preferences.provider,
      model: preferences.model,
      codexConnected: preferences.codexConnected === true,
    };
  });

  await launch();
  if (pendingAuthTicket) void completeDesktopAuth(pendingAuthTicket);
  dictationController.start();
  if (app.isPackaged) {
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      setTimeout(() => {
        void autoUpdater.checkForUpdatesAndNotify().catch((error) => {
          fs.appendFile(logPath, `${new Date().toISOString()} [Ari update] ${String(error?.message || error)}\n`, () => {});
        });
      }, 5000);
    } catch (error) {
      fs.appendFile(logPath, `${new Date().toISOString()} [Ari update] ${String(error?.message || error)}\n`, () => {});
    }
  }
  if (process.env.ARI_DESKTOP_SMOKE === 'true') {
    setTimeout(() => app.quit(), 20000);
  }
}

if (process.defaultApp && process.argv[1]) {
  app.setAsDefaultProtocolClient('ari', process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient('ari');
}

app.on('open-url', (event, url) => {
  if (acceptAuthDeepLink(url)) event.preventDefault();
});

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    const ticket = ticketFromCommandLine(commandLine);
    if (ticket) {
      pendingAuthTicket = ticket;
      if (mainWindow) void completeDesktopAuth(ticket);
    }
    if (dictationController) dictationController.showMainWindow();
    else if (mainWindow) mainWindow.focus();
  });
  app.whenReady().then(boot);
}

app.on('window-all-closed', () => {
  if (!dictationController) app.quit();
});
app.on('activate', () => dictationController?.showMainWindow());
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  Promise.all([
    dictationController ? dictationController.shutdown() : Promise.resolve(),
    services ? services.stopAll() : Promise.resolve(),
  ]).finally(() => {
    if (backendService?.managed) {
      try { removeInternalToken(desktopInternalTokenPath); } catch (_) {}
    }
    app.exit(0);
  });
});
