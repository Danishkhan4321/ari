/**
 * Firecrawl integration — structured web scraping for opportunity enrichment.
 *
 * Complements Exa: Exa finds opportunity URLs; Firecrawl fetches the page
 * and extracts structured data (deadline, contact email, application URL) with
 * schema-based JSON output.
 *
 * Use in Visa Profile Builder:
 *   - scrapeOpportunity(url) → clean markdown + structured fields
 *   - scrapeWithSchema(url, schema) → JSON matching your schema
 *   - searchFirecrawl(query) → fallback search if Exa fails
 *   - mapSite(rootUrl) → discover URLs on a conference / demo site
 *
 * Fails open if FIRECRAWL_API_KEY is not set — callers check `.ok`.
 *
 * Docs: https://docs.firecrawl.dev
 */

const logger = require('../utils/logger');

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;

let client = null;
let initAttempted = false;

function getClient() {
  if (initAttempted) return client;
  initAttempted = true;

  if (!FIRECRAWL_API_KEY) {
    logger.info('Firecrawl: disabled (FIRECRAWL_API_KEY not set)');
    return null;
  }

  try {
    const mod = require('@mendable/firecrawl-js');
    const Firecrawl = mod.default || mod.Firecrawl || mod;
    client = new Firecrawl({ apiKey: FIRECRAWL_API_KEY });
    logger.info('Firecrawl: enabled (client initialized)');
  } catch (e) {
    logger.warn(`Firecrawl init failed: ${e.message}`);
    client = null;
  }

  return client;
}

function isConfigured() {
  return !!FIRECRAWL_API_KEY;
}

/**
 * Scrape a single URL and return clean markdown + optional structured extraction.
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {string[]} [opts.formats=['markdown']]  - 'markdown' | 'html' | 'links' | 'screenshot'
 * @param {object} [opts.jsonSchema]  - if set, Firecrawl extracts JSON matching this schema
 * @param {string} [opts.jsonPrompt]  - natural-language prompt for JSON extraction
 * @param {number} [opts.timeout=30000]
 * @param {boolean} [opts.onlyMainContent=true]
 * @returns {Promise<{ok: boolean, markdown?: string, json?: object, metadata?: object, error?: string}>}
 */
async function scrape(opts) {
  const c = getClient();
  if (!c) return { ok: false, degraded: true, error: 'Firecrawl not configured' };

  const {
    url,
    formats = ['markdown'],
    jsonSchema,
    jsonPrompt,
    timeout = 30000,
    onlyMainContent = true
  } = opts || {};

  if (!url) return { ok: false, error: 'url is required' };

  // Build request config
  const scrapeOpts = {
    formats: [...formats],
    onlyMainContent,
    timeout
  };

  if (jsonSchema || jsonPrompt) {
    // Firecrawl v2 API format: json format is an object with { type, schema, prompt }
    // (v1 pattern of `formats.push('json'); jsonOptions = {...}` is rejected by the current API)
    const jsonFormat = { type: 'json' };
    if (jsonSchema) jsonFormat.schema = jsonSchema;
    if (jsonPrompt) jsonFormat.prompt = jsonPrompt;
    scrapeOpts.formats.push(jsonFormat);
  }

  const start = Date.now();
  try {
    // SDK method is scrapeUrl (v1) — check both for compatibility
    const scrapeMethod = (typeof c.scrapeUrl === 'function') ? 'scrapeUrl'
                      : (typeof c.scrape === 'function') ? 'scrape'
                      : null;
    if (!scrapeMethod) {
      throw new Error('Firecrawl SDK has no scrape/scrapeUrl method');
    }
    const result = await c[scrapeMethod](url, scrapeOpts);
    const elapsed = Date.now() - start;

    // Firecrawl v1 SDK returns data at the top level OR nested under data
    const data = result?.data || result;

    logger.info({
      component: 'firecrawl',
      op: 'scrape',
      url: url.slice(0, 100),
      elapsed,
      hasMarkdown: !!data?.markdown,
      hasJson: !!data?.json,
      markdownLen: data?.markdown?.length || 0
    }, `Firecrawl scraped ${url.slice(0, 60)} in ${elapsed}ms`);

    return {
      ok: true,
      markdown: data?.markdown,
      html: data?.html,
      links: data?.links,
      json: data?.json,
      metadata: data?.metadata,
      latencyMs: elapsed
    };
  } catch (error) {
    const msg = error.response?.data?.error || error.message;
    logger.warn(`Firecrawl scrape failed for ${url}: ${msg}`);
    return { ok: false, error: msg };
  }
}

