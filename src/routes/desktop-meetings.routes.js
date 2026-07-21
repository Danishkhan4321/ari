'use strict';

const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createDesktopInternalAuth } = require('../utils/desktop-internal-auth');
const { validatePositiveInt } = require('../utils/security');

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const ALLOWED_AUDIO_TYPES = new Set([
  'audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/ogg',
  'video/webm', 'audio/x-caf', 'application/octet-stream',
]);

function createByteLimitTransform(maxBytes) {
  let received = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) {
        const error = new Error('Meeting recording exceeds the upload limit');
        error.code = 'UPLOAD_TOO_LARGE';
        return callback(error);
      }
      return callback(null, chunk);
    },
  });
}

function safeCaptureSession(value) {
  const id = String(value || '').trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,199}$/.test(id) ? id : null;
}

function safeTitle(value) {
  const title = String(value || 'Untitled Meeting').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return title.slice(0, 500) || 'Untitled Meeting';
}

function contentType(req) {
  return String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim().toLowerCase();
}

function sendRouteError(res, error) {
  const status = error?.code === 'MEETING_NOT_FOUND' ? 404
    : error?.code === 'UPLOAD_TOO_LARGE' ? 413
      : error?.code === 'MEETING_STATE_CONFLICT' ? 409 : 500;
  const message = status === 404 ? 'Meeting not found.'
    : status === 413 ? 'Meeting recording is too large.'
      : status === 409 ? 'Meeting state changed; refresh and try again.'
        : 'The meeting request could not be completed.';
  return res.status(status).json({ ok: false, error: message });
}

