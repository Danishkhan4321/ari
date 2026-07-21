const express = require('express');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const router = express.Router();
const webhookController = require('../controllers/webhook.controller');
const aiService = require('../services/ai.service');
const gmailService = require('../services/gmail.service');
const emailTrackingService = require('../services/email-tracking.service');
const { query } = require('../config/database');
const logger = require('../utils/logger');
const { isAllowedInternalAddress } = require('../utils/internal-api-auth');
const { sanitizeFilename, sanitizeInput, validateMimeType } = require('../utils/security');
const chatSubmissionService = require('../services/chat-submission.service');
const { UUID_PATTERN } = require('../services/chat-submission.service');
const { runWithChatSession } = require('../services/chat-session-context');
const googleAuthService = require('../services/google-auth.service');

const DASHBOARD_ATTACHMENT_ROOT = path.resolve(os.tmpdir(), 'ari-desktop-attachments');
const MAX_DASHBOARD_ATTACHMENTS = 5;
const MAX_DASHBOARD_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const dashboardRuns = new Map();

function reserveDashboardRun(runKey, run) {
  if (dashboardRuns.has(runKey)) return false;
  dashboardRuns.set(runKey, run);
  return true;
}

function releaseDashboardRun(runKey, runId) {
  if (dashboardRuns.get(runKey)?.runId !== runId) return false;
  dashboardRuns.delete(runKey);
  return true;
}

class DashboardAttachmentBatchError extends Error {
  constructor({ cause, index, total, attachment, completedResults }) {
    const completed = Array.isArray(completedResults) ? completedResults : [];
    const failedAttachment = String(attachment?.filename || attachment?.fileName || `attachment ${index + 1}`);
    const partial = completed.length > 0;
    super(partial
      ? `Saved ${completed.length} of ${total} attachments before ${failedAttachment} failed`
      : `Could not save ${failedAttachment}`);
    this.name = 'DashboardAttachmentBatchError';
    this.code = partial ? 'attachment_batch_partial' : 'attachment_batch_failed';
    this.status = partial ? 'partial' : 'failed';
    this.completedAttachments = completed.length;
    this.totalAttachments = total;
    this.failedAttachment = failedAttachment;
    this.completedResults = completed;
    this.causeCode = cause?.code || 'document_ingestion_failed';
    if (cause) this.cause = cause;
  }
}

function isDashboardAttachmentBatchError(error) {
  return error?.name === 'DashboardAttachmentBatchError'
    && (error?.status === 'failed' || error?.status === 'partial');
}

function dashboardSubmissionStatusForError(error, cancelled) {
  // A completed save is an externally visible effect, so partial truth wins
  // even if Stop races the later failure.
  if (error?.status === 'partial') return 'partial';
  if (cancelled) return 'cancelled';
  return 'failed';
}

function dashboardAttachmentFailureMessage(error) {
  const completed = Number(error?.completedAttachments) || 0;
  const total = Number(error?.totalAttachments) || 1;
  const failedAttachment = String(error?.failedAttachment || 'one of the documents');
  if (completed > 0) {
    return `I saved ${completed} of ${total} documents, but couldn't save ${failedAttachment}. I did not run your instruction, so no email or other follow-up action was attempted. The ${completed === 1 ? 'saved document remains' : 'saved documents remain'} available.`;
  }
  return `I couldn't save ${failedAttachment}. I did not run your instruction, so no email or other follow-up action was attempted. Please check the file and try again.`;
}

async function surfaceDashboardAttachmentFailure({
  error,
  userId,
  text,
  attachmentCount,
  saveMessage = (phone, role, content) => aiService.saveMessage(phone, role, content),
}) {
  const instruction = sanitizeInput(String(text || '').trim(), 5000).trim()
    || `Review the attached ${attachmentCount === 1 ? 'document' : 'documents'}.`;
  const errorText = dashboardAttachmentFailureMessage(error);
  // The caption never entered the controller, so persist the failed exchange
  // here. This replaces the dashboard's optimistic message and makes the
  // terminal error visible through the normal message poller.
  await saveMessage(userId, 'user', instruction);
  await saveMessage(userId, 'assistant', errorText);
  return {
    status: dashboardSubmissionStatusForError(error, false),
    error: errorText,
  };
}

async function readDashboardAttachments(attachments) {
  if (attachments === undefined) return [];
  if (!Array.isArray(attachments) || attachments.length > MAX_DASHBOARD_ATTACHMENTS) {
    throw new Error('invalid attachments');
  }

  return Promise.all(attachments.map(async (attachment) => {
    if (!attachment || typeof attachment !== 'object' || typeof attachment.localPath !== 'string') {
      throw new Error('invalid attachment');
    }
    const localPath = path.resolve(attachment.localPath);
    const relativePath = path.relative(DASHBOARD_ATTACHMENT_ROOT, localPath);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new Error('invalid attachment path');
    }
    const stats = await fs.stat(localPath);
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_DASHBOARD_ATTACHMENT_BYTES) {
      throw new Error('invalid attachment size');
    }
    try {
      const buffer = await fs.readFile(localPath);
      return {
        id: `desktop_file_${crypto.randomUUID()}`,
        filename: sanitizeFilename(String(attachment.fileName || 'document')),
        mime_type: validateMimeType(String(attachment.mimeType || 'application/octet-stream')) || 'application/octet-stream',
        buffer,
      };
    } finally {
      // The dashboard only stages uploads long enough to hand them to the
      // local bot. Delete the temporary source regardless of processing.
      await fs.unlink(localPath).catch(() => {});
    }
  }));
}