/**
 * Scrape an opportunity page and extract structured fields.
 * Pre-configured schema for demos / CFPs / peer review calls.
 *
 * @param {string} url
 * @returns {Promise<{ok: boolean, data?: object, error?: string}>}
 */
async function scrapeOpportunity(url) {
  const result = await scrape({
    url,
    formats: ['markdown'],
    jsonPrompt: `Extract the following from this opportunity page. Return null for any field not clearly present on the page — DO NOT guess or hallucinate:

- title: event/opportunity name
- organizer: organization running it
- event_date: when the event/program happens (ISO 8601 if possible)
- application_deadline: last date to apply (ISO 8601)
- location: city/country or "remote" or "virtual"
- remote_ok: true if remote participation allowed
- contact_email: primary email to reach organizers
- contact_person: name of point of contact if listed
- application_url: the actual URL to apply (not the page URL)
- eligibility: who can apply
- categories: array of topical tags (AI, web3, sustainability, etc.)
- prize_or_compensation: money / benefits offered
- is_judge_opportunity: true if they're calling for judges/reviewers/mentors
- is_speaker_opportunity: true if they're calling for speakers/presenters
- is_participant_only: true if this is just participation, not judging/speaking
- has_application_form: TRUE if the page contains a real application/submission form (HTML form with name+email+content fields, or an embedded Tally/Typeform/Google Form). A bare mailto: link does NOT count.
- application_form_url: the URL the user opens to fill the form. Use the page URL if the form is inline; the embed src if it is a Tally/Typeform/Google Form iframe; or null if no form exists.`,
    jsonSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        organizer: { type: 'string' },
        event_date: { type: 'string' },
        application_deadline: { type: 'string' },
        location: { type: 'string' },
        remote_ok: { type: 'boolean' },
        contact_email: { type: 'string' },
        contact_person: { type: 'string' },
        application_url: { type: 'string' },
        eligibility: { type: 'string' },
        categories: { type: 'array', items: { type: 'string' } },
        prize_or_compensation: { type: 'string' },
        is_judge_opportunity: { type: 'boolean' },
        is_speaker_opportunity: { type: 'boolean' },
        is_participant_only: { type: 'boolean' },
        has_application_form: {
          type: 'boolean',
          description: 'TRUE if the page contains a real application/submission form (HTML form with name+email+content fields, or an embedded Tally/Typeform/Google Form). A bare mailto: link does not count.'
        },
        application_form_url: {
          // Match the schema-form used by every other nullable field above
          // (plain `'string'`); nullability is enforced at the return layer
          // via `?? null`. Mixed `type: ['string','null']` form risks
          // tripping Zod-based validators in the Firecrawl SDK.
          type: 'string',
          description: 'The URL the user opens to fill the form. Use the page URL if the form is inline; the embed src if it is a Tally/Typeform/Google Form iframe; or null if no form exists.'
        }
      }
    }
  });

  // Surface the fields that downstream code branches on directly on the result,
  // with sane defaults so callers never see `undefined`. The full extraction
  // remains accessible via `result.json` for backward compatibility.
  const j = result?.json || {};
  // Strict `=== true`: the LLM may return `"true"` (string), `1`, or
  // `"TRUE"` — all of which we want to coerce to `false` so a
  // false-positive form match never sends the user down the wrong
  // branch. A false negative is recoverable (user falls back to email).
  const hasForm = j.has_application_form === true;
  const formUrl = j.application_form_url ?? null;
  return {
    ...result,
    // If the LLM said "form detected" but didn't extract a URL, treat it
    // as no form — downstream guard `if (has_application_form && form_url)`
    // would reject it anyway, but normalising here keeps the row clean.
    has_application_form: hasForm && !!formUrl,
    application_form_url: hasForm ? formUrl : null,
    contact_email: j.contact_email ?? null
  };
}

