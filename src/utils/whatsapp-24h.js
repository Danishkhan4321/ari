const { query } = require('../config/database');
const messagingService = require('../services/messaging.service');
const whatsappAdapter = require('../adapters/whatsapp.adapter');
const logger = require('./logger');

/**
 * Check if a WhatsApp user has messaged within the last 24 hours.
 * If yes, free-form messages can be sent. If no, must use templates.
 */
async function hasRecentInteraction(phone) {
  try {
    const result = await query(
      `SELECT 1 FROM conversation_history
       WHERE user_phone = $1 AND role = 'user'
         AND created_at > NOW() - INTERVAL '24 hours'
       LIMIT 1`,
      [phone]
    );
    return result.rows.length > 0;
  } catch (e) {
    logger.warn(`hasRecentInteraction check failed: ${e.message}`);
    // Fallback: check if they've ever interacted
    try {
      const ever = await query(
        `SELECT 1 FROM conversation_history WHERE user_phone = $1 AND role = 'user' LIMIT 1`,
        [phone]
      );
      return ever.rows.length > 0;
    } catch (_) {
      return true; // Assume in-window if DB is down (try free-form, template will fail gracefully)
    }
  }
}

/**
 * Send a message with automatic template fallback for the 24h window.
 * - If user is within 24h window: send free-form (FREE)
 * - If user is outside 24h window: send template (paid but delivered)
 *
 * @param {string} phone - Recipient phone (raw number or prefixed userId)
 * @param {string} freeFormText - The full message to send as free-form
 * @param {object} templateDef - { name: 'template_name', lang: 'en' } from whatsapp-templates.js
 * @param {string[]} templateParams - Array of parameter values for the template
 * @returns {object} { sent: true, method: 'freeform'|'template' } or { sent: false, error }
 */
async function sendWithTemplateFallback(phone, freeFormText, templateDef, templateParams = []) {
  // Extract raw phone number for template sending
  const rawPhone = String(phone).replace(/^wa_/, '').replace(/^\+/, '');
  const isWhatsApp = !String(phone).startsWith('dc_') && !String(phone).startsWith('tg_') && !String(phone).startsWith('sl_') && !String(phone).startsWith('gc_');

  // Non-WhatsApp platforms: always send free-form (no 24h restriction)
  if (!isWhatsApp) {
    try {
      await messagingService.send(phone, freeFormText);
      return { sent: true, method: 'freeform' };
    } catch (e) {
      return { sent: false, error: e.message };
    }
  }

  // Check 24h window
  const inWindow = await hasRecentInteraction(rawPhone);

  if (inWindow) {
    // Within 24h: send free-form (free)
    try {
      await messagingService.send(phone, freeFormText);
      return { sent: true, method: 'freeform' };
    } catch (e) {
      logger.warn(`Free-form send failed for ${rawPhone}, trying template: ${e.message}`);
      // Fall through to template
    }
  }

  // Outside 24h or free-form failed: send template
  if (!templateDef || !templateDef.name) {
    logger.warn(`No template defined for fallback to ${rawPhone}`);
    return { sent: false, error: 'Outside 24h window and no template configured' };
  }

  try {
    // Meta rejects template params containing newlines, tabs, or 5+ consecutive
    // spaces (error 132018). Free-form messages allow these — but template
    // params don't. Sanitize at this layer so individual call sites don't
    // each need to remember the rule. " · " is a clean visible separator.
    const sanitizedParams = (templateParams || []).map(sanitizeTemplateParam);
    await whatsappAdapter.sendTemplate(rawPhone, templateDef.name, templateDef.lang, sanitizedParams);
    return { sent: true, method: 'template' };
  } catch (e) {
    logger.error(`Template fallback also failed for ${rawPhone}: ${e.message}`);
    return { sent: false, error: `Both free-form and template failed: ${e.message}` };
  }
}

/**
 * Sanitize a single template parameter value to satisfy Meta's strict rules:
 *   - No newline / tab characters
 *   - No more than 4 consecutive spaces
 * Also caps very long strings since template params have a soft length limit.
 */
function sanitizeTemplateParam(value) {
  return String(value == null ? '' : value)
    .replace(/[\r\n\t]+/g, ' · ')   // newlines/tabs → bullet separator
    .replace(/ {5,}/g, '    ')      // 5+ spaces → exactly 4
    .trim()
    .slice(0, 1024);                // belt-and-suspenders length cap
}

module.exports = { hasRecentInteraction, sendWithTemplateFallback, sanitizeTemplateParam };
