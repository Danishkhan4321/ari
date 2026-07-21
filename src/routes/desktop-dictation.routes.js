'use strict';

const express = require('express');
const { createDesktopInternalAuth } = require('../utils/desktop-internal-auth');
const { createAssemblyAIDictation } = require('../services/assemblyai-dictation.service');
const { createDictationPolisher, normalizeCategory } = require('../services/dictation-polish.service');

const MAX_RECOVERY_BYTES = 50 * 1024 * 1024;

function publicError(error) {
  if (error instanceof TypeError || error instanceof RangeError) return { status: 400, message: error.message };
  if (/ASSEMBLYAI_API_KEY/.test(error?.message || '')) return { status: 503, message: 'Voice dictation is not configured.' };
  if (error?.safeCode === 'TRANSCRIPTION_TIMEOUT') return { status: 504, message: 'Voice transcription timed out. Try again.' };
  return { status: 502, message: 'Voice dictation is temporarily unavailable.' };
}

function createDesktopDictationRouter({
  token = process.env.ARI_DESKTOP_INTERNAL_TOKEN,
  assembly,
  polisher = createDictationPolisher(),
} = {}) {
  const router = express.Router();
  router.use(createDesktopInternalAuth({ token }));

  function assemblyClient() {
    return assembly || createAssemblyAIDictation();
  }

  router.post('/session', async (_req, res) => {
    try {
      return res.json({ ok: true, ...(await assemblyClient().createStreamingSession()) });
    } catch (error) {
      const safe = publicError(error);
      return res.status(safe.status).json({ ok: false, error: safe.message });
    }
  });

  router.post('/polish', express.json({ limit: '64kb' }), async (req, res) => {
    try {
      const result = await polisher.polish({
        rawText: req.body?.rawText,
        appCategory: req.body?.appCategory,
        languageCodes: req.body?.languageCodes,
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      const safe = publicError(error);
      return res.status(safe.status).json({ ok: false, error: safe.message });
    }
  });

  router.post('/retry', express.raw({ type: () => true, limit: MAX_RECOVERY_BYTES }), async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw new TypeError('Recovery audio is required');
      const raw = await assemblyClient().transcribeRecording(req.body);
      if (!raw.text) throw new Error('AssemblyAI returned an empty recovery transcript');
      const polished = await polisher.polish({
        rawText: raw.text,
        appCategory: normalizeCategory(req.get('x-ari-app-category')),
        languageCodes: raw.languageCodes,
      });
      return res.json({ ok: true, rawText: raw.text, ...polished });
    } catch (error) {
      const safe = publicError(error);
      return res.status(safe.status).json({ ok: false, error: safe.message });
    }
  });

  router.use((error, _req, res, next) => {
    if (error?.type === 'entity.too.large' || error?.status === 413) {
      return res.status(413).json({ ok: false, error: 'Recovery audio exceeds the dictation limit.' });
    }
    return next(error);
  });

  return router;
}

function createDefaultRouter() {
  return createDesktopDictationRouter();
}

module.exports = createDefaultRouter();
module.exports.MAX_RECOVERY_BYTES = MAX_RECOVERY_BYTES;
module.exports.createDesktopDictationRouter = createDesktopDictationRouter;
module.exports.publicError = publicError;
