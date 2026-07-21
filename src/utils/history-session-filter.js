'use strict';

/**
 * Trim conversation_history rows down to the *current session* before they
 * are sent to the LLM.
 *
 * Why this exists
 * ---------------
 * Without this filter, ai.service.js sends up to 100 rows from the last 14
 * days into every chat call. The LLM then "improvises" clarification
 * examples by splicing fragments from prior days' messages — most
 * famously the `kainsl vn en too` voice-transcription gibberish that kept
 * surfacing inside `Example: "Remind X: ..."` lines, plus "cancel 1 & 2"
 * style commands that bled across day boundaries.
 *
 * The DB still keeps 30 days for audit and for features that explicitly
 * query history (search, recall) — but the *LLM context window* should
 * only see what the user is actively talking about right now.
 *
 * Algorithm
 * ---------
 * Walk the list newest-first looking for the first inter-message gap
 * larger than `sessionGapMinutes`. Everything from that boundary forward
 * is the current session; anything older is dropped.
 *
 * Defensive behavior:
 *  - empty / null / undefined → []
 *  - single row → returned as-is
 *  - rows missing `created_at` → returned as-is (we can't time-split them)
 *
 * @param {Array<{role: string, content: string, created_at?: string|Date}>} messages
 *        Rows in chronological order (oldest first), as ai.service.js loads them.
 * @param {number} [sessionGapMinutes=60]
 *        Inter-message gap that defines a "session boundary".
 * @returns {Array<object>} the current-session slice of `messages`.
 */
function filterToCurrentSession(messages, sessionGapMinutes = 60) {
  if (!Array.isArray(messages) || messages.length <= 1) {
    return Array.isArray(messages) ? messages : [];
  }

  // If any row lacks a parseable timestamp, fall through unchanged — we
  // can't safely time-split a list with missing data.
  const ts = new Array(messages.length);
  for (let i = 0; i < messages.length; i++) {
    const raw = messages[i] && messages[i].created_at;
    const t = raw ? new Date(raw).getTime() : NaN;
    if (Number.isNaN(t)) return messages;
    ts[i] = t;
  }

  const gapMs = sessionGapMinutes * 60_000;

  // Walk backward from newest. The first gap > threshold is the boundary;
  // everything from index `i` onward is the current session.
  let sessionStart = 0;
  for (let i = messages.length - 1; i > 0; i--) {
    if (ts[i] - ts[i - 1] > gapMs) {
      sessionStart = i;
      break;
    }
  }
  return messages.slice(sessionStart);
}

module.exports = { filterToCurrentSession };
