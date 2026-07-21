'use strict';

// Validate local file descriptors before their bytes are read and sent to a
// model provider.
//
// This is a faithful Node port of agno_runtime/file_inputs.py, which was the
// process-local safety boundary for the Python sidecar. When file turns moved
// to the in-process native runtime, that boundary had to move with them —
// dropping it would have silently traded a real hardening for convenience.
//
// Node already resolves tenant ownership upstream (an artifact is only listed
// for the user who owns it). This is the SECOND boundary: only current-turn
// session artifacts, living under the configured attachment root, as regular
// files, matching their recorded size (and digest when supplied), may be read.
//
// Failures deliberately do not enumerate: callers get one generic message so a
// probe cannot use error text to map the host filesystem.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_MAX_FILE_COUNT = 10;
const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const HARD_MAX_FILE_COUNT = 50;
const HARD_MAX_FILE_BYTES = 100 * 1024 * 1024;
const HARD_MAX_TOTAL_BYTES = 250 * 1024 * 1024;
const GENERIC_ATTACHMENT_FAILURE = 'One or more attached files could not be loaded safely';

const ALLOWED_FIELDS = new Set(['artifact_id', 'path', 'name', 'mime_type', 'size', 'sha256']);
const REQUIRED_FIELDS = ['artifact_id', 'path', 'name', 'mime_type', 'size'];
const SESSION_ARTIFACT = /^session:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;

class AttachmentInputFailure extends Error {
  constructor(message = GENERIC_ATTACHMENT_FAILURE) {
    super(message);
    this.name = 'AttachmentInputFailure';
    this.code = 'attachment_input_rejected';
  }
}

function configuredLimit(name, fallback, hardMaximum, env) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(value) || value < 1) throw new Error('limit must be positive');
  return Math.min(value, hardMaximum);
}

/** Absolute, lexically normalized — deliberately WITHOUT resolving symlinks. */
function absoluteWithoutLinks(value) {
  return path.resolve(String(value));
}

