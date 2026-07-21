const axios = require('axios');
const logger = require('../utils/logger');

const WHATSAPP_API_URL = 'https://graph.facebook.com/v22.0';

class WhatsAppService {
  constructor() {
    this.token = process.env.META_WHATSAPP_TOKEN;
    this.phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  }

  async sendMessage(to, message) {
    try {
      const phoneNumber = to.replace(/\+/g, '');
      
      const response = await axios.post(
        `${WHATSAPP_API_URL}/${this.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          to: phoneNumber,
          type: 'text',
          text: { body: message }
        },
        {
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      logger.info(`Message sent to ${phoneNumber}`);
      return response.data;
    } catch (error) {
      const status = error.response?.status;
      const detail = error.response?.data?.error?.message || error.message;
      logger.error(`WhatsApp send error [${status || 'unknown'}] to ${to}: ${detail}`);
      throw error;
    }
  }

  async sendButtonMessage(to, bodyText, buttons) {
    try {
      const phoneNumber = to.replace(/\+/g, '');
      
      const response = await axios.post(
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
                reply: {
                  id: btn.id || `btn_${idx}`,
                  title: btn.title.slice(0, 20)
                }
              }))
            }
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      return response.data;
    } catch (error) {
      logger.error(`WhatsApp button error [${error.response?.status || 'unknown'}]: ${error.response?.data?.error?.message || error.message}`);
      return this.sendMessage(to, bodyText);
    }
  }

  async sendImage(to, imageUrl, caption = '') {
    try {
      const phoneNumber = to.replace(/\+/g, '');
      
      const response = await axios.post(
        `${WHATSAPP_API_URL}/${this.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: phoneNumber,
          type: 'image',
          image: {
            link: imageUrl,
            caption: caption.substring(0, 1024)
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      logger.info(`Image sent to ${phoneNumber}`);
      return response.data;
    } catch (error) {
      logger.error(`WhatsApp image error [${error.response?.status || 'unknown'}]: ${error.response?.data?.error?.message || error.message}`);
      return this.sendMessage(to, `Image: ${imageUrl}\n\n${caption}`);
    }
  }

  async sendDocument(to, documentUrl, caption = '', filename = 'document') {
    try {
      const phoneNumber = to.replace(/\+/g, '');
      const response = await axios.post(
        `${WHATSAPP_API_URL}/${this.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          to: phoneNumber,
          type: 'document',
          document: {
            link: documentUrl,
            caption: caption.substring(0, 1024),
            filename
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
          }
        }
      );
      logger.info(`Document sent to ${phoneNumber}`);
      return response.data;
    } catch (error) {
      logger.error('Error sending document:', error.response?.data || error.message);
      return this.sendMessage(to, `Document: ${documentUrl}\n\n${caption}`);
    }
  }

  async markAsReadAndType(messageId) {
    try {
      await axios.post(
        `${WHATSAPP_API_URL}/${this.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId,
          typing_indicator: {
            type: 'text'
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
          }
        }
      );
      logger.info(`[WA] Marked as read + typing for ${messageId}`);
    } catch (error) {
      logger.warn(`[WA] markAsReadAndType failed for ${messageId}: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  // Mark as read only (no typing indicator)
  async markAsRead(messageId) {
    try {
      await axios.post(
        `${WHATSAPP_API_URL}/${this.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId
        },
        {
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
          }
        }
      );
    } catch (error) {
      logger.warn(`[WA] markAsRead failed for ${messageId}: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  async sendReaction(to, messageId, emoji) {
    try {
      const phoneNumber = to.replace(/\+/g, '');
      await axios.post(
        `${WHATSAPP_API_URL}/${this.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          to: phoneNumber,
          type: 'reaction',
          reaction: {
            message_id: messageId,
            emoji
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
          }
        }
      );
    } catch (error) {
      logger.error('Error sending reaction:', error.response?.data || error.message);
    }
  }

  parseWebhookMessage(body) {
    try {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const message = value?.messages?.[0];
      
      if (!message) return null;
      
      const contact = value.contacts?.[0];
      
      return {
        from: message.from,
        name: contact?.profile?.name || 'User',
        messageId: message.id,
        timestamp: message.timestamp,
        type: message.type,
        text: message.text?.body || '',
        interactive: message.interactive,
        audio: message.audio,
        image: message.image,
        document: message.document
      };
    } catch (error) {
      logger.error('Error parsing webhook message:', error);
      return null;
    }
  }
  
  async getMediaUrl(mediaId) {
    try {
      const response = await axios.get(
        `${WHATSAPP_API_URL}/${mediaId}`,
        { headers: { 'Authorization': `Bearer ${this.token}` } }
      );
      return response.data.url;
    } catch (error) {
      logger.error('Error getting media URL:', error.response?.data || error.message);
      throw error;
    }
  }

  async downloadMedia(mediaUrl) {
    try {
      const response = await axios.get(mediaUrl, {
        headers: { 'Authorization': `Bearer ${this.token}` },
        responseType: 'arraybuffer'
      });
      return Buffer.from(response.data);
    } catch (error) {
      logger.error('Error downloading media:', error.message);
      throw error;
    }
  }

  async transcribeAudio(audioId, userPhone = null) {
    try {
      const fs = require('fs');
      const path = require('path');

      logger.info(`Transcribing audio: ${audioId}`);

      const mediaUrl = await this.getMediaUrl(audioId);
      const audioBuffer = await this.downloadMedia(mediaUrl);
      logger.info(`Downloaded ${audioBuffer.length} bytes`);

      // Check if user's language is Indian → use Sarvam STT
      const sarvamService = require('./sarvam.service');
      if (sarvamService.isConfigured()) {
        let userLang = 'hi'; // default for Indian users
        if (userPhone) {
          const languageService = require('./language.service');
          const cached = languageService.getUserLanguage(userPhone);
          if (cached) userLang = cached.code;
        }

        if (sarvamService.isIndianLanguage(userLang) || userLang === 'hi') {
          const transcript = await sarvamService.transcribe(audioBuffer, userLang);
          if (transcript) {
            let text = this.convertToRoman(transcript);
            logger.info(`[Sarvam] Transcribed: ${text}`);
            return text;
          }
          logger.warn('[Sarvam] STT returned null, falling back to Whisper');
        }
      }

      // Fallback: OpenAI Whisper
      const OpenAI = require('openai');
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

      const tempFilePath = path.join(require('os').tmpdir(), `whisper_${crypto.randomBytes(8).toString('hex')}.ogg`);
      fs.writeFileSync(tempFilePath, audioBuffer);

      let transcription;
      try {
        transcription = await openai.audio.transcriptions.create({
          file: fs.createReadStream(tempFilePath),
          model: 'whisper-1',
          language: 'hi',
          prompt: 'This is Hinglish (Hindi + English mix). Write in Roman/Latin script only. Examples: "mujhe yaad dilana", "remind karna 5 minute baad", "khaana khaana hai", "meeting hai kal", "call karna hai"',
          response_format: 'text'
        });
      } finally {
        try { fs.unlinkSync(tempFilePath); } catch (_) {}
      }

      let text = transcription;
      text = this.convertToRoman(text);

      logger.info(`Transcribed: ${text}`);
      return text;

    } catch (error) {
      logger.error('Transcription error:', error.message);
      return null;
    }
  }

  convertToRoman(text) {
    if (/[\u0900-\u097F]/.test(text)) {
      logger.info('Converting Devanagari to Roman...');
      
      const hindiToRoman = {
        'मुझे': 'mujhe', 'याद': 'yaad', 'दिलाना': 'dilana', 'करना': 'karna',
        'है': 'hai', 'हैं': 'hain', 'में': 'mein', 'को': 'ko', 'का': 'ka',
        'की': 'ki', 'के': 'ke', 'और': 'aur', 'पर': 'par', 'से': 'se',
        'ने': 'ne', 'यह': 'yeh', 'वह': 'woh', 'कि': 'ki', 'जो': 'jo',
        'तो': 'to', 'भी': 'bhi', 'हाँ': 'haan', 'नहीं': 'nahi', 'क्या': 'kya',
        'कैसे': 'kaise', 'कब': 'kab', 'कहाँ': 'kahan', 'क्यों': 'kyun',
        'अभी': 'abhi', 'बाद': 'baad', 'पहले': 'pehle', 'मिनट': 'minute',
        'घंटे': 'ghante', 'बजे': 'baje', 'सुबह': 'subah', 'शाम': 'shaam',
        'रात': 'raat', 'दोपहर': 'dopahar', 'कल': 'kal', 'आज': 'aaj',
        'अच्छा': 'accha', 'ठीक': 'theek', 'हो गया': 'ho gaya', 'कर दिया': 'kar diya',
        'बोल': 'bol', 'बता': 'bata', 'देख': 'dekh', 'सुन': 'sun', 'जा': 'ja',
        'आ': 'aa', 'ले': 'le', 'दे': 'de', 'खाना': 'khaana', 'पानी': 'paani',
        'पीना': 'peena', 'लेना': 'lena', 'देना': 'dena', 'रखना': 'rakhna',
        'भेजना': 'bhejna', 'मीटिंग': 'meeting', 'कॉल': 'call', 'मैसेज': 'message',
        'रिमाइंडर': 'reminder', 'फ़ोन': 'phone', 'चार्ज': 'charge'
      };

      for (const [hindi, roman] of Object.entries(hindiToRoman)) {
        text = text.replace(new RegExp(hindi, 'g'), roman);
      }

      const charMap = {
        'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo',
        'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऋ': 'ri',
        'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n',
        'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n',
        'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
        'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
        'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
        'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'श': 'sh',
        'ष': 'sh', 'स': 's', 'ह': 'h',
        'ा': 'a', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo',
        'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au',
        '्': '', 'ं': 'n', 'ः': 'h', 'ँ': 'n', '़': '', '।': '.', '॥': '.'
      };

      for (const [hindi, roman] of Object.entries(charMap)) {
        text = text.replace(new RegExp(hindi, 'g'), roman);
      }
    }

    return text.trim();
  }
}

module.exports = new WhatsAppService();