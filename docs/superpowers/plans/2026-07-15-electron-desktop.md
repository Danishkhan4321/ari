# Ari Electron Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secure Electron desktop companion for Ari on Windows and macOS.

**Architecture:** A separate `desktop/` package owns Electron, local service lifecycle, navigation policy, and packaging metadata. Electron loads the root `.env` only into server child processes, overrides all Ari base URLs to loopback, disables backend background jobs, and renders the existing dashboard at `http://127.0.0.1:3001/` without changing dashboard components or styles.

**Tech Stack:** Electron 43, electron-builder 26, Node.js CommonJS, Node's built-in test runner, Next.js 14, Express 4.

---

## File map

- Create `desktop/package.json`: isolated scripts, dependencies, and Windows/macOS builder configuration.
- Create `desktop/src/config.js`: repository paths, ports, local-only URLs, environment loading, and desktop authentication selection.
- Create `desktop/src/service-controller.js`: child-process startup, readiness, log tail, and managed shutdown.
- Create `desktop/src/navigation.js`: local navigation allow-list and external URL classification.
- Create `desktop/src/main.js`: Electron lifecycle, loading window, security hooks, and service orchestration.
- Create `desktop/src/preload.js`: minimal retry and quit bridge for the local startup surface.
- Create `desktop/src/startup.html`: small startup/failure surface shown before the unchanged dashboard is ready.
- Create `desktop/tests/config.test.js`: loopback and environment safety tests.
- Create `desktop/tests/service-controller.test.js`: service readiness and shutdown tests.
- Create `desktop/tests/navigation.test.js`: loopback-only navigation tests.
- Create `desktop/scripts/smoke.js`: bounded Windows/macOS development launch smoke test.
- Modify `.gitignore`: ignore Electron output and desktop logs.
- Modify `package.json`: add repository-level desktop commands without changing the existing backend entry point.
- Modify `README.md`: document local desktop commands and current packaging limits.

The existing dashboard source is deliberately not modified.

### Task 1: Desktop package and safe runtime configuration

**Files:**
- Create: `desktop/package.json`
- Create: `desktop/tests/config.test.js`
- Create: `desktop/src/config.js`

- [ ] **Step 1: Create the desktop package manifest**

Create `desktop/package.json`:

```json
{
  "name": "ari-desktop",
  "version": "0.1.0",
  "private": true,
  "description": "Local Electron desktop shell for Ari",
  "main": "src/main.js",
  "scripts": {
    "dev": "electron .",
    "test": "node --test tests/*.test.js",
    "smoke": "node scripts/smoke.js",
    "build:win": "electron-builder --win nsis --x64",
    "build:mac": "electron-builder --mac dmg zip --x64 --arm64"
  },
  "dependencies": {
    "dotenv": "^16.6.1",
    "tree-kill": "^1.2.2"
  },
  "devDependencies": {
    "electron": "^43.1.1",
    "electron-builder": "^26.15.3"
  },
  "build": {
    "appId": "com.ari.desktop",
    "productName": "Ari",
    "asar": true,
    "directories": {
      "output": "dist",
      "buildResources": "build"
    },
    "files": [
      "src/**/*",
      "package.json"
    ],
    "win": {
      "target": ["nsis"],
      "icon": "../dashboard/public/favicon.ico"
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true
    },
    "mac": {
      "target": ["dmg", "zip"],
      "category": "public.app-category.productivity",
      "icon": "../dashboard/public/logo-wolf.png"
    }
  }
}
```

- [ ] **Step 2: Write configuration tests that fail before implementation**

Create `desktop/tests/config.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { buildRuntimeConfig, firstAdminPhone } = require('../src/config');

test('desktop runtime uses loopback URLs and disables background work', () => {
  const config = buildRuntimeConfig({
    repoRoot: path.resolve('D:/example/ari'),
    env: {
      DATABASE_URL: 'postgres://example',
      INTERNAL_API_SECRET: 'secret',
      ADMIN_PHONES: '919876543210, +14155550123',
      APP_BASE_URL: 'http://127.0.0.1:43100',
      DASHBOARD_BASE_URL: 'http://127.0.0.1:43101'
    }
  });

  assert.equal(config.backendUrl, 'http://127.0.0.1:3000');
  assert.equal(config.dashboardUrl, 'http://127.0.0.1:3001');
  assert.equal(config.childEnv.DISABLE_BACKGROUND_JOBS, 'true');
  assert.equal(config.childEnv.APP_BASE_URL, config.backendUrl);
  assert.equal(config.childEnv.BOT_INTERNAL_URL, config.backendUrl);
  assert.equal(config.childEnv.DASHBOARD_BASE_URL, config.dashboardUrl);
  assert.equal(config.childEnv.ARI_DEMO_USER_PHONE, '+919876543210');
  assert.equal(Object.values(config.childEnv).some((value) => String(value).includes('https://')), false);
});

test('firstAdminPhone normalizes the first configured phone', () => {
  assert.equal(firstAdminPhone('919876543210,+14155550123'), '+919876543210');
  assert.equal(firstAdminPhone(''), null);
});
```