/**
 * Firecrawl web search — returns results with optional full-page markdown.
 * Fallback if Exa fails or for specific domain searches.
 *
 * @param {object} opts
 * @param {string} opts.query
 * @param {number} [opts.limit=10]
 * @param {boolean} [opts.includePageContent=false]
 */
async function searchFirecrawl(opts) {
  const c = getClient();
  if (!c) return { ok: false, degraded: true, error: 'Firecrawl not configured' };

  const { query, limit = 10, includePageContent = false } = opts || {};
  if (!query) return { ok: false, error: 'query is required' };

  const searchOpts = { limit };
  if (includePageContent) {
    searchOpts.scrapeOptions = { formats: ['markdown'], onlyMainContent: true };
  }

  const start = Date.now();
  try {
    // SDK: `search` exists in newer versions; older versions only scrape
    if (typeof c.search !== 'function') {
      return { ok: false, error: 'Firecrawl SDK does not support search on this version' };
    }
    const result = await c.search(query, searchOpts);
    const elapsed = Date.now() - start;
    const data = result?.data || result;

    logger.info({
      component: 'firecrawl',
      op: 'search',
      query: query.slice(0, 60),
      limit,
      elapsed,
      resultCount: data?.length || 0
    }, `Firecrawl search completed in ${elapsed}ms`);

    return {
      ok: true,
      results: (Array.isArray(data) ? data : [data]).map(r => ({
        title: r.title,
        url: r.url,
        description: r.description,
        markdown: r.markdown,
        metadata: r.metadata
      })),
      latencyMs: elapsed
    };
  } catch (error) {
    const msg = error.response?.data?.error || error.message;
    logger.warn(`Firecrawl search failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

/**
 * Map a site — discover all URLs reachable from a root URL.
 * Useful for finding all sub-pages of a demo/conference site (track pages, judges page, sponsors, etc.)
 *
 * @param {object} opts
 * @param {string} opts.url  - root URL to start from
 * @param {number} [opts.limit=50]
 * @param {string} [opts.search]  - optional search term to filter URLs
 */
async function mapSite(opts) {
  const c = getClient();
  if (!c) return { ok: false, degraded: true, error: 'Firecrawl not configured' };

  const { url, limit = 50, search } = opts || {};
  if (!url) return { ok: false, error: 'url is required' };

  const mapOpts = { limit };
  if (search) mapOpts.search = search;

  const start = Date.now();
  try {
    const mapMethod = (typeof c.mapUrl === 'function') ? 'mapUrl'
                    : (typeof c.map === 'function') ? 'map'
                    : null;
    if (!mapMethod) {
      return { ok: false, error: 'Firecrawl SDK has no map/mapUrl method' };
    }
    const result = await c[mapMethod](url, mapOpts);
    const elapsed = Date.now() - start;
    const links = result?.links || result?.data?.links || [];

    logger.info({
      component: 'firecrawl',
      op: 'map',
      url: url.slice(0, 60),
      elapsed,
      linkCount: links.length
    }, `Firecrawl map found ${links.length} links in ${elapsed}ms`);

    return { ok: true, links, latencyMs: elapsed };
  } catch (error) {
    const msg = error.response?.data?.error || error.message;
    logger.warn(`Firecrawl map failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

module.exports = {
  isConfigured,
  scrape,
  scrapeOpportunity,
  searchFirecrawl,
  mapSite
};