async function processDashboardAttachmentBatch({
  attachments,
  text,
  userId,
  runId,
  clientMessageId,
  signal,
  isCancelled = () => false,
  controller = webhookController,
}) {
  const batch = Array.isArray(attachments) ? attachments : [];
  const completedResults = [];
  for (let index = 0; index < batch.length; index += 1) {
    if (isCancelled()) return;
    let result;
    try {
      result = await controller.handlePlatformMessage({
        userId,
        text: '',
        type: 'document',
        platform: 'whatsapp',
        source: 'dashboard',
        runId,
        messageId: `${clientMessageId}:attachment:${index}`,
        name: null,
        signal,
        documentSaveOnly: true,
        documentBatchId: clientMessageId,
        document: { ...batch[index], caption: '' },
      });
      if (!result || result.status !== 'success') {
        const ingestionError = new Error(`Document ingestion did not confirm ${batch[index]?.filename || 'the attachment'} was saved`);
        ingestionError.code = 'document_ingestion_unconfirmed';
        throw ingestionError;
      }
    } catch (cause) {
      throw new DashboardAttachmentBatchError({
        cause,
        index,
        total: batch.length,
        attachment: batch[index],
        completedResults,
      });
    }
    completedResults.push(result);
  }
  if (isCancelled()) return;
  const instruction = String(text || '').trim()
    || `Review the attached ${batch.length === 1 ? 'document' : 'documents'}.`;
  await controller.handlePlatformMessage({
    userId,
    text: instruction,
    type: 'text',
    platform: 'whatsapp',
    source: 'dashboard',
    runId,
    messageId: clientMessageId,
    name: null,
    signal,
  });
  return { status: 'completed', attachments: completedResults };
}

/**
 * Verify Meta's X-Hub-Signature-256 header (HMAC-SHA256 of raw body using app secret).
 * If META_APP_SECRET is not set, log a warning and allow (dev mode).
 * If it IS set and signature doesn't match, reject with 401.
 */
function verifyMetaSignature(req, res, next) {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) {
    logger.warn('META_APP_SECRET not set — skipping WhatsApp webhook signature verification (dev mode)');
    return next();
  }

  const signature = req.headers['x-hub-signature-256'];
  if (!signature) {
    logger.security('webhook_missing_signature', {
      platform: 'whatsapp',
      ip: req.ip,
      userAgent: req.get('user-agent') || ''
    });
    return res.status(401).json({ error: 'Missing signature' });
  }

  const rawBody = req.rawBody;
  if (!rawBody) {
    logger.warn('WhatsApp webhook: raw body not available for signature verification');
    return res.status(401).json({ error: 'Cannot verify signature' });
  }

  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');

  try {
    const isValid = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    if (!isValid) {
      logger.security('webhook_invalid_signature', {
        platform: 'whatsapp',
        ip: req.ip,
        userAgent: req.get('user-agent') || ''
      });
      return res.status(401).json({ error: 'Invalid signature' });
    }
  } catch {
    logger.security('webhook_signature_error', {
      platform: 'whatsapp',
      ip: req.ip
    });
    return res.status(401).json({ error: 'Invalid signature' });
  }

  next();
}

// Webhook verification (GET)
router.get('/', (req, res) => webhookController.verifyWebhook(req, res));

// Webhook messages (POST) — verify Meta signature before processing
router.post('/', verifyMetaSignature, (req, res) => webhookController.handleMessage(req, res));

// ─── Internal: dashboard chat bridge ────────────────────────────────────
// The web dashboard POSTs here when a user types a message on the chat
// page. Authenticated by INTERNAL_API_SECRET (same value lives in the
// dashboard's env). The dashboard validated the user's session before
// making this call, so we trust user_phone in the body.
//
// We then pipe the message through the same handler the multi-platform
// adapters use (handlePlatformMessage) — same intent detection, same
// reply via WhatsApp adapter, same conversation_history writes — so the
// dashboard chat and WhatsApp chat share one conversation log.
function verifyInternalSecret(req, res, next) {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    return res.status(503).json({ error: 'Internal API not enabled (INTERNAL_API_SECRET unset).' });
  }

  // Loopback-only enforcement (default: on in production). Threat model:
  // the secret lives in .env on the same EC2 box as the dashboard, so a
  // proper deployment never needs to accept this endpoint from a non-local
  // IP. If the box is ever fronted by nginx with X-Forwarded-For, set
  // INTERNAL_API_TRUST_PROXY=1 and we'll honor the proxy hop chain. Set
  // INTERNAL_API_ALLOW_PUBLIC=1 to disable entirely (not recommended).
  const rawIp = req.ip || req.connection?.remoteAddress || '';
  const allowedAddress = isAllowedInternalAddress(rawIp, {
    allowPrivate: process.env.INTERNAL_API_ALLOW_PRIVATE === '1',
    allowPublic: process.env.INTERNAL_API_ALLOW_PUBLIC === '1',
  });
  if (!allowedAddress) {
      logger.security('internal_api_remote_attempt', { ip: rawIp, path: req.path });
      return res.status(403).json({ error: 'Internal API restricted to trusted networks.' });
  }

  const provided = req.headers['x-internal-secret'];
  if (!provided || typeof provided !== 'string') {
    return res.status(401).json({ error: 'Missing x-internal-secret.' });
  }
  try {
    const ok = provided.length === secret.length
      && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
    if (!ok) return res.status(401).json({ error: 'Bad secret.' });
  } catch {
    return res.status(401).json({ error: 'Bad secret.' });
  }
  next();
}

router.post('/internal/dashboard-google-status', verifyInternalSecret, async (req, res) => {
  const userPhone = req.body?.user_phone;
  if (!userPhone || typeof userPhone !== 'string') {
    return res.status(400).json({ error: 'user_phone required' });
  }
  try {
    const status = googleAuthService.useComposio()
      ? await googleAuthService.getGoogleConnectionStatus(userPhone)
      : { connected: await googleAuthService.isConnected(userPhone), allConnected: false, products: {} };
    const connected = status.connected;
    const email = connected ? await googleAuthService.getGoogleEmail(userPhone) : null;
    return res.json({ ...status, email });
  } catch (error) {
    logger.error('Dashboard Google status failed:', error.message);
    return res.status(502).json({ error: 'Could not check Google connection.' });
  }
});

