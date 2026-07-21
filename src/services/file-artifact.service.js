'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const axios = require('axios');
const database = require('../config/database');
const { currentChatSession } = require('./chat-session-context');
const { phoneCandidates } = require('./contact-group.service');
const { isSafeUrl, validateMimeType } = require('../utils/security');

const SESSION_ARTIFACT_RE = /^session:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const USER_FILE_ARTIFACT_RE = /^user_file:([1-9]\d{0,9})$/;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_ARTIFACTS = 10;

function artifactError(code, message = 'The requested artifact is unavailable.') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function unavailableArtifact() {
  // Unknown and foreign IDs intentionally have the same public failure. This
  // prevents an ID probe from revealing whether another tenant owns a file.
  return artifactError('artifact_not_found');
}

function isInsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function safeArtifactName(value) {
  return String(value || 'document')
    .replace(/[\\/\u0000-\u001f\u007f]+/g, '_')
    .trim()
    .slice(0, 255) || 'document';
}

function safeArtifactMime(value) {
  return validateMimeType(String(value || '')) || 'application/octet-stream';
}

function publicArtifact(row) {
  return {
    artifact_id: `session:${String(row.id)}`,
    name: safeArtifactName(row.file_name),
    mime_type: safeArtifactMime(row.mime_type),
    size: Number(row.size_bytes || 0),
    created_at: row.created_at || null,
  };
}

