/**
 * Security middleware — HTTPS enforcement, headers, request logging,
 * IP rate limiting, and suspicious traffic detection.
 */
const helmet = require('helmet');
const cors = require('cors');
const logger = require('../utils/logger');
const BoundedMap = require('../utils/bounded-map');

const isProduction = process.env.NODE_ENV === 'production';

// ── 1. HTTPS Enforcement ────────────────────────────────────────────────────
function enforceHttps(req, res, next) {
  // Behind a reverse proxy (Fly.io / nginx / Cloudflare) the original
  // protocol is in X-Forwarded-Proto; trust it when trust proxy is set.
  if (isProduction && req.protocol !== 'https' && req.get('x-forwarded-proto') !== 'https') {
    logger.security('http_plaintext_request', {
      ip: req.ip,
      path: req.path,
      method: req.method
    });
    return res.redirect(301, `https://${req.hostname}${req.originalUrl}`);
  }
  next();
}

// ── 2. Helmet — sets secure HTTP headers ─────────────────────────────────────
const helmetMiddleware = helmet({
  // HSTS — tell browsers to only use HTTPS for 1 year
  hsts: {
    maxAge: 365 * 24 * 60 * 60, // 1 year
    includeSubDomains: true,
    preload: true
  },
  // Block rendering inside iframes (clickjacking)
  frameguard: { action: 'deny' },
  // Prevent MIME sniffing
  noSniff: true,
  // Content Security Policy — restrictive default
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"], // recording page uses inline styles
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'", 'https://*.r2.cloudflarestorage.com', 'https://*.supabase.co'],
      upgradeInsecureRequests: isProduction ? [] : null
    }
  },
  // Referrer policy
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
});

// ── 3. CORS — restrict cross-origin requests ────────────────────────────────
const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : [];

const corsMiddleware = cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (webhooks, curl, server-to-server)
    if (!origin) return callback(null, true);
    if (allowedOrigins.length === 0) return callback(null, true); // not configured — allow all
    if (allowedOrigins.includes(origin)) return callback(null, true);
    logger.security('cors_rejected', { origin });
    callback(new Error('CORS not allowed'));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Hub-Signature-256',
    'X-Slack-Signature', 'X-Slack-Request-Timestamp',
    'X-Webhook-Signature', 'X-Webhook-Secret'],
  maxAge: 86400 // 24h preflight cache
});

// ── 4. IP-based rate limiter for webhook / API endpoints ─────────────────────
const ipRateMap = new BoundedMap(100000, 5 * 60 * 1000); // 5min TTL

const IP_RATE_WINDOW_MS = 60 * 1000;   // 1 minute window
const IP_RATE_MAX       = parseInt(process.env.IP_RATE_LIMIT || '120', 10); // 120 req/min per IP

function ipRateLimiter(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();

  let entry = ipRateMap.get(ip);
  if (!entry || (now - entry.windowStart) >= IP_RATE_WINDOW_MS) {
    ipRateMap.set(ip, { windowStart: now, count: 1 });
    return next();
  }

  entry.count++;

  if (entry.count > IP_RATE_MAX) {
    logger.security('ip_rate_limited', {
      ip,
      count: entry.count,
      path: req.path,
      method: req.method
    });
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }
  next();
}

// ── 5. Request logger — logs every request with timing ───────────────────────
function requestLogger(req, res, next) {
  const start = Date.now();

  // Log when response finishes
  res.on('finish', () => {
    const duration = Date.now() - start;
    const ip = req.ip || req.connection?.remoteAddress;
    const logData = {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip,
      userAgent: req.get('user-agent') || ''
    };

    // Log auth failures and server errors at warn/error level
    if (res.statusCode === 401 || res.statusCode === 403) {
      logger.security('auth_failure', logData);
    } else if (res.statusCode === 429) {
      // already logged by rate limiter
    } else if (res.statusCode >= 500) {
      logger.error({ message: 'server_error_response', ...logData });
    } else if (isProduction && duration > 10000) {
      // Slow requests (>10s) in production
      logger.warn({ message: 'slow_request', ...logData });
    }
  });

  next();
}

// ── 6. Suspicious traffic detection ──────────────────────────────────────────
const suspiciousPatterns = [
  /\.\.\//,                          // path traversal
  /(<script|javascript:)/i,          // XSS probes
  /(union\s+select|;\s*drop\s)/i,    // SQL injection probes
  /\.(php|asp|aspx|jsp|cgi)\b/i,     // scanning for other stacks
  /\/(wp-admin|wp-login|xmlrpc|\.env|\.git|phpmyadmin|admin)/i // common scan targets
];

function suspiciousRequestDetector(req, res, next) {
  const fullUrl = req.originalUrl || req.url;

  for (const pattern of suspiciousPatterns) {
    if (pattern.test(fullUrl)) {
      const ip = req.ip || req.connection?.remoteAddress;
      logger.security('suspicious_request', {
        ip,
        method: req.method,
        url: fullUrl,
        pattern: pattern.source,
        userAgent: req.get('user-agent') || ''
      });
      // Don't reveal that we detected it — just 404
      return res.status(404).send('Not Found');
    }
  }
  next();
}

// ── 7. Hide X-Powered-By (defense in depth, helmet also does this) ───────────
function hidePoweredBy(req, res, next) {
  res.removeHeader('X-Powered-By');
  next();
}

// ── 8. Request body type validation ─────────────────────────────────────────
// Reject requests with unexpected Content-Type to prevent deserialization attacks
function validateContentType(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();

  const contentType = (req.headers['content-type'] || '').toLowerCase();

  // Allow standard content types
  const allowed = [
    'application/json',
    'application/x-www-form-urlencoded',
    'multipart/form-data',
    'text/plain',        // Slack sends text/plain sometimes
    'application/octet-stream' // raw body
  ];

  if (contentType && !allowed.some(a => contentType.includes(a))) {
    logger.security('rejected_content_type', {
      ip: req.ip,
      contentType,
      path: req.path,
      method: req.method
    });
    return res.status(415).json({ error: 'Unsupported content type' });
  }
  next();
}

// ── Export: apply all middleware in correct order ─────────────────────────────
function applySecurityMiddleware(app) {
  // Trust proxy (required for req.ip behind reverse proxy & HTTPS detection)
  app.set('trust proxy', isProduction ? 1 : false);

  // Order matters — early rejection saves resources
  app.use(hidePoweredBy);
  app.use(suspiciousRequestDetector);
  app.use(validateContentType);
  app.use(ipRateLimiter);
  app.use(requestLogger);

  if (isProduction) {
    app.use(enforceHttps);
  }

  app.use(helmetMiddleware);
  app.use(corsMiddleware);
}

module.exports = { applySecurityMiddleware };