router.post('/internal/dashboard-google-connect', verifyInternalSecret, async (req, res) => {
  const userPhone = req.body?.user_phone;
  const product = req.body?.product || 'all';
  const destination = req.body?.destination;
  if (!userPhone || typeof userPhone !== 'string') {
    return res.status(400).json({ error: 'user_phone required' });
  }
  if (!['all', 'gmail', 'calendar', 'drive', 'docs', 'sheets', 'slides', 'tasks'].includes(product)) {
    return res.status(400).json({ error: 'invalid Google product' });
  }
  if (destination !== undefined && !['dashboard', 'desktop'].includes(destination)) {
    return res.status(400).json({ error: 'invalid connection destination' });
  }
  if (destination && !googleAuthService.useComposio()) {
    return res.status(503).json({ error: 'Composio connection is not configured.' });
  }
  try {
    const url = product === 'all'
      ? await googleAuthService.generateAuthUrl(userPhone, [], { destination })
      : await googleAuthService.generateProductAuthUrl(userPhone, product, [], { destination });
    return res.json({ url });
  } catch (error) {
    logger.error('Dashboard Google connect failed:', error.message);
    return res.status(502).json({ error: 'Could not start Google connection.' });
  }
});

router.post('/internal/dashboard-message', verifyInternalSecret, async (req, res) => {
  let reservation = null;
  try {
    const {
      user_phone,
      text,
      attachments,
      run_id: requestedRunId,
      session_id: sessionId,
      client_message_id: clientMessageId,
    } = req.body || {};
    if (!user_phone || typeof user_phone !== 'string') {
      return res.status(400).json({ error: 'user_phone required' });
    }
    if (text !== undefined && typeof text !== 'string') {
      return res.status(400).json({ error: 'invalid text' });
    }
    if (requestedRunId !== undefined && (typeof requestedRunId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestedRunId))) {
      return res.status(400).json({ error: 'invalid run' });
    }
    if (!UUID_PATTERN.test(String(sessionId || '')) || !UUID_PATTERN.test(String(clientMessageId || ''))) {
      return res.status(400).json({ error: 'valid session_id and client_message_id required' });
    }
    let dashboardAttachments;
    try {
      dashboardAttachments = await readDashboardAttachments(attachments);
    } catch {
      return res.status(400).json({ error: 'invalid attachment' });
    }
    if ((!text || !text.trim()) && dashboardAttachments.length === 0) {
      return res.status(400).json({ error: 'text or attachment required' });
    }
    const runId = requestedRunId || `dash_${crypto.randomUUID()}`;
    const userId = user_phone.replace(/\D/g, '');
    const runKey = `${userId}:${sessionId}`;
    const abortController = new AbortController();
    if (!reserveDashboardRun(runKey, {
      runId, cancelled: false, startedAt: Date.now(), abortController,
    })) {
      return res.status(409).json({ error: 'A run is already active for this chat session.' });
    }
    reservation = { runKey, runId };
    require('../services/run-registry.service').register(runId, {
      abortController, userId, sessionId, runKey,
    });
    const claim = await chatSubmissionService.claim({
      userPhone: user_phone,
      sessionId,
      clientMessageId,
      runId,
    });
    if (!claim.ok) {
      releaseDashboardRun(runKey, runId);
      reservation = null;
      return res.status(claim.reason === 'not_found' ? 404 : 400).json({ error: 'invalid chat session' });
    }
    if (!claim.claimed) {
      releaseDashboardRun(runKey, runId);
      reservation = null;
      return res.json({ ok: true, queued: false, duplicate: true });
    }
    // Persist the accepted instruction before starting background work. This
    // keeps its context available even when the user immediately Steers and
    // cancellation reaches the worker before the controller's normal history
    // write. The later controller save is idempotent by client message UUID.
    await runWithChatSession({
      userPhone: user_phone,
      sessionId,
      clientMessageId,
      runId,
      signal: abortController.signal,
    }, () => aiService.saveMessage(userId, 'user', String(text || '').trim()));

    // Synthetic WhatsApp-shaped message. handlePlatformMessage saves the
    // assistant reply to conversation_history; the dashboard polls that table.
    //
    // Source tag `dashboard` lets downstream code (specifically the
    // WhatsApp send path) decide NOT to also push the reply to the
    // user's phone — until May 19 2026, typing in the dashboard chat
    // produced an unwanted WhatsApp ping for every reply. The bot
    // adapter checks message.source and skips the outbound send when
    // it's 'dashboard'.
    // Flip the per-user dashboard-mode flag so the reply path (which calls
    // messagingService.send) suppresses the outbound WhatsApp ping. The
    // flag self-clears after 60s via TTL.
    try {
      const messagingService = require('../services/messaging.service');
      messagingService.setDashboardMode(userId);
    } catch (e) {
      logger.warn(`[Dashboard] could not set dashboard mode: ${e.message}`);
    }

    // Fire-and-forget: don't make the dashboard wait for full LLM round-trip.
    // The polling endpoint will surface the reply as soon as it's saved.
    setImmediate(() => runWithChatSession({
      userPhone: user_phone,
      sessionId,
      clientMessageId,
      runId,
      signal: abortController.signal,
    }, async () => {
      let finalStatus = 'completed';
      try {
        const isCancelled = () => dashboardRuns.get(runKey)?.runId === runId && dashboardRuns.get(runKey)?.cancelled;
        if (isCancelled()) return;
        if (dashboardAttachments.length > 0) {
          await processDashboardAttachmentBatch({
            attachments: dashboardAttachments,
            text,
            userId,
            runId,
            clientMessageId,
            signal: abortController.signal,
            isCancelled,
          });
          return;
        }
        if (isCancelled()) return;
        await webhookController.handlePlatformMessage({
          userId,
          text: String(text).trim(),
          type: 'text',
          platform: 'whatsapp',
          source: 'dashboard',
          runId,
          messageId: clientMessageId,
          name: null,
          signal: abortController.signal,
        });
      } catch (err) {
        finalStatus = dashboardSubmissionStatusForError(err, abortController.signal.aborted);
        if (isDashboardAttachmentBatchError(err)) {
          try {
            await surfaceDashboardAttachmentFailure({
              error: err,
              userId,
              text,
              attachmentCount: dashboardAttachments.length,
            });
          } catch (surfaceError) {
            logger.error(`[Dashboard] could not persist attachment failure for ${userId}: ${surfaceError.message}`);
          }
        }
        logger.error(`[Dashboard] processing failed for ${userId}: ${err.message}`);
      } finally {
        if (abortController.signal.aborted && finalStatus !== 'partial') finalStatus = 'cancelled';
        await chatSubmissionService.markStatus({ userPhone: user_phone, sessionId, clientMessageId, status: finalStatus }).catch(() => {});
        // The agent controller owns the run ledger because it can distinguish
        // a clean pre-tool cancellation from Stop racing an in-flight CRM
        // mutation (partial/unknown). Do not overwrite that richer terminal
        // status merely because the dashboard submission itself was stopped.
        //
        // TERMINAL SIGNAL OF LAST RESORT: the live UI stops its spinner on a
        // terminal event, and _runAgenticTurn only emits one when the turn
        // actually reaches the agent loop. Attachment-only turns, deterministic
        // short-circuits, and early returns never get there — leaving the
        // dashboard spinning forever (observed: a 73-minute spinner on a turn
        // the server had finished 76 minutes earlier). This block always runs,
        // so publish here; the client treats terminal events idempotently.
        try {
          require('../services/run-event-bus.service').publish(userId, {
            runId,
            type: 'run.finished',
            step: null,
            toolName: null,
            summary: finalStatus,
            payload: { status: finalStatus, source: 'submission' },
          });
        } catch (_) { /* best effort */ }
        try {
          const messagingService = require('../services/messaging.service');
          messagingService.clearDashboardMode(userId);
        } catch (_) { /* best effort */ }
        require('../services/run-registry.service').unregister(runId);
        releaseDashboardRun(runKey, runId);
      }
    }));
    reservation = null;
    res.json({ ok: true, queued: true });
  } catch (error) {
    if (reservation) releaseDashboardRun(reservation.runKey, reservation.runId);
    logger.error('Dashboard message route error:', error.message);
    res.status(500).json({ error: 'internal error' });
  }
});

