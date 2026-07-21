/**
 * Abuse Protection — per-feature rate limiting, bot detection,
 * AI call budgets, and brute-force protection.
 *
 * Works alongside the existing security.js middleware (IP rate limiting + headers).
 * This module adds FEATURE-LEVEL limits (AI calls, OAuth, search, media, etc.)
 */
const logger = require('../utils/logger');
const BoundedMap = require('../utils/bounded-map');

// ── Rate Limit Buckets ──────────────────────────────────────────────────────
// Each bucket: BoundedMap<key, { windowStart, count }>
// Key is usually userPhone or IP depending on context.

const BUCKETS = {
  // Per-user AI API calls (intent + chat + translation = 3-4 per message)
  aiCalls:       new BoundedMap(50000, 5 * 60 * 1000),
  // Per-user web search / external API
  webSearch:     new BoundedMap(50000, 5 * 60 * 1000),
  // Per-user media processing (image analysis, audio transcription, documents)
  mediaProcess:  new BoundedMap(50000, 5 * 60 * 1000),
  // Per-IP OAuth callback attempts
  oauthCallback: new BoundedMap(10000, 60 * 60 * 1000), // 1h TTL
  // Per-user account link code attempts (brute-force protection)
  linkCode:      new BoundedMap(10000, 60 * 60 * 1000), // 1h TTL
  // Per-IP recording endpoint access
  recordingAccess: new BoundedMap(10000, 5 * 60 * 1000),
  // Per-user message burst (tighter than existing 30/min — detect rapid-fire bots)
  messageBurst:  new BoundedMap(50000, 60 * 1000),
  // Per-IP new user creation
  newUser:       new BoundedMap(10000, 60 * 60 * 1000) // 1h TTL
};

// ── Configurable limits ──────────────────────────────────────────────────────
const LIMITS = {
  // AI calls: max per user per minute
  aiCalls:          { max: parseInt(process.env.LIMIT_AI_CALLS || '40', 10),         windowMs: 60 * 1000 },
  // Web search: max per user per minute
  webSearch:        { max: parseInt(process.env.LIMIT_WEB_SEARCH || '5', 10),        windowMs: 60 * 1000 },
  // Media processing: max per user per minute (images, audio, docs)
  mediaProcess:     { max: parseInt(process.env.LIMIT_MEDIA_PROCESS || '8', 10),     windowMs: 60 * 1000 },
  // OAuth callbacks: max per IP per hour
  oauthCallback:    { max: parseInt(process.env.LIMIT_OAUTH_CALLBACK || '10', 10),   windowMs: 60 * 60 * 1000 },
  // Link code attempts: max per user per hour
  linkCode:         { max: parseInt(process.env.LIMIT_LINK_CODE || '5', 10),         windowMs: 60 * 60 * 1000 },
  // Recording page access: max per IP per minute
  recordingAccess:  { max: parseInt(process.env.LIMIT_RECORDING_ACCESS || '15', 10), windowMs: 60 * 1000 },
  // Message burst: max messages in 10 seconds (bot detection)
  messageBurst:     { max: parseInt(process.env.LIMIT_MSG_BURST || '5', 10),         windowMs: 10 * 1000 },
  // New user creation: max per IP per hour
  newUser:          { max: parseInt(process.env.LIMIT_NEW_USER || '10', 10),         windowMs: 60 * 60 * 1000 }
};

// ── Core rate check function ─────────────────────────────────────────────────
/**
 * Check if a key has exceeded its limit in a given bucket.
 * Returns { limited: boolean, count: number, retryAfterMs: number }
 */
function checkLimit(bucketName, key) {
  const bucket = BUCKETS[bucketName];
  const limit = LIMITS[bucketName];
  if (!bucket || !limit) return { limited: false, count: 0, retryAfterMs: 0 };

  const now = Date.now();
  let entry = bucket.get(key);

  if (!entry || (now - entry.windowStart) >= limit.windowMs) {
    bucket.set(key, { windowStart: now, count: 1 });
    return { limited: false, count: 1, retryAfterMs: 0 };
  }

  entry.count++;

  if (entry.count > limit.max) {
    const retryAfterMs = limit.windowMs - (now - entry.windowStart);
    return { limited: true, count: entry.count, retryAfterMs };
  }

  return { limited: false, count: entry.count, retryAfterMs: 0 };
}

