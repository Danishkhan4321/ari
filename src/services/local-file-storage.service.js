'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

function storageError(code, message = 'The local file could not be stored safely.') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isInsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function safeExtension(fileName) {
  const extension = path.extname(String(fileName || '')).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : '';
}

function createLocalFileStorage(options = {}) {
  const rootInput = options.root !== undefined
    ? options.root
    : process.env.ARI_SESSION_ATTACHMENT_DIR;
  const mkdirFn = options.mkdirFn || fs.mkdir;
  const writeFileFn = options.writeFileFn || fs.writeFile;
  const readFileFn = options.readFileFn || fs.readFile;
  const realpathFn = options.realpathFn || fs.realpath;
  const lstatFn = options.lstatFn || fs.lstat;
  const statFn = options.statFn || fs.stat;
  const unlinkFn = options.unlinkFn || fs.unlink;
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : DEFAULT_MAX_BYTES;

  async function resolvedRoot() {
    if (!rootInput) throw storageError('local_file_root_not_configured');
    const requested = path.resolve(String(rootInput));
    await mkdirFn(requested, { recursive: true });
    return path.resolve(String(await realpathFn(requested)));
  }

  async function inspect(localPath, expected = {}) {
    const root = await resolvedRoot();
    const requested = path.resolve(String(localPath || ''));
    let linkStats;
    let resolved;
    try {
      linkStats = await lstatFn(requested);
      resolved = path.resolve(String(await realpathFn(requested)));
    } catch (_) {
      throw storageError('local_file_unavailable');
    }
    if (linkStats?.isSymbolicLink?.() || !isInsideRoot(root, resolved)) {
      throw storageError('local_file_outside_root');
    }
    const stats = await statFn(resolved);
    const size = Number(stats?.size || 0);
    if (!stats?.isFile?.() || size <= 0 || size > maxBytes) {
      throw storageError(size > maxBytes ? 'local_file_too_large' : 'local_file_unavailable');
    }
    if (Number(expected.sizeBytes) > 0 && size !== Number(expected.sizeBytes)) {
      throw storageError('local_file_integrity_mismatch');
    }
    return { root, path: resolved, size };
  }

  async function read(localPath, expected = {}) {
    const inspected = await inspect(localPath, expected);
    const buffer = Buffer.from(await readFileFn(inspected.path));
    if (buffer.length !== inspected.size) throw storageError('local_file_integrity_mismatch');
    const digest = crypto.createHash('sha256').update(buffer).digest('hex');
    if (expected.sha256 && digest !== String(expected.sha256).toLowerCase()) {
      throw storageError('local_file_integrity_mismatch');
    }
    return { ...inspected, buffer, sha256: digest };
  }

  async function store({ userPhone, buffer, fileName } = {}) {
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
    if (!userPhone || bytes.length <= 0 || bytes.length > maxBytes) {
      throw storageError(bytes.length > maxBytes ? 'local_file_too_large' : 'invalid_local_file');
    }
    const root = await resolvedRoot();
    const tenant = crypto.createHash('sha256').update(String(userPhone)).digest('hex').slice(0, 24);
    const directory = path.join(root, 'user-files', tenant);
    await mkdirFn(directory, { recursive: true });
    const resolvedDirectory = path.resolve(String(await realpathFn(directory)));
    if (!isInsideRoot(root, resolvedDirectory)) throw storageError('local_file_outside_root');

    const localPath = path.join(resolvedDirectory, `${crypto.randomUUID()}${safeExtension(fileName)}`);
    await writeFileFn(localPath, bytes, { flag: 'wx', mode: 0o600 });
    try {
      const checked = await inspect(localPath, { sizeBytes: bytes.length });
      return {
        localPath: checked.path,
        sizeBytes: checked.size,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      };
    } catch (error) {
      await unlinkFn(localPath).catch(() => {});
      throw error;
    }
  }

  async function remove(localPath) {
    if (!localPath) return false;
    try {
      const checked = await inspect(localPath);
      await unlinkFn(checked.path);
      return true;
    } catch (error) {
      if (error?.code === 'local_file_unavailable') return false;
      throw error;
    }
  }

  return { inspect, read, remove, store };
}

module.exports = {
  createLocalFileStorage,
  localFileStorage: createLocalFileStorage(),
  storageError,
};
