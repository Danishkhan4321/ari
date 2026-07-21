const axios = require('axios');
const logger = require('../utils/logger');
const { isSafeUrl } = require('../utils/security');

const HTTP_TIMEOUT = 30000; // 30 seconds

const WHATSAPP_API_URL = 'https://graph.facebook.com/v22.0';

class WhatsAppAdapter {

  constructor() {
    this.platform = 'whatsapp';
    this.token = process.env.META_WHATSAPP_TOKEN;
    this.phoneNumberId = process.env.META_PHONE_NUMBER_ID;
    this.maxMessageLength = 4000;
  }

  isConfigured() {
    return !!(this.token && this.phoneNumberId);
  }

  // WhatsApp Cloud API is webhook-based — Meta pushes events to our Express endpoint
  async initialize(onMessage) {
    this.messageHandler = onMessage;
    logger.info('[WhatsApp] Adapter ready (webhook mode — events come via HTTP)');
  }

  // Normalize user ID: whatsapp uses phone numbers
  normalizeUserId(raw) {
    return `wa_${raw.replace(/\+/g, '')}`;
  }

  // Extract raw platform ID from universal ID
  extractPlatformId(universalId) {
    return universalId.replace(/^wa_/, '');
  }

  async sendMessage(platformId, text) {
    try {
      const phoneNumber = platformId.replace(/\+/g, '');
      const response = await axios.post(
        `${WHATSAPP_API_URL}/${this.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          to: phoneNumber,
          type: 'text',
          text: { body: text }
        },
        {
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
          },
          timeout: HTTP_TIMEOUT
        }
      );
      logger.info(`[WA] Message sent to ${phoneNumber}`);
      // Return wamid for delivery tracking
      return response.data?.messages?.[0]?.id || null;
    } catch (error) {
      const detail = error.response?.data?.error?.message || error.message;
      logger.error(`[WA] Send error to ${platformId}: ${detail}`);
      throw error;
    }
  }

  // Send a pre-approved message template (works outside 24-hour window)
  async sendTemplate(platformId, templateName, languageCode, parameters = []) {
    const phoneNumber = platformId.replace(/\+/g, '');
    const components = [];
    if (parameters.length > 0) {
      // Meta rejects template params containing newlines, tabs, or 5+
      // consecutive spaces (error 132018). Sanitize at this lowest layer so
      // every caller is protected — including direct callers that bypass
      // sendWithTemplateFallback (task assignment, reminder.job, etc.).
      // " · " is a clean visible separator that survives Meta's filters.
      const sanitized = parameters.map(p =>
        String(p == null ? '' : p)
          .replace(/[\r\n\t]+/g, ' · ')
          .replace(/ {5,}/g, '    ')
          .trim()
          .slice(0, 1024)
      );
      components.push({
        type: 'body',
        parameters: sanitized.map(p => ({ type: 'text', text: p }))
      });
    }

    // Try the given language code first, then fallbacks
    const langCodes = [languageCode];
    if (languageCode === 'en') langCodes.push('en_US', 'en_GB');
    else if (languageCode === 'en_US') langCodes.push('en', 'en_GB');
    else if (languageCode === 'en_GB') langCodes.push('en', 'en_US');

    let lastError;
    for (const lang of langCodes) {
      try {
        const payload = {
          messaging_product: 'whatsapp',
          to: phoneNumber,
          type: 'template',
          template: {
            name: templateName,
            language: { code: lang },
            components
          }
        };
        logger.info(`[WA] Sending template "${templateName}" lang="${lang}" to ${phoneNumber} payload=${JSON.stringify(payload)}`);
        const response = await axios.post(
          `${WHATSAPP_API_URL}/${this.phoneNumberId}/messages`,
          payload,
          {
            headers: {
              'Authorization': `Bearer ${this.token}`,
              'Content-Type': 'application/json'
            },
            timeout: HTTP_TIMEOUT
          }
        );
        logger.info(`[WA] Template "${templateName}" (${lang}) sent to ${phoneNumber} response=${JSON.stringify(response.data)}`);
        return;
      } catch (error) {
        const detail = error.response?.data?.error?.message || error.message;
        const code = error.response?.data?.error?.code;
        logger.warn(`[WA] Template "${templateName}" lang="${lang}" failed: ${detail} (code: ${code})`);
        lastError = error;
        // Only retry with next lang if it's a template-not-found error (132001)
        if (code !== 132001) throw error;
      }
    }
    throw lastError;
  }

  async sendImage(platformId, imageUrl, caption = '') {
    try {
      const phoneNumber = platformId.replace(/\+/g, '');
      await axios.post(
        `${WHATSAPP_API_URL}/${this.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: phoneNumber,
          type: 'image',
          image: { link: imageUrl, caption: caption.substring(0, 1024) }
        },
        {
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
          },
          timeout: HTTP_TIMEOUT
        }
      );
      logger.info(`[WA] Image sent to ${phoneNumber}`);
    } catch (error) {
      logger.error(`[WA] Image error: ${error.response?.data?.error?.message || error.message}`);
      await this.sendMessage(platformId, `Image: ${imageUrl}\n\n${caption}`);
    }
  }

  /**
   * Upload a Buffer directly to the Meta Graph /media endpoint and return
   * a media_id that can be referenced in subsequent document/image sends.
   * Avoids needing an external URL for small transient files like transcripts.
   *
   * @param {Buffer} buffer
   * @param {string} mimeType e.g. 'text/plain'
   * @param {string} filename e.g. 'transcript.txt'
   * @returns {Promise<string>} media_id
   */
  async uploadMediaBuffer(buffer, mimeType, filename) {
    const FormData = require('form-data');
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimeType);
    form.append('file', buffer, { filename, contentType: mimeType });

    const resp = await axios.post(
      `${WHATSAPP_API_URL}/${this.phoneNumberId}/media`,
      form,
      {
        headers: { ...form.getHeaders(), 'Authorization': `Bearer ${this.token}` },
        timeout: HTTP_TIMEOUT,
        maxContentLength: 100 * 1024 * 1024,
        maxBodyLength: 100 * 1024 * 1024,
      }
    );
    return resp.data.id;
  }

  /**
   * Send a document that was uploaded via uploadMediaBuffer (uses media id).
   */
  async sendDocumentByMediaId(platformId, mediaId, caption = '', filename = 'document') {
    try {
      const phoneNumber = platformId.replace(/\+/g, '');
      await axios.post(
        `${WHATSAPP_API_URL}/${this.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          to: phoneNumber,
          type: 'document',
          document: { id: mediaId, caption: caption.substring(0, 1024), filename }
        },
        {
          headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' },
          timeout: HTTP_TIMEOUT
        }
      );
    } catch (error) {
      logger.error('[WA] Document by media_id error:', error.response?.data || error.message);
      throw error;
    }
  }

  async sendDocument(platformId, documentUrl, caption = '', filename = 'document') {
    try {
      const phoneNumber = platformId.replace(/\+/g, '');
      await axios.post(
        `${WHATSAPP_API_URL}/${this.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          to: phoneNumber,
          type: 'document',
          document: { link: documentUrl, caption: caption.substring(0, 1024), filename }
        },
        {
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
          },
          timeout: HTTP_TIMEOUT
        }
      );
    } catch (error) {
      logger.error('[WA] Document error:', error.response?.data || error.message);
      await this.sendMessage(platformId, `Document: ${documentUrl}\n\n${caption}`);
    }
  }

  async sendButtonMessage(platformId, bodyText, buttons) {
    try {
      const phoneNumber = platformId.replace(/\+/g, '');
      await axios.post(
        `${WHATSAPP_API_URL}/${this.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          to: phoneNumber,
          type: 'interactive',
          interactive: {
            type: 'button',
            body: { text: bodyText },
            action: {
              buttons: buttons.slice(0, 3).map((btn, idx) => ({
                type: 'reply',
                reply: { id: btn.id || `btn_${idx}`, title: btn.title.slice(0, 20) }
              }))
            }
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
          },
          timeout: HTTP_TIMEOUT
        }
      );
    } catch (error) {
      logger.error(`[WA] Button error: ${error.response?.data?.error?.message || error.message}`);
      await this.sendMessage(platformId, bodyText);
    }
  }

  async sendReaction(platformId, messageId, emoji) {
    try {
      const phoneNumber = platformId.replace(/\+/g, '');
      await axios.post(
        `${WHATSAPP_API_URL}/${this.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          to: phoneNumber,
          type: 'reaction',
          reaction: { message_id: messageId, emoji }
        },
        {
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
          },
          timeout: HTTP_TIMEOUT
        }
      );
    } catch (error) {
      logger.error('[WA] Reaction error:', error.response?.data || error.message);
    }
  }

  async getMediaUrl(mediaId) {
    const response = await axios.get(
      `${WHATSAPP_API_URL}/${mediaId}`,
      { headers: { 'Authorization': `Bearer ${this.token}` }, timeout: HTTP_TIMEOUT }
    );
    return response.data.url;
  }

  async downloadMedia(mediaUrl) {
    if (!isSafeUrl(mediaUrl)) {
      throw new Error('Blocked: unsafe media URL');
    }
    const response = await axios.get(mediaUrl, {
      headers: { 'Authorization': `Bearer ${this.token}` },
      responseType: 'arraybuffer',
      timeout: HTTP_TIMEOUT,
      maxContentLength: 25 * 1024 * 1024 // 25MB max
    });
    return Buffer.from(response.data);
  }

  async transcribeAudio(audioId, userPhone = null) {
    const fs = require('fs').promises;
    const fsSync = require('fs');
    const path = require('path');
    const os = require('os');
    const crypto = require('crypto');
    let tempFilePath;

    try {
      const mediaUrl = await this.getMediaUrl(audioId);
      const audioBuffer = await this.downloadMedia(mediaUrl);

      // Try Sarvam STT for Indian languages
      const sarvamService = require('../services/sarvam.service');
      if (sarvamService.isConfigured()) {
        let userLang = 'hi';
        if (userPhone) {
          const languageService = require('../services/language.service');
          const cached = languageService.getUserLanguage(userPhone);
          if (cached) userLang = cached.code;
        }

        if (sarvamService.isIndianLanguage(userLang) || userLang === 'hi') {
          const transcript = await sarvamService.transcribe(audioBuffer, userLang);
          if (transcript) {
            let text = this.convertToRoman(transcript);
            logger.info(`[WA/Sarvam] Transcribed: ${text}`);
            return text;
          }
          logger.warn('[WA/Sarvam] STT returned null, falling back to Whisper');
        }
      }

      // Fallback: OpenAI Whisper
      const OpenAI = require('openai');
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

      const uniqueId = crypto.randomBytes(8).toString('hex');
      tempFilePath = path.join(os.tmpdir(), `ari_audio_${uniqueId}.ogg`);
      await fs.writeFile(tempFilePath, audioBuffer);

      const transcription = await openai.audio.transcriptions.create({
        file: fsSync.createReadStream(tempFilePath),
        model: 'whisper-1',
        language: 'hi',
        prompt: 'This is Hinglish (Hindi + English mix). Write in Roman/Latin script only.',
        response_format: 'text'
      });

      let text = transcription;
      text = this.convertToRoman(text);
      return text;
    } catch (error) {
      logger.error('[WA] Transcription error:', error.message);
      return null;
    } finally {
      if (tempFilePath) {
        fs.unlink(tempFilePath).catch(() => {});
      }
    }
  }

  // Parse incoming webhook payload into normalized message
  parseIncoming(body) {
    try {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const msg = value?.messages?.[0];
      if (!msg) return null;

      const contact = value.contacts?.[0];

      return {
        platform: 'whatsapp',
        platformId: msg.from,
        userId: this.normalizeUserId(msg.from),
        name: contact?.profile?.name || 'User',
        messageId: msg.id,
        timestamp: msg.timestamp,
        type: msg.type,
        text: msg.text?.body || '',
        interactive: msg.interactive,
        audio: msg.audio,
        image: msg.image,
        document: msg.document
      };
    } catch (error) {
      logger.error('[WA] Parse error:', error);
      return null;
    }
  }

  convertToRoman(text) {
    if (!/[\u0900-\u097F]/.test(text)) return text.trim();

    const hindiToRoman = {
      '\u092E\u0941\u091D\u0947': 'mujhe', '\u092F\u093E\u0926': 'yaad', '\u0926\u093F\u0932\u093E\u0928\u093E': 'dilana',
      '\u0915\u0930\u0928\u093E': 'karna', '\u0939\u0948': 'hai', '\u0939\u0948\u0902': 'hain', '\u092E\u0947\u0902': 'mein',
      '\u0915\u094B': 'ko', '\u0915\u093E': 'ka', '\u0915\u0940': 'ki', '\u0915\u0947': 'ke', '\u0914\u0930': 'aur',
      '\u092A\u0930': 'par', '\u0938\u0947': 'se', '\u0928\u0947': 'ne', '\u092F\u0939': 'yeh', '\u0935\u0939': 'woh',
      '\u0924\u094B': 'to', '\u092D\u0940': 'bhi', '\u0939\u093E\u0901': 'haan', '\u0928\u0939\u0940\u0902': 'nahi',
      '\u0915\u094D\u092F\u093E': 'kya', '\u0915\u0948\u0938\u0947': 'kaise', '\u0915\u092C': 'kab',
      '\u0915\u0939\u093E\u0901': 'kahan', '\u0915\u094D\u092F\u094B\u0902': 'kyun', '\u0905\u092D\u0940': 'abhi',
      '\u092C\u093E\u0926': 'baad', '\u092A\u0939\u0932\u0947': 'pehle', '\u092E\u093F\u0928\u091F': 'minute',
      '\u0918\u0902\u091F\u0947': 'ghante', '\u092C\u091C\u0947': 'baje', '\u0938\u0941\u092C\u0939': 'subah',
      '\u0936\u093E\u092E': 'shaam', '\u0930\u093E\u0924': 'raat', '\u0915\u0932': 'kal', '\u0906\u091C': 'aaj'
    };
    for (const [h, r] of Object.entries(hindiToRoman)) {
      text = text.replace(new RegExp(h, 'g'), r);
    }

    const charMap = {
      '\u0905': 'a', '\u0906': 'aa', '\u0907': 'i', '\u0908': 'ee', '\u0909': 'u', '\u090A': 'oo',
      '\u090F': 'e', '\u0910': 'ai', '\u0913': 'o', '\u0914': 'au',
      '\u0915': 'k', '\u0916': 'kh', '\u0917': 'g', '\u0918': 'gh', '\u091A': 'ch', '\u091B': 'chh',
      '\u091C': 'j', '\u091D': 'jh', '\u091F': 't', '\u0920': 'th', '\u0921': 'd', '\u0922': 'dh',
      '\u0923': 'n', '\u0924': 't', '\u0925': 'th', '\u0926': 'd', '\u0927': 'dh', '\u0928': 'n',
      '\u092A': 'p', '\u092B': 'ph', '\u092C': 'b', '\u092D': 'bh', '\u092E': 'm',
      '\u092F': 'y', '\u0930': 'r', '\u0932': 'l', '\u0935': 'v', '\u0936': 'sh', '\u0937': 'sh',
      '\u0938': 's', '\u0939': 'h',
      '\u093E': 'a', '\u093F': 'i', '\u0940': 'ee', '\u0941': 'u', '\u0942': 'oo',
      '\u0947': 'e', '\u0948': 'ai', '\u094B': 'o', '\u094C': 'au',
      '\u094D': '', '\u0902': 'n', '\u0903': 'h', '\u0901': 'n', '\u093C': '', '\u0964': '.', '\u0965': '.'
    };
    for (const [h, r] of Object.entries(charMap)) {
      text = text.replace(new RegExp(h, 'g'), r);
    }
    return text.trim();
  }
}

module.exports = new WhatsAppAdapter();