// ─── Internal: live run-event stream (SSE over the in-process bus) ───────
// The dashboard proxies this to the browser. Unlike the polled
// agent_run_events feed, this pushes status lines and assistant text deltas
// the instant they happen — no Postgres round-trip, no 1s poll lag.
router.get('/internal/run-events', verifyInternalSecret, (req, res) => {
  const userPhone = String(req.query.user_phone || '').replace(/\D/g, '');
  if (!userPhone) return res.status(400).json({ error: 'user_phone required' });
  const afterSeq = Number.parseInt(String(req.headers['last-event-id'] || req.query.after || '0'), 10) || 0;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  const bus = require('../services/run-event-bus.service');
  const unsubscribe = bus.subscribe(userPhone, {
    afterSeq,
    onEvent: (entry) => {
      try {
        res.write(`id: ${entry.seq}\nevent: run\ndata: ${JSON.stringify(entry)}\n\n`);
      } catch (_) { /* client went away; close handler cleans up */ }
    },
  });
  const heartbeat = setInterval(() => {
    try { res.write(': keep-alive\n\n'); } catch (_) {}
  }, 15000);
  heartbeat.unref?.();
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

router.post('/internal/dashboard-cancel', verifyInternalSecret, (req, res) => {
  const userId = String(req.body?.user_phone || '').replace(/\D/g, '');
  const runId = req.body?.run_id;
  const sessionId = String(req.body?.session_id || '');
  if (!userId || !UUID_PATTERN.test(sessionId) || typeof runId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(runId)) {
    return res.status(400).json({ error: 'invalid cancellation request' });
  }
  // The runId-keyed registry is the cancellation authority: either it finds
  // THE run (scoped to this user + session) and aborts it, or the stop is
  // honestly reported as not_found — the run may have finished, belong to
  // another session, or never have existed.
  const runRegistry = require('../services/run-registry.service');
  const aborted = runRegistry.abort(runId, {
    userId,
    sessionId,
    reason: Object.assign(new Error('Dashboard run cancelled by the user.'), {
      code: 'agent_cancelled',
    }),
  });
  const active = dashboardRuns.get(`${userId}:${sessionId}`);
  if (active?.runId === runId) active.cancelled = true;
  if (!aborted.stopped) {
    return res.json({ ok: false, stopped: false, code: aborted.code || 'not_found' });
  }
  // Stop means "nothing further should happen": a pended destructive action
  // from this run must not stay armed where a later "yes" could fire it.
  try {
    require('../services/confirmation-gate.service').clear(userId);
  } catch (error) {
    logger.warn('dashboard-cancel: could not clear confirmation gate:', error.message);
  }
  try {
    webhookController.clearAllPendingState?.(userId);
  } catch (error) {
    logger.warn('dashboard-cancel: could not clear pending state:', error.message);
  }
  return res.json({ ok: true, stopped: true });
});

// ─── Internal: dashboard bulk email send (campaigns) ────────────────────
router.post('/internal/dashboard-contact-enrich', verifyInternalSecret, async (req, res) => {
  try {
    const profile = req.body?.profile;
    if (!profile || typeof profile !== 'object' || typeof profile.name !== 'string' || !profile.name.trim()) {
      return res.status(400).json({ ok: false, error: 'A contact name is required.' });
    }
    const contactEnrichment = require('../services/contact-enrichment.service');
    const result = await contactEnrichment.enrichContact(profile);
    if (!result.ok) {
      return res.status(result.error.includes('configured') ? 503 : 422).json(result);
    }
    return res.json(result);
  } catch (error) {
    logger.error(`Dashboard contact enrichment failed: ${error.message}`);
    return res.status(500).json({ ok: false, error: 'Contact enrichment is temporarily unavailable.' });
  }
});

router.post('/internal/dashboard-team-broadcast', verifyInternalSecret, async (req, res) => {
  try {
    const { admin_phone, team_name, message_text, members } = req.body || {};
    if (typeof admin_phone !== 'string' || !admin_phone.trim()) {
      return res.status(400).json({ ok: false, error: 'admin_phone required' });
    }
    if (typeof team_name !== 'string' || !team_name.trim()) {
      return res.status(400).json({ ok: false, error: 'team_name required' });
    }
    if (typeof message_text !== 'string' || !message_text.trim() || message_text.length > 4000) {
      return res.status(400).json({ ok: false, error: 'A valid message is required.' });
    }
    if (!Array.isArray(members) || members.length === 0 || members.length > 1000) {
      return res.status(400).json({ ok: false, error: 'Valid team members are required.' });
    }

    const teamCommsService = require('../services/team-comms.service');
    const result = await teamCommsService.sendBroadcast({
      adminPhone: admin_phone.replace(/\D/g, ''),
      teamName: team_name.trim().toLowerCase(),
      messageText: message_text.trim(),
      members,
    });
    return res.json(result);
  } catch (error) {
    logger.error(`Dashboard team broadcast failed: ${error.message}`);
    return res.status(500).json({ ok: false, error: 'The broadcast could not be completed.' });
  }
});

router.post('/internal/dashboard-notify', verifyInternalSecret, async (req, res) => {
  try {
    const recipient = String(req.body?.recipient || '').replace(/\D/g, '');
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    const templateParams = Array.isArray(req.body?.template_params)
      ? req.body.template_params.map(value => String(value).slice(0, 500)).slice(0, 2)
      : [];
    if (!/^\d{8,15}$/.test(recipient) || !text || text.length > 4000) {
      return res.status(400).json({ ok: false, error: 'A valid recipient and message are required.' });
    }

    const { sendWithTemplateFallback } = require('../utils/whatsapp-24h');
    const TEMPLATES = require('../config/whatsapp-templates');
    await sendWithTemplateFallback(recipient, text, TEMPLATES.TASK_REMINDER, templateParams);
    return res.json({ ok: true, delivered: true });
  } catch (error) {
    logger.warn(`Dashboard notification delivery failed (${error?.name || 'error'})`);
    return res.status(502).json({ ok: false, error: 'The notification could not be delivered.' });
  }
});

// The dashboard's "Send campaign" flow POSTs personalized per-recipient
// drafts here. We send each as an individual 1:1 email through the user's
// connected Gmail (tokens already encrypted in google_tokens), inject an
// open-tracking pixel, and record one email_sends row per recipient so the
// campaign analytics reflect real sends/opens. Mirrors the WhatsApp bulk
// path's leak guard + 100ms throttle. Auth: verifyInternalSecret
// (INTERNAL_API_SECRET + loopback-only), same as the chat bridge above.
//
// Body: { user_phone, campaign_id?, drafts:[{to,subject,body}], scheduled_for?, track? }
// Returns: { sent, failed, failedRecipients, aborted } — the shape the
// dashboard send route consumes.

// Treat these gmail.service error strings as systemic (token/quota/auth/429):
// re-sending into them is pure waste, so the loop aborts the remainder.
function isSystemicSendError(err) {
  return /not connected|connect google|invalid_grant|unauthor|quota|rate.?limit|suspend|token|\b429\b/i.test(String(err || ''));
}
// Guard against an accidental duplicate dispatch of the same campaign_id
// (double-click / retry) re-entering the background send loop and double-sending.
const inFlightCampaigns = new Set();
// Basic email shape; also rejects whitespace/CRLF that could inject MIME headers.
function isValidEmail(addr) {
  return typeof addr === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr);
}
// Whole-token mention so a short email isn't a substring false-positive inside
// a longer one (an@x.com inside ryan@x.com). body + email are pre-lowercased.
function bodyMentionsEmail(body, email) {
  const esc = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^a-z0-9._%+\\-])' + esc + '($|[^a-z0-9.\\-])', 'i').test(body);
}

