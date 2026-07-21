/**
 * News Service — world top-N news in the last 24h via Exa.
 *
 * Pipeline:
 *   1. Exa search with category='news', startPublishedDate = now - 24h
 *   2. Dedup by domain + title similarity
 *   3. Quality gate via LLM — reject press releases, opinion pieces,
 *      listicles, clickbait, already-covered duplicates
 *   4. Summarise each into a single-line what-this-is-about description
 *
 * Deep-dive (per item):
 *   5. Firecrawl scrape the URL (main content only, max 10k chars)
 *   6. LLM summary (~100-150 words): what the article actually says
 *
 * Used by briefing.service.js for the morning roundup, and by the
 * webhook controller for "know more about #N" follow-ups.
 */

const axios = require('axios');
const logger = require('../utils/logger');
const exa = require('./exa.service');
const firecrawl = require('./firecrawl.service');
const { openaiBreaker } = require('../utils/circuit-breakers');
const { llmTrace } = require('../utils/llm-trace');
const { generateObject } = require('ai');
const llm = require('./llm-provider');
const { z } = require('zod');

// Model slot — news uses the default model. Env override still supported,
// but by default it follows the active LLM_PROVIDER (Gemini 3 Flash).
const NEWS_MODEL = process.env.NEWS_MODEL || llm.defaultModel();

// Zod schemas for structured news outputs — replaces manual JSON.parse.
const CurateSchema = z.object({
  items: z.array(z.object({
    idx: z.number().int(),
    one_liner: z.string()
  }))
});
const DeepDiveSchema = z.object({
  summary: z.string(),
  key_points: z.array(z.string()).default([])
});
const NEWS_QUERIES = [
  'top world news today breaking',
  'major international news happening today',
  'top business and technology news today',
  'important political news today worldwide'
];

/**
 * Fetch top N world news items from the last 24h.
 *
 * @param {object} opts
 * @param {number} [opts.limit=10]
 * @param {number} [opts.hours=24] - how recent
 * @param {string[]} [opts.topics] - optional user-preferred topic hints
 * @returns {Promise<{ok: boolean, items?: Array<{title, summary, url, publishedAt, source}>, error?: string}>}
 */
async function getTopNews(opts = {}) {
  const { limit = 10, hours = 24, topics = [] } = opts;

  if (!exa.isConfigured()) {
    return { ok: false, error: 'Exa not configured — news feed unavailable' };
  }

  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  // Build query set — base world-news queries plus any user topics
  const queries = [...NEWS_QUERIES];
  for (const topic of topics.slice(0, 2)) {
    queries.push(`${topic} latest news today`);
  }

  // Search in parallel
  const searches = await Promise.all(
    queries.map(q =>
      exa.exaSearch({
        query: q,
        category: 'news',
        numResults: 8,
        startPublishedDate: since,
        withContents: true,
        maxCharacters: 2000
      }).catch(e => ({ ok: false, error: e.message }))
    )
  );

  // Flatten + dedupe by URL and by coarse title similarity
  const seenUrls = new Set();
  const seenTitleHashes = new Set();
  const pool = [];

  for (const s of searches) {
    if (!s.ok || !Array.isArray(s.results)) continue;
    for (const r of s.results) {
      if (!r.url || !r.title) continue;
      if (seenUrls.has(r.url)) continue;

      // Normalize title for dedup (first 10 words lowercased)
      const titleHash = r.title
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 10)
        .join(' ');
      if (seenTitleHashes.has(titleHash)) continue;

      seenUrls.add(r.url);
      seenTitleHashes.add(titleHash);
      pool.push({
        title: r.title,
        url: r.url,
        publishedAt: r.publishedDate,
        source: extractDomain(r.url),
        text: r.text || r.summary || ''
      });
    }
  }

  if (pool.length === 0) {
    return { ok: false, error: 'No fresh news found in the last 24 hours' };
  }

  logger.info({ component: 'news', poolSize: pool.length, hours }, 'News pool assembled');

  // Quality + summary in one LLM pass
  const curated = await curateNews(pool, limit);

  return { ok: true, items: curated };
}

/**
 * Deep-dive on a single news item — fetch the full article and summarise.
 *
 * @param {{url: string, title: string}} item
 * @returns {Promise<{ok: boolean, summary?: string, keyPoints?: string[], error?: string}>}
 */