/** Windows paths are case-insensitive; match Python's os.path.normcase. */
function normalizeCase(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function isWithin(root, candidate) {
  if (candidate === root) return false; // the root itself is never an attachment
  return candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * Reject a path where ANY component between root and target is a symlink.
 * Checking only the final target would miss a symlinked parent directory.
 */
function rejectSymlinkComponents(root, candidate) {
  const relative = path.relative(root, candidate);
  let cursor = root;
  for (const component of relative.split(path.sep)) {
    if (!component) continue;
    cursor = path.join(cursor, component);
    let entry;
    try {
      entry = fs.lstatSync(cursor);
    } catch (_) {
      throw new Error('attachment path component is unreadable');
    }
    if (entry.isSymbolicLink()) throw new Error('symlinked attachment path');
  }
}

function sha256File(filePath) {
  const digest = crypto.createHash('sha256');
  const handle = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const read = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      digest.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(handle);
  }
  return digest.digest('hex');
}

function hasControlCharacters(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function validateFileSpecsStrict(fileSpecs, env) {
  if (!Array.isArray(fileSpecs)) throw new TypeError('files must be a list');
  if (fileSpecs.length === 0) return [];

  const maxCount = configuredLimit('ARI_AGENT_FILE_MAX_COUNT', DEFAULT_MAX_FILE_COUNT, HARD_MAX_FILE_COUNT, env);
  const maxFileBytes = configuredLimit('ARI_AGENT_FILE_MAX_BYTES', DEFAULT_MAX_FILE_BYTES, HARD_MAX_FILE_BYTES, env);
  const maxTotalBytes = configuredLimit('ARI_AGENT_FILE_TOTAL_MAX_BYTES', DEFAULT_MAX_TOTAL_BYTES, HARD_MAX_TOTAL_BYTES, env);
  if (fileSpecs.length > maxCount) throw new Error('too many attachments');

  const rootValue = String(env.ARI_SESSION_ATTACHMENT_DIR || '').trim();
  if (!rootValue) throw new Error('attachment root is not configured');
  const lexicalRoot = absoluteWithoutLinks(rootValue);
  const resolvedRoot = fs.realpathSync(lexicalRoot);
  if (!fs.lstatSync(resolvedRoot).isDirectory()) throw new Error('attachment root is not a directory');

  const validated = [];
  const seenIds = new Set();
  const seenPaths = new Set();
  let totalBytes = 0;

  for (const descriptor of fileSpecs) {
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
      throw new TypeError('attachment descriptor must be an object');
    }
    const fields = Object.keys(descriptor);
    if (!REQUIRED_FIELDS.every((field) => fields.includes(field))
      || !fields.every((field) => ALLOWED_FIELDS.has(field))) {
      throw new Error('attachment descriptor fields are invalid');
    }

    const { artifact_id: artifactId, path: filePath, name, mime_type: mimeType, size: expectedSize } = descriptor;
    const expectedHash = descriptor.sha256 === undefined ? null : descriptor.sha256;

    if (typeof artifactId !== 'string' || !SESSION_ARTIFACT.test(artifactId)) {
      throw new Error('attachment ID is invalid');
    }
    if (typeof filePath !== 'string' || !filePath || !path.isAbsolute(filePath)) {
      throw new Error('attachment path must be absolute');
    }
    if (typeof name !== 'string' || !name || name.length > 255
      || name === '.' || name === '..'
      || name.includes('/') || name.includes('\\')
      || hasControlCharacters(name)) {
      throw new Error('attachment name is invalid');
    }
    if (typeof mimeType !== 'string' || !mimeType || mimeType.length > 255 || hasControlCharacters(mimeType)) {
      throw new Error('attachment MIME type is invalid');
    }
    if (typeof expectedSize !== 'number' || !Number.isInteger(expectedSize) || expectedSize < 0) {
      throw new Error('attachment size is invalid');
    }
    if (expectedHash !== null && (typeof expectedHash !== 'string' || !SHA256.test(expectedHash))) {
      throw new Error('attachment digest is invalid');
    }

    // Containment is checked twice: lexically (catches ../ traversal) and
    // again after resolution (catches a symlink escaping the root).
    const lexicalPath = absoluteWithoutLinks(filePath);
    if (!isWithin(lexicalRoot, lexicalPath)) {
      throw new Error('attachment path is outside the configured root');
    }
    rejectSymlinkComponents(lexicalRoot, lexicalPath);
    let resolvedPath;
    try {
      resolvedPath = fs.realpathSync(lexicalPath);
    } catch (_) {
      throw new Error('attachment path is unreadable');
    }
    if (!isWithin(resolvedRoot, resolvedPath)) {
      throw new Error('attachment path resolves outside the configured root');
    }

    const before = fs.lstatSync(resolvedPath, { bigint: true });
    if (!before.isFile()) throw new Error('attachment is not a regular file');
    const actualSize = Number(before.size);
    if (actualSize !== expectedSize || actualSize > maxFileBytes) {
      throw new Error('attachment size is inconsistent or too large');
    }

    const normalizedId = artifactId.toLowerCase();
    const normalizedPath = normalizeCase(resolvedPath);
    if (seenIds.has(normalizedId) || seenPaths.has(normalizedPath)) {
      throw new Error('duplicate attachment');
    }
    seenIds.add(normalizedId);
    seenPaths.add(normalizedPath);

    totalBytes += actualSize;
    if (totalBytes > maxTotalBytes) throw new Error('attachment total is too large');

    if (expectedHash !== null) {
      // TOCTOU guard: hash the bytes, then re-stat and require the file
      // identity to be unchanged. A swap during hashing fails here.
      const actualHash = sha256File(resolvedPath);
      const after = fs.lstatSync(resolvedPath, { bigint: true });
      const sameIdentity = before.dev === after.dev
        && before.ino === after.ino
        && before.size === after.size
        && before.mtimeNs === after.mtimeNs;
      if (!sameIdentity || actualHash !== expectedHash.toLowerCase()) {
        throw new Error('attachment digest is inconsistent');
      }
    }

    validated.push({
      artifactId,
      path: resolvedPath,
      name,
      mimeType,
      size: actualSize,
    });
  }

  return validated;
}

/**
 * Return safe descriptors, or throw ONE generic error carrying no host detail.
 * @param {Array} fileSpecs agent file descriptors
 * @returns {Array<{artifactId,path,name,mimeType,size}>}
 */
function validateFileSpecs(fileSpecs, env = process.env) {
  try {
    return validateFileSpecsStrict(fileSpecs, env);
  } catch (error) {
    if (error instanceof AttachmentInputFailure) throw error;
    throw new AttachmentInputFailure();
  }
}

module.exports = {
  validateFileSpecs,
  AttachmentInputFailure,
  GENERIC_ATTACHMENT_FAILURE,
  _internals: { validateFileSpecsStrict, isWithin, normalizeCase },
};