router.post('/internal/dashboard-bulk-send', verifyInternalSecret, async (req, res) => {
  try {
    const { user_phone, campaign_id, drafts, scheduled_for, track } = req.body || {};
    if (!user_phone || typeof user_phone !== 'string') {
      return res.status(400).json({ error: 'user_phone required' });
    }
    if (!Array.isArray(drafts) || drafts.length === 0) {
      return res.status(400).json({ error: 'drafts required' });
    }

    // Scheduled dashboard campaigns are not wired yet: the scheduled-email
    // cron stores a single prebuilt html_body, so per-recipient tracking +
    // personalization there needs separate work. Reject clearly rather than
    // 200-and-silently-drop (no regression — this path 404'd before).
    if (scheduled_for) {
      return res.status(501).json({ error: 'scheduled dashboard send is not supported yet — use "Send now"' });
    }

    const trackOpens = track !== false; // default on

    // Leak guard runs synchronously BEFORE we accept: a tripwire here aborts
    // the whole campaign so nothing is sent.
    const allEmails = drafts.map(d => String((d && d.to) || '').toLowerCase()).filter(Boolean);
    for (const d of drafts) {
      const mine = String((d && d.to) || '').toLowerCase();
      const body = String((d && d.body) || '').toLowerCase();
      const leaked = allEmails.find(e => e !== mine && bodyMentionsEmail(body, e));
      if (leaked) {
        logger.error('[DashboardBulkSend] leak guard tripped — aborted, nothing sent.');
        return res.status(400).json({
          error: "leak guard tripped — a draft contains another recipient's email",
        });
      }
    }

    if (trackOpens && !emailTrackingService.trackingBaseUrl()) {
      logger.warn('[DashboardBulkSend] track requested but DASHBOARD_BASE_URL is unset — opens will not be recorded.');
    }

    // Accept now, send in the background: the loop can take minutes for a large
    // campaign, so detaching it from the request removes the per-request
    // recipient cap and any fetch-timeout race. The bot finalizes the campaign
    // row itself; the dashboard reads live sent/opens/clicks from the campaign +
    // email_sends. (A durable queue that survives a bot restart is a follow-up.)
    res.status(202).json({ ok: true, accepted: drafts.length, async: true });
    setImmediate(() => {
      runDashboardBulkSend({ userPhone: user_phone, campaignId: campaign_id, drafts, trackOpens })
        .catch(err => logger.error(`[DashboardBulkSend] unhandled background error: ${err.message}`));
    });
  } catch (error) {
    logger.error('dashboard-bulk-send route error:', error.message);
    if (!res.headersSent) res.status(500).json({ error: 'internal error' });
  }
});

