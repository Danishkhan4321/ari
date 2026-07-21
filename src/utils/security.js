const crypto = require('crypto');

/**
 * Escape HTML special characters to prevent XSS
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Verify Slack request signature (X-Slack-Signature)
 */
function verifySlackSignature(signingSecret, requestBody, timestamp, signature) {
  if (!signingSecret || !timestamp || !signature) return false;

  // Reject requests older than 5 minutes (replay protection)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) return false;

  const sigBaseString = `v0:${timestamp}:${requestBody}`;
  const mySignature = 'v0=' + crypto
    .createHmac('sha256', signingSecret)
    .update(sigBaseString, 'utf8')
    .digest('hex');

  // Timing-safe comparison
  try {
    return crypto.timingSafeEqual(
      Buffer.from(mySignature, 'utf8'),
      Buffer.from(signature, 'utf8')
    );
  } catch {
    return false;
  }
}

/**
 * Verify Google Chat JWT bearer token with signature verification.
 * Fetches Google's public keys and validates the RS256 signature.
 */
let _googleCertsCache = null;
let _googleCertsCacheExpiry = 0;

async function _fetchGoogleCerts() {
  const now = Date.now();
  if (_googleCertsCache && now < _googleCertsCacheExpiry) return _googleCertsCache;
  try {
    const https = require('https');
    const data = await new Promise((resolve, reject) => {
      https.get('https://www.googleapis.com/service_accounts/v1/metadata/x509/chat%40system.gserviceaccount.com', (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve(JSON.parse(body)));
        res.on('error', reject);
      }).on('error', reject);
    });
    _googleCertsCache = data;
    _googleCertsCacheExpiry = now + 3600000; // cache 1 hour
    return data;
  } catch {
    return _googleCertsCache || {}; // use stale cache if fetch fails
  }
}

async function verifyGoogleChatToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  try {
    const token = authHeader.replace('Bearer ', '');
    const parts = token.split('.');
    if (parts.length !== 3) return false;

    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());

    // Verify issuer
    if (payload.iss !== 'chat@system.gserviceaccount.com') return false;
    // Verify token hasn't expired (5 min clock skew tolerance)
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000) - 300) return false;

    // Verify RS256 signature using Google's public certificate
    const certs = await _fetchGoogleCerts();
    const cert = certs[header.kid];
    if (!cert) return false;

    const signedData = parts[0] + '.' + parts[1];
    const signature = Buffer.from(parts[2], 'base64url');
    const isValid = crypto.createVerify('RSA-SHA256')
      .update(signedData)
      .verify(cert, signature);

    return isValid;
  } catch {
    return false;
  }
}

/**
 * Returns true if `hostname` (decimal-dotted IPv4) is in a private/internal
 * range. Used by isSafeUrl for SSRF protection.
 */
function _isPrivateIPv4(hostname) {
  const parts = hostname.split('.');
  if (parts.length !== 4 || !parts.every(p => /^\d+$/.test(p))) return false;
  const [a, b] = parts.map(p => parseInt(p, 10));
  if (a === 0) return true;       // 0.0.0.0/8 — "this network"
  if (a === 10) return true;      // 10.0.0.0/8
  if (a === 127) return true;     // 127.0.0.0/8 — loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 — link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  return false;
}

/**
 * Returns true if `hostname` (already lowercased) is an IPv6 address in a
 * private/internal range.
 *
 * Apr 29 2026: added to close the IPv6 SSRF bypass — previously isSafeUrl
 * only matched the exact string `::1` and anything starting with `[`, but
 * that missed every other IPv6 private address (fe80::, fc00::, the
 * IPv4-mapped forms, etc.).
 *
 * Notes on Node's URL parser quirks:
 *   – URL.hostname for an IPv6 URL KEEPS the surrounding `[...]`. We strip
 *     them here so the regexes don't have to think about brackets.
 *   – Node normalises `::ffff:127.0.0.1` → `::ffff:7f00:1` (hex). We
 *     handle BOTH forms.
 *   – IPv6 segments can be 1–4 hex digits; we don't try to canonicalise
 *     fully — the regexes match on the leading bits which is enough for
 *     the private-range check.
 */
