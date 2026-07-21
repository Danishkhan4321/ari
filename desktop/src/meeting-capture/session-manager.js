'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const VALID_STATES = new Set(['prepared', 'recording', 'paused', 'finalizing', 'finalized', 'uploading', 'submitted', 'cancelled', 'failed']);
const RECOVERABLE_STATES = new Set(['prepared', 'recording', 'paused', 'finalizing', 'finalized', 'uploading', 'failed']);

function sanitizeText(value, maxLength) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);
}

function createSessionManager({
  root,
  minFreeBytes = 512 * 1024 * 1024,
  maxChunkBytes = 16 * 1024 * 1024,
  uuid = () => crypto.randomUUID(),
  now = () => new Date(),
  freeBytes,
} = {}) {
  if (!root) throw new TypeError('capture root is required');
  const captureRoot = path.resolve(root);
  const locks = new Map();

  const pathsFor = (id) => ({
    manifest: path.join(captureRoot, `${id}.json`),
  });

  async function availableBytes() {
    if (freeBytes) return freeBytes(captureRoot);
    if (typeof fs.promises.statfs !== 'function') return Number.MAX_SAFE_INTEGER;
    const stats = await fs.promises.statfs(captureRoot);
    return Number(stats.bavail) * Number(stats.bsize);
  }

  async function writeManifest(manifest) {
    const paths = pathsFor(manifest.id);
    const temp = `${paths.manifest}.${uuid()}.tmp`;
    await fs.promises.writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await fs.promises.rename(temp, paths.manifest);
  }

  async function readManifest(id) {
    if (!/^[a-f0-9-]{20,64}$/i.test(String(id || ''))) throw new TypeError('invalid capture session ID');
    const parsed = JSON.parse(await fs.promises.readFile(pathsFor(id).manifest, 'utf8'));
    if (parsed.id !== id || !VALID_STATES.has(parsed.state)) throw new Error('invalid capture manifest');
    return parsed;
  }

  function serialized(id, operation) {
    const previous = locks.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    locks.set(id, current);
    return current.finally(() => { if (locks.get(id) === current) locks.delete(id); });
  }

  async function update(id, allowed, nextState, extra = {}) {
    return serialized(id, async () => {
      const manifest = await readManifest(id);
      if (!allowed.includes(manifest.state)) throw new Error(`Cannot move capture from ${manifest.state} to ${nextState}`);
      const updated = { ...manifest, ...extra, state: nextState, updatedAt: now().toISOString() };
      await writeManifest(updated);
      return updated;
    });
  }

  async function prepare({ platform, codec, title = 'Untitled Meeting' } = {}) {
    await fs.promises.mkdir(captureRoot, { recursive: true, mode: 0o700 });
    if (await availableBytes() < minFreeBytes) throw new Error('Not enough free disk space to record a meeting');
    const id = uuid();
    const paths = pathsFor(id);
    const recordingPath = path.join(captureRoot, `${id}.${platform === 'darwin' ? 'caf' : 'webm'}`);
    await fs.promises.writeFile(recordingPath, Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
    const timestamp = now().toISOString();
    const manifest = {
      id, state: 'prepared', recordingPath, bytes: 0,
      platform: sanitizeText(platform, 40), codec: sanitizeText(codec, 160),
      title: sanitizeText(title, 500) || 'Untitled Meeting',
      createdAt: timestamp, updatedAt: timestamp,
    };
    await writeManifest(manifest);
    return manifest;
  }

  const start = (id) => update(id, ['prepared'], 'recording', { startedAt: now().toISOString() });
  const pause = (id) => update(id, ['recording'], 'paused');
  const resume = (id) => update(id, ['paused'], 'recording');

  async function writeChunk(id, chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!bytes.length || bytes.length > maxChunkBytes) throw new RangeError('invalid meeting audio chunk size');
    return serialized(id, async () => {
      const manifest = await readManifest(id);
      if (manifest.state !== 'recording') throw new Error(`Cannot write audio while capture is ${manifest.state}`);
      if (await availableBytes() < minFreeBytes + bytes.length) throw new Error('Not enough free disk space to continue recording');
      await fs.promises.appendFile(manifest.recordingPath, bytes);
      const updated = { ...manifest, bytes: Number(manifest.bytes || 0) + bytes.length, updatedAt: now().toISOString() };
      await writeManifest(updated);
      return updated;
    });
  }

  async function stop(id) {
    return serialized(id, async () => {
      let manifest = await readManifest(id);
      if (['finalized', 'uploading', 'submitted', 'failed'].includes(manifest.state)) return manifest;
      if (!['recording', 'paused', 'finalizing'].includes(manifest.state)) throw new Error(`Cannot stop capture from ${manifest.state}`);
      if (manifest.state !== 'finalizing') {
        manifest = { ...manifest, state: 'finalizing', updatedAt: now().toISOString() };
        await writeManifest(manifest);
      }
      const stats = await fs.promises.stat(manifest.recordingPath);
      manifest = { ...manifest, state: 'finalized', bytes: stats.size, finalizedAt: now().toISOString(), updatedAt: now().toISOString() };
      await writeManifest(manifest);
      return manifest;
    });
  }

  const markUploading = (id) => update(id, ['finalized', 'failed'], 'uploading');
  const markSubmitted = (id, result) => update(id, ['uploading'], 'submitted', { meetingId: result.meetingId, processingStage: result.processingStage });
  const markFailed = (id, message) => update(id, ['finalized', 'uploading'], 'failed', { error: sanitizeText(message, 500) });

  async function cancel(id) {
    return serialized(id, async () => {
      const manifest = await readManifest(id);
      if (manifest.state === 'submitted') throw new Error('A submitted recording cannot be cancelled');
      if (manifest.state === 'cancelled') return manifest;
      await fs.promises.rm(manifest.recordingPath, { force: true });
      const cancelled = { ...manifest, state: 'cancelled', cancelledAt: now().toISOString(), updatedAt: now().toISOString() };
      await writeManifest(cancelled);
      return cancelled;
    });
  }

  async function recover() {
    await fs.promises.mkdir(captureRoot, { recursive: true, mode: 0o700 });
    const entries = await fs.promises.readdir(captureRoot, { withFileTypes: true });
    const recovered = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9-]{20,64}\.json$/i.test(entry.name)) continue;
      try {
        const manifest = await readManifest(entry.name.slice(0, -5));
        if (RECOVERABLE_STATES.has(manifest.state)) recovered.push(manifest);
      } catch (_) { /* ignore corrupt manifests; never guess paths */ }
    }
    return recovered.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  return { prepare, start, writeChunk, pause, resume, stop, cancel, recover, markUploading, markSubmitted, markFailed, read: readManifest };
}

module.exports = { createSessionManager, VALID_STATES, RECOVERABLE_STATES };