// ─── Internal: Gmail history lookup ─────────────────────────────────────
// Used by the dashboard "Sync Gmail history" buttons (single lead + whole
// group). Looks up sent mail for each address, optionally persists the newest
// message into sales_emails_log and bumps sales_leads.last_contacted_at.
router.post('/internal/gmail-history-lookup', verifyInternalSecret, async (req, res) => {
  try {
    const userPhone = String(req.body?.user_phone || '').replace(/\D/g, '');
    const emails = Array.isArray(req.body?.emails)
      ? [...new Set(req.body.emails.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))].slice(0, 200)
      : [];
    const persist = req.body?.persist === true;
    if (!userPhone || emails.length === 0) {
      return res.status(400).json({ ok: false, error: 'user_phone and emails required' });
    }

    const googleAuthService = require('../services/google-auth.service');
    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) {
      return res.status(409).json({ ok: false, error: 'Google is not connected for this user' });
    }
    const { google } = require('googleapis');
    const gmail = google.gmail({ version: 'v1', auth: authClient });

    let persisted = 0;
    const results = {};
    for (const email of emails) {
      try {
        const list = await gmail.users.messages.list({
          userId: 'me',
          q: `to:${email} in:sent`,
          maxResults: 5,
        });
        const messages = list.data.messages || [];
        if (messages.length === 0) { results[email] = { sent: 0 }; continue; }
        const meta = await gmail.users.messages.get({
          userId: 'me',
          id: messages[0].id,
          format: 'metadata',
          metadataHeaders: ['Subject', 'Date'],
        });
        const headers = meta.data.payload?.headers || [];
        const latestSubject = headers.find((h) => h.name === 'Subject')?.value || null;
        const dateHeader = headers.find((h) => h.name === 'Date')?.value;
        const latestDate = dateHeader
          ? new Date(dateHeader)
          : (meta.data.internalDate ? new Date(Number(meta.data.internalDate)) : null);
        results[email] = { sent: messages.length, latestSubject, latestAt: latestDate ? latestDate.toISOString() : null };

        if (persist) {
          const lead = await query(
            `SELECT id FROM sales_leads WHERE user_phone = $1 AND LOWER(email) = $2 ORDER BY id DESC LIMIT 1`,
            [userPhone, email]
          );
          const leadId = lead.rows[0]?.id;
          if (leadId) {
            const existing = await query(
              `SELECT 1 FROM sales_emails_log WHERE user_phone = $1 AND gmail_message_id = $2 LIMIT 1`,
              [userPhone, messages[0].id]
            );
            if (existing.rows.length === 0) {
              await query(
                `INSERT INTO sales_emails_log (user_phone, lead_id, email_type, subject, gmail_message_id, sent_at)
                 VALUES ($1, $2, 'gmail_history', $3, $4, $5)`,
                [userPhone, leadId, latestSubject, messages[0].id, latestDate || new Date()]
              );
              persisted++;
            }
            if (latestDate) {
              await query(
                `UPDATE sales_leads
                    SET last_contacted_at = GREATEST(COALESCE(last_contacted_at, 'epoch'::timestamp), $2)
                  WHERE id = $1`,
                [leadId, latestDate]
              ).catch((e) => logger.warn(`[GmailHistory] last_contacted_at bump failed: ${e.message}`));
            }
          }
        }
      } catch (lookupError) {
        results[email] = { error: String(lookupError.message || 'lookup failed').slice(0, 160) };
      }
    }
    return res.json({ ok: true, persisted, results });
  } catch (error) {
    logger.error('gmail-history-lookup route error:', error.message);
    return res.status(500).json({ ok: false, error: 'internal error' });
  }
});

// ─── Internal: AI bulk-email draft ──────────────────────────────────────
// Used by the composer's "Write with AI". Returns a template with
// {first_name}/{name}/{company} placeholders that the composer compiles per
// recipient. Uses the configured LLM provider (Gemini via Vertex).
router.post('/internal/ai-email-draft', verifyInternalSecret, async (req, res) => {
  try {
    const purpose = String(req.body?.purpose || '').trim().slice(0, 1200);
    if (purpose.length < 3) return res.status(400).json({ ok: false, error: 'purpose required' });
    const tone = String(req.body?.tone || 'professional').trim().slice(0, 60);
    const groupName = String(req.body?.group_name || '').trim().slice(0, 120);
    const senderName = String(req.body?.sender_name || '').trim().slice(0, 120);
    const sample = req.body?.sample_member && typeof req.body.sample_member === 'object'
      ? { name: String(req.body.sample_member.name || ''), company: String(req.body.sample_member.company || '') }
      : null;

    const llm = require('../services/llm-provider');
    const response = await llm.chatCompletion({
      messages: [
        {
          role: 'system',
          content: `You draft ONE reusable email template for a bulk campaign. Output ONLY valid JSON: {"subject":"...","body":"..."}.
Rules:
- Use the placeholders {first_name}, {name}, {company} where personalization belongs; they are compiled per recipient later.
- Plain text body only (no HTML). Short paragraphs. No spam phrases.
- Tone: ${tone}.
- Sign off ${senderName ? `as "${senderName}"` : 'with a neutral signature placeholder'}.`,
        },
        {
          role: 'user',
          content: `Purpose: ${purpose}${groupName ? `\nAudience: the "${groupName}" contact group` : ''}${sample?.name ? `\nExample recipient: ${sample.name}${sample.company ? ` at ${sample.company}` : ''}` : ''}`,
        },
      ],
      temperature: 0.4,
      max_tokens: 700,
    }, { task: 'email_draft', timeout: 40000 });

    const content = response?.data?.choices?.[0]?.message?.content || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(502).json({ ok: false, error: 'model returned no draft' });
    let parsed;
    try { parsed = JSON.parse(jsonMatch[0]); } catch {
      return res.status(502).json({ ok: false, error: 'model returned invalid JSON' });
    }
    const subject = String(parsed.subject || '').trim().slice(0, 300);
    const body = String(parsed.body || '').trim().slice(0, 8000);
    if (!subject || !body) return res.status(502).json({ ok: false, error: 'draft missing subject or body' });
    return res.json({ ok: true, subject, body });
  } catch (error) {
    logger.error('ai-email-draft route error:', error.message);
    return res.status(500).json({ ok: false, error: 'internal error' });
  }
});