function _isPrivateIPv6(rawHostname) {
  if (!rawHostname.includes(':')) return false; // Not IPv6 at all
  // Strip surrounding brackets (Node's URL.hostname keeps them for IPv6)
  let h = rawHostname;
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  // Loopback ::1 (any zero-collapsed form)
  if (h === '::1' || /^0*(?::0*)*:0*1$/.test(h)) return true;
  // Unspecified ::
  if (h === '::' || /^0*(?::0*)+$/.test(h)) return true;
  // Link-local fe80::/10  → first 16 bits in fe80..febf
  if (/^fe[89ab][0-9a-f]?:/.test(h)) return true;
  // Unique local fc00::/7 → fc00..fdff
  if (/^f[cd][0-9a-f]{0,2}:/.test(h)) return true;
  // Site-local fec0::/10 (deprecated, still treat as private)
  if (/^fe[cdef][0-9a-f]?:/.test(h)) return true;
  // IPv4-mapped, dotted form: ::ffff:x.x.x.x
  const mappedDotted = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedDotted) return _isPrivateIPv4(mappedDotted[1]);
  // IPv4-mapped, hex form (Node's normalisation): ::ffff:xxxx:yyyy
  const mappedHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return _isPrivateIPv4(ipv4);
  }
  // IPv4-compatible (deprecated): ::x.x.x.x
  const compat = h.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  if (compat) return _isPrivateIPv4(compat[1]);
  return false;
}

/**
 * Validate a URL is not pointing to internal/private networks (SSRF protection)
 */
function isSafeUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    // Only allow http/https
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const hostname = parsed.hostname.toLowerCase();
    // Block internal hostnames
    if (hostname === 'localhost' || hostname === '0.0.0.0') return false;
    if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return false;
    // Block private IPv4 + IPv6 ranges
    if (_isPrivateIPv4(hostname)) return false;
    if (_isPrivateIPv6(hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

// ── Input Validation & Sanitization ─────────────────────────────────────────

/**
 * Sanitize user text input:
 * - Coerce to string
 * - Strip null bytes (injection vector for C-based systems, databases)
 * - Strip other dangerous control characters (keep \n, \r, \t)
 * - Truncate to max length
 */
function sanitizeInput(text, maxLength = 5000) {
  if (!text) return '';
  let s = String(text);
  // Remove null bytes — can bypass security filters in some backends
  s = s.replace(/\0/g, '');
  // Remove control chars except \t (0x09), \n (0x0A), \r (0x0D)
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  // M2-N fix (Batch F5): strip Unicode bidi/format overrides. These
  // chars (RLO, LRO, RLE, LRE, PDF, RLI, LRI, FSI, PDI) let an attacker
  // display "evil.scr" as "rcs.live" in WhatsApp UI to trick the user.
  // Removing them flattens display to the actual code-point order.
  s = s.replace(/[‎‏‪-‮⁦-⁩]/g, '');
  return s.substring(0, maxLength);
}

/**
 * Validate and sanitize a phone number / userId format.
 * Allows: digits, plus sign prefix, and platform prefixes (wa_, dc_, tg_, sl_, gc_).
 * Rejects everything else.
 */
function validateUserId(userId) {
  if (!userId || typeof userId !== 'string') return null;
  const s = userId.trim();
  if (s.length === 0 || s.length > 50) return null;
  // Platform-prefixed IDs: wa_123, dc_123, tg_123, sl_U123, gc_users/123
  if (/^(wa_|dc_|tg_|sl_|gc_)[\w/]{1,45}$/.test(s)) return s;
  // Plain phone numbers: digits, optional + prefix
  if (/^\+?\d{5,20}$/.test(s)) return s;
  // Slack user IDs (U + alphanumeric)
  if (/^U[A-Z0-9]{5,20}$/.test(s)) return s;
  // Discord snowflakes / Telegram numeric IDs
  if (/^\d{5,25}$/.test(s)) return s;
  return null;
}

/**
 * Validate a positive integer from user input (route params, query params, etc.)
 * Returns the integer or null if invalid.
 */
function validatePositiveInt(value) {
  if (value === undefined || value === null) return null;
  const n = parseInt(String(value), 10);
  if (isNaN(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER) return null;
  if (String(n) !== String(value).trim()) return null; // reject "123abc"
  return n;
}

/**
 * Validate a hex token (share tokens, link codes, etc.)
 * Returns cleaned token or null if invalid.
 */
function validateToken(token, minLen = 6, maxLen = 128) {
  if (!token || typeof token !== 'string') return null;
  const s = token.trim();
  if (s.length < minLen || s.length > maxLen) return null;
  // Allow hex, alphanumeric, hyphens, underscores (covers UUIDs, hex tokens, etc.)
  if (!/^[a-zA-Z0-9_-]+$/.test(s)) return null;
  return s;
}

/**
 * Sanitize a filename: strip path traversal, null bytes, and shell metacharacters.
 * Returns a safe filename or 'untitled'.
 */
function sanitizeFilename(name) {
  if (!name || typeof name !== 'string') return 'untitled';
  let s = String(name);
  // Remove null bytes
  s = s.replace(/\0/g, '');
  // Remove path separators (prevent directory traversal)
  s = s.replace(/[/\\]/g, '');
  // Remove parent directory references
  s = s.replace(/\.\./g, '');
  // Remove shell metacharacters and control chars
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\x00-\x1F\x7F<>:"|?*`$;!&{}()[\]]/g, '');
  // Trim dots/spaces from start and end (Windows issues)
  s = s.replace(/^[.\s]+|[.\s]+$/g, '');
  // Limit length
  s = s.substring(0, 200);
  return s || 'untitled';
}

/**
 * Validate MIME type format.
 * Returns the MIME type if valid, null otherwise.
 */
function validateMimeType(mimeType) {
  if (!mimeType || typeof mimeType !== 'string') return null;
  const s = mimeType.trim().toLowerCase();
  // Standard MIME: type/subtype, optionally with +suffix or parameters
  if (!/^[a-z]+\/[a-z0-9][a-z0-9!#$&\-.^_+]*$/i.test(s)) return null;
  if (s.length > 100) return null;
  return s;
}

// Allowed MIME types for media uploads
const ALLOWED_IMAGE_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'
]);
const ALLOWED_AUDIO_MIMES = new Set([
  'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm',
  'audio/aac', 'audio/amr', 'audio/opus', 'audio/x-wav'
]);
const ALLOWED_VIDEO_MIMES = new Set([
  'video/mp4', 'video/webm', 'video/mpeg', 'video/quicktime', 'video/x-matroska'
]);
const ALLOWED_DOCUMENT_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'text/plain', 'text/csv', 'text/html',
  'application/json', 'application/xml'
]);

/**
 * Check if a MIME type is allowed for the given media category.
 * category: 'image' | 'audio' | 'video' | 'document' | 'any'
 */
function isAllowedMimeType(mimeType, category = 'any') {
  const m = validateMimeType(mimeType);
  if (!m) return false;
  switch (category) {
    case 'image':    return ALLOWED_IMAGE_MIMES.has(m);
    case 'audio':    return ALLOWED_AUDIO_MIMES.has(m);
    case 'video':    return ALLOWED_VIDEO_MIMES.has(m);
    case 'document': return ALLOWED_DOCUMENT_MIMES.has(m);
    case 'any':
      return ALLOWED_IMAGE_MIMES.has(m) || ALLOWED_AUDIO_MIMES.has(m) ||
             ALLOWED_VIDEO_MIMES.has(m) || ALLOWED_DOCUMENT_MIMES.has(m);
    default: return false;
  }
}

/**
 * Sanitize a string for use in Google Drive / Sheets API queries.
 * Escapes single quotes AND backslashes to prevent injection.
 */
function sanitizeApiQueryString(str, maxLength = 200) {
  if (!str || typeof str !== 'string') return '';
  let s = String(str).substring(0, maxLength);
  // Remove null bytes
  s = s.replace(/\0/g, '');
  // Escape backslashes first, then single quotes
  s = s.replace(/\\/g, '\\\\');
  s = s.replace(/'/g, "\\'");
  return s;
}

/**
 * Validate OAuth state parameter format.
 * State should be a hex HMAC or opaque token — reject anything that looks like injection.
 */
function validateOAuthState(state) {
  if (!state || typeof state !== 'string') return null;
  const s = state.trim();
  // State tokens are typically hex, base64url, or UUID. Max 500 chars.
  if (s.length === 0 || s.length > 500) return null;
  // Allow alphanumeric, hyphens, underscores, dots, colons, equals (base64 padding)
  if (!/^[a-zA-Z0-9_\-.:=+/]+$/.test(s)) return null;
  return s;
}

/**
 * Validate a meeting URL — must be a recognized platform URL.
 */
function validateMeetingUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const s = url.trim();
  if (s.length > 500) return null;
  // Must start with https
  if (!s.startsWith('https://')) return null;
  // Must be a known meeting platform
  const knownDomains = [
    'meet.google.com',
    'zoom.us', 'zoom.com',
    'teams.microsoft.com', 'teams.live.com'
  ];
  try {
    const parsed = new URL(s);
    const hostname = parsed.hostname.toLowerCase();
    if (!knownDomains.some(d => hostname === d || hostname.endsWith('.' + d))) return null;
    return s;
  } catch {
    return null;
  }
}

module.exports = {
  escapeHtml,
  verifySlackSignature,
  verifyGoogleChatToken,
  isSafeUrl,
  sanitizeInput,
  validateUserId,
  validatePositiveInt,
  validateToken,
  sanitizeFilename,
  validateMimeType,
  isAllowedMimeType,
  sanitizeApiQueryString,
  validateOAuthState,
  validateMeetingUrl
};
