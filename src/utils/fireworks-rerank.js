'use strict';

const axios = require('axios');

const FIREWORKS_RERANK_URL = `${(process.env.FIREWORKS_BASE_URL || 'https://api.fireworks.ai/inference/v1').replace(/\/+$/, '')}/rerank`;
const FIREWORKS_RERANKER_MODEL = process.env.FIREWORKS_RERANKER_MODEL || 'fireworks/qwen3-reranker-8b';

function isAvailable() {
  return process.env.FIREWORKS_RERANKER_ENABLED !== 'false'
    && !!process.env.FIREWORKS_API_KEY;
}

function normalizeResults(data) {
  const rows = Array.isArray(data?.results) ? data.results
    : Array.isArray(data?.data) ? data.data
    : [];

  return rows
    .map((row, fallbackIndex) => ({
      index: Number.isInteger(row.index) ? row.index : fallbackIndex,
      score: typeof row.relevance_score === 'number' ? row.relevance_score
        : typeof row.score === 'number' ? row.score
        : Array.isArray(row.embedding) && typeof row.embedding[1] === 'number' ? row.embedding[1]
        : 0,
      document: row.document,
    }))
    .sort((a, b) => b.score - a.score);
}

async function rerank(query, documents, options = {}) {
  if (!isAvailable()) return null;
  if (!query || !Array.isArray(documents) || documents.length === 0) return null;

  const response = await axios.post(
    FIREWORKS_RERANK_URL,
    {
      model: options.model || FIREWORKS_RERANKER_MODEL,
      query,
      documents,
      top_n: Math.max(1, Math.min(options.topN || documents.length, documents.length)),
      return_documents: options.returnDocuments === true,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.FIREWORKS_API_KEY}`,
      },
      timeout: options.timeout || 10000,
    }
  );

  return normalizeResults(response.data);
}

module.exports = {
  isAvailable,
  rerank,
};
