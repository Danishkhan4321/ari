require('dotenv').config();

// Sentry must initialize before any other module so instrumentation hooks attach.
// Fails open if SENTRY_DSN is not set.
const { initSentry, Sentry, captureException } = require('./utils/sentry');
initSentry();

const { validateEnvironment } = require('./utils/env-check');
validateEnvironment(); // Check env vars before loading anything else

const express = require('express');
const { pool } = require('./config/database');
const webhookRoutes = require('./routes/webhook.routes');
const authRoutes = require('./routes/auth.routes');
const microsoftAuthRoutes = require('./routes/microsoft-auth.routes');
const razorpayRoutes = require('./routes/razorpay.routes');
// Apr 29 2026: removed slackRoutes/gchatRoutes — bot is WhatsApp-only
const reminderJob = require('./jobs/reminder.job');
const taskJob = require('./jobs/task.job');
const calendarReminderJob = require('./jobs/calendar-reminder.job');
const standupJob = require('./jobs/standup.job');
const scheduledEmailJob = require('./jobs/scheduled-email.job');
const focusJob = require('./jobs/focus.job');
const habitJob = require('./jobs/habit.job');
const followUpJob = require('./jobs/follow-up.job');
const sprintJob = require('./jobs/sprint.job');
const incidentJob = require('./jobs/incident.job');
const pollJob = require('./jobs/poll.job');
const anthropicCacheWarmerJob = require('./jobs/anthropic-cache-warmer.job');
const autoLabelJob = require('./jobs/auto-label.job');
const replyTrackerJob = require('./jobs/reply-tracker.job');
// Apr 30 2026 — visaIngestionJob removed; visa profile builder feature
// moved to a separate dedicated bot.
const dailyBriefingJob = require('./jobs/daily-briefing.job');
const leadEnrichmentJob = require('./jobs/lead-enrichment.job');
const realtimeSyncService = require('./services/realtime-sync.service');
const autoUpdateService = require('./services/auto-update.service');
const messagingService = require('./services/messaging.service');
const logger = require('./utils/logger');
const manualMeetingProcessor = require('./services/manual-meetings/processor');

const { applySecurityMiddleware } = require('./middleware/security');

const app = express();
const PORT = process.env.PORT || 3000;
const STARTUP_DB_TIMEOUT_MS = parseInt(process.env.STARTUP_DB_TIMEOUT_MS || '12000', 10);

function shouldSkipBackgroundWork() {
  return process.env.DISABLE_BACKGROUND_JOBS === 'true';
}

function shouldAllowDegradedStartup() {
  return process.env.ALLOW_START_WITHOUT_DB === 'true'
    || process.env.NODE_ENV === 'development'
    || process.env.npm_lifecycle_event === 'dev';
}

