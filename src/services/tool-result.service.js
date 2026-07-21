'use strict';

const VALID_STATUSES = new Set(['success', 'failure', 'partial', 'waiting_approval', 'waiting_input']);
const LEGACY_FAILURE_RE = /^(?:error\b|failed\b|failure\b|could\s+not\b|couldn['’]?t\b|i\s+couldn['’]?t\b|something\s+went\s+wrong\b|you\s+need\b|temporarily\s+unavailable\b|(?:google|outlook|apple|calendar|email|drive)\s+(?:is\s+)?not\s+connected\b|authentication\s+(?:is\s+)?required\b|not\s+configured\b)/i;
const LEGACY_PARTIAL_RE = /^(?:sent\s+to\s+[1-9]\d*\s*\/\s*\d+,\s*then\s+hit\s+a\s+problem\b|task\s+created,\s*but\s+i\s+couldn(?:['’]t|\s+not)\b|[1-9]\d*\s*\/\s*\d+\s+emails?\s+scheduled\.[\s\S]*\bfailed\s*:)/i;

function stripLeadingStatusGlyphs(text) {
  // Legacy handlers often prefix failures with ❌, ⚠️, or ⛔. Classify
  // the words after those presentation glyphs while preserving the original
  // user-facing message.
  return String(text || '').replace(
    /^(?:(?:[\u2600-\u27BF]|\p{Extended_Pictographic}|\uFE0F|\u200D)\s*)+/u,
    '',
  );
}

function legacyStringFailed(text) {
  const compact = String(text || '').trim().slice(0, 1000);
  const semantic = stripLeadingStatusGlyphs(compact);
  return LEGACY_FAILURE_RE.test(semantic)
    || /^i\s+was\s+not\s+able\b/i.test(semantic)
    || /^aborted\b/i.test(semantic)
    || /^(?:scheduling|translation)\s+failed\b/i.test(semantic)
    || /^task\s+error\b/i.test(semantic)
    || /^sent\s+to\s+0\s*\/\s*\d+,\s*then\s+hit\s+a\s+problem\b/i.test(semantic)
    || /\bbut\s+(?:i\s+)?couldn(?:['’]t|\s+not)\b/i.test(semantic)
    || /^(?:invalid\b|unable\s+to\b|cannot\b|can['’]?t\b|not\s+found\b|no\s+recent\b|missing\b|unsupported\b|expired\b)/i.test(semantic)
    || /\b(?:is|are)\s+not\s+(?:connected|configured|available|authorized)\b/i.test(semantic)
    || /\bnot\s+found\b/i.test(semantic)
    || /\b(?:failed\s+to|does\s+not\s+exist|could\s+not)\b/i.test(semantic)
    || /\b(?:permission|access)\s+denied\b/i.test(semantic)
    || /\b(?:already\s+in\s+the\s+past|please\s+(?:provide|specify|choose|connect|attach|select)|must\s+(?:provide|specify|choose))\b/i.test(semantic);
}

function legacyStringPartial(text) {
  const semantic = stripLeadingStatusGlyphs(String(text || '').trim().slice(0, 4000));
  return LEGACY_PARTIAL_RE.test(semantic);
}

function normalizeError(error, fallbackMessage = 'Tool execution failed.') {
  if (error && typeof error === 'object') {
    return {
      code: String(error.code || 'tool_error'),
      category: String(error.category || 'execution'),
      retryable: error.retryable === true,
      message: String(error.message || fallbackMessage),
    };
  }
  return {
    code: 'tool_error',
    category: 'execution',
    retryable: false,
    message: String(error || fallbackMessage),
  };
}

function normalizeToolResult(value, options = {}) {
  const tool = String(options.toolName || value?.tool || 'unknown_tool');

  if (value && typeof value === 'object' && VALID_STATUSES.has(value.status)) {
    const status = value.status;
    const userSummary = typeof value.user_summary === 'string'
      ? value.user_summary
      : (typeof value.result === 'string' ? value.result : '');
    return {
      status,
      ok: status === 'success',
      tool,
      data: value.data ?? null,
      error: status === 'failure' || status === 'partial'
        ? normalizeError(value.error, userSummary || 'Tool did not complete.')
        : null,
      user_summary: userSummary,
      evidence: Array.isArray(value.evidence) ? value.evidence.slice(0, 20) : [],
      meta: { ...(value.meta && typeof value.meta === 'object' ? value.meta : {}), typed: true },
    };
  }

  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) {
      return {
        status: 'failure', ok: false, tool, data: null,
        error: {
          code: 'empty_tool_result', category: 'execution', retryable: false,
          message: 'The tool returned an empty result, so completion could not be verified.',
        },
        user_summary: `${tool} returned no result; completion was not verified.`,
        evidence: [], meta: { legacy: true },
      };
    }
    const partial = legacyStringPartial(text);
    const failed = !partial && legacyStringFailed(text);
    const status = partial ? 'partial' : (failed ? 'failure' : 'success');
    return {
      status,
      ok: status === 'success',
      tool,
      data: null,
      error: failed || partial ? {
        code: partial ? 'legacy_tool_partial' : 'legacy_tool_error',
        category: 'business_rule',
        retryable: false,
        message: text || (partial ? 'Tool completed only partially.' : 'Tool execution failed.'),
      } : null,
      user_summary: text,
      evidence: [],
      meta: { legacy: true },
    };
  }

  if (value && typeof value === 'object') {
    const explicitlyFailed = value.ok === false
      || value.success === false
      || Boolean(value.error && value.ok !== true && value.success !== true);
    const userSummary = typeof value.result === 'string'
      ? value.result
      : (typeof value.user_summary === 'string'
        ? value.user_summary
        : (typeof value.message === 'string' ? value.message : ''));
    const data = value.data !== undefined
      ? value.data
      : Object.fromEntries(Object.entries(value).filter(([key]) => !['ok', 'error', 'result', 'user_summary', 'tool'].includes(key)));
    return {
      status: explicitlyFailed ? 'failure' : 'success',
      ok: !explicitlyFailed,
      tool,
      data,
      error: explicitlyFailed ? normalizeError(value.error, userSummary || 'Tool execution failed.') : null,
      user_summary: userSummary,
      evidence: Array.isArray(value.evidence) ? value.evidence.slice(0, 20) : [],
      meta: { legacy: true },
    };
  }

  return {
    status: 'failure', ok: false, tool, data: null,
    error: {
      code: 'empty_tool_result', category: 'execution', retryable: false,
      message: 'The tool returned no result, so completion could not be verified.',
    },
    user_summary: `${tool} returned no result; completion was not verified.`,
    evidence: [], meta: { legacy: true },
  };
}

function compactData(value, depth = 0, options = {}) {
  const maxDepth = options.maxDepth || 5;
  const maxItems = options.maxItems || 12;
  const maxKeys = options.maxKeys || 30;
  const maxString = options.maxString || 700;
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > maxString ? `${value.slice(0, maxString)}…` : value;
  if (typeof value === 'bigint') return String(value);
  if (depth >= maxDepth) return '[nested data omitted]';
  if (Array.isArray(value)) {
    const items = value.slice(0, maxItems).map((item) => compactData(item, depth + 1, options));
    if (value.length > maxItems) items.push({ omitted_items: value.length - maxItems });
    return items;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    const out = Object.fromEntries(entries.slice(0, maxKeys)
      .map(([key, item]) => [key, compactData(item, depth + 1, options)]));
    if (entries.length > maxKeys) out.omitted_fields = entries.length - maxKeys;
    return out;
  }
  return String(value).slice(0, maxString);
}

function serializeToolResult(result, maxChars = 4000) {
  const normalized = normalizeToolResult(result, { toolName: result?.tool });
  const serialized = JSON.stringify(normalized);
  if (serialized.length <= maxChars) return serialized;

  let bounded = {
    status: normalized.status,
    ok: normalized.ok,
    tool: normalized.tool,
    // Preserve compact IDs/counts/records for subsequent CRM steps. Dropping
    // the entire data object here used to make the agent forget what it made.
    data: compactData(normalized.data),
    error: normalized.error,
    user_summary: String(normalized.user_summary || '').slice(0, Math.max(120, maxChars - 1200)),
    evidence: normalized.evidence.slice(0, 3),
    meta: { ...normalized.meta, truncated: true, original_chars: serialized.length },
  };
  let compacted = JSON.stringify(bounded);
  if (compacted.length <= maxChars) return compacted;

  bounded = {
    ...bounded,
    data: compactData(normalized.data, 0, { maxDepth: 3, maxItems: 4, maxKeys: 12, maxString: 220 }),
  };
  compacted = JSON.stringify(bounded);
  if (compacted.length <= maxChars) return compacted;

  bounded.data = null;
  bounded.meta = { ...bounded.meta, data_omitted: true };
  return JSON.stringify(bounded);
}

module.exports = {
  normalizeToolResult,
  serializeToolResult,
  compactData,
  legacyStringFailed,
  legacyStringPartial,
  stripLeadingStatusGlyphs,
};
