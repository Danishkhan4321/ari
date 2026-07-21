// src/services/email-tracking.service.js
// Open/click tracking for outbound email. Mirrors the dashboard's email_sends
// table (dashboard/lib/email-tracking.ts) — whichever side touches it first
// creates it (idempotent CREATE TABLE IF NOT EXISTS). The bot is the WRITER:
// it generates a per-recipient token, injects the open pixel into the MIME
// HTML, and records one row per (campaign × recipient). The dashboard's
// /api/email/track/open|click endpoints are the READERS.
const crypto = require('crypto');
const { query } = require('../config/database');
const logger = require('../utils/logger');

let ready = false;

// Idempotent — safe to call on every write. Keeps the bot self-sufficient
// instead of depending on a dashboard page having been hit first.
async function ensureTable() {
  if (ready) return;
  await query(`
    CREATE TABLE IF NOT EXISTS email_sends (
      id SERIAL PRIMARY KEY,
      user_phone VARCHAR(20) NOT NULL,
      campaign_id INT,
      recipient_email VARCHAR(255) NOT NULL,
      subject TEXT,
      gmail_message_id VARCHAR(120),
      tracking_token VARCHAR(40) UNIQUE NOT NULL,
      send_status VARCHAR(20) NOT NULL DEFAULT 'sent',
      send_error TEXT,
      opened_at TIMESTAMP,
      open_count INT NOT NULL DEFAULT 0,
      last_opened_at TIMESTAMP,
      clicked_at TIMESTAMP,
      click_count INT NOT NULL DEFAULT 0,
      last_clicked_at TIMESTAMP,
      sent_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_email_sends_campaign  ON email_sends(campaign_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_email_sends_user      ON email_sends(user_phone)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_email_sends_recipient ON email_sends(recipient_email)`);
  ready = true;
}

// 40 hex chars — fits VARCHAR(40) and the open route's ^[a-f0-9]{16,64}$ check.
function generateToken() {
  return crypto.randomBytes(20).toString('hex');
}

// Public dashboard origin that serves the pixel/redirect endpoints. Without
// it we can't build a reachable URL, so tracking silently no-ops (the email
// still sends fine — just untracked).
function trackingBaseUrl() {
  const base = process.env.DASHBOARD_BASE_URL;
  return base ? String(base).replace(/\/+$/, '') : null;
}

// Append a 1×1 transparent pixel pointing at the open endpoint. bodyToHtml()
// returns a <div>-wrapped fragment (no <body> element), so we append at the
// end. `.gif` suffix makes the URL look like a real image to clients that
// sniff content type (the open route strips it).
function injectOpenPixel(html, token) {
  const base = trackingBaseUrl();
  if (!base || !token) return html;
  const pixel = `<img src="${base}/api/email/track/open/${token}.gif" width="1" height="1" alt="" style="display:none;max-height:0;overflow:hidden" />`;
  // Tuck the pixel just inside the wrapper div (looks marginally more natural
  // to spam classifiers than trailing after </div>); fall back to append.
  if (/<\/div>\s*$/.test(html)) return html.replace(/<\/div>\s*$/, `${pixel}</div>`);
  return `${html}${pixel}`;
}

// Rewrite http(s) <a href> targets to route through the click endpoint,
// preserving the original URL in ?u=. Leaves mailto:/anchor/relative links
// untouched. Apply BEFORE injectOpenPixel (the pixel is an <img>, unaffected).
function rewriteClickLinks(html, token) {
  const base = trackingBaseUrl();
  if (!base || !token) return html;
  return String(html).replace(
    /(<a\b[^>]*\bhref=")(https?:\/\/[^"]+)(")/gi,
    // Un-escape &amp; → & so HTML-escaped hrefs (bodyToHtml escapes bare-domain
    // auto-links) round-trip cleanly through the click route's URL parser.
    (_m, pre, url, post) => `${pre}${base}/api/email/track/click/${token}?u=${encodeURIComponent(url.replace(/&amp;/g, '&'))}${post}`
  );
}

// Record one row per send. Best-effort: a tracking-write failure must NEVER
// fail the actual email send, so everything here is swallowed-and-logged.
async function recordSend({ userPhone, campaignId, recipientEmail, subject, gmailMessageId, token, status, error }) {
  try {
    await ensureTable();
    await query(
      `INSERT INTO email_sends
         (user_phone, campaign_id, recipient_email, subject, gmail_message_id, tracking_token, send_status, send_error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        userPhone,
        campaignId == null ? null : Number(campaignId),
        recipientEmail,
        subject || null,
        gmailMessageId || null,
        token,
        status || 'sent',
        error ? String(error).slice(0, 1000) : null,
      ]
    );
  } catch (e) {
    logger.warn(`[EmailTracking] recordSend failed for ${recipientEmail}: ${e.message}`);
  }
}

module.exports = { ensureTable, generateToken, trackingBaseUrl, injectOpenPixel, rewriteClickLinks, recordSend };