async function deepDive(item) {
  if (!item?.url) return { ok: false, error: 'No URL to expand' };

  // 1. Pull article content via Firecrawl
  let articleText = '';
  let articleMeta = {};
  if (firecrawl.isConfigured()) {
    try {
      const scrape = await firecrawl.scrape({
        url: item.url,
        formats: ['markdown'],
        onlyMainContent: true,
        timeout: 20000
      });
      if (scrape.ok && scrape.markdown) {
        articleText = scrape.markdown.slice(0, 12000);
        articleMeta = scrape.metadata || {};
      }
    } catch (e) {
      logger.debug(`News deep-dive scrape failed: ${e.message}`);
    }
  }

  // Fallback: Exa getContents
  if (!articleText && exa.isConfigured()) {
    try {
      const contents = await exa.exaGetContents({ urls: [item.url], maxCharacters: 12000 });
      if (contents.ok && contents.results?.[0]?.text) {
        articleText = contents.results[0].text;
      }
    } catch (e) {
      logger.debug(`News deep-dive exa fallback failed: ${e.message}`);
    }
  }

  if (!articleText || articleText.length < 200) {
    return {
      ok: false,
      error: 'Could not retrieve the full article. Open it in a browser:\n' + item.url
    };
  }

  // 2. LLM summary
  const apiKey = llm.apiKey();
  if (!apiKey) {
    // Fallback: return a trimmed excerpt
    return {
      ok: true,
      summary: articleText.slice(0, 500) + (articleText.length > 500 ? '...' : ''),
      keyPoints: []
    };
  }

  const system = `You are a concise news explainer. The user just saw a one-line headline and wants to know what the article actually says.

Output JSON with:
- summary: 100-150 words in plain English explaining what the article covers — the WHO, WHAT, WHERE, WHEN, and SO WHAT. Skip intro filler. No quotes around the summary.
- key_points: 3-5 short bullet strings (max 15 words each) covering the most important specific facts or developments.

Stay faithful to the article — do not add speculation, context from elsewhere, or opinions.`;

  try {
    const result = await llmTrace(
      { name: 'news.deep_dive', model: NEWS_MODEL, tags: ['news', 'summarize', 'generateObject'] },
      () => openaiBreaker.fire(async () => generateObject({
        model: llm.sdkModel('default'),
        schema: DeepDiveSchema,
        system,
        prompt: `TITLE: ${item.title}\n\nARTICLE:\n${articleText}`,
        temperature: 0.2,
        maxRetries: 2,
        abortSignal: AbortSignal.timeout(30000)
      }))
    );

    return {
      ok: true,
      summary: result.object.summary || '',
      keyPoints: result.object.key_points || []
    };
  } catch (e) {
    if (e?.degraded) return { ok: true, summary: articleText.slice(0, 700), keyPoints: [] };
    logger.warn(`News deep-dive LLM failed: ${e.message}`);
    return { ok: true, summary: articleText.slice(0, 700), keyPoints: [] };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * One LLM call — rank + summarise the top N. Rejects non-news in the same pass.
 */
async function curateNews(pool, limit) {
  const apiKey = llm.apiKey();

  // If no LLM, fall back to simple ranking by recency + first-seen
  if (!apiKey) {
    return pool.slice(0, limit).map(p => ({
      title: p.title,
      summary: p.text ? p.text.slice(0, 150) : '',
      url: p.url,
      publishedAt: p.publishedAt,
      source: p.source
    }));
  }

  const system = `You curate the ${limit} most significant world news stories from the past 24 hours.

REJECT (do not include):
- Press releases / promotional content
- Opinion pieces, editorials, "explainers" without a news trigger
- Listicles ("Top 10 ways to...")
- Celebrity gossip unless genuinely major
- Region-specific local stories unless global in impact
- Duplicate stories (pick the best single version)

PREFER:
- Breaking hard news (politics, conflict, markets, tech developments, science)
- Broad global significance — something an informed person should know today
- Mix of beats: don't return 10 politics stories; aim for diversity

For each chosen story, write ONE plain-English line (15-25 words) describing what the news is — so a person reading the headline understands at a glance. Avoid jargon and clickbait.

Output JSON: { "items": [{"idx": <number>, "one_liner": "<15-25 words, plain English>"}] }

Order items by significance (most important first). Include AT MOST ${limit}.`;

  const payload = pool.slice(0, 40).map((p, i) => ({
    idx: i,
    title: p.title,
    source: p.source,
    published: p.publishedAt,
    excerpt: (p.text || '').slice(0, 400)
  }));

  try {
    const result = await llmTrace(
      { name: 'news.curate', model: NEWS_MODEL, tags: ['news', 'curate', 'generateObject'] },
      () => openaiBreaker.fire(async () => generateObject({
        model: llm.sdkModel('default'),
        schema: CurateSchema,
        system,
        prompt: JSON.stringify(payload),
        temperature: 0.2,
        maxRetries: 2,
        abortSignal: AbortSignal.timeout(30000)
      }))
    );

    const selected = (result.object.items || []).slice(0, limit);

    return selected.map(sel => {
      const src = pool[Number(sel.idx)];
      if (!src) return null;
      return {
        title: src.title,
        summary: sel.one_liner || '',
        url: src.url,
        publishedAt: src.publishedAt,
        source: src.source
      };
    }).filter(Boolean);
  } catch (e) {
    if (e?.degraded) {
      return pool.slice(0, limit).map(p => ({
        title: p.title, summary: (p.text || '').slice(0, 150),
        url: p.url, publishedAt: p.publishedAt, source: p.source
      }));
    }
    logger.warn(`News curation LLM failed: ${e.message}`);
    return pool.slice(0, limit).map(p => ({
      title: p.title,
      summary: (p.text || '').slice(0, 150),
      url: p.url,
      publishedAt: p.publishedAt,
      source: p.source
    }));
  }
}

function extractDomain(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

module.exports = {
  getTopNews,
  deepDive
};
