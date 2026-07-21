/**
 * LLM output validation — catches context-bleed bugs.
 *
 * Problem: when the LLM is asked to fill a text parameter (e.g. the
 * reminder's `message` field), it can grab random stale strings from
 * the conversation history rather than reading the user's actual
 * current request. We saw this in production: a user said *"use that
 * text which i just gave you"* and the LLM returned a phrase from
 * YESTERDAY'S conversation instead.
 *
 * This utility compares an LLM-produced text against the user's
 * current message and flags outputs that likely didn't come from the
 * current user turn.
 *
 * It is a HEURISTIC — not perfect, but catches the worst cases:
 *   - Completely fabricated strings (no overlap with user text)
 *   - Strings lifted from old context (no overlap with CURRENT user turn)
 *
 * Caller should treat a "suspicious" result as a signal to fall back
 * (to regex extraction, to asking the user, etc.) rather than silently
 * committing the value.
 */

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'to', 'for', 'at', 'in', 'on', 'of', 'with', 'and',
  'or', 'but', 'if', 'is', 'am', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'should', 'could', 'may', 'might', 'can', 'i', 'you', 'he', 'she',
  'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your',
  'his', 'its', 'our', 'their', 'this', 'that', 'these', 'those',
  'what', 'when', 'where', 'who', 'why', 'how', 'just', 'set',
  'create', 'make', 'remind', 'reminder', 'please', 'kindly',
  'ok', 'okay', 'yes', 'no', 'pm', 'am', 'hi', 'hello', 'hey',
  'give', 'gave', 'use', 'used'
]);

/**
 * Tokenize a string into comparable "content words":
 *   - lowercase
 *   - strip punctuation
 *   - remove stop words
 *   - keep only tokens of 3+ characters
 */
function contentTokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOP_WORDS.has(t));
}

/**
 * Check if an LLM-produced text parameter is plausibly sourced from the
 * user's current message. Returns {ok, overlap, suspicious} where:
 *   - ok:         boolean — safe to use the LLM value as-is
 *   - overlap:    number  — fraction of LLM tokens found in user text (0..1)
 *   - suspicious: boolean — negate of `ok`, for readability
 *
 * A value is safe if:
 *   - It's very short (<3 chars) — nothing meaningful to validate
 *   - It's a verbatim substring of the user text
 *   - At least 30% of its content tokens appear in the user text
 *
 * @param {string} llmText     - the parameter value the LLM produced
 * @param {string} userText    - the user's CURRENT message (just this turn)
 * @param {object} [opts]
 * @param {number} [opts.minOverlap=0.3] - required token overlap fraction
 * @returns {{ok: boolean, overlap: number, suspicious: boolean, reason?: string}}
 */
function checkTextFromUser(llmText, userText, opts = {}) {
  const minOverlap = typeof opts.minOverlap === 'number' ? opts.minOverlap : 0.3;

  const llm = String(llmText || '').trim();
  const user = String(userText || '').trim();

  if (llm.length < 3) {
    return { ok: true, overlap: 1, suspicious: false, reason: 'too_short_to_validate' };
  }

  // Verbatim substring — definitely came from the user
  if (user.toLowerCase().includes(llm.toLowerCase())) {
    return { ok: true, overlap: 1, suspicious: false, reason: 'verbatim' };
  }

  const llmTokens = contentTokens(llm);
  const userTokens = new Set(contentTokens(user));

  if (llmTokens.length === 0) {
    return { ok: true, overlap: 1, suspicious: false, reason: 'no_content_tokens' };
  }

  const matched = llmTokens.filter(t => userTokens.has(t)).length;
  const overlap = matched / llmTokens.length;

  // Tighter rule: overlap alone isn't enough. We require either:
  //   (a) at least 2 content tokens matched AND minOverlap met, OR
  //   (b) overall overlap >= 0.8 (i.e. nearly all of the LLM output lines
  //       up with user text — room for 1 paraphrase word)
  // Without the min-match-count gate, incidental overlap on common
  // words ("time", "call") can hide real context-bleed bugs.
  const ok = (matched >= 2 && overlap >= minOverlap) || overlap >= 0.8;

  return {
    ok,
    overlap,
    suspicious: !ok,
    reason: ok ? 'sufficient_overlap' : (matched < 2 ? 'too_few_matched_tokens' : 'low_overlap'),
    matched,
    total: llmTokens.length
  };
}

module.exports = {
  checkTextFromUser,
  contentTokens
};