// ── Public API for services to call ──────────────────────────────────────────

/**
 * Check if a user has exhausted their AI call budget.
 * Call this BEFORE every OpenAI/Groq API call.
 * Returns true if the call should be blocked.
 */
function isAiCallLimited(userPhone) {
  const result = checkLimit('aiCalls', userPhone);
  if (result.limited) {
    logger.security('ai_call_rate_limited', {
      userPhone,
      count: result.count,
      limit: LIMITS.aiCalls.max,
      window: `${LIMITS.aiCalls.windowMs / 1000}s`
    });
  }
  return result.limited;
}

/**
 * Check if a user has exhausted their web search budget.
 * Returns true if search should be blocked.
 */
function isWebSearchLimited(userPhone) {
  const result = checkLimit('webSearch', userPhone);
  if (result.limited) {
    logger.security('web_search_rate_limited', {
      userPhone,
      count: result.count,
      limit: LIMITS.webSearch.max
    });
  }
  return result.limited;
}

/**
 * Check if a user has exhausted their media processing budget.
 * Returns true if processing should be blocked.
 */
function isMediaProcessLimited(userPhone) {
  const result = checkLimit('mediaProcess', userPhone);
  if (result.limited) {
    logger.security('media_process_rate_limited', {
      userPhone,
      count: result.count,
      limit: LIMITS.mediaProcess.max
    });
  }
  return result.limited;
}

/**
 * Check if a user is sending messages in a bot-like burst.
 * 5 messages in 10 seconds = likely automated.
 * Returns true if burst detected.
 */
function isMessageBurst(userPhone) {
  const result = checkLimit('messageBurst', userPhone);
  if (result.limited) {
    logger.security('message_burst_detected', {
      userPhone,
      count: result.count,
      window: '10s',
      reason: 'Possible bot or automated script'
    });
  }
  return result.limited;
}

/**
 * Check if link code attempts are exceeded (brute-force protection).
 * Returns true if blocked.
 */
function isLinkCodeLimited(userIdOrPhone) {
  const result = checkLimit('linkCode', userIdOrPhone);
  if (result.limited) {
    logger.security('link_code_brute_force', {
      userId: userIdOrPhone,
      count: result.count,
      limit: LIMITS.linkCode.max,
      window: '1h'
    });
  }
  return result.limited;
}

/**
 * Check if new user creation from an IP is exceeded.
 * Returns true if blocked.
 */
function isNewUserLimited(ip) {
  const result = checkLimit('newUser', ip || 'unknown');
  if (result.limited) {
    logger.security('new_user_rate_limited', {
      ip,
      count: result.count,
      limit: LIMITS.newUser.max,
      window: '1h'
    });
  }
  return result.limited;
}

// ── Express middleware for route-level protection ─────────────────────────────

/**
 * Rate limit OAuth callback endpoints (per IP).
 * Prevents automated callback spam.
 */