async function pingDatabase(timeoutMs = STARTUP_DB_TIMEOUT_MS) {
  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Database connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeoutId.unref?.();
  });

  try {
    return await Promise.race([
      pool.query('SELECT 1'),
      timeoutPromise
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// Security middleware — HTTPS, headers, rate limiting, suspicious traffic detection
applySecurityMiddleware(app);

// Raw desktop meeting audio must be mounted before JSON/body parsers consume it.
app.use('/internal/desktop/meetings', require('./routes/desktop-meetings.routes'));
// Dictation recovery audio is also raw and must be mounted before global parsers.
app.use('/internal/desktop/dictation', require('./routes/desktop-dictation.routes'));

// Body parsing — capture raw body for webhook signature verification
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(express.urlencoded({ extended: false, limit: '10mb' }));

// Static public assets used by web clients.
// Also override Cross-Origin-Resource-Policy (default 'same-origin' from security
// middleware would otherwise block cross-origin embedding in Chromium).
const pathMod = require('path');
app.use('/assets', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  next();
}, express.static(pathMod.join(__dirname, '..', 'assets'), { fallthrough: true }));
// Batch H (May 20 2026): asset 404 cleanup. Previously `fallthrough: false`
// made every missing-file probe (scanner bots hitting /assets/config.json,
// /assets/settings.json, /assets/favicon.png) throw, get caught by the
// global error handler, and surface as 500 in logs. Now we fall through
// and explicitly 404 — clean signal in metrics, no noisy errors.
app.use('/assets', (req, res) => res.status(404).send('Not found'));

// Routes
app.use('/webhook', webhookRoutes);           // WhatsApp
app.use('/webhook/razorpay', razorpayRoutes); // Razorpay payment events
// Apr 29 2026: removed Slack and Google Chat webhook mounts (WhatsApp-only)
app.use('/auth/google', authRoutes);
app.use('/auth/microsoft', microsoftAuthRoutes);

// MCP platform endpoint — Ari's context layer for external AI clients
// (Claude, Cursor, partner agents). Bearer-token scoped per user.
try {
  app.use('/mcp', require('./routes/mcp.routes'));
} catch (e) {
  logger.error(`MCP endpoint failed to mount (continuing without it): ${e.message}`);
}

// Inngest durable execution — registers durable functions + mounts the
// /api/inngest webhook that Inngest cloud calls. No-op when disabled.
try {
  const inngestFunctions = require('./services/inngest-functions.service');
  inngestFunctions.registerAll();
  const { mountIfEnabled: mountInngest } = require('./routes/inngest.routes');
  mountInngest(app, '/api/inngest');
} catch (e) {
  logger.warn(`Inngest setup skipped: ${e.message}`);
}

// Meeting recording redirect — generates fresh presigned URL on each click (never expires)
// Requires share_token for authorization (prevents enumeration by sequential ID)
const { recordingAccessLimiter } = require('./middleware/abuse-protection');

// Short-link redirect for meeting recordings: /r/:slug -> 302 to fresh S3 presigned URL.
// Fresh URL is generated on every click, so short links never expire. Slug is 8 chars
// of [A-Za-z0-9] (unambiguous alphabet, no 0/O/1/l/I). See services/short-link.service.js.
app.get('/r/:slug', recordingAccessLimiter, async (req, res) => {
  try {
    const shortLinkService = require('./services/short-link.service');
    const resolved = await shortLinkService.resolveSlug(req.params.slug);
    if (!resolved) {
      return res.status(404).send('Link not found or expired.');
    }

    const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
    const s3 = new S3Client({ region: AWS_REGION });
    const bucket = resolved.s3Bucket || process.env.AWS_BUCKET_NAME || 'ari-meetings';

    // 1 hour presigned URL — enough time for a user to click-and-watch.
    // On next click we generate another fresh URL.
    const presignedUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: bucket, Key: resolved.s3Key }),
      { expiresIn: 60 * 60 }
    );

    res.redirect(302, presignedUrl);
  } catch (error) {
    logger.error('Short-link redirect error: ' + error.message);
    res.status(500).send('Error generating recording link');
  }
});

