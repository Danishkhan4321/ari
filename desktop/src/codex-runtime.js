const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const VALID_PROVIDERS = new Set(['ari', 'codex']);
const VALID_MODELS = new Set(['auto', 'sol', 'terra', 'luna']);

function targetTriple(platform = process.platform, arch = process.arch) {
  const targets = {
    'win32:x64': ['@openai/codex-win32-x64', 'x86_64-pc-windows-msvc', 'codex.exe'],
    'win32:arm64': ['@openai/codex-win32-arm64', 'aarch64-pc-windows-msvc', 'codex.exe'],
    'darwin:x64': ['@openai/codex-darwin-x64', 'x86_64-apple-darwin', 'codex'],
    'darwin:arm64': ['@openai/codex-darwin-arm64', 'aarch64-apple-darwin', 'codex'],
  };
  return targets[`${platform}:${arch}`] || null;
}

function resolveBundledCodex(repoRoot, options = {}) {
  const target = targetTriple(options.platform, options.arch);
  if (!target) throw new Error(`Codex is not available for ${options.platform || process.platform}/${options.arch || process.arch}.`);
  const [packageName, triple, executable] = target;
  const packageJson = require.resolve(`${packageName}/package.json`, { paths: [repoRoot] });
  const binary = path.join(path.dirname(packageJson), 'vendor', triple, 'bin', executable);
  if (!fs.existsSync(binary)) throw new Error('The bundled Codex runtime is missing. Reinstall the Ari desktop dependencies.');
  return binary;
}

function defaultPreferences() {
  return {
    provider: 'ari',
    model: 'auto',
    codexConnected: false,
    updatedAt: new Date().toISOString(),
  };
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function publicError(output, fallback) {
  const lines = String(output || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const safe = lines.find((line) => !/token|credential|auth\.json/i.test(line));
  return (safe || fallback).slice(0, 240);
}

function publicPreferences(preferences) {
  return {
    provider: preferences.provider,
    model: preferences.model,
    codexConnected: preferences.codexConnected === true,
  };
}

class CodexRuntime {
  constructor({ repoRoot, userDataPath, openExternal = async () => {} }) {
    this.repoRoot = repoRoot;
    this.userDataPath = userDataPath;
    this.preferencesPath = path.join(userDataPath, 'ai-preferences.json');
    this.codexHome = path.join(userDataPath, 'codex');
    this.workspace = path.join(userDataPath, 'codex-workspace');
    this.openExternal = openExternal;
    fs.mkdirSync(this.codexHome, { recursive: true });
    fs.mkdirSync(this.workspace, { recursive: true });
    if (!fs.existsSync(this.preferencesPath)) writeJson(this.preferencesPath, defaultPreferences());
  }

  childEnvironment() {
    return {
      ...process.env,
      CODEX_HOME: this.codexHome,
    };
  }

  preferences() {
    const stored = { ...defaultPreferences(), ...readJson(this.preferencesPath) };
    return {
      ...stored,
      provider: VALID_PROVIDERS.has(stored.provider) ? stored.provider : 'ari',
      model: VALID_MODELS.has(stored.model) ? stored.model : 'auto',
    };
  }

  updatePreferences(patch) {
    const current = this.preferences();
    const next = {
      ...current,
      ...(VALID_PROVIDERS.has(patch?.provider) ? { provider: patch.provider } : {}),
      ...(VALID_MODELS.has(patch?.model) ? { model: patch.model } : {}),
      ...(typeof patch?.codexConnected === 'boolean' ? { codexConnected: patch.codexConnected } : {}),
      updatedAt: new Date().toISOString(),
    };
    if (next.provider === 'codex' && !next.codexConnected) next.provider = 'ari';
    writeJson(this.preferencesPath, next);
    return next;
  }

  run(args, { timeoutMs = 30_000, openLoginUrl = false } = {}) {
    const executable = resolveBundledCodex(this.repoRoot);
    return new Promise((resolve) => {
      const child = spawn(executable, args, {
        cwd: this.workspace,
        env: this.childEnvironment(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      let opened = false;
      const collect = (chunk) => {
        output += String(chunk);
        if (openLoginUrl && !opened) {
          const match = output.match(/https:\/\/[^\s]+/i);
          if (match) {
            opened = true;
            void this.openExternal(match[0].replace(/[),.;]+$/, ''));
          }
        }
      };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        resolve({ ok: false, code: null, output, timedOut: true });
      }, timeoutMs);
      child.once('error', (error) => {
        clearTimeout(timer);
        resolve({ ok: false, code: null, output: `${output}\n${error.message}`, timedOut: false });
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve({ ok: code === 0, code, output, timedOut: false });
      });
    });
  }

  async status() {
    try {
      const result = await this.run(['login', 'status']);
      const connected = result.ok;
      const preferences = this.updatePreferences({ codexConnected: connected });
      return {
        available: true,
        connected,
        provider: preferences.provider,
        model: preferences.model,
        account: connected ? String(result.output || '').trim().slice(0, 160) : null,
        error: connected ? null : publicError(result.output, 'Codex is not connected.'),
      };
    } catch (error) {
      const preferences = this.updatePreferences({ codexConnected: false });
      return {
        available: false,
        connected: false,
        provider: preferences.provider,
        model: preferences.model,
        account: null,
        error: publicError(error.message, 'Codex is unavailable.'),
      };
    }
  }

  async connect() {
    const result = await this.run(['login'], { timeoutMs: 5 * 60_000, openLoginUrl: true });
    if (!result.ok) {
      const preferences = this.updatePreferences({ codexConnected: false });
      return { ok: false, ...publicPreferences(preferences), error: publicError(result.output, result.timedOut ? 'Codex sign-in timed out.' : 'Codex sign-in did not complete.') };
    }
    // Connecting an account must not silently change the active engine.
    // The provider only changes when the user explicitly selects Codex in
    // Settings; otherwise chats keep running on the default Ari runtime.
    const preferences = this.updatePreferences({ codexConnected: true });
    return { ok: true, ...publicPreferences(preferences) };
  }

  async disconnect() {
    await this.run(['logout']);
    const preferences = this.updatePreferences({ codexConnected: false, provider: 'ari' });
    return { ok: true, ...publicPreferences(preferences) };
  }
}

module.exports = {
  CodexRuntime,
  defaultPreferences,
  readJson,
  publicPreferences,
  resolveBundledCodex,
  targetTriple,
  writeJson,
};
