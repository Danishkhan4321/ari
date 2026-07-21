/**
 * Exa AI Search integration — primary opportunity discovery engine.
 *
 * Why Exa (vs Tavily/Andi): Exa is purpose-built for AI agent workflows.
 * It has curated indexes for research papers (100M+), personal sites, companies,
 * and news — letting us target specific slices (peer review calls, organizer
 * contacts, demo listings) with `category` filters instead of relying on
 * generic web ranking.
 *
 * Use in Visa Profile Builder:
 *   - exaSearch({query, category: 'research paper'}) → peer review calls
 *   - exaSearch({query, category: 'personal site'}) → find organizer contacts
 *   - exaDeepSearch({query}) → iterative multi-step opportunity discovery
 *   - exaGetContents({urls}) → extract structured data from opportunity pages
 *   - exaStructuredSearch({query, schema}) → grounded JSON answers with citations
 *
 * Docs: https://docs.exa.ai
 * Config:
 *   EXA_API_KEY=exa_xxx  (required — fails open without it)
 */

const logger = require('../utils/logger');
const { openaiEmbeddingsBreaker } = require('../utils/circuit-breakers'); // reused — TODO: add dedicated exaBreaker

const EXA_API_KEY = process.env.EXA_API_KEY;

let exaClient = null;
let initAttempted = false;

function getClient() {
  if (initAttempted) return exaClient;
  initAttempted = true;

  if (!EXA_API_KEY) {
    logger.info('Exa: disabled (EXA_API_KEY not set)');
    return null;
  }

  try {
    const Exa = require('exa-js').default || require('exa-js');
    exaClient = new Exa(EXA_API_KEY);
    logger.info('Exa: enabled (client initialized)');
  } catch (e) {
    logger.warn(`Exa init failed: ${e.message}`);
    exaClient = null;
  }

  return exaClient;
}

function isConfigured() {
  return !!EXA_API_KEY;
}

/**
 * Basic web search with optional content extraction.
 *
 * @param {object} opts
 * @param {string} opts.query
 * @param {'auto'|'fast'|'instant'|'deep-lite'|'deep'|'deep-reasoning'} [opts.type='auto']
 * @param {number} [opts.numResults=10]
 * @param {string} [opts.category] - 'research paper'|'personal site'|'company'|'news'|'tweet'|'github'|'pdf'|'financial report'
 * @param {string[]} [opts.includeDomains]
 * @param {string[]} [opts.excludeDomains]
 * @param {string} [opts.startPublishedDate] - ISO date
 * @param {string} [opts.endPublishedDate]
 * @param {boolean} [opts.withContents=true] - fetch full text too
 * @param {number} [opts.maxCharacters=20000]
 * @param {number} [opts.maxAgeHours] - omit for default behavior; 0 = always livecrawl
 * @returns {Promise<{ok: boolean, results?: Array, error?: string}>}
 */
async function exaSearch(opts) {
  const client = getClient();
  if (!client) {
    return { ok: false, degraded: true, error: 'Exa not configured (EXA_API_KEY missing)' };
  }

  const {
    query,
    type = 'auto',
    numResults = 10,
    category,
    includeDomains,
    excludeDomains,
    startPublishedDate,
    endPublishedDate,
    withContents = true,
    maxCharacters = 20000,
    maxAgeHours
  } = opts || {};

  if (!query || typeof query !== 'string') {
    return { ok: false, error: 'query is required' };
  }

  // Category + excludeDomains is a 400 on Exa — guard against it.
  const safeOpts = { type, numResults };
  if (category) safeOpts.category = category;
  if (includeDomains?.length) safeOpts.includeDomains = includeDomains;
  if (excludeDomains?.length && category !== 'company' && category !== 'people') {
    safeOpts.excludeDomains = excludeDomains;
  }
  if (startPublishedDate) safeOpts.startPublishedDate = startPublishedDate;
  if (endPublishedDate) safeOpts.endPublishedDate = endPublishedDate;

  // Contents configuration
  if (withContents) {
    safeOpts.text = { maxCharacters };
    if (typeof maxAgeHours === 'number') safeOpts.maxAgeHours = maxAgeHours;
  }

  const start = Date.now();
  try {
    const method = withContents ? 'searchAndContents' : 'search';
    const response = await client[method](query, safeOpts);
    const elapsed = Date.now() - start;

    logger.info({
      component: 'exa',
      op: method,
      type,
      numResults,
      category,
      elapsed,
      resultCount: response.results?.length || 0
    }, `Exa search completed in ${elapsed}ms`);

    return {
      ok: true,
      results: (response.results || []).map(r => ({
        title: r.title,
        url: r.url,
        publishedDate: r.publishedDate,
        author: r.author,
        text: r.text,
        highlights: r.highlights,
        summary: r.summary,
        score: r.score
      })),
      requestId: response.requestId,
      costDollars: response.costDollars,
      latencyMs: elapsed
    };
  } catch (error) {
    const apiMsg = error.response?.data?.error || error.response?.data?.message || error.message;
    logger.warn(`Exa search failed (${Date.now() - start}ms): ${apiMsg}`);
    return { ok: false, error: apiMsg };
  }
}

