'use strict';

/**
 * Shared embedding utility.
 *
 * Provider order:
 * 1. Explicit EMBEDDING_PROVIDER: fireworks, gemini, or openai.
 * 2. Fireworks Qwen3 embeddings when FIREWORKS_API_KEY is set.
 * 3. Gemini embeddings when GEMINI_API_KEY is set.
 * 4. OpenAI embeddings when OPENAI_API_KEY is set.
 *
 * Returns the OpenAI-compatible shape: Array<{ embedding: number[] }>.
 */

const axios = require('axios');

const FIREWORKS_EMBED_URL = `${(process.env.FIREWORKS_BASE_URL || 'https://api.fireworks.ai/inference/v1').replace(/\/+$/, '')}/embeddings`;
const GEMINI_EMBED_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/embeddings';
const OPENAI_EMBED_URL = 'https://api.openai.com/v1/embeddings';

const FIREWORKS_MODEL_DEFAULT = process.env.FIREWORKS_EMBEDDING_MODEL || 'fireworks/qwen3-embedding-8b';
const GEMINI_MODEL_DEFAULT = process.env.EMBEDDING_GEMINI_MODEL || 'gemini-embedding-001';
const OPENAI_MODEL_DEFAULT = process.env.EMBEDDING_OPENAI_MODEL || 'text-embedding-3-small';

function resolveProvider() {
  const explicit = (process.env.EMBEDDING_PROVIDER || '').toLowerCase();
  if (explicit === 'fireworks' && process.env.FIREWORKS_API_KEY) return 'fireworks';
  if (explicit === 'gemini' && process.env.GEMINI_API_KEY) return 'gemini';
  if (explicit === 'openai' && process.env.OPENAI_API_KEY) return 'openai';

  if (process.env.FIREWORKS_API_KEY) return 'fireworks';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return null;
}

async function embed(input, options = {}) {
  const provider = options.provider || resolveProvider();
  if (!provider) {
    throw new Error('No embedding provider available - set FIREWORKS_API_KEY, GEMINI_API_KEY, or OPENAI_API_KEY');
  }

  const timeout = options.timeout || 15000;

  if (provider === 'fireworks') {
    const payload = {
      model: options.model || FIREWORKS_MODEL_DEFAULT,
      input,
    };
    if (options.dimensions || process.env.FIREWORKS_EMBEDDING_DIMENSIONS) {
      payload.dimensions = Number(options.dimensions || process.env.FIREWORKS_EMBEDDING_DIMENSIONS);
    }
    const response = await axios.post(FIREWORKS_EMBED_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.FIREWORKS_API_KEY}`,
      },
      timeout,
    });
    return response.data.data;
  }

  if (provider === 'gemini') {
    const response = await axios.post(
      GEMINI_EMBED_URL,
      { model: options.model || GEMINI_MODEL_DEFAULT, input },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.GEMINI_API_KEY}`,
        },
        timeout,
      }
    );
    return response.data.data;
  }

  const response = await axios.post(
    OPENAI_EMBED_URL,
    { model: options.model || OPENAI_MODEL_DEFAULT, input },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      timeout,
    }
  );
  return response.data.data;
}

async function embedOne(text, options = {}) {
  const data = await embed(text, options);
  return data[0]?.embedding;
}

module.exports = { embed, embedOne, resolveProvider };