app.get('/recording/:id/:token', recordingAccessLimiter, async (req, res) => {
  try {
    const { query } = require('./config/database');
    const { resolveRecordingPlayback } = require('./services/manual-meetings/recording-playback');
    const { escapeHtml, validatePositiveInt, validateToken } = require('./utils/security');

    // Validate route params — reject malformed IDs before hitting the database
    const recordingId = validatePositiveInt(req.params.id);
    const shareToken = validateToken(req.params.token, 6, 128);
    if (!recordingId || !shareToken) {
      return res.status(400).send('Invalid request');
    }

    const result = await query(
      `SELECT id, recording_url, recording_object_key, recording_mime_type,
              title, created_at, duration_seconds
         FROM meeting_recordings WHERE id = $1 AND share_token = $2`,
      [recordingId, shareToken]
    );
    if (!result.rows.length || (!result.rows[0].recording_url && !result.rows[0].recording_object_key)) {
      return res.status(404).send('Recording not found');
    }
    const meeting = result.rows[0];

    const presignedUrl = await resolveRecordingPlayback(meeting);
    if (!presignedUrl) {
      return res.status(500).send('Could not generate download link');
    }

    const title = escapeHtml(meeting.title || 'Meeting Recording');
    const safeUrl = encodeURI(presignedUrl);
    const date = meeting.created_at
      ? new Date(meeting.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
      : '';
    const mins = meeting.duration_seconds ? Math.floor(meeting.duration_seconds / 60) : null;
    const duration = mins ? `${mins} min` : '';

    // Detect MIME type from the recording URL extension
    const recUrl = meeting.recording_object_key || meeting.recording_url || '';
    const recExt = recUrl.split('?')[0].split('.').pop().toLowerCase();
    const mimeMap = { webm: 'video/webm', mp4: 'video/mp4', mkv: 'video/x-matroska', avi: 'video/x-msvideo', mov: 'video/quicktime', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg' };
    const mimeType = meeting.recording_mime_type || mimeMap[recExt] || 'video/webm';
    const isAudioOnly = mimeType.startsWith('audio/');
    const mediaTag = isAudioOnly ? 'audio' : 'video';

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0f0f0f; color: #fff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 20px; }
    .container { width: 100%; max-width: 900px; }
    h1 { font-size: 1.4rem; font-weight: 600; margin-bottom: 6px; }
    .meta { color: #888; font-size: 0.85rem; margin-bottom: 20px; }
    video, audio { width: 100%; border-radius: 10px; background: #000; outline: none; }
    .download { display: inline-block; margin-top: 14px; color: #888; font-size: 0.8rem; text-decoration: none; }
    .download:hover { color: #fff; }
    .error { display: none; color: #ff6b6b; margin-top: 12px; font-size: 0.9rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${title}</h1>
    <div class="meta">${[date, duration].filter(Boolean).join(' \u00b7 ')}</div>
    <${mediaTag} id="player" controls autoplay preload="metadata">
      <source src="${safeUrl}" type="${mimeType}">
      ${!isAudioOnly ? `<source src="${safeUrl}" type="video/mp4">` : ''}
      Your browser does not support this media format.
    </${mediaTag}>
    <div id="playError" class="error"></div>
    <a class="download" href="${safeUrl}" download>\u2b07 Download recording</a>
  </div>
  <script>
    var player = document.getElementById('player');
    player.addEventListener('error', function() {
      var err = player.error;
      var msg = 'Could not play this recording in the browser.';
      if (err && err.code === 4) msg += ' Format may not be supported — try downloading instead.';
      document.getElementById('playError').textContent = msg;
      document.getElementById('playError').style.display = 'block';
    });
  </script>
</body>
</html>`);
  } catch (error) {
    logger.error('Recording redirect error: ' + error.message);
    res.status(500).send('Error generating recording link');
  }
});

// Health check
app.get('/', (req, res) => {
  res.send('Ari Bot is running!');
});

// Detailed health check
app.get('/health', async (req, res) => {
  const uptime = process.uptime();
  const memUsage = process.memoryUsage();

  let dbOk = false;
  try {
    await pingDatabase(Math.min(STARTUP_DB_TIMEOUT_MS, 3000));
    dbOk = true;
  } catch (e) { /* db down */ }

  const status = dbOk ? 'healthy' : 'degraded';

  let contextCacheStats = null;
  try { contextCacheStats = require('./utils/context-cache').getStats(); } catch (e) { /* noop */ }

  let breakerStats = null;
  try { breakerStats = require('./utils/circuit-breakers').getHealth(); } catch (e) { /* noop */ }

  res.status(dbOk ? 200 : 503).json({
    status,
    uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
    memory: {
      rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
      heap: `${Math.round(memUsage.heapUsed / 1024 / 1024)}/${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`
    },
    database: dbOk ? 'connected' : 'disconnected',
    dbPool: {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount
    },
    contextCache: contextCacheStats,
    circuitBreakers: breakerStats,
    node: process.version
  });
});

// Version info endpoint
app.get('/version', (req, res) => {
  res.json(autoUpdateService.getVersionInfo());
});

// ── Debug test endpoints (behind a secret key) ───────────────────────────
// Use these to verify Sentry / circuit breakers / cache are working after deploy.
// Protected by ADMIN_TEST_KEY env var — if not set, the endpoints return 404.
// NOTE: path is /debug/* (not /admin/*) because our suspicious-traffic
// middleware (security.js) auto-404s anything matching /admin to block
// wp-admin/phpmyadmin scanners.
const ADMIN_TEST_KEY = process.env.ADMIN_TEST_KEY;
function requireAdminKey(req, res, next) {
  if (!ADMIN_TEST_KEY) return res.status(404).send('Not found');
  // Constant-time compare — `!==` leaks timing on a long key (impractical
  // but trivial to fix, and the codebase already uses timingSafeEqual on
  // webhooks). Length check first so timingSafeEqual doesn't throw.
  const crypto = require('crypto');
  const provided = req.query.key || req.headers['x-admin-key'] || '';
  let ok = false;
  try {
    if (typeof provided === 'string' && provided.length === ADMIN_TEST_KEY.length) {
      ok = crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(ADMIN_TEST_KEY));
    }
  } catch { /* ok stays false */ }
  if (!ok) return res.status(403).json({ error: 'Invalid admin key' });
  next();
}

// GET /debug/test-error?key=xxx&type=sync|async|message|chain
// Triggers a test error to verify Sentry is receiving events.
app.get('/debug/test-error', requireAdminKey, async (req, res) => {
  const type = req.query.type || 'sync';
  logger.info(`[admin] test-error fired: type=${type}`);

  try {
    if (type === 'sync') {
      throw new Error('Sentry test: synchronous error from /debug/test-error');
    } else if (type === 'async') {
      await new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Sentry test: async rejected promise')), 10)
      );
    } else if (type === 'message') {
      Sentry.captureMessage('Sentry test: informational message', { level: 'info' });
      return res.json({ ok: true, sent: 'message', level: 'info' });
    } else if (type === 'chain') {
      // Demonstrates stack trace + user context + tags
      const { setRequestContext } = require('./utils/sentry');
      setRequestContext('wa_test_user_9999', 'whatsapp', { testScenario: 'chain' });
      const deep = () => { throw new Error('Sentry test: nested stack trace (deep → mid → shallow)'); };
      const mid = () => deep();
      const shallow = () => mid();
      shallow();
    }
    res.json({ ok: true, note: 'Unknown type. Use ?type=sync|async|message|chain' });
  } catch (error) {
    // Capture manually so we can return info in the HTTP response too.
    captureException(error, {
      endpoint: '/debug/test-error',
      type,
      testUser: 'wa_test_user_9999'
    });
    res.json({
      ok: true,
      captured: true,
      errorMessage: error.message,
      note: `Check your Sentry dashboard within ~30 seconds. You should see: "${error.message}"`
    });
  }
});

// GET /debug/breakers?key=xxx&breaker=openai
// Inspect current state of a circuit breaker.
app.get('/debug/breakers', requireAdminKey, (req, res) => {
  const { getHealth } = require('./utils/circuit-breakers');
  res.json(getHealth());
});

// GET /debug/cache?key=xxx
// Inspect context cache stats.
app.get('/debug/cache', requireAdminKey, (req, res) => {
  const { getStats } = require('./utils/context-cache');
  res.json(getStats());
});

// Apr 30 2026 — visa admin endpoints removed (5 routes: /debug/visa/{enroll,unenroll,profile,ingest,stats}).
// Visa profile builder feature moved to a separate dedicated bot.

// GET /debug/test-judge?key=xxx&scenario=good|bad
// Trigger the LLM-as-a-Judge manually to verify it's working.
// scenario=good → sends a well-matched user/bot pair (should score 4-5)
// scenario=bad  → sends a mismatched user/bot pair (should score 1-2)
app.get('/debug/test-judge', requireAdminKey, async (req, res) => {
  const scenario = req.query.scenario || 'good';

  const cases = {
    good: {
      userMessage: 'remind me to call mom at 6pm tomorrow',
      botResponse: "Got it — I'll remind you to call mom tomorrow at 6pm.",
      intent: 'set_reminder'
    },
    bad: {
      userMessage: 'schedule a meeting with John tomorrow at 3pm',
      botResponse: "Reminder set for 3pm tomorrow: 'John'.",
      intent: 'set_reminder'  // wrong — should have been calendar event
    }
  };

  const c = cases[scenario] || cases.good;

  try {
    const judge = require('./services/llm-judge.service');
    const stats = judge.stats();

    if (!stats.enabled) {
      return res.json({
        ok: false,
        reason: 'LLM_JUDGE_ENABLED is not set to true — set it in .env and restart',
        config: stats
      });
    }
    if (!stats.hasApiKey) {
      return res.json({
        ok: false,
        reason: 'GROQ_API_KEY not set in .env',
        config: stats
      });
    }

    // Force-run the judge synchronously for this test (normal path is async).
    const result = await judge.judge({
      userId: 'test-judge-user',
      userMessage: c.userMessage,
      botResponse: c.botResponse,
      intent: c.intent
    });

    res.json({
      ok: true,
      scenario,
      input: c,
      judgeResult: result,
      config: stats
    });
  } catch (error) {
    captureException(error, { endpoint: '/debug/test-judge', scenario });
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Sentry Express error handler — must be registered BEFORE our global handler
// so it captures exceptions thrown from routes before the fallback kicks in.
try {
  if (typeof Sentry.setupExpressErrorHandler === 'function') {
    Sentry.setupExpressErrorHandler(app);
  } else if (Sentry.Handlers && typeof Sentry.Handlers.errorHandler === 'function') {
    app.use(Sentry.Handlers.errorHandler());
  }
} catch (e) {
  logger.warn(`Sentry express handler setup skipped: ${e.message}`);
}

// Global error handler — prevents unhandled route errors from crashing the server
app.use((err, req, res, next) => {
  captureException(err, { path: req.path, method: req.method });
  logger.error(`Unhandled error on ${req.method} ${req.path}: ${err.message}`);
  res.status(500).json({ error: 'Internal server error' });
});

// Catch unhandled rejections and uncaught exceptions
process.on('unhandledRejection', (reason) => {
  captureException(reason instanceof Error ? reason : new Error(String(reason)), { source: 'unhandledRejection' });
  logger.error(`Unhandled Promise Rejection: ${reason instanceof Error ? reason.stack || reason.message : reason}`);
});
process.on('uncaughtException', (err) => {
  captureException(err, { source: 'uncaughtException' });
  logger.error(`Uncaught Exception: ${err.message}\n${err.stack}`);
  // Give time to log + flush Sentry, then exit — the process manager will restart
  setTimeout(async () => {
    try { if (Sentry.close) await Sentry.close(2000); } catch (e) { /* noop */ }
    process.exit(1);
  }, 1000);
});

// Test database connection
async function testDatabaseConnection() {
  try {
    await pingDatabase();
    logger.info('Connected to Supabase PostgreSQL');
    return true;
  } catch (error) {
    logger.error('Database connection failed:', error.message);
    return false;
  }
}

// Start server
let server;

async function startServer() {
  // Test database connection
  const dbConnected = await testDatabaseConnection();
  const degradedStartupAllowed = shouldAllowDegradedStartup();

  if (!dbConnected && !degradedStartupAllowed) {
    logger.error('Cannot start server without database connection');
    process.exit(1);
  }

  if (!dbConnected && degradedStartupAllowed) {
    logger.warn('Starting in degraded mode without database connection because dev startup is enabled.');
  }

  server = app.listen(PORT, async () => {
    logger.info(`Ari server running on port ${PORT}`);

    if (!dbConnected) {
      logger.warn('Database is unavailable. Skipping messaging platform initialization and background jobs. Health endpoint will report degraded.');
      return;
    }

    if (process.env.ARI_DESKTOP_INTERNAL_TOKEN && process.env.ASSEMBLYAI_API_KEY) {
      manualMeetingProcessor.startRecovery().catch((error) =>
        logger.error(`Manual meeting recovery failed: ${error.message}`)
      );
    }

    if (shouldSkipBackgroundWork()) {
      logger.warn('Background messaging, cron jobs, realtime sync, and auto-update checks are disabled for this run.');
      return;
    }

    // Start pg-boss durable job queue — required by any job that uses it.
    // Gracefully handles failure (logs + continues with node-cron fallback).
    try {
      const { startBoss } = require('./config/jobs');
      await startBoss();
    } catch (e) {
      logger.error(`pg-boss failed to start: ${e.message}. Jobs will run via node-cron only.`);
    }

    // Apr 28 2026 — Pre-warm Mem0 so the first user message doesn't pay the
    // ~4-5s pgvector + embedder cold-start cost. Fire-and-forget on purpose:
    // we don't want to block startup, and Mem0's lazy init still works as a
    // safety net if this background warm-up fails for any reason.
    (async () => {
      try {
        const mem0 = require('./services/mem0-memory.service');
        if (typeof mem0.isAvailable === 'function' && mem0.isAvailable()
            && typeof mem0.initialize === 'function') {
          const t0 = Date.now();
          const ok = await mem0.initialize();
          if (ok) {
            logger.info(`[Mem0] Pre-warmed at startup in ${Date.now() - t0}ms`);
          } else {
            logger.warn('[Mem0] Pre-warm returned false — falling back to lazy init at first request');
          }
        }
      } catch (e) {
        logger.warn(`[Mem0] Pre-warm failed: ${e.message} — lazy init will retry on first request`);
      }
    })();

    // Apr 28 2026 — Keep-alive heartbeat to prevent cold-start latency.
    //
    // After ~60s of idle, HTTP keep-alives to Gemini close, Postgres pool
    // connections idle-timeout, and the next user message pays a 7-10s
    // TLS+pool reconnect penalty. We send tiny "ping" calls every 60s to
    // hold these connections open.
    //
    // Cost: ~$0.15/month using Flash-Lite for the LLM ping. Postgres ping
    // is free. We use Flash-Lite (not Flash) specifically because the
    // heartbeat doesn't need quality — it just needs the connection alive.
    //
    // Logging: only logs once per minute summary at debug-level. Errors
    // are swallowed silently (transient API outages should NOT spam logs
    // or break the bot).
    //
    // Lifecycle: setInterval is .unref()'d so the process can exit cleanly
    // on SIGTERM/SIGINT. The bot won't hang on shutdown waiting for ticks.
    if (process.env.HEARTBEAT_ENABLED !== 'false') {
      const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS || '60000', 10);
      const heartbeatStats = { successes: 0, failures: 0, lastReport: Date.now() };
      const heartbeatTimer = setInterval(async () => {
        try {
          const results = await Promise.allSettled([
            // Gemini Flash-Lite ping — cheapest model that still keeps TLS warm
            (async () => {
              const llm = require('./services/llm-provider');
              await llm.chatCompletion({
                model: llm.fastModel(),
                messages: [{ role: 'user', content: 'ping' }],
                max_tokens: 1,
                temperature: 0,
              }, { task: 'heartbeat', timeout: 5000 });
            })(),
            // Postgres ping — free, keeps pool connection alive
            (async () => {
              const { query } = require('./config/database');
              await query('SELECT 1');
            })(),
          ]);
          const ok = results.filter(r => r.status === 'fulfilled').length;
          if (ok === results.length) heartbeatStats.successes++;
          else heartbeatStats.failures++;
          // Log a summary roughly every 5 min so logs aren't spammed
          if (Date.now() - heartbeatStats.lastReport > 5 * 60 * 1000) {
            logger.debug(`[Heartbeat] last 5min: ${heartbeatStats.successes} ok, ${heartbeatStats.failures} fail`);
            heartbeatStats.successes = 0;
            heartbeatStats.failures = 0;
            heartbeatStats.lastReport = Date.now();
          }
        } catch (_) {
          // Never let heartbeat crash the bot. Silent failure is by design.
        }
      }, HEARTBEAT_INTERVAL_MS);
      heartbeatTimer.unref();
      logger.info(`[Heartbeat] started — pinging Gemini + Postgres every ${HEARTBEAT_INTERVAL_MS / 1000}s`);
    }

    // Initialize multi-platform messaging (Discord, Telegram connect here)
    try {
      const webhookController = require('./controllers/webhook.controller');
      const { setRequestContext } = require('./utils/sentry');
      const activePlatforms = await messagingService.initializeAll(async (message) => {
        // Universal message handler for non-WhatsApp platforms
        // (WhatsApp goes through its own webhook route)
        try {
          // Tag Sentry scope with user + platform so any captured error surfaces with context.
          setRequestContext(message.userId, message.platform, {
            textLen: (message.text || '').length,
            hasMedia: !!(message.mediaId || message.attachments)
          });

          // Store channel context for reply routing
          messagingService.setChannelContext(message.userId, message.channelId || message.spaceId);

          // Process through the same engine as WhatsApp
          await webhookController.handlePlatformMessage(message);
        } catch (error) {
          captureException(error, { platform: message.platform, userId: message.userId });
          logger.error(`Platform message error (${message.platform}):`, error.message);
          try {
            await messagingService.send(message.userId, "Sorry, something went wrong. Try again?");
          } catch (e) { /* swallow */ }
        }
      });
      logger.info(`Messaging platforms: ${activePlatforms.join(', ') || 'WhatsApp only'}`);
    } catch (e) {
      logger.error('Failed to initialize messaging platforms:', e.message);
    }

    // Start background jobs
    try {
      reminderJob.start();
      logger.info('Reminder job started');
    } catch (e) {
      logger.error('Failed to start reminder job:', e.message);
    }

    try {
      taskJob.start();
      logger.info('Task job started');
    } catch (e) {
      logger.error('Failed to start task job:', e.message);
    }

    try {
      calendarReminderJob.start();
      logger.info('Calendar reminder job started');
    } catch (e) {
      logger.error('Failed to start calendar reminder job:', e.message);
    }

    try {
      standupJob.start();
      logger.info('Standup job started');
    } catch (e) {
      logger.error('Failed to start standup job:', e.message);
    }

    try {
      scheduledEmailJob.start();
      logger.info('Scheduled email job started');
    } catch (e) {
      logger.error('Failed to start scheduled email job:', e.message);
    }

    try {
      focusJob.start();
      logger.info('Focus job started');
    } catch (e) {
      logger.error('Failed to start focus job:', e.message);
    }

    try {
      habitJob.start();
      logger.info('Habit job started');
    } catch (e) {
      logger.error('Failed to start habit job:', e.message);
    }

    try {
      followUpJob.start();
      logger.info('Follow-up job started');
    } catch (e) {
      logger.error('Failed to start follow-up job:', e.message);
    }

    try {
      sprintJob.start();
      logger.info('Sprint job started');
    } catch (e) {
      logger.error('Failed to start sprint job:', e.message);
    }

    try {
      incidentJob.start();
      logger.info('Incident job started');
    } catch (e) {
      logger.error('Failed to start incident job:', e.message);
    }

    try {
      pollJob.start();
    } catch (e) {
      logger.error('Failed to start poll job:', e.message);
    }

    // Anthropic prompt-cache warmer — only fires if recent traffic, idle-skip
    // saves $$ at low volume. Cuts cache-write premium from ~50% of Anthropic
    // bill down to ~10%. See src/jobs/anthropic-cache-warmer.job.js.
    try {
      anthropicCacheWarmerJob.start();
    } catch (e) {
      logger.error('Failed to start Anthropic cache warmer:', e.message);
    }

    // Email automation jobs (independent of meeting backend)
    try {
      autoLabelJob.start();
      logger.info('Auto-label job started');
    } catch (e) {
      logger.error('Failed to start auto-label job:', e.message);
    }

    try {
      replyTrackerJob.start();
      logger.info('Reply tracker job started');
    } catch (e) {
      logger.error('Failed to start reply tracker job:', e.message);
    }

    // Apr 30 2026 — visa ingestion job removed; visa feature moved to a separate bot.

    // Daily briefing auto-send — tasks/meetings/reminders + top 10 news at user's local 8am
    try {
      dailyBriefingJob.start();
      logger.info('Daily briefing job started');
    } catch (e) {
      logger.error('Failed to start daily briefing job:', e.message);
    }

    try {
      leadEnrichmentJob.start();
    } catch (e) {
      logger.error('Failed to start lead enrichment worker:', e.message);
    }

    // Batch G (May 19 2026) — Daily maintenance: prunes processed_messages
    // older than 25h so the webhook dedup table doesn't grow unbounded.
    try {
      const dailyMaintenanceJob = require('./jobs/daily-maintenance.job');
      dailyMaintenanceJob.start();
      logger.info('Daily maintenance job started');
    } catch (e) {
      logger.error('Failed to start daily maintenance job:', e.message);
    }

    // Batch H (May 20 2026) — Eagerly bootstrap processed_messages so the
    // first prune doesn't hit "relation does not exist". The webhook
    // controller has a lazy-create path for safety, but creating up
    // front gives us a clean dependency surface: daily-maintenance
    // assumes the table exists.
    try {
      const { query: dbq } = require('./config/database');
      await dbq(`CREATE TABLE IF NOT EXISTS processed_messages (
                   message_id VARCHAR(255) PRIMARY KEY,
                   user_phone VARCHAR(50),
                   processed_at TIMESTAMP DEFAULT NOW()
                 )`);
      await dbq(`CREATE INDEX IF NOT EXISTS idx_processed_messages_at
                   ON processed_messages(processed_at DESC)`);
      logger.info('processed_messages table ready');
    } catch (e) {
      logger.warn(`processed_messages bootstrap failed (will lazy-create): ${e.message}`);
    }

    // Ari patch (Phase 3): Weekly user-profile inference.
    // Aggregates each active user's Mem0 entries into a structured profile
    // (preferred_name, work_context, communication_style, key_people, etc.)
    // which the context-builder injects into every turn.
    try {
      const userProfileJob = require('./jobs/user-profile.job');
      userProfileJob.start();
      logger.info('User profile inference job started');
    } catch (e) {
      logger.error('Failed to start user profile job:', e.message);
    }

    // Start real-time sync
    try {
      realtimeSyncService.initialize();
      logger.info('Real-time sync service started');
    } catch (e) {
      logger.error('Failed to start real-time sync:', e.message);
    }

    // Start auto-update check service
    try {
      autoUpdateService.startPeriodicCheck();
      logger.info('Auto-update service started');
    } catch (e) {
      logger.error('Failed to start auto-update service:', e.message);
    }
  });
}

// Graceful shutdown
//
// Apr 29 2026 — fixed pool.end() race condition.
//
// Previous behaviour: server.close() was fire-and-forget, so pool.end()
// could run while HTTP handlers were still doing database work, producing
// "Cannot use a pool after calling end on the pool" errors in production
// logs. pg-boss was also stopped AFTER pool.end(), meaning durable jobs
// already enqueued couldn't finish their final DB writes.
//
// New ordering, top to bottom:
//   1. Stop accepting new connections   (server.close, awaited)
//   2. Stop background work that uses the pool
//        – messaging adapters (any platform timers)
//        – realtime sync subscriptions
//        – pg-boss workers (in-flight job draining)
//   3. Close the pool                   (last DB consumer is gone)
//   4. Flush observability sinks        (Langfuse, Sentry)
//   5. Exit
//
// A 10s force-exit timer guards against any of these hanging.
async function shutdown(signal) {
  logger.info(`${signal} received. Shutting down gracefully...`);

  // Force exit after 10s if graceful shutdown hangs
  const forceTimer = setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10000);
  forceTimer.unref();

  // 1. Stop accepting new HTTP connections and wait for in-flight requests
  //    to finish their handlers (this is what was missing — the await).
  if (server) {
    await new Promise((resolve) => {
      server.close((err) => {
        if (err) {
          logger.error(`HTTP server close error: ${err.message}`);
        } else {
          logger.info('HTTP server closed');
        }
        resolve();
      });
    });
  }

  // 2a. Shutdown messaging platforms (timers, websocket adapters)
  try {
    await messagingService.shutdownAll();
  } catch (e) {
    logger.error('Error shutting down messaging platforms:', e.message);
  }

  // 2a-bis. Stop every node-cron task we ever scheduled. Without this, the
  // 17 jobs' interval timers keep the event loop alive until the 10s force
  // timer kicks in — every PM2 reload took ~10s and occasionally produced
  // half-fired reminders during the wind-down. node-cron v3+ exposes a
  // global registry of tasks; we just iterate and stop.
  try {
    const cron = require('node-cron');
    if (typeof cron.getTasks === 'function') {
      const tasks = cron.getTasks();
      let stopped = 0;
      for (const task of tasks.values()) {
        try { task.stop(); stopped++; } catch (_) { /* noop */ }
      }
      logger.info(`Stopped ${stopped} node-cron task(s) on shutdown`);
    }
  } catch (e) {
    logger.error('Error stopping node-cron tasks:', e.message);
  }

  // 2b. Shutdown real-time sync
  try {
    await realtimeSyncService.shutdown();
  } catch (e) {
    logger.error('Error shutting down realtime sync:', e.message);
  }

  // 2c. Stop pg-boss BEFORE pool.end() — workers are mid-job and need the
  //     pool to checkpoint completion. Stopping after pool.end() leaves
  //     jobs in 'in-progress' state forever.
  try {
    const { stopBoss } = require('./config/jobs');
    await stopBoss();
  } catch (e) {
    logger.error('Error stopping pg-boss:', e.message);
  }

  // 3. Now the pool has no remaining consumers — safe to close.
  try {
    await pool.end();
    logger.info('Database pool closed');
  } catch (e) {
    logger.error('Error closing pool:', e.message);
  }

  // 4a. Flush Langfuse observations so nothing is lost.
  try {
    const llmTrace = require('./utils/llm-trace');
    if (llmTrace.flush) await llmTrace.flush();
  } catch (e) { /* noop */ }

  // 4b. Flush buffered Sentry events before exit (2s timeout so we don't hang).
  try {
    if (Sentry.close) await Sentry.close(2000);
  } catch (e) { /* noop */ }

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

startServer();
