'use strict';

// Shared terminal-outcome post-processing for Ari's agent runtimes.
//
// Extracted from agno-agent.service.js so agno and the native loop apply the
// exact same rules for (a) mapping a terminal tool result onto the run status
// and (b) refusing to let model prose contradict verified tool results.

const { legacyStringFailed } = require('./tool-result.service');

/**
 * @param {object} input
 * @param {string} input.modelStatus       provider-reported final status
 * @param {string} input.modelText         provider-reported final text
 * @param {Array}  input.toolResults       normalized tool results, in order
 * @param {object|null} input.terminalToolResult  latched terminal result
 * @param {number} input.toolsUsedCount
 * @returns {{ status: string, text: string|null }}
 */
/** Human-readable action name for a tool, for honest failure text. */
function readableTool(name) {
  return String(name || 'that action').replace(/_/g, ' ');
}

/**
 * Last result per tool. A tool that failed and then succeeded on retry (the
 * model correcting invalid arguments, say) is RECOVERED and must not poison
 * the outcome; only its final attempt counts.
 */
function finalResultsPerTool(toolResults) {
  const lastByTool = new Map();
  for (const result of toolResults || []) {
    lastByTool.set(String(result?.tool || '(unknown)'), result);
  }
  return [...lastByTool.values()];
}

/**
 * Past-tense claims that a MUTATION completed. Nothing in Ari can create,
 * change, or delete anything without a tool call, so a claim like this in a
 * turn that executed zero tools is false by construction — not a judgement
 * call, an invariant.
 *
 * Deliberately narrow: only first-person completion claims about write verbs.
 * "Here are your reminders" or "I can add that for you" must not match.
 */
const CLAIMED_MUTATION = new RegExp(
  String.raw`\b(?:i(?:'ve| have)?\s+)?(?:successfully\s+)?`
  + String.raw`(?:added|created|saved|updated|changed|renamed|deleted|removed|archived|restored`
  + String.raw`|scheduled|started|sent|marked|completed|assigned|moved|set up|logged|posted|cancelled|canceled)\b`,
  'i',
);

/**
 * True when the model narrated a completed mutation without calling anything.
 * Observed in the wild: after several successful turns the model pattern-matches
 * the conversation and answers "Onboarding started for Priya" having executed
 * no tools at all. The user believes the work happened.
 */
function claimsMutationWithoutActing(text, toolsUsedCount) {
  if (toolsUsedCount > 0) return false;
  const value = String(text || '').trim();
  if (!value) return false;
  // A question or an offer is not a claim.
  if (/\?\s*$/.test(value)) return false;
  if (/\b(?:would you like|shall i|do you want|should i|i can|i could|let me know)\b/i.test(value)) return false;
  return CLAIMED_MUTATION.test(value);
}

function finalizeAgentOutcome({ modelStatus, modelText, toolResults, terminalToolResult, toolsUsedCount }) {
  const results = Array.isArray(toolResults) ? toolResults : [];
  const finalResults = finalResultsPerTool(results);
  const unrecoveredFailures = finalResults.filter(
    (result) => result?.status === 'failure' || result?.status === 'partial',
  );
  const anySuccess = finalResults.some((result) => result?.status === 'success');

  let status = String(modelStatus || 'completed').toLowerCase();
  if (terminalToolResult?.status === 'waiting_approval') status = 'waiting_approval';
  else if (terminalToolResult?.status === 'waiting_input') status = 'waiting_input';
  else if (terminalToolResult?.error?.category === 'unknown_outcome') status = 'partial';
  else if (terminalToolResult?.status === 'failure' || terminalToolResult?.status === 'partial') {
    status = anySuccess ? 'partial' : 'failed';
  } else if (status === 'error') status = toolsUsedCount > 0 ? 'partial' : 'failed';
  else if (unrecoveredFailures.length > 0) {
    // A plain tool failure does not latch a terminal result, so without this
    // a run where one action failed was still recorded as "completed" — the
    // ledger claiming more than actually happened.
    status = anySuccess ? 'partial' : 'failed';
  }

  const terminalMustFence = terminalToolResult && terminalToolResult.status !== 'success';
  const trimmedModelText = String(modelText || '').trim();
  const verifiedSuccessText = results
    .filter((result) => result.status === 'success' && result.user_summary)
    .map((result) => result.user_summary)
    .join('\n');
  // Tool results are the source of truth. If every executed tool succeeded
  // but the model nevertheless writes failure-leading prose, return the
  // verified summaries instead of persisting a contradictory claim.
  const contradictsVerifiedSuccess = results.length > 0
    && results.every((result) => result.status === 'success')
    && legacyStringFailed(trimmedModelText);
  let text = String(
    terminalMustFence
      ? terminalToolResult.user_summary
      : (contradictsVerifiedSuccess
        ? verifiedSuccessText
        : (trimmedModelText || terminalToolResult?.user_summary || verifiedSuccessText))
  ).trim() || null;

  // The dangerous direction: a tool FAILED but the model narrates success
  // ("I've added it to the email" when the tool returned nothing). Never let
  // that stand alone — append what actually failed, in the user's terms.
  if (!terminalMustFence && unrecoveredFailures.length > 0 && text && !legacyStringFailed(text)) {
    const failureLines = unrecoveredFailures.map((result) => {
      const summary = String(result?.user_summary || '').trim();
      return summary || `I could not complete ${readableTool(result?.tool)}.`;
    });
    text = [text, ...failureLines].join('\n\n');
  }

  // Nothing can be created, changed, or deleted without a tool call. A reply
  // asserting that a mutation happened in a turn that ran zero tools is
  // therefore false — the model narrated the action instead of taking it.
  // Refuse to pass it off as done; the user would believe the work landed.
  if (claimsMutationWithoutActing(text, toolsUsedCount) && !terminalMustFence) {
    status = 'failed';
    text = 'I described that as done, but I did not actually run it — so nothing changed. '
      + 'Say it again and I will carry it out properly.';
  }

  return { status, text };
}

module.exports = { finalizeAgentOutcome, claimsMutationWithoutActing };