- [ ] **Step 3: Run the configuration test and verify failure**

Run: `node --test desktop/tests/config.test.js`

Expected: FAIL with `Cannot find module '../src/config'`.

- [ ] **Step 4: Implement local-only runtime configuration**

Create `desktop/src/config.js`:

```js
const path = require('node:path');
const dotenv = require('dotenv');

function firstAdminPhone(raw) {
  const first = String(raw || '').split(',').map((value) => value.trim()).find(Boolean);
  if (!first) return null;
  const digits = first.replace(/[^0-9]/g, '');
  return digits ? `+${digits}` : null;
}

function loadLocalEnvironment(repoRoot, baseEnv = process.env) {
  const parsed = dotenv.config({ path: path.join(repoRoot, '.env') }).parsed || {};
  return { ...parsed, ...baseEnv };
}

function buildRuntimeConfig({ repoRoot, env }) {
  const backendPort = Number(env.ARI_DESKTOP_BACKEND_PORT || 3000);
  const dashboardPort = Number(env.ARI_DESKTOP_DASHBOARD_PORT || 3001);
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  const dashboardUrl = `http://127.0.0.1:${dashboardPort}`;
  const desktopPhone = env.ARI_DESKTOP_USER_PHONE || firstAdminPhone(env.ADMIN_PHONES);
  const bypassAuth = env.ARI_DESKTOP_AUTH_BYPASS !== 'false' && Boolean(desktopPhone);

  const childEnv = {
    ...env,
    DESKTOP_MODE: 'true',
    DISABLE_BACKGROUND_JOBS: 'true',
    HEARTBEAT_ENABLED: 'false',
    PORT: String(backendPort),
    APP_BASE_URL: backendUrl,
    BOT_BASE_URL: backendUrl,
    BOT_INTERNAL_URL: backendUrl,
    DASHBOARD_BASE_URL: dashboardUrl,
    HOSTNAME: '127.0.0.1',
    ARI_DEMO_MODE: bypassAuth ? 'true' : 'false',
    ...(bypassAuth ? { ARI_DEMO_USER_PHONE: desktopPhone } : {})
  };

  return {
    repoRoot,
    dashboardRoot: path.join(repoRoot, 'dashboard'),
    backendEntry: path.join(repoRoot, 'src', 'index.js'),
    dashboardEntry: path.join(repoRoot, 'dashboard', 'node_modules', 'next', 'dist', 'bin', 'next'),
    backendUrl,
    dashboardUrl,
    childEnv
  };
}

function createRuntimeConfig(repoRoot) {
  return buildRuntimeConfig({ repoRoot, env: loadLocalEnvironment(repoRoot) });
}

module.exports = { buildRuntimeConfig, createRuntimeConfig, firstAdminPhone, loadLocalEnvironment };
```

- [ ] **Step 5: Run the configuration test**

Run: `node --test desktop/tests/config.test.js`

Expected: 2 tests PASS.

- [ ] **Step 6: Commit the configuration boundary locally**

```bash
git add desktop/package.json desktop/src/config.js desktop/tests/config.test.js
git commit -m "feat(desktop): add local-only runtime configuration"
```

### Task 2: Managed local service lifecycle

**Files:**
- Create: `desktop/tests/service-controller.test.js`
- Create: `desktop/src/service-controller.js`

- [ ] **Step 1: Write failing service lifecycle tests**

Create `desktop/tests/service-controller.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { ServiceController } = require('../src/service-controller');

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

