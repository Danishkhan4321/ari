/**
 * LLM-powered Query Extractor
 *
 * Extracts the actual search intent from natural language instructions.
 * Used across all features (email, drive, docs, sheets, images, etc.)
 * to separate "what the user wants to find" from "how they asked for it".
 *
 * Example:
 *   Input:  "did i receive any email from dhenu today?"
 *   Output: { query: "dhenu", filters: { from: "dhenu", timeframe: "today" } }
 */

'use strict';

const axios = require('axios');
const logger = require('./logger');
const llm = require('../services/llm-provider');

const CACHE = new Map(); // Simple cache to avoid duplicate LLM calls
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Extract search query and filters from a natural language message.
 *
 * @param {string} message - The user's full message
 * @param {string} context - The feature context: "email", "drive", "docs", "sheets", "image", "note", "task", "contact"
 * @returns {Promise<{ query: string, filters: object }>}
 */
async function extractQuery(message, context = 'general') {
  if (!message || message.trim().length < 3) {
    return { query: message?.trim() || '', filters: {} };
  }

  // Check cache
  const cacheKey = `${context}:${message.toLowerCase().trim()}`;
  const cached = CACHE.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL) {
    return cached.result;
  }

  try {
    const apiKey = llm.apiKey();
    if (!apiKey) {
      return fallbackExtract(message, context);
    }

    const apiUrl = llm.chatUrl();
    const model = llm.fastModel();

    const systemPrompt = getSystemPrompt(context);

    const response = await axios.post(apiUrl, {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message },
      ],
      temperature: 0.1,
      max_tokens: 200,
    }, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 8000,
    });

    const content = response.data.choices[0].message.content;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const result = {
        query: parsed.query || parsed.search_query || '',
        filters: parsed.filters || {},
      };
      // Cache result
      CACHE.set(cacheKey, { result, ts: Date.now() });
      // Evict old entries
      if (CACHE.size > 500) {
        const oldest = [...CACHE.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, 250);
        for (const [key] of oldest) CACHE.delete(key);
      }
      logger.info(`[QueryExtractor] ${context}: "${message}" → query="${result.query}" filters=${JSON.stringify(result.filters)}`);
      return result;
    }
  } catch (error) {
    logger.warn(`[QueryExtractor] LLM failed for ${context}: ${error.message}`);
  }

  return fallbackExtract(message, context);
}

/**
 * Context-specific system prompts
 */
function getSystemPrompt(context) {
  const base = `You extract the ACTUAL search intent from a natural language message. The user is giving an instruction to an AI assistant — your job is to extract ONLY what they want to search for, removing all instructional/conversational text.

Return JSON: { "query": "the actual search term", "filters": { ...optional filters } }

Rules:
- REMOVE all instruction words: "find", "search", "show me", "did i receive", "do i have", "can you check", "list", "get", "fetch"
- REMOVE filler words: "any", "some", "the", "my", "please", "can you"
- KEEP the actual subject/topic/person/thing being searched
- If a person's name is mentioned, extract it as the query
- If a timeframe is mentioned (today, yesterday, last week), put it in filters.timeframe
- If "from" someone is mentioned, put the name in filters.from
- If "about" something is mentioned, put it in filters.about
- query should be SHORT — just the key search terms`;

  const contextRules = {
    email: `
Context: EMAIL search
Examples:
- "did i receive any email from dhenu today?" → {"query": "dhenu", "filters": {"from": "dhenu", "timeframe": "today"}}
- "check if john sent me the report" → {"query": "john report", "filters": {"from": "john"}}
- "any emails about the budget meeting?" → {"query": "budget meeting", "filters": {"about": "budget meeting"}}
- "show me mails from last week" → {"query": "", "filters": {"timeframe": "last week"}}
- "did danish reply to my email?" → {"query": "danish", "filters": {"from": "danish"}}`,

    drive: `
Context: GOOGLE DRIVE file search
Examples:
- "find the budget spreadsheet from last month" → {"query": "budget spreadsheet", "filters": {"timeframe": "last month"}}
- "do i have any files about the project proposal?" → {"query": "project proposal", "filters": {}}
- "search my drive for the marketing plan" → {"query": "marketing plan", "filters": {}}`,

    docs: `
Context: GOOGLE DOCS search
Examples:
- "find my document about meeting notes" → {"query": "meeting notes", "filters": {}}
- "search docs for quarterly report" → {"query": "quarterly report", "filters": {}}`,

    sheets: `
Context: GOOGLE SHEETS search
Examples:
- "find the expense tracker spreadsheet" → {"query": "expense tracker", "filters": {}}
- "show me the sales data sheet" → {"query": "sales data", "filters": {}}`,

    image: `
Context: IMAGE search/delete
Examples:
- "delete that image of the receipt from last week" → {"query": "receipt", "filters": {"timeframe": "last week"}}
- "find the screenshot i saved yesterday" → {"query": "screenshot", "filters": {"timeframe": "yesterday"}}
- "remove the photo of the whiteboard" → {"query": "whiteboard", "filters": {}}`,

    general: `
Examples:
- "find information about machine learning" → {"query": "machine learning", "filters": {}}
- "search for restaurants near me" → {"query": "restaurants near me", "filters": {}}`,
  };

  return base + (contextRules[context] || contextRules.general) + '\n\nOutput ONLY valid JSON.';
}

/**
 * Regex fallback when LLM is unavailable
 */
function fallbackExtract(message, context) {
  let query = message
    .replace(/^(did\s+i\s+receive|do\s+i\s+have|can\s+you\s+check|show\s+me|find|search|get|fetch|list|delete|remove)\s*/i, '')
    .replace(/\b(any|some|the|my|please|can\s+you|from\s+my)\b\s*/gi, '')
    .replace(/\b(email|emails|mail|mails|inbox|drive|file|files|document|docs?|sheets?|spreadsheets?|image|photo|picture)\b\s*/gi, '')
    .replace(/\b(for|from|about|with|containing|in|on)\s*/gi, '')
    .replace(/\b(today|yesterday|last\s+week|this\s+week|last\s+month)\b/gi, '')
    .replace(/[?.!]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return { query, filters: {} };
}

module.exports = { extractQuery };
