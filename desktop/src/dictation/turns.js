(function exposeTurns(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ariDictationTurns = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  function upsertTurn(turns, message = {}) {
    const order = Number(message.turn_order);
    const formattedUtterance = message.turn_is_formatted === true ? message.utterance : '';
    const value = String(formattedUtterance || message.transcript || message.utterance || '').trim();
    if (!Number.isInteger(order) || order < 0 || !value) return false;
    turns.set(order, value);
    return true;
  }

  function transcriptText(turns) {
    return [...turns.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, value]) => value)
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function compactPreview(value, maxWords = 3) {
    const words = String(value || '').trim().split(/\s+/).filter(Boolean);
    const limit = Math.max(1, Math.floor(Number(maxWords) || 3));
    if (words.length <= limit) return words.join(' ');
    return `${words.slice(0, limit).join(' ')}\u2026`;
  }

  return { compactPreview, transcriptText, upsertTurn };
}));
