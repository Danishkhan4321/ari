'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_TRANSCRIPTS = 10;
const MAX_TEXT_LENGTH = 20_000;

function normalizeItem(value) {
  const text = String(value?.text || '').trim().slice(0, MAX_TEXT_LENGTH);
  const id = String(value?.id || '').trim().slice(0, 80);
  const createdAt = String(value?.createdAt || '').trim();
  if (!id || !text || Number.isNaN(Date.parse(createdAt))) return null;
  return {
    id,
    text,
    createdAt,
    pasted: value?.pasted === true,
  };
}

function readItems(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const values = Array.isArray(parsed) ? parsed : parsed?.items;
    if (!Array.isArray(values)) return [];
    return values.map(normalizeItem).filter(Boolean).slice(0, MAX_TRANSCRIPTS);
  } catch (_) {
    return [];
  }
}

function writeItems(filePath, items) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  const payload = { version: 1, items: items.slice(0, MAX_TRANSCRIPTS) };
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function createTranscriptHistory(filePath, {
  createId = () => crypto.randomUUID(),
  now = () => new Date().toISOString(),
} = {}) {
  let items = readItems(filePath);

  function list() {
    return items.map((item) => ({ ...item }));
  }

  function add({ text, pasted = false } = {}) {
    const item = normalizeItem({ id: createId(), text, createdAt: now(), pasted });
    if (!item) return null;
    items = [item, ...items.filter((existing) => existing.id !== item.id)].slice(0, MAX_TRANSCRIPTS);
    writeItems(filePath, items);
    return { ...item };
  }

  function find(id) {
    const item = items.find((candidate) => candidate.id === String(id || ''));
    return item ? { ...item } : null;
  }

  return { add, find, list };
}

module.exports = {
  MAX_TEXT_LENGTH,
  MAX_TRANSCRIPTS,
  createTranscriptHistory,
  normalizeItem,
  readItems,
};