// ─── Internal: AI project plan (sprint planner) ─────────────────────────
// Used by the dashboard "Plan with AI" sprint modal. Preview-only: returns a
// structured plan; the dashboard writes the sprint when the admin accepts.
router.post('/internal/ai-project-plan', verifyInternalSecret, async (req, res) => {
  try {
    const goal = String(req.body?.goal || '').trim().slice(0, 1500);
    if (!goal) return res.status(400).json({ ok: false, error: 'goal required' });
    const weeks = Math.max(1, Math.min(26, Number(req.body?.weeks) || 6));
    const members = (Array.isArray(req.body?.members) ? req.body.members : [])
      .map((m) => ({ name: String(m?.name || '').trim(), phone: String(m?.phone || '').trim() }))
      .filter((m) => m.name)
      .slice(0, 30);
    if (members.length === 0) return res.status(400).json({ ok: false, error: 'members required' });

    const llm = require('../services/llm-provider');
    const response = await llm.chatCompletion({
      messages: [
        {
          role: 'system',
          content: `You are a pragmatic project planner. Break the goal into a sprint plan. Output ONLY valid JSON:
{"plan_name":"...","summary":"...","items":[{"title":"...","description":"...","story_points":1,"assigned_to_name":"...","week_offset":0}]}
Rules:
- 8 to 30 items, each concrete and completable.
- story_points: 1, 2, 3, 5, or 8.
- week_offset: 0-based week the item starts, less than ${weeks}.
- assigned_to_name MUST be one of the given member names, spreading work sensibly.
- summary: 2-3 sentences.`,
        },
        {
          role: 'user',
          content: `Goal: ${goal}\nTimeline: ${weeks} weeks\nTeam members: ${members.map((m) => m.name).join(', ')}`,
        },
      ],
      temperature: 0.4,
      max_tokens: 2200,
    }, { task: 'agent_primary', timeout: 40000 });

    const content = response?.data?.choices?.[0]?.message?.content || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(502).json({ ok: false, error: 'model returned no plan' });
    let parsed;
    try { parsed = JSON.parse(jsonMatch[0]); } catch {
      return res.status(502).json({ ok: false, error: 'model returned invalid JSON' });
    }
    const nameToPhone = new Map(members.map((m) => [m.name.toLowerCase(), m.phone || null]));
    const items = (Array.isArray(parsed.items) ? parsed.items : [])
      .map((item) => {
        const assignedName = String(item?.assigned_to_name || '').trim();
        const points = Number(item?.story_points);
        return {
          title: String(item?.title || '').trim().slice(0, 200),
          description: item?.description ? String(item.description).trim().slice(0, 600) : null,
          story_points: [1, 2, 3, 5, 8].includes(points) ? points : 2,
          assigned_to_name: assignedName || members[0].name,
          assigned_to_phone: nameToPhone.get(assignedName.toLowerCase()) ?? null,
          week_offset: Math.max(0, Math.min(weeks - 1, Number(item?.week_offset) || 0)),
        };
      })
      .filter((item) => item.title)
      .slice(0, 30);
    if (items.length === 0) return res.status(502).json({ ok: false, error: 'plan had no usable items' });
    return res.json({
      ok: true,
      plan_name: String(parsed.plan_name || goal).trim().slice(0, 120),
      summary: String(parsed.summary || '').trim().slice(0, 600),
      weeks,
      items,
    });
  } catch (error) {
    logger.error('ai-project-plan route error:', error.message);
    return res.status(500).json({ ok: false, error: 'internal error' });
  }
});

// ─── Internal: team welcome messages ────────────────────────────────────
// Used by the dashboard bulk-invite flow. Best-effort WhatsApp welcome to
// each newly added member; the caller treats failures as non-fatal.
router.post('/internal/team-welcome', verifyInternalSecret, async (req, res) => {
  try {
    const adminPhone = String(req.body?.admin_phone || '').replace(/\D/g, '');
    const adminName = String(req.body?.admin_name || 'your team admin').trim().slice(0, 120);
    const teamName = String(req.body?.team_name || '').trim().slice(0, 120);
    const newMembers = (Array.isArray(req.body?.new_members) ? req.body.new_members : [])
      .map((m) => ({ phone: String(m?.phone || '').replace(/\D/g, ''), name: String(m?.name || '').trim() }))
      .filter((m) => m.phone)
      .slice(0, 100);
    if (!adminPhone || !teamName || newMembers.length === 0) {
      return res.status(400).json({ ok: false, error: 'admin_phone, team_name and new_members required' });
    }

    const messagingService = require('../services/messaging.service');
    let welcomed = 0;
    let failed = 0;
    for (const member of newMembers) {
      try {
        await messagingService.send(
          member.phone,
          `Hi${member.name ? ` ${member.name}` : ''}! ${adminName} added you to the *${teamName}* team on Ari. ` +
          `You'll get task assignments, reminders, and standup check-ins here. Reply anytime to talk to Ari.`
        );
        welcomed++;
      } catch (sendError) {
        failed++;
        logger.warn(`[TeamWelcome] send to ${member.phone.slice(-4)} failed: ${sendError.message}`);
      }
    }
    return res.json({ ok: true, welcomed, failed });
  } catch (error) {
    logger.error('team-welcome route error:', error.message);
    return res.status(500).json({ ok: false, error: 'internal error' });
  }
});

