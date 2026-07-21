const axios = require('axios');
const logger = require('../utils/logger');
const BoundedMap = require('../utils/bounded-map');
const llm = require('./llm-provider');

const apiKey = llm.apiKey();
const apiUrl = llm.chatUrl();
const model = llm.fastModel();

class LanguageService {

  constructor() {
    this.userLanguageCache = new BoundedMap(20000, 30 * 60 * 1000); // 30min TTL
    this.cacheTTL = 30 * 60 * 1000;
  }

  // Always use AI to detect language
  async detectLanguage(text) {
    // Strip URLs, email addresses, and random IDs — these can look like foreign
    // words to the LLM. For example, a Google Meet code like "fru-ctyu-rui" can
    // be mistaken for French by the detector.
    const cleaned = (text || '')
      .replace(/https?:\/\/[^\s]+/g, ' ')           // URLs
      .replace(/\b[a-z0-9._-]+@[a-z0-9.-]+\b/gi, ' ') // email addresses
      .replace(/\b[a-z]{3,}-[a-z]{3,}-[a-z]{3,}\b/gi, ' ') // meeting codes (abc-defg-hij)
      .replace(/\s+/g, ' ')
      .trim();

    // If nothing left to analyze, default to English
    if (cleaned.length < 2) {
      return { code: 'en', name: 'English' };
    }

    // SHORT-INPUT BYPASS (fix for "mahaprasad" → Bengali bug):
    // Single-word Latin-script inputs are almost always proper nouns
    // (names, commands, app terms) and the LLM often mis-detects them as
    // obscure languages based on phonetic similarity. Default to English
    // for these, so error messages don't get translated into e.g. Bengali
    // when the user types just "mahaprasad".
    const wordCount = cleaned.split(/\s+/).length;
    const isLatin = /^[\x20-\x7E]+$/.test(cleaned);  // ASCII-only
    if (wordCount === 1 && isLatin) {
      return { code: 'en', name: 'English' };
    }

    try {
      // Route via modelFor('language_detect') — falls back to current model if env unset.
      const taskModel = llm.modelFor('language_detect') || model;
      const systemPrompt = `You are a language detector. Detect the language of the user's text.
Output ONLY valid JSON: {"code": "ISO 639-1 code", "name": "language name in English"}

Rules:
- Hindi + English mixed in Latin script (e.g. "mujhe yaad dilana", "kal meeting hai") → {"code": "hi-Latn", "name": "Hinglish"}
- Pure Hindi in Devanagari → {"code": "hi", "name": "Hindi"}
- German words like "erinnere", "morgen", "Uhr", "bitte", "mich", "Teammeeting" → {"code": "de", "name": "German"}
- French words like "rappelle", "demain", "matin", "appeler" → {"code": "fr", "name": "French"}
- Spanish words like "necesito", "programar", "reunion", "manana" → {"code": "es", "name": "Spanish"}
- Even if some English words are mixed in (e.g. "Teammeeting"), detect the DOMINANT language, not English.
- IMPORTANT: Person names like "Danish", "Neha", "Rahul", "Priya" are NOT language indicators. "tell Danish to..." is English, not Danish language. Only detect a language if the actual WORDS (not proper nouns) are in that language.
- If the message is a command/instruction in English that happens to mention a person's name that matches a language (e.g. "Danish", "Thai"), it is still English.
- Use standard ISO 639-1 codes for all other languages (en, es, fr, de, pt, ar, zh, ja, ko, ru, ta, te, bn, gu, ml, kn, pa, ur, tr, vi, id, pl, nl, sv, etc.)`;

      const response = await llm.chatCompletion({
        model: taskModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: cleaned }
        ],
        temperature: 0,
        max_tokens: 30,
      }, { task: 'language_detect', timeout: 3000 });

      // Track usage for cost monitoring (safe no-op if tracker unavailable)
      try {
        const tracker = require('./model-usage-tracker.service');
        tracker.log({ task: 'language_detect', model: taskModel, usage: response?.data?.usage });
      } catch (_) {}

      const content = response.data.choices[0].message.content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return { code: parsed.code || 'en', name: parsed.name || 'English' };
      }
    } catch (error) {
      logger.error('AI language detection error:', error.message);
    }

    return { code: 'en', name: 'English' };
  }

  // Translate bot response to user's language
  async translateResponse(text, targetLangCode, targetLangName) {
    if (targetLangCode === 'en' || targetLangCode === 'hi-Latn') return text;

    // Use Sarvam for Indian languages
    const sarvamService = require('./sarvam.service');
    if (sarvamService.isConfigured() && sarvamService.isIndianLanguage(targetLangCode)) {
      const translated = await sarvamService.translate(text, 'en', targetLangCode);
      if (translated && translated !== text) return translated;
      // Fall through to GPT if Sarvam fails
    }

    try {
      const response = await axios.post(apiUrl, {
        model,
        messages: [
          {
            role: 'system',
            content: `Translate the following text to ${targetLangName}. Keep any special formatting (*bold*, _italic_, numbers, dates, times, URLs) exactly as they are. Only translate the natural language parts. Output ONLY the translated text, nothing else.`
          },
          { role: 'user', content: text }
        ],
        temperature: 0.1,
        max_tokens: 1000
      }, {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 8000
      });

      return response.data.choices[0].message.content.trim();
    } catch (error) {
      logger.error('Translation error:', error.message);
      return text;
    }
  }

  // Translate user's message to English for internal processing
  async translateToEnglish(text, sourceLangCode, sourceLangName) {
    if (sourceLangCode === 'en' || sourceLangCode === 'hi-Latn') return text;

    // Use Sarvam for Indian languages
    const sarvamService = require('./sarvam.service');
    if (sarvamService.isConfigured() && sarvamService.isIndianLanguage(sourceLangCode)) {
      const translated = await sarvamService.translate(text, sourceLangCode, 'en');
      if (translated && translated !== text) return translated;
      // Fall through to GPT if Sarvam fails
    }

    try {
      const response = await axios.post(apiUrl, {
        model,
        messages: [
          {
            role: 'system',
            content: `Translate the following ${sourceLangName} text to English. Preserve any names, numbers, dates, times, phone numbers exactly as they are. Output ONLY the English translation.`
          },
          { role: 'user', content: text }
        ],
        temperature: 0.1,
        max_tokens: 500
      }, {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 5000
      });

      return response.data.choices[0].message.content.trim();
    } catch (error) {
      logger.error('Translation to English error:', error.message);
      return text;
    }
  }

  setUserLanguage(userPhone, langInfo) {
    this.userLanguageCache.set(userPhone, { ...langInfo, timestamp: Date.now() });
  }

  getUserLanguage(userPhone) {
    const cached = this.userLanguageCache.get(userPhone);
    if (cached && (Date.now() - cached.timestamp) < this.cacheTTL) return cached;
    return null;
  }
}

module.exports = new LanguageService();
