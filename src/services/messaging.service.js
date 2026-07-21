// Apr 29 2026 — WhatsApp-only.
// Removed Discord/Telegram/Slack/GChat adapters along with their multi-platform
// branching logic. The bot is exclusively a WhatsApp assistant; carrying dead
// code for other platforms was masking real bugs and wasting cold-start cycles.
// If multi-platform support is ever wanted again, restore from the
// pre-cleanup-2026-04-29 git tag.

const whatsappAdapter = require('../adapters/whatsapp.adapter');
const BoundedMap = require('../utils/bounded-map');
const { withRetry } = require('../utils/retry');
const logger = require('../utils/logger');

function envFlag(value) {
  return ['true', '1', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function shouldSuppressOutboundMessages() {
  return envFlag(process.env.DISABLE_OUTBOUND_MESSAGES);
}

class MessagingService {

  constructor() {
    this.adapters = {
      whatsapp: whatsappAdapter,
    };

    // userId prefix → platform map. Kept for forward-compat — any future
    // platform adapter just adds its prefix here.
    this.prefixMap = {
      'wa_': 'whatsapp',
    };

    // Channel context for any platform that needs it. Currently empty for
    // WhatsApp (it doesn't need channel routing) — preserved as infra so we
    // don't have to re-add it later.
    this.channelContext = new BoundedMap(50000, 24 * 60 * 60 * 1000); // 24hr TTL

    // Dashboard-mode flag: when the user's current turn arrived via the web
    // dashboard bridge (synthetic message with source='dashboard'), we
    // suppress the outbound WhatsApp send for the reply — the user is
    // watching the dashboard chat and doesn't need a parallel WhatsApp
    // ping. The value is a reference count because multiple dashboard
    // sessions for the same user may now run concurrently.
    this.dashboardMode = new BoundedMap(10000, 5 * 60 * 1000);
  }

  // Mark this user's current turn as dashboard-originated. The safety TTL
  // prevents a crashed worker from suppressing outbound delivery forever.
  setDashboardMode(userId) {
    if (userId) this.dashboardMode.set(userId, Number(this.dashboardMode.get(userId) || 0) + 1);
  }
  isInDashboardMode(userId) {
    return userId ? !!this.dashboardMode.get(userId) : false;
  }
  clearDashboardMode(userId) {
    if (!userId) return;
    const remaining = Number(this.dashboardMode.get(userId) || 0) - 1;
    if (remaining > 0) this.dashboardMode.set(userId, remaining);
    else this.dashboardMode.delete(userId);
  }

  // ========== GET ADAPTER ==========
  getAdapter(platform) {
    return this.adapters[platform] || null;
  }

  // Detect platform from userId prefix
  getPlatformFromUserId(userId) {
    for (const [prefix, platform] of Object.entries(this.prefixMap)) {
      if (userId.startsWith(prefix)) return platform;
    }
    // Bare phone numbers are WhatsApp
    if (/^\d+$/.test(userId)) return 'whatsapp';
    return null;
  }

  // Get the adapter for a given userId
  getAdapterForUser(userId) {
    const platform = this.getPlatformFromUserId(userId);
    return platform ? this.adapters[platform] : null;
  }

  // Extract the raw platform ID from a universal userId
  extractPlatformId(userId) {
    const adapter = this.getAdapterForUser(userId);
    if (adapter) return adapter.extractPlatformId(userId);
    return userId;
  }

  // ========== STORE/GET CHANNEL CONTEXT ==========
  setChannelContext(userId, channelId) {
    if (channelId) this.channelContext.set(userId, channelId);
  }

  getChannelContext(userId) {
    return this.channelContext.get(userId) || null;
  }

  // ========== SEND (with retry) ==========
  async send(userId, text) {
    if (shouldSuppressOutboundMessages()) {
      logger.info(`[messaging] Dry-run WhatsApp send suppressed for ${userId}`);
      return { skipped: true, reason: 'outbound_disabled' };
    }

    // Dashboard-originated turns: skip the WhatsApp push. The reply is
    // already written to conversation_history by the controller and will
    // surface in the dashboard poll within ~5s. Doing both produces an
    // unwanted parallel WhatsApp notification.
    if (this.isInDashboardMode(userId)) {
      logger.debug(`[messaging] Skipping WhatsApp send for ${userId} — dashboard mode active`);
      return { skipped: true, reason: 'dashboard_mode' };
    }
    const platformId = whatsappAdapter.extractPlatformId(userId);
    return withRetry(() => whatsappAdapter.sendMessage(platformId, text), { maxRetries: 2, baseDelay: 1000 });
  }

  async sendImage(userId, imageUrl, caption = '') {
    if (shouldSuppressOutboundMessages()) {
      logger.info(`[messaging] Dry-run WhatsApp image suppressed for ${userId}`);
      return { skipped: true, reason: 'outbound_disabled' };
    }

    if (this.isInDashboardMode(userId)) {
      logger.debug(`[messaging] Skipping WhatsApp image for ${userId} — dashboard mode active`);
      return { skipped: true, reason: 'dashboard_mode' };
    }
    const platformId = whatsappAdapter.extractPlatformId(userId);
    return whatsappAdapter.sendImage(platformId, imageUrl, caption);
  }

  async sendDocument(userId, documentUrl, caption = '', filename = 'document') {
    if (shouldSuppressOutboundMessages()) {
      logger.info(`[messaging] Dry-run WhatsApp document suppressed for ${userId}`);
      return { skipped: true, reason: 'outbound_disabled' };
    }

    if (this.isInDashboardMode(userId)) {
      logger.debug(`[messaging] Skipping WhatsApp document for ${userId} — dashboard mode active`);
      return { skipped: true, reason: 'dashboard_mode' };
    }
    const platformId = whatsappAdapter.extractPlatformId(userId);
    return whatsappAdapter.sendDocument(platformId, documentUrl, caption, filename);
  }

  async sendButtonMessage(userId, bodyText, buttons) {
    if (shouldSuppressOutboundMessages()) {
      logger.info(`[messaging] Dry-run WhatsApp buttons suppressed for ${userId}`);
      return { skipped: true, reason: 'outbound_disabled' };
    }

    if (this.isInDashboardMode(userId)) {
      logger.debug(`[messaging] Skipping WhatsApp buttons for ${userId} — dashboard mode active`);
      return { skipped: true, reason: 'dashboard_mode' };
    }
    const platformId = whatsappAdapter.extractPlatformId(userId);
    return whatsappAdapter.sendButtonMessage(platformId, bodyText, buttons);
  }

  async sendTemplate(userId, templateName, languageCode, parameters = []) {
    if (shouldSuppressOutboundMessages()) {
      logger.info(`[messaging] Dry-run WhatsApp template suppressed for ${userId}`);
      return { skipped: true, reason: 'outbound_disabled' };
    }

    // Templates are sent OUTSIDE the 24h window when the bot couldn't reach
    // the user via free-form. If the user is using the dashboard right now,
    // they're already inside our app — pushing a template to their WA is
    // probably noise.
    if (this.isInDashboardMode(userId)) {
      logger.debug(`[messaging] Skipping WhatsApp template for ${userId} — dashboard mode active`);
      return { skipped: true, reason: 'dashboard_mode' };
    }
    const phoneNumber = whatsappAdapter.extractPlatformId(userId) || userId;
    return whatsappAdapter.sendTemplate(phoneNumber, templateName, languageCode, parameters);
  }

  async sendReaction(userId, messageId, emoji) {
    if (shouldSuppressOutboundMessages()) {
      logger.info(`[messaging] Dry-run WhatsApp reaction suppressed for ${userId}`);
      return { skipped: true, reason: 'outbound_disabled' };
    }

    // Reactions are cheap and ephemeral — sending one even during a
    // dashboard turn is fine. The skip is mostly a documentation hint;
    // we still go through with the WA call so :thumbsup acks land.
    const platformId = whatsappAdapter.extractPlatformId(userId);
    return whatsappAdapter.sendReaction(platformId, messageId, emoji);
  }

  // ========== MEDIA ==========
  async downloadMedia(userId, urlOrId) {
    return whatsappAdapter.downloadMedia(urlOrId);
  }

  async getMediaUrl(userId, mediaId) {
    return whatsappAdapter.getMediaUrl(mediaId);
  }

  async transcribeAudio(userId, audioId) {
    return whatsappAdapter.transcribeAudio(audioId);
  }

  // ========== LONG MESSAGE (auto-chunking) ==========
  async sendLong(userId, text) {
    const maxLength = whatsappAdapter.maxMessageLength || 4000;

    if (text.length <= maxLength) {
      return this.send(userId, text);
    }

    // Split at paragraph boundaries
    const chunks = [];
    let current = '';
    for (const para of text.split('\n\n')) {
      if ((current + '\n\n' + para).length > maxLength) {
        if (current) chunks.push(current.trim());
        current = para;
      } else {
        current = current ? current + '\n\n' + para : para;
      }
    }
    if (current) chunks.push(current.trim());

    for (const chunk of chunks) {
      await this.send(userId, chunk);
    }
  }

  // ========== INITIALIZE ALL PLATFORMS ==========
  async initializeAll(onMessage) {
    const active = [];

    for (const [name, adapter] of Object.entries(this.adapters)) {
      if (adapter.isConfigured()) {
        try {
          await adapter.initialize(onMessage);
          active.push(name);
        } catch (error) {
          logger.error(`Failed to initialize ${name}:`, error.message);
        }
      }
    }

    if (active.length > 0) {
      logger.info(`Messaging platforms active: ${active.join(', ')}`);
    } else {
      logger.warn('No messaging platforms configured!');
    }

    return active;
  }

  // ========== SHUTDOWN ALL ==========
  shutdownAll() {
    for (const adapter of Object.values(this.adapters)) {
      if (adapter.shutdown) adapter.shutdown();
    }
  }
}

module.exports = new MessagingService();