test('reuses a ready service and never marks it managed', async () => {
  let spawnCalls = 0;
  const controller = new ServiceController({
    spawnProcess: () => { spawnCalls += 1; return fakeChild(); },
    probe: async () => true,
    killTree: (_pid, _signal, done) => done()
  });

  const service = await controller.ensure({ name: 'dashboard', url: 'http://127.0.0.1:3001' });
  assert.equal(service.managed, false);
  assert.equal(spawnCalls, 0);
});

test('starts an unavailable service and marks it managed', async () => {
  const child = fakeChild();
  let probes = 0;
  const controller = new ServiceController({
    spawnProcess: () => child,
    probe: async () => ++probes > 1,
    killTree: (_pid, _signal, done) => done(),
    sleep: async () => {}
  });

  const service = await controller.ensure({
    name: 'backend',
    url: 'http://127.0.0.1:3000/health',
    command: 'node',
    args: ['src/index.js'],
    cwd: 'D:/example/ari',
    env: {}
  });
  assert.equal(service.managed, true);
  assert.equal(service.child, child);
});

test('stopAll terminates only managed child processes', async () => {
  const killed = [];
  const controller = new ServiceController({
    spawnProcess: () => fakeChild(),
    probe: async () => true,
    killTree: (pid, signal, done) => { killed.push([pid, signal]); done(); }
  });
  controller.services.push({ managed: false, child: { pid: 100 } });
  controller.services.push({ managed: true, child: { pid: 200 } });
  await controller.stopAll();
  assert.deepEqual(killed, [[200, 'SIGTERM']]);
});
```

- [ ] **Step 2: Verify the lifecycle tests fail**

Run: `node --test desktop/tests/service-controller.test.js`

Expected: FAIL with `Cannot find module '../src/service-controller'`.

- [ ] **Step 3: Implement the service controller**

Create `desktop/src/service-controller.js`:

```js
const { spawn } = require('node:child_process');
const treeKill = require('tree-kill');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function defaultProbe(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500), redirect: 'follow' });
    return response.status < 500;
  } catch {
    return false;
  }
}

class ServiceController {
  constructor({ spawnProcess = spawn, probe = defaultProbe, killTree = treeKill, sleep = delay, onLog = () => {} } = {}) {
    this.spawnProcess = spawnProcess;
    this.probe = probe;
    this.killTree = killTree;
    this.sleep = sleep;
    this.onLog = onLog;
    this.services = [];
  }

  async ensure(spec) {
    if (await this.probe(spec.url)) {
      const existing = { ...spec, managed: false, child: null, logs: [] };
      this.services.push(existing);
      return existing;
    }

    const child = this.spawnProcess(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const service = { ...spec, managed: true, child, logs: [] };
    this.services.push(service);
    this.capture(service, child.stdout);
    this.capture(service, child.stderr);

    const deadline = Date.now() + (spec.timeoutMs || 90000);
    while (Date.now() < deadline) {
      if (child.exitCode !== null && child.exitCode !== undefined) {
        throw new Error(`${spec.name} exited before it became ready. ${service.logs.slice(-8).join(' ')}`);
      }
      if (await this.probe(spec.url)) return service;
      await this.sleep(500);
    }
    throw new Error(`${spec.name} did not become ready in time. ${service.logs.slice(-8).join(' ')}`);
  }

  capture(service, stream) {
    if (!stream?.on) return;
    stream.on('data', (chunk) => {
      const safe = String(chunk).replace(/(?:postgres(?:ql)?:\/\/)[^\s]+/gi, '[database-url]');
      service.logs.push(safe.trim());
      this.onLog(service.name, safe.trim());
      if (service.logs.length > 50) service.logs.shift();
    });
  }

  stop(service, signal = 'SIGTERM') {
    if (!service?.managed || !service.child?.pid) return Promise.resolve();
    return new Promise((resolve) => this.killTree(service.child.pid, signal, () => resolve()));
  }

  async stopAll() {
    const managed = this.services.filter((service) => service.managed).reverse();
    await Promise.all(managed.map((service) => this.stop(service)));
    this.services = [];
  }
}

module.exports = { ServiceController, defaultProbe };
```

- [ ] **Step 4: Run service lifecycle tests**

Run: `node --test desktop/tests/service-controller.test.js`

Expected: 3 tests PASS.

- [ ] **Step 5: Commit the lifecycle controller locally**

```bash
git add desktop/src/service-controller.js desktop/tests/service-controller.test.js
git commit -m "feat(desktop): manage local Ari services"
```

### Task 3: Navigation and external-link security

**Files:**
- Create: `desktop/tests/navigation.test.js`
- Create: `desktop/src/navigation.js`

- [ ] **Step 1: Write failing navigation policy tests**

Create `desktop/tests/navigation.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyUrl } = require('../src/navigation');