function createDesktopMeetingsRouter({
  token = process.env.ARI_DESKTOP_INTERNAL_TOKEN,
  repo,
  processor,
  storage,
  tempRoot = path.join(os.tmpdir(), 'ari-manual-meetings'),
  maxBytes = Number(process.env.MANUAL_MEETING_MAX_UPLOAD_BYTES) || DEFAULT_MAX_BYTES,
  logger = console,
} = {}) {
  if (!repo || !processor || !storage) throw new TypeError('repo, processor, and storage are required');
  const router = express.Router();
  router.use(createDesktopInternalAuth({ token }));

  router.post('/', async (req, res) => {
    const captureSessionId = safeCaptureSession(req.get('x-ari-capture-session'));
    if (!captureSessionId) return res.status(400).json({ ok: false, error: 'A valid capture session is required.' });
    const declaredLength = Number(req.get('content-length') || 0);
    if (declaredLength > maxBytes) return res.status(413).json({ ok: false, error: 'Meeting recording is too large.' });
    const mimeType = contentType(req);
    if (!ALLOWED_AUDIO_TYPES.has(mimeType)) {
      return res.status(415).json({ ok: false, error: 'Unsupported meeting recording format.' });
    }

    await fs.promises.mkdir(tempRoot, { recursive: true });
    const uploadPath = path.join(tempRoot, `${crypto.randomUUID()}.upload`);
    try {
      await pipeline(req, createByteLimitTransform(maxBytes), fs.createWriteStream(uploadPath, { flags: 'wx' }));
      const meeting = await repo.createFromCapture({
        captureSessionId,
        userPhone: req.ariUserPhone,
        title: safeTitle(req.get('x-ari-meeting-title')),
        capturePlatform: safeTitle(req.get('x-ari-capture-platform') || process.platform).slice(0, 40),
        captureCodec: safeTitle(req.get('x-ari-capture-codec') || mimeType).slice(0, 160),
      });
      if (typeof processor.ingest === 'function') {
        const retained = await processor.ingest({
          meetingId: meeting.id,
          userPhone: req.ariUserPhone,
          localPath: uploadPath,
          mimeType,
        });
        await fs.promises.rm(uploadPath, { force: true }).catch(() => {});
        processor.resume({ meetingId: meeting.id, userPhone: req.ariUserPhone })
          .catch((error) => logger.error(`Manual meeting ${meeting.id} failed: ${error.message}`));
        return res.status(202).json({ ok: true, meetingId: meeting.id, processingStage: retained.processing_stage });
      }
      processor.process({ meetingId: meeting.id, userPhone: req.ariUserPhone, localPath: uploadPath, mimeType })
        .catch((error) => logger.error(`Manual meeting ${meeting.id} failed: ${error.message}`))
        .finally(() => fs.promises.rm(uploadPath, { force: true }).catch(() => {}));
      return res.status(202).json({ ok: true, meetingId: meeting.id, processingStage: meeting.processing_stage || 'captured' });
    } catch (error) {
      await fs.promises.rm(uploadPath, { force: true }).catch(() => {});
      return sendRouteError(res, error);
    }
  });

  router.get('/:id/status', async (req, res) => {
    const meetingId = validatePositiveInt(req.params.id);
    if (!meetingId) return res.status(400).json({ ok: false, error: 'Invalid meeting ID.' });
    try {
      const meeting = await repo.getOwned(meetingId, req.ariUserPhone);
      if (!meeting) return res.status(404).json({ ok: false, error: 'Meeting not found.' });
      return res.json({ ok: true, meeting });
    } catch (error) { return sendRouteError(res, error); }
  });

  router.post('/:id/retry', async (req, res) => {
    const meetingId = validatePositiveInt(req.params.id);
    if (!meetingId) return res.status(400).json({ ok: false, error: 'Invalid meeting ID.' });
    try {
      const meeting = await repo.getOwned(meetingId, req.ariUserPhone);
      if (!meeting) return res.status(404).json({ ok: false, error: 'Meeting not found.' });
      processor.retry({ meetingId, userPhone: req.ariUserPhone })
        .catch((error) => logger.error(`Manual meeting retry ${meetingId} failed: ${error.message}`));
      return res.status(202).json({ ok: true, meetingId, processingStage: meeting.processing_stage });
    } catch (error) { return sendRouteError(res, error); }
  });

  router.patch('/:id/speakers/:speakerId', express.json({ limit: '4kb' }), async (req, res) => {
    const meetingId = validatePositiveInt(req.params.id);
    if (!meetingId) return res.status(400).json({ ok: false, error: 'Invalid meeting ID.' });
    try {
      const meeting = await repo.renameSpeaker({ meetingId, userPhone: req.ariUserPhone, speakerId: req.params.speakerId, name: req.body?.name });
      return res.json({ ok: true, meeting });
    } catch (error) {
      if (error instanceof TypeError) return res.status(400).json({ ok: false, error: error.message });
      return sendRouteError(res, error);
    }
  });

  router.get('/:id/recording', async (req, res) => {
    const meetingId = validatePositiveInt(req.params.id);
    if (!meetingId) return res.status(400).json({ ok: false, error: 'Invalid meeting ID.' });
    try {
      const meeting = await repo.getOwned(meetingId, req.ariUserPhone);
      if (!meeting || !meeting.recording_object_key) return res.status(404).json({ ok: false, error: 'Recording not found.' });
      const storageClient = typeof storage === 'function' ? storage() : storage;
      const url = await storageClient.signRead(meeting.recording_object_key, 900);
      return res.json({ ok: true, url, expiresInSeconds: 900, mimeType: meeting.recording_mime_type });
    } catch (error) { return sendRouteError(res, error); }
  });

  return router;
}

function createDefaultRouter() {
  const { pool, query } = require('../config/database');
  const { createMeetingRepository } = require('../services/manual-meetings/meeting-repository');
  const meetingProcessor = require('../services/manual-meetings/processor');
  const { createRecordingStorage } = require('../services/manual-meetings/recording-storage');
  return createDesktopMeetingsRouter({
    repo: createMeetingRepository({ query, connect: () => pool.connect() }),
    processor: meetingProcessor,
    storage: () => createRecordingStorage(),
    logger: require('../utils/logger'),
  });
}

module.exports = createDefaultRouter();
module.exports.createDesktopMeetingsRouter = createDesktopMeetingsRouter;
module.exports.createByteLimitTransform = createByteLimitTransform;
module.exports.safeCaptureSession = safeCaptureSession;
