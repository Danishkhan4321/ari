'use strict';

const { EventEmitter } = require('node:events');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

function resolveMacOSHelper({ resourcesPath = process.resourcesPath, desktopRoot = path.resolve(__dirname, '..', '..') } = {}) {
  if (process.env.NODE_ENV === 'development' || !resourcesPath) {
    return path.join(desktopRoot, 'native', 'macos', '.build', 'release', 'AriMeetingCapture');
  }
  return path.join(resourcesPath, 'native', 'macos', 'ari-meeting-capture');
}

function createMacOSCaptureHelper({
  executablePath = resolveMacOSHelper(),
  spawnImpl = spawn,
  readyTimeoutMs = 20_000,
} = {}) {
  const fixedExecutable = path.resolve(executablePath);
  let child = null;
  let pendingFinalization = null;

  function start({ outputPath }) {
    if (child) return Promise.reject(new Error('macOS meeting capture is already running'));
    const target = path.resolve(String(outputPath || ''));
    if (!outputPath || !path.isAbsolute(target)) return Promise.reject(new TypeError('absolute outputPath is required'));
    const events = new EventEmitter();
    child = spawnImpl(fixedExecutable, ['--output', target], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = readline.createInterface({ input: child.stdout });
    let ready = false;
    let settled = false;
    let timeout;
    const readyPromise = new Promise((resolve, reject) => {
      timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        child?.kill();
        reject(new Error('macOS capture helper did not become ready'));
      }, readyTimeoutMs);
      lines.on('line', (line) => {
        let event;
        try { event = JSON.parse(line); } catch (_) { return; }
        if (!event || typeof event.type !== 'string') return;
        events.emit(event.type, event);
        events.emit('event', event);
        if (event.type === 'ready' && !settled) {
          settled = true;
          ready = true;
          clearTimeout(timeout);
          resolve({ events, outputPath: target });
        }
        if (event.type === 'error' && !ready && !settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(event.message || 'macOS capture helper failed'));
        }
      });
      child.once('error', (error) => {
        if (!settled) { settled = true; clearTimeout(timeout); reject(error); }
        events.emit('error', error);
      });
      child.once('exit', (code, signal) => {
        const exitedChild = child;
        child = null;
        lines.close();
        const error = code === 0 ? null : new Error(`macOS capture helper exited (${code ?? signal})`);
        if (!settled) { settled = true; clearTimeout(timeout); reject(error || new Error('macOS capture helper exited before ready')); }
        if (error) events.emit('helper-exit-error', error);
        events.emit('exit', { code, signal, child: exitedChild });
      });
    });
    return readyPromise;
  }

  function command(type) {
    if (!child?.stdin?.writable) throw new Error('macOS capture helper is not running');
    child.stdin.write(`${JSON.stringify({ type })}\n`);
  }

  const pause = () => command('pause');
  const resume = () => command('resume');

  function stop(events) {
    if (pendingFinalization) return pendingFinalization;
    pendingFinalization = new Promise((resolve, reject) => {
      events.once('finalized', resolve);
      events.once('helper-exit-error', reject);
      command('stop');
    }).finally(() => { pendingFinalization = null; });
    return pendingFinalization;
  }

  function cancel() { command('cancel'); }

  return { start, pause, resume, stop, cancel, executablePath: fixedExecutable };
}

module.exports = { createMacOSCaptureHelper, resolveMacOSHelper };
