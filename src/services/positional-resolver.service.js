'use strict';

// Deterministic resolution of bare positional replies ("1", "#2", "number 3")
// against the most recent numbered list the user was shown
// (utils/list-position-cache). Runs BEFORE any model call: the resolved item
// is injected into contextHints/runtime context so the model receives the
// concrete id instead of guessing which tool a bare digit belongs to
// (smoke-test H-1: "1" after an email list routed to manage_images).

const listPositionCache = require('../utils/list-position-cache');

const BARE_NUMBER = /^\s*#?(\d{1,3})\s*$/;
const NUMBER_PHRASE = /^\s*(?:number|no\.?|item|option|the)\s+#?(\d{1,3})(?:st|nd|rd|th)?\s*$/i;

/**
 * @returns {null | { position: number, listType: string, id: any, label: string|null }}
 */
function resolve(userPhone, text) {
  const value = String(text || '');
  const match = value.match(BARE_NUMBER) || value.match(NUMBER_PHRASE);
  if (!match) return null;
  const position = Number(match[1]);
  if (!Number.isInteger(position) || position < 1) return null;
  const picked = listPositionCache.pickFromLatest(userPhone, position);
  if (!picked) return null;
  const item = picked.item || {};
  const label = String(item.title || item.label || item.name || item.message || '').slice(0, 120);
  return {
    position,
    listType: picked.listType,
    id: item.id ?? null,
    label: label || null,
  };
}

module.exports = { resolve };