// Background processor for a dashboard campaign. Sends each draft as an
// individual 1:1 email with an open pixel + click-tracked links, records an
// email_sends row per recipient (campaign analytics), logs each lead send to
// sales_emails_log WITH the gmail message id (so it shows on the lead-profile
// timeline with an "Open in Gmail" link) + bumps last_contacted_at, then
// finalizes the bulk_email_campaigns row. Runs detached from the HTTP request.
async function runDashboardBulkSend({ userPhone, campaignId, drafts, trackOpens }) {
  // Idempotency: never run the same campaign twice concurrently.
  if (campaignId != null) {
    if (inFlightCampaigns.has(campaignId)) {
      logger.warn(`[DashboardBulkSend] campaign ${campaignId} already in flight — skipping duplicate dispatch.`);
      return;
    }
    inFlightCampaigns.add(campaignId);
  }

  let sent = 0;
  const failedRecipients = [];
  let consecutiveFailures = 0;
  let aborted = false;
  let lastError = null;

  try {
    for (let i = 0; i < drafts.length; i++) {
      const draft = drafts[i] || {};
      const to = String(draft.to || '').trim();
      // Skip malformed addresses outright (also blocks To: header injection).
      if (!isValidEmail(to)) { failedRecipients.push(to); continue; }

      // Light throttle so spam filters don't see a bursty firehose.
      if (i > 0) await new Promise(r => setTimeout(r, 100));

      // Always mint a token (the row needs one); only rewrite links + inject
      // the pixel when tracking is on, so sent/failed counts record either way.
      const token = emailTrackingService.generateToken();
      let html = gmailService.bodyToHtml(String(draft.body || ''));
      if (trackOpens) {
        html = emailTrackingService.rewriteClickLinks(html, token);
        html = emailTrackingService.injectOpenPixel(html, token);
      }

      let status = 'sent';
      let sendError = null;
      let messageId = null;
      let breakerHint = '';
      try {
        const result = await gmailService.sendEmail(userPhone, {
          to,
          subject: String(draft.subject || ''),
          htmlBody: html,
        });
        if (result && result.success) {
          sent++;
          messageId = result.messageId || null;
          consecutiveFailures = 0;
        } else {
          status = 'failed';
          sendError = (result && result.error) || 'send returned success=false';
          // `reason`/`code` carry the real Gmail error (quota/429/etc) that
          // sendEmail otherwise masks behind a generic message.
          breakerHint = `${(result && result.reason) || ''} ${(result && result.code) || ''} ${sendError}`;
          lastError = sendError;
          failedRecipients.push(to);
          consecutiveFailures++;
        }
      } catch (err) {
        status = 'failed';
        sendError = err.message || String(err);
        breakerHint = sendError;
        lastError = sendError;
        failedRecipients.push(to);
        consecutiveFailures++;
      }

      await emailTrackingService.recordSend({
        userPhone,
        campaignId,
        recipientEmail: to,
        subject: draft.subject,
        gmailMessageId: messageId,
        token,
        status,
        error: sendError,
      });

      // Log the send against the lead so it appears on the profile timeline
      // with an "Open in Gmail" deep-link. The dashboard passes member_kind/
      // member_id; the bot is the only side that holds the gmail message id.
      if (status === 'sent' && draft.member_kind === 'lead' && Number(draft.member_id) > 0) {
        try {
          await query(
            `INSERT INTO sales_emails_log (user_phone, lead_id, email_type, subject, gmail_message_id)
             VALUES ($1, $2, 'bulk_dashboard', $3, $4)`,
            [userPhone, Number(draft.member_id), String(draft.subject || ''), messageId]
          );
          await query(
            `UPDATE sales_leads SET last_contacted_at = NOW() WHERE id = $1 AND user_phone = $2`,
            [Number(draft.member_id), userPhone]
          );
        } catch (e) {
          logger.warn(`[DashboardBulkSend] lead-log failed for ${to}: ${e.message}`);
        }
      }

      // Circuit breaker: a systemic failure (revoked token, quota, 429, auth)
      // or a run of consecutive failures means every further send is wasted —
      // abort the remainder instead of hammering Gmail N times into a wall.
      if (status === 'failed' && (isSystemicSendError(breakerHint) || consecutiveFailures >= 5)) {
        aborted = true;
        for (let j = i + 1; j < drafts.length; j++) {
          const rest = String((drafts[j] || {}).to || '');
          if (rest) failedRecipients.push(rest);
        }
        logger.error(`[DashboardBulkSend] aborted after failure on ${to}: ${sendError}. Sent=${sent}.`);
        break;
      }
    }
  } catch (err) {
    logger.error(`[DashboardBulkSend] background loop crashed: ${err.message}`);
  } finally {
    // Finalize the campaign row (the bot owns this now — the request already
    // 202'd) and release the in-flight lock. Best-effort; the analytics list
    // also derives opens/clicks live from email_sends. "failed" (the bot tried,
    // everything bounced) is distinct from the dashboard's "cancelled" (never
    // reached the bot).
    if (campaignId != null) {
      const failed = failedRecipients.length;
      const finalStatus = sent === 0 ? 'failed' : (failed === 0 ? 'completed' : 'partial');
      const errText = sent === 0 ? String(lastError || 'all sends failed').slice(0, 300) : null;
      try {
        await query(
          `UPDATE bulk_email_campaigns
              SET sent_count = $1, failed_count = $2, status = $3, error = $4, completed_at = NOW()
            WHERE id = $5 AND user_phone = $6`,
          [sent, failed, finalStatus, errText, Number(campaignId), userPhone]
        );
      } catch (e) {
        logger.warn(`[DashboardBulkSend] campaign finalize failed (id=${campaignId}): ${e.message}`);
      }
      inFlightCampaigns.delete(campaignId);
    }
    logger.info(`[DashboardBulkSend] done: sent=${sent}, failed=${failedRecipients.length}, aborted=${aborted}, campaign=${campaignId}`);
  }
}

module.exports = router;
module.exports._internals = {
  DashboardAttachmentBatchError,
  dashboardAttachmentFailureMessage,
  dashboardRuns,
  dashboardSubmissionStatusForError,
  isDashboardAttachmentBatchError,
  processDashboardAttachmentBatch,
  readDashboardAttachments,
  reserveDashboardRun,
  releaseDashboardRun,
  // Exported so a chat-started campaign uses the SAME sender as the dashboard
  // (per-recipient tracking rows, leak guard, throttle, campaign finalize)
  // instead of growing a second, divergent send path.
  runDashboardBulkSend,
  surfaceDashboardAttachmentFailure,
};
