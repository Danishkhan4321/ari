/**
 * OCR service — wraps Marker API (https://www.datalab.to) for extracting text
 * from scanned/image-based PDFs where `pdf-parse` returns empty.
 *
 * Why needed: Ari's users often send scanned utility bills, receipts, and
 * photographed documents as PDFs. The existing `pdf-parse` only reads PDFs with
 * an embedded text layer. On scans it returns "" and the LLM fabricates a
 * summary from the filename — a serious trust problem ("due March 28" when
 * the actual due date is April 25).
 *
 * How it works:
 *  1. Called only when pdf-parse returns < 100 chars (scanned-PDF heuristic)
 *  2. Uploads PDF to Datalab Marker API
 *  3. Polls the async job endpoint for completion
 *  4. Returns markdown-formatted text (preserves tables, headings)
 *
 * Fails open: if MARKER_API_KEY isn't set or the API errors, returns null and
 * the caller falls back to existing behavior (LLM summarizes filename + empty
 * text). The existing pdf-parse path is untouched.
 *
 * Pricing: ~$3 per 1,000 pages at the time of writing. At 500 DAU × 5% PDF
 * send rate × 3 pages average = ~$7/month. Track usage via Langfuse custom metric.
 */

const axios = require('axios');
const FormData = require('form-data');
const logger = require('../utils/logger');

const MARKER_BASE_URL = process.env.MARKER_API_URL || 'https://www.datalab.to/api/v1/marker';
const MARKER_API_KEY = process.env.MARKER_API_KEY;
const MIN_TEXT_LENGTH_BEFORE_OCR = parseInt(process.env.OCR_FALLBACK_THRESHOLD || '100', 10);
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 60; // 3 minutes max (60 × 3s)

/**
 * Should we attempt OCR fallback? Only if:
 *  - MARKER_API_KEY is configured
 *  - extracted text is shorter than the threshold (scanned-PDF signal)
 *
 * @param {string} extractedText
 * @returns {boolean}
 */
function shouldFallback(extractedText) {
  if (!MARKER_API_KEY) return false;
  if (typeof extractedText !== 'string') return true;
  return extractedText.trim().length < MIN_TEXT_LENGTH_BEFORE_OCR;
}

/**
 * Run OCR against a PDF buffer. Returns extracted markdown text or null on failure.
 *
 * @param {Buffer} pdfBuffer
 * @param {string} [fileName='document.pdf']
 * @returns {Promise<string|null>}
 */
async function extractFromPdf(pdfBuffer, fileName = 'document.pdf') {
  if (!MARKER_API_KEY) {
    return null;
  }

  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
    logger.warn('OCR: empty or invalid PDF buffer');
    return null;
  }

  try {
    // Step 1: submit the document for processing.
    const form = new FormData();
    form.append('file', pdfBuffer, { filename: fileName, contentType: 'application/pdf' });
    form.append('output_format', 'markdown');
    form.append('use_llm', 'false');       // Save cost — plain OCR is usually enough
    form.append('force_ocr', 'false');     // Let Marker decide if OCR is needed
    form.append('paginate', 'false');

    const submitStart = Date.now();
    const submitRes = await axios.post(MARKER_BASE_URL, form, {
      headers: {
        'X-Api-Key': MARKER_API_KEY,
        ...form.getHeaders()
      },
      timeout: 60000,
      maxContentLength: 25 * 1024 * 1024, // 25MB cap to match WhatsApp media limit
      maxBodyLength: 25 * 1024 * 1024
    });

    const checkUrl = submitRes.data?.request_check_url;
    const requestId = submitRes.data?.request_id;
    if (!checkUrl) {
      logger.warn('OCR: no request_check_url in Marker submit response');
      return null;
    }

    logger.info(`OCR: submitted to Marker (request_id=${requestId}, ${Date.now() - submitStart}ms)`);

    // Step 2: poll for completion.
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      await sleep(POLL_INTERVAL_MS);

      let poll;
      try {
        poll = await axios.get(checkUrl, {
          headers: { 'X-Api-Key': MARKER_API_KEY },
          timeout: 15000
        });
      } catch (e) {
        logger.debug(`OCR: poll attempt ${attempt + 1} errored: ${e.message}`);
        continue;
      }

      const status = poll.data?.status;
      if (status === 'complete') {
        const markdown = poll.data?.markdown || poll.data?.output || '';
        const pages = poll.data?.page_count || '?';
        logger.info(`OCR: complete (${pages} pages, ${Math.round(markdown.length / 1000)}k chars)`);
        return markdown.trim() || null;
      }

      if (status === 'failed' || status === 'error') {
        logger.warn(`OCR: Marker reported status=${status}, error=${poll.data?.error || 'unknown'}`);
        return null;
      }

      // Still processing — continue polling.
    }

    logger.warn(`OCR: Marker did not complete within ${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s — giving up`);
    return null;
  } catch (e) {
    const status = e.response?.status;
    const bodyPreview = e.response?.data
      ? JSON.stringify(e.response.data).slice(0, 200)
      : e.message;
    logger.warn(`OCR: Marker call failed (status=${status}): ${bodyPreview}`);
    return null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isAvailable() {
  return !!MARKER_API_KEY;
}

module.exports = { shouldFallback, extractFromPdf, isAvailable };