test('allows the local dashboard and its routes', () => {
  assert.equal(classifyUrl('http://127.0.0.1:3001/tasks', 'http://127.0.0.1:3001'), 'local');
});

test('blocks every non-local URL', () => {
  assert.equal(classifyUrl('https://example.com', 'http://127.0.0.1:3001'), 'external');
  assert.equal(classifyUrl('https://app.example.com/login', 'http://127.0.0.1:3001'), 'external');
});

test('opens other http links externally and blocks unsafe protocols', () => {
  assert.equal(classifyUrl('https://accounts.google.com/', 'http://127.0.0.1:3001'), 'external');
  assert.equal(classifyUrl('file:///C:/Windows/System32', 'http://127.0.0.1:3001'), 'blocked');
  assert.equal(classifyUrl('javascript:alert(1)', 'http://127.0.0.1:3001'), 'blocked');
});
```

- [ ] **Step 2: Verify the navigation tests fail**

Run: `node --test desktop/tests/navigation.test.js`

Expected: FAIL with `Cannot find module '../src/navigation'`.

- [ ] **Step 3: Implement URL classification**

Create `desktop/src/navigation.js`:

```js
function classifyUrl(rawUrl, dashboardOrigin) {
  let url;
  let origin;
  try {
    url = new URL(rawUrl);
    origin = new URL(dashboardOrigin).origin;
  } catch {
    return 'blocked';
  }
  const host = url.hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost'].includes(host)) return 'external';
  if (url.origin === origin) return 'local';
  if (url.protocol === 'http:' || url.protocol === 'https:') return 'external';
  return 'blocked';
}

module.exports = { classifyUrl };
```

- [ ] **Step 4: Run navigation policy tests**

Run: `node --test desktop/tests/navigation.test.js`

Expected: 3 tests PASS.

- [ ] **Step 5: Commit the security policy locally**

```bash
git add desktop/src/navigation.js desktop/tests/navigation.test.js
git commit -m "feat(desktop): restrict desktop navigation"
```

### Task 4: Electron window and service orchestration

**Files:**
- Create: `desktop/src/main.js`
- Create: `desktop/src/preload.js`
- Create: `desktop/src/startup.html`

- [ ] **Step 1: Create the startup and failure surface**

Create `desktop/src/startup.html` with a neutral loading screen that is not a redesign of the dashboard:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Starting Ari</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f3ee; color: #111; }
    main { width: min(420px, calc(100vw - 48px)); padding: 32px; border: 2px solid #111; border-radius: 8px; background: #fff; box-shadow: 6px 6px 0 #111; }
    h1 { margin: 0 0 8px; font-size: 28px; }
    p { margin: 0; line-height: 1.5; color: #555; }
    .actions { display: none; gap: 10px; margin-top: 22px; }
    body[data-state="error"] .actions { display: flex; }
    button { border: 2px solid #111; border-radius: 4px; padding: 9px 14px; background: #c8ff60; font: inherit; font-weight: 700; cursor: pointer; }
    button:last-child { background: #fff; }
    .dot { display: inline-block; width: 10px; height: 10px; margin-right: 10px; border-radius: 50%; background: #c8ff60; border: 1px solid #111; }
    body[data-state="error"] .dot { background: #ff9f7a; }
  </style>
</head>
<body>
  <main>
    <h1><span class="dot"></span><span id="title">Starting Ari</span></h1>
    <p id="message">Preparing your local dashboard…</p>
    <div class="actions"><button id="retry">Retry</button><button id="quit">Quit</button></div>
  </main>
  <script>
    const params = new URLSearchParams(location.search);
    if (params.get('error')) {
      document.body.dataset.state = 'error';
      document.getElementById('title').textContent = 'Ari could not start';
      document.getElementById('message').textContent = params.get('error');
    }
    document.getElementById('retry').addEventListener('click', () => window.ariDesktop.retry());
    document.getElementById('quit').addEventListener('click', () => window.ariDesktop.quit());
  </script>
</body>
</html>
```