/**
 * Deep iterative search — for complex opportunity research.
 * Exa agent decomposes the query, searches multiple angles, iterates.
 *
 * @param {object} opts - same as exaSearch but type defaults to 'deep'
 */
async function exaDeepSearch(opts) {
  return exaSearch({ ...opts, type: opts?.type || 'deep' });
}

/**
 * Extract content from known URLs.
 *
 * @param {object} opts
 * @param {string[]} opts.urls
 * @param {number} [opts.maxCharacters=20000]
 * @param {boolean} [opts.highlights=false] - return highlights instead of full text
 * @param {string} [opts.highlightsQuery] - relevance query for highlights
 * @param {number} [opts.maxAgeHours] - freshness control
 */
async function exaGetContents(opts) {
  const client = getClient();
  if (!client) return { ok: false, degraded: true, error: 'Exa not configured' };

  const {
    urls,
    maxCharacters = 20000,
    highlights = false,
    highlightsQuery,
    maxAgeHours
  } = opts || {};

  if (!Array.isArray(urls) || urls.length === 0) {
    return { ok: false, error: 'urls array is required' };
  }

  const config = {};
  if (highlights) {
    config.highlights = { maxCharacters: Math.min(maxCharacters, 4000) };
    if (highlightsQuery) config.highlights.query = highlightsQuery;
  } else {
    config.text = { maxCharacters };
  }
  if (typeof maxAgeHours === 'number') config.maxAgeHours = maxAgeHours;

  const start = Date.now();
  try {
    const response = await client.getContents(urls, config);
    const elapsed = Date.now() - start;
    logger.info({
      component: 'exa',
      op: 'getContents',
      urlCount: urls.length,
      elapsed
    }, `Exa getContents completed in ${elapsed}ms`);

    return {
      ok: true,
      results: (response.results || []).map(r => ({
        title: r.title,
        url: r.url,
        text: r.text,
        highlights: r.highlights,
        publishedDate: r.publishedDate,
        author: r.author
      })),
      latencyMs: elapsed
    };
  } catch (error) {
    const apiMsg = error.response?.data?.error || error.response?.data?.message || error.message;
    logger.warn(`Exa getContents failed (${Date.now() - start}ms): ${apiMsg}`);
    return { ok: false, error: apiMsg };
  }
}

/**
 * Structured output search — returns grounded JSON matching your schema.
 * Best for enrichment: "find demos, return structured list with name/date/url/email".
 *
 * @param {object} opts
 * @param {string} opts.query
 * @param {object} opts.schema - JSON Schema (Exa's subset: max depth 2, max 10 properties)
 * @param {'auto'|'deep-lite'|'deep'|'deep-reasoning'} [opts.type='deep']
 * @param {string} [opts.category]
 */
async function exaStructuredSearch(opts) {
  const client = getClient();
  if (!client) return { ok: false, degraded: true, error: 'Exa not configured' };

  const { query, schema, type = 'deep', category } = opts || {};

  if (!query || !schema) {
    return { ok: false, error: 'query and schema are required' };
  }

  const searchOpts = {
    type,
    outputSchema: schema,
    contents: { highlights: { maxCharacters: 4000 } }
  };
  if (category) searchOpts.category = category;

  const start = Date.now();
  try {
    const response = await client.search(query, searchOpts);
    const elapsed = Date.now() - start;
    logger.info({
      component: 'exa',
      op: 'structuredSearch',
      type,
      category,
      elapsed
    }, `Exa structuredSearch completed in ${elapsed}ms`);

    return {
      ok: true,
      output: response.output?.content,
      grounding: response.output?.grounding,
      rawResults: response.results,
      latencyMs: elapsed
    };
  } catch (error) {
    const apiMsg = error.response?.data?.error || error.response?.data?.message || error.message;
    logger.warn(`Exa structuredSearch failed (${Date.now() - start}ms): ${apiMsg}`);
    return { ok: false, error: apiMsg };
  }
}

/**
 * Find a person's contact info / professional profile.
 * Uses category='personal site' to target individual websites.
 *
 * @param {object} opts
 * @param {string} opts.name
 * @param {string} [opts.context] - org, role, topic hints
 */
async function findPerson(opts) {
  const { name, context } = opts || {};
  if (!name) return { ok: false, error: 'name is required' };

  const query = context
    ? `${name} ${context} contact email personal site`
    : `${name} personal website contact`;

  return exaSearch({
    query,
    category: 'personal site',
    numResults: 5,
    withContents: true,
    maxCharacters: 8000
  });
}

/**
 * Find academic / research content (for peer review discovery, author outreach).
 *
 * @param {object} opts
 * @param {string} opts.query
 * @param {number} [opts.numResults=10]
 */
async function findResearchPapers(opts) {
  const { query, numResults = 10 } = opts || {};
  if (!query) return { ok: false, error: 'query is required' };

  return exaSearch({
    query,
    category: 'research paper',
    numResults,
    withContents: true,
    maxCharacters: 8000
  });
}

module.exports = {
  isConfigured,
  exaSearch,
  exaDeepSearch,
  exaGetContents,
  exaStructuredSearch,
  findPerson,
  findResearchPapers
};