function createFileArtifactService(options = {}) {
  const queryFn = options.queryFn || database.query;
  const readFileFn = options.readFileFn || fs.readFile;
  const realpathFn = options.realpathFn || fs.realpath;
  const lstatFn = options.lstatFn || fs.lstat;
  const statFn = options.statFn || fs.stat;
  const localFileRoot = options.localFileRoot !== undefined
    ? options.localFileRoot
    : (process.env.ARI_SESSION_ATTACHMENT_DIR || null);
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : DEFAULT_MAX_BYTES;
  const httpGet = options.httpGet || ((url) => axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30000,
    maxContentLength: maxBytes,
    maxBodyLength: maxBytes,
    maxRedirects: 0,
  }));

  function activeTurn(overrides = {}) {
    const current = currentChatSession() || {};
    return {
      sessionId: overrides.sessionId || current.sessionId || null,
      clientMessageId: overrides.clientMessageId || current.clientMessageId || null,
    };
  }

  async function currentTurnRows(userPhone, overrides = {}) {
    const turn = activeTurn(overrides);
    if (!turn.sessionId || !turn.clientMessageId) return [];
    const result = await queryFn(
      `SELECT id, file_name, mime_type, local_path, size_bytes, created_at
         FROM ari_chat_attachments
        WHERE user_phone = $1
          AND session_id = $2
          AND client_message_id = $3
        ORDER BY created_at ASC, id ASC`,
      [String(userPhone), String(turn.sessionId), String(turn.clientMessageId)],
    );
    return Array.isArray(result.rows) ? result.rows : [];
  }

  async function listCurrentTurnArtifacts(userPhone, overrides = {}) {
    const rows = await currentTurnRows(userPhone, overrides);
    return rows.map(publicArtifact);
  }

  async function confinedLocalFile(localPath) {
    if (!localFileRoot) {
      throw artifactError(
        'artifact_root_not_configured',
        'Local attachment access is not configured on this server.',
      );
    }
    let root;
    let resolved;
    let linkStats;
    try {
      [root, resolved, linkStats] = await Promise.all([
        realpathFn(path.resolve(String(localFileRoot))),
        realpathFn(path.resolve(String(localPath))),
        lstatFn(path.resolve(String(localPath))),
      ]);
    } catch (_) {
      throw artifactError('artifact_unavailable');
    }
    root = path.resolve(String(root));
    resolved = path.resolve(String(resolved));
    if (linkStats?.isSymbolicLink?.() || !isInsideRoot(root, resolved)) {
      throw artifactError(
        'artifact_path_outside_root',
        'The stored artifact path is outside the configured attachment directory.',
      );
    }
    const stat = await statFn(resolved);
    if (!stat?.isFile?.()) throw artifactError('artifact_unavailable');
    if (Number(stat.size) > maxBytes) {
      throw artifactError('artifact_too_large', `The artifact exceeds the ${maxBytes}-byte analysis limit.`);
    }
    return { path: resolved, size: Number(stat.size) };
  }

  async function toAgentFilesForCurrentTurn(userPhone, overrides = {}) {
    const rows = await currentTurnRows(userPhone, overrides);
    if (rows.length > DEFAULT_MAX_ARTIFACTS) {
      throw artifactError('too_many_artifacts', `At most ${DEFAULT_MAX_ARTIFACTS} current-turn artifacts can be attached.`);
    }
    const files = [];
    for (const row of rows) {
      const local = await confinedLocalFile(row.local_path);
      files.push({
        artifact_id: `session:${String(row.id)}`,
        path: local.path,
        name: safeArtifactName(row.file_name),
        mime_type: safeArtifactMime(row.mime_type),
        size: local.size,
      });
    }
    return files;
  }

  async function resolveOwnedArtifact(userPhone, artifactId, overrides = {}) {
    const rawId = String(artifactId || '').trim();
    const sessionMatch = rawId.match(SESSION_ARTIFACT_RE);
    if (sessionMatch) {
      const turn = activeTurn(overrides);
      if (!turn.sessionId) throw unavailableArtifact();
      const result = await queryFn(
        `SELECT id, file_name, mime_type, local_path, size_bytes, created_at
           FROM ari_chat_attachments
          WHERE user_phone = $1 AND session_id = $2 AND id = $3
          LIMIT 1`,
        [String(userPhone), String(turn.sessionId), sessionMatch[1]],
      );
      const row = result.rows?.[0];
      if (!row) throw unavailableArtifact();
      return {
        artifactId: `session:${String(row.id)}`,
        fileName: safeArtifactName(row.file_name),
        mimeType: safeArtifactMime(row.mime_type),
        createdAt: row.created_at || null,
        storage: { kind: 'local', path: String(row.local_path || '') },
      };
    }

    const userFileMatch = rawId.match(USER_FILE_ARTIFACT_RE);
    if (userFileMatch) {
      const fileId = Number(userFileMatch[1]);
      const result = await queryFn(
        `SELECT id, file_url, file_name, document_name, mime_type, local_path,
                size_bytes, content_sha256, created_at
           FROM user_files
          WHERE user_phone = ANY($1) AND id = $2
          LIMIT 1`,
        [phoneCandidates(userPhone), fileId],
      );
      const row = result.rows?.[0];
      if (!row) throw unavailableArtifact();
      let storage;
      if (row.local_path) {
        storage = {
          kind: 'local',
          path: String(row.local_path),
          expectedSize: Number(row.size_bytes || 0) || null,
          expectedHash: row.content_sha256 ? String(row.content_sha256).toLowerCase() : null,
        };
      } else {
        let url;
        try {
          url = new URL(String(row.file_url || ''));
        } catch (_) {
          throw artifactError('artifact_unavailable');
        }
        if (!['https:', 'http:'].includes(url.protocol) || !isSafeUrl(url.toString())) {
          // Old `buffer:local` rows deliberately fail honestly; they never
          // contained recoverable persistent bytes.
          throw artifactError('artifact_unavailable');
        }
        storage = {
          kind: 'remote',
          url: url.toString(),
          expectedSize: Number(row.size_bytes || 0) || null,
          expectedHash: row.content_sha256 ? String(row.content_sha256).toLowerCase() : null,
        };
      }
      return {
        artifactId: `user_file:${String(row.id)}`,
        fileName: safeArtifactName(row.file_name || row.document_name),
        mimeType: safeArtifactMime(row.mime_type),
        createdAt: row.created_at || null,
        storage,
      };
    }

    throw unavailableArtifact();
  }

  async function loadOwnedArtifact(userPhone, artifactId, overrides = {}) {
    const artifact = await resolveOwnedArtifact(userPhone, artifactId, overrides);
    let buffer;
    if (artifact.storage.kind === 'local') {
      const local = await confinedLocalFile(artifact.storage.path);
      if (artifact.storage.expectedSize && local.size !== artifact.storage.expectedSize) {
        throw artifactError('artifact_integrity_mismatch');
      }
      buffer = Buffer.from(await readFileFn(local.path));
    } else {
      const response = await httpGet(artifact.storage.url);
      buffer = Buffer.from(response.data);
    }
    if (buffer.length > maxBytes) {
      throw artifactError('artifact_too_large', `The artifact exceeds the ${maxBytes}-byte analysis limit.`);
    }
    if (artifact.storage.expectedSize && buffer.length !== artifact.storage.expectedSize) {
      throw artifactError('artifact_integrity_mismatch');
    }
    if (artifact.storage.expectedHash) {
      const digest = crypto.createHash('sha256').update(buffer).digest('hex');
      if (digest !== artifact.storage.expectedHash) {
        throw artifactError('artifact_integrity_mismatch');
      }
    }
    return {
      artifactId: artifact.artifactId,
      buffer,
      fileName: artifact.fileName,
      mimeType: artifact.mimeType,
      createdAt: artifact.createdAt,
    };
  }

  async function loadOwnedArtifacts(userPhone, artifactIds, overrides = {}) {
    const ids = Array.isArray(artifactIds) ? artifactIds : [];
    if (ids.length === 0 || ids.length > DEFAULT_MAX_ARTIFACTS) {
      throw artifactError(
        'invalid_artifact_count',
        `Choose between 1 and ${DEFAULT_MAX_ARTIFACTS} artifacts.`,
      );
    }
    const loaded = [];
    // Sequential resolution deliberately preserves the caller's requested
    // order and bounds concurrent memory/download pressure.
    for (const artifactId of ids) {
      loaded.push(await loadOwnedArtifact(userPhone, artifactId, overrides));
    }
    return loaded;
  }

  return {
    listCurrentTurnArtifacts,
    toAgentFilesForCurrentTurn,
    resolveOwnedArtifact,
    loadOwnedArtifact,
    loadOwnedArtifacts,
  };
}

module.exports = {
  createFileArtifactService,
  fileArtifactService: createFileArtifactService(),
};