- [ ] **Step 2: Create the minimal startup bridge**

Create `desktop/src/preload.js`:

```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ariDesktop', Object.freeze({
  retry: () => ipcRenderer.send('desktop:retry'),
  quit: () => ipcRenderer.send('desktop:quit')
}));
```

- [ ] **Step 3: Implement Electron orchestration and hardened BrowserWindow settings**

Create `desktop/src/main.js`:

```js
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const { createRuntimeConfig } = require('./config');
const { ServiceController } = require('./service-controller');
const { classifyUrl } = require('./navigation');

const repoRoot = process.env.ARI_REPO_ROOT || path.resolve(__dirname, '..', '..');
const runtime = createRuntimeConfig(repoRoot);
let services = null;
let mainWindow = null;
let quitting = false;

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
    backgroundColor: '#f5f3ee',
    title: 'Ari',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      devTools: !app.isPackaged
    }
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'startup.html'));

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
  await services.ensure({
    name: 'Ari backend',
    url: `${runtime.backendUrl}/health`,
    command: nodeCommand(),
    args: [runtime.backendEntry],
    cwd: runtime.repoRoot,
    env: runtime.childEnv,
    timeoutMs: 60000
  });
  await services.ensure({
    name: 'Ari dashboard',
    url: runtime.dashboardUrl,
    command: nodeCommand(),
    args: [runtime.dashboardEntry, 'dev', '-H', '127.0.0.1', '-p', new URL(runtime.dashboardUrl).port],
    cwd: runtime.dashboardRoot,
    env: { ...runtime.childEnv, NODE_ENV: 'development' },
    timeoutMs: 120000
  });
}

async function launch() {
  await mainWindow.loadFile(path.join(__dirname, 'startup.html'));
  try {
    await startLocalServices();
    await mainWindow.loadURL(runtime.dashboardUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown startup error';
    await mainWindow.loadFile(path.join(__dirname, 'startup.html'), { query: { error: message.slice(0, 500) } });
  }
}

async function boot() {
  const logPath = path.join(app.getPath('logs'), 'ari-desktop.log');
  services = new ServiceController({
    onLog: (name, line) => fs.appendFile(logPath, `${new Date().toISOString()} [${name}] ${line}\n`, () => {})
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  mainWindow = createWindow();
  const fromStartupPage = (event) => event.senderFrame.url.startsWith('file:');
  ipcMain.on('desktop:retry', (event) => { if (fromStartupPage(event)) void launch(); });
  ipcMain.on('desktop:quit', (event) => { if (fromStartupPage(event)) app.quit(); });
  await launch();
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(boot);
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  (services ? services.stopAll() : Promise.resolve()).finally(() => app.exit(0));
});
```

- [ ] **Step 4: Run all unit tests**

Run: `npm test --prefix desktop`

Expected: 8 tests PASS and no Electron window opens.

- [ ] **Step 5: Commit the Electron window locally**

```bash
git add desktop/src/main.js desktop/src/preload.js desktop/src/startup.html
git commit -m "feat(desktop): launch the unchanged Ari dashboard"
```

### Task 5: Repository commands, generated-file safety, and operator instructions

**Files:**
- Modify: `.gitignore`
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Add desktop output ignores**

Append to `.gitignore`:

```gitignore

# Electron desktop local output
desktop/node_modules/
desktop/dist/
desktop/logs/
```

- [ ] **Step 2: Add root commands without changing existing scripts**

Add these entries to the existing root `package.json` `scripts` object:

```json
"desktop:install": "npm install --prefix desktop",
"desktop:dev": "npm run dev --prefix desktop",
"desktop:test": "npm test --prefix desktop",
"desktop:smoke": "npm run smoke --prefix desktop",
"desktop:build:win": "npm run build:win --prefix desktop",
"desktop:build:mac": "npm run build:mac --prefix desktop"
```

- [ ] **Step 3: Document local usage and limits**

Append this section to `README.md`:

```markdown
## Desktop app (local Electron preview)

The Electron app reuses the existing dashboard without changing its design. It starts the backend and dashboard on `127.0.0.1`, uses the repository's local `.env`, disables autonomous background jobs, and keeps application navigation on loopback.

```bash
npm run desktop:install
npm run desktop:dev
```

Set `ARI_DESKTOP_USER_PHONE` in the local environment to choose the dashboard user explicitly. When it is absent, the first `ADMIN_PHONES` entry is used for this local-only preview. Set `ARI_DESKTOP_AUTH_BYPASS=false` if normal dashboard login should be tested instead.

Checks:

```bash
npm run desktop:test
npm run desktop:smoke
```

Windows packaging is configured for NSIS. macOS packaging is configured for DMG and ZIP, but the macOS artifacts must be built and tested on a Mac. No `.env` file or service secret is included in installers.
```

