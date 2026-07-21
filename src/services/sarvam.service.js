const axios = require('axios');
const FormData = require('form-data');
const logger = require('../utils/logger');

const SARVAM_API_KEY = process.env.SARVAM_API_KEY;
const SARVAM_BASE_URL = 'https://api.sarvam.ai';

// Map ISO 639-1 codes to Sarvam language codes
const SARVAM_LANG_MAP = {
  'hi': 'hi-IN',
  'hi-Latn': 'hi-IN',
  'bn': 'bn-IN',
  'ta': 'ta-IN',
  'te': 'te-IN',
  'kn': 'kn-IN',
  'ml': 'ml-IN',
  'gu': 'gu-IN',
  'mr': 'mr-IN',
  'pa': 'pa-IN',
  'or': 'od-IN',
  'ur': 'ur-IN',
  'as': 'as-IN',
  'sa': 'sa-IN',
  'en': 'en-IN'
};

// Indian language codes we route to Sarvam
const INDIAN_LANG_CODES = new Set([
  'hi', 'hi-Latn', 'bn', 'ta', 'te', 'kn', 'ml', 'gu', 'mr', 'pa', 'or', 'ur', 'as', 'sa'
]);

class SarvamService {

  isConfigured() {
    return !!SARVAM_API_KEY;
  }

  isIndianLanguage(langCode) {
    return INDIAN_LANG_CODES.has(langCode);
  }

  getSarvamLangCode(isoCode) {
    return SARVAM_LANG_MAP[isoCode] || null;
  }

  /**
   * Speech-to-text using Sarvam Saaras V3
   * @param {Buffer} audioBuffer - Audio file buffer (ogg/wav/mp3)
   * @param {string} langCode - ISO 639-1 language code (default: 'hi')
   * @returns {string|null} Transcribed text
   */
  async transcribe(audioBuffer, langCode = 'hi') {
    if (!this.isConfigured()) {
      logger.warn('[Sarvam] Not configured, skipping STT');
      return null;
    }

    try {
      const sarvamLang = this.getSarvamLangCode(langCode) || 'hi-IN';

      const form = new FormData();
      form.append('file', audioBuffer, { filename: 'audio.ogg', contentType: 'audio/ogg' });
      form.append('model', 'saaras:v3');
      form.append('language_code', sarvamLang);

      const response = await axios.post(`${SARVAM_BASE_URL}/speech-to-text`, form, {
        headers: {
          ...form.getHeaders(),
          'api-subscription-key': SARVAM_API_KEY
        },
        timeout: 30000
      });

      const transcript = response.data?.transcript;
      if (transcript) {
        logger.info(`[Sarvam] STT (${sarvamLang}): ${transcript.substring(0, 80)}...`);
        return transcript;
      }

      return null;
    } catch (error) {
      logger.error(`[Sarvam] STT error: ${error.response?.data?.message || error.message}`);
      return null;
    }
  }

  /**
   * Translate text using Sarvam Mayura
   * @param {string} text - Text to translate
   * @param {string} sourceLang - Source ISO 639-1 code
   * @param {string} targetLang - Target ISO 639-1 code
   * @returns {string} Translated text (or original on failure)
   */
  async translate(text, sourceLang, targetLang) {
    if (!this.isConfigured()) {
      logger.warn('[Sarvam] Not configured, skipping translation');
      return text;
    }

    const sourceSarvam = this.getSarvamLangCode(sourceLang);
    const targetSarvam = this.getSarvamLangCode(targetLang);

    if (!sourceSarvam || !targetSarvam) {
      logger.warn(`[Sarvam] Unsupported lang pair: ${sourceLang} → ${targetLang}`);
      return text;
    }

    try {
      const response = await axios.post(`${SARVAM_BASE_URL}/translate`, {
        input: text,
        source_language_code: sourceSarvam,
        target_language_code: targetSarvam,
        model: 'mayura:v1',
        enable_preprocessing: true
      }, {
        headers: {
          'api-subscription-key': SARVAM_API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });

      const translated = response.data?.translated_text;
      if (translated) {
        logger.info(`[Sarvam] Translated (${sourceSarvam}→${targetSarvam}): ${translated.substring(0, 80)}...`);
        return translated;
      }

      return text;
    } catch (error) {
      logger.error(`[Sarvam] Translation error: ${error.response?.data?.message || error.message}`);
      return text;
    }
  }
}

module.exports = new SarvamService();