function oauthCallbackLimiter(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const result = checkLimit('oauthCallback', ip);

  if (result.limited) {
    logger.security('oauth_callback_rate_limited', {
      ip,
      path: req.path,
      count: result.count,
      limit: LIMITS.oauthCallback.max
    });
    return res.status(429).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:50px">
        <h2>Too Many Attempts</h2>
        <p>Please wait before trying again.</p>
      </body></html>
    `);
  }
  next();
}

/**
 * Rate limit recording page access (per IP).
 * Prevents token enumeration / scraping.
 */
function recordingAccessLimiter(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const result = checkLimit('recordingAccess', ip);

  if (result.limited) {
    logger.security('recording_access_rate_limited', {
      ip,
      count: result.count,
      limit: LIMITS.recordingAccess.max
    });
    return res.status(429).send('Too many requests. Please try again later.');
  }
  next();
}

// ── Bot detection heuristics ─────────────────────────────────────────────────

// Track user message timing patterns
const userTimingMap = new BoundedMap(50000, 10 * 60 * 1000); // 10min TTL

/**
 * Analyze message timing to detect bots.
 * Real humans have variable inter-message delays.
 * Bots send at constant intervals.
 * Returns { isBot: boolean, confidence: number, reason: string }
 */
function detectBotBehavior(userPhone) {
  const now = Date.now();
  let timing = userTimingMap.get(userPhone);

  if (!timing) {
    userTimingMap.set(userPhone, { timestamps: [now], flagCount: 0 });
    return { isBot: false, confidence: 0, reason: '' };
  }

  timing.timestamps.push(now);

  // Keep last 20 timestamps
  if (timing.timestamps.length > 20) {
    timing.timestamps = timing.timestamps.slice(-20);
  }

  // Need at least 5 messages to analyze
  if (timing.timestamps.length < 5) {
    return { isBot: false, confidence: 0, reason: '' };
  }

  // Calculate inter-message delays
  const delays = [];
  for (let i = 1; i < timing.timestamps.length; i++) {
    delays.push(timing.timestamps[i] - timing.timestamps[i - 1]);
  }

  // Check 1: All delays under 2 seconds (machine-gun fire)
  const allUnder2s = delays.every(d => d < 2000);
  if (allUnder2s) {
    timing.flagCount++;
    if (timing.flagCount >= 2) {
      logger.security('bot_detected_rapid_fire', {
        userPhone,
        avgDelay: `${Math.round(delays.reduce((a, b) => a + b, 0) / delays.length)}ms`,
        messageCount: timing.timestamps.length,
        flagCount: timing.flagCount
      });
      return { isBot: true, confidence: 0.9, reason: 'rapid_fire' };
    }
  }

  // Check 2: Very consistent timing (coefficient of variation < 0.15)
  // Human typing has high variance; bots are metronomic
  const recentDelays = delays.slice(-8);
  if (recentDelays.length >= 5) {
    const mean = recentDelays.reduce((a, b) => a + b, 0) / recentDelays.length;
    const variance = recentDelays.reduce((a, d) => a + Math.pow(d - mean, 2), 0) / recentDelays.length;
    const stdDev = Math.sqrt(variance);
    const cv = mean > 0 ? stdDev / mean : 0;

    if (cv < 0.15 && mean < 5000) {
      timing.flagCount++;
      if (timing.flagCount >= 3) {
        logger.security('bot_detected_constant_timing', {
          userPhone,
          cv: cv.toFixed(3),
          meanDelay: `${Math.round(mean)}ms`,
          flagCount: timing.flagCount
        });
        return { isBot: true, confidence: 0.8, reason: 'constant_timing' };
      }
    }
  }

  return { isBot: false, confidence: 0, reason: '' };
}

// ── Cooldown for rate-limited users ──────────────────────────────────────────
// When a user hits a limit, tell them once and then silence for a period.
const cooldownNotified = new BoundedMap(50000, 5 * 60 * 1000);

/**
 * Check if we already notified this user about rate limiting recently.
 * Returns true if we should silently drop (already told them).
 * Returns false if this is the first time — caller should send a friendly message.
 */
function shouldSilentDrop(userPhone, feature) {
  const key = `${userPhone}:${feature}`;
  if (cooldownNotified.get(key)) return true;
  cooldownNotified.set(key, true);
  return false;
}

module.exports = {
  // Service-level checks (call from within services)
  isAiCallLimited,
  isWebSearchLimited,
  isMediaProcessLimited,
  isMessageBurst,
  isLinkCodeLimited,
  isNewUserLimited,

  // Express middleware (apply to routes)
  oauthCallbackLimiter,
  recordingAccessLimiter,

  // Bot detection
  detectBotBehavior,

  // Notification dedup
  shouldSilentDrop,

  // For testing
  checkLimit,
  LIMITS
};