- [ ] **Step 4: Validate both package manifests**

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json')); JSON.parse(require('fs').readFileSync('desktop/package.json')); console.log('package manifests valid')"`

Expected: `package manifests valid`.

- [ ] **Step 5: Commit commands and documentation locally**

```bash
git add .gitignore package.json README.md
git commit -m "docs(desktop): add local desktop commands"
```

### Task 6: Install dependencies and add a bounded launch smoke test

**Files:**
- Create: `desktop/scripts/smoke.js`
- Create: `desktop/package-lock.json` via npm

- [ ] **Step 1: Install the isolated desktop dependencies**

Run: `npm install --prefix desktop`

Expected: `desktop/package-lock.json` is created and Electron installs successfully.

- [ ] **Step 2: Create the smoke-test launcher**

Create `desktop/scripts/smoke.js`:

```js
const { spawn } = require('node:child_process');
const path = require('node:path');

const desktopRoot = path.resolve(__dirname, '..');
const electronBinary = require('electron');
const child = spawn(electronBinary, ['.'], {
  cwd: desktopRoot,
  env: { ...process.env, ARI_DESKTOP_SMOKE: 'true' },
  windowsHide: false,
  stdio: 'inherit'
});

const timeout = setTimeout(() => {
  child.kill('SIGTERM');
  console.log('Desktop smoke window stayed alive for 20 seconds.');
}, 20000);

child.on('exit', (code) => {
  clearTimeout(timeout);
  if (code && code !== 0) process.exitCode = code;
});
```

- [ ] **Step 3: Run all desktop tests after dependency installation**

Run: `npm run desktop:test`

Expected: 8 tests PASS.

- [ ] **Step 4: Run the development smoke test**

Run: `npm run desktop:smoke`

Expected: an Ari Electron window opens, shows the existing dashboard or its unchanged login page, remains alive for 20 seconds, then closes its managed services. No application request loads a hosted product page.

- [ ] **Step 5: Commit the smoke test and lockfile locally**

```bash
git add desktop/scripts/smoke.js desktop/package-lock.json
git commit -m "test(desktop): add local launch smoke test"
```

### Task 7: Full local verification and packaging metadata check

**Files:**
- No new source files.

- [ ] **Step 1: Run desktop tests**

Run: `npm run desktop:test`

Expected: all desktop tests PASS.

- [ ] **Step 2: Run dashboard type checking**

Run: `npm run typecheck --prefix dashboard`

Expected: PASS, or record pre-existing diagnostics without changing dashboard design files.

- [ ] **Step 3: Run relevant dashboard tests**

Run: `npm test --prefix dashboard`

Expected: dashboard test suite PASS, or record failures proven to predate the Electron-only changes.

- [ ] **Step 4: Run relevant backend tests**

Run: `npm test`

Expected: backend test suite PASS, or record failures proven to predate the Electron-only changes.

- [ ] **Step 5: Inspect effective Windows builder configuration without publishing**

Run: `npm exec --prefix desktop electron-builder -- --win --x64 --dir --config.directories.output=dist-check`

Expected: electron-builder creates a local unpacked Windows directory under `desktop/dist-check` and performs no publish action. If packaging cannot include the local runtime without bundling secrets, keep development mode as the validated artifact and report the packaging limitation explicitly.

- [ ] **Step 6: Inspect macOS target configuration without attempting a Windows-hosted macOS release**

Run: `node -e "const p=require('./desktop/package.json'); console.log(p.build.mac.target.join(','))"`

Expected: `dmg,zip`.

- [ ] **Step 7: Verify no remote operation occurred**

Run: `git status --short && git log --oneline -8`

Expected: only local commits and working-tree changes are shown; no `git push`, release, deployment, or publishing command has run.

- [ ] **Step 8: Launch the app for user review**

Run: `npm run desktop:dev`

Expected: the native Ari window opens on Windows using the existing dashboard design and local services. Leave it open for the user to inspect.
