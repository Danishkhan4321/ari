'use strict';

const logger = require('../utils/logger');

const LOG_PREFIX = '[Mem0]';

/**
 * Smart memory service powered by Mem0 OSS.
 * Uses pgvector for semantic search, entity linking, and hybrid BM25 scoring.
 * Wraps Mem0's Memory class to work with the bot's existing memory API.
 */
class Mem0MemoryService {
  constructor() {
    this.memory = null;
    this.initialized = false;
    this.initializing = false;
  }

  /**
   * Lazily initialize Mem0 Memory instance.
   * Called on first use, not at startup (to avoid blocking boot).
   */
  async initialize() {
    if (this.initialized) return true;
    if (this.initializing) {
      // Wait for ongoing initialization
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (this.initialized) return true;
      }
      return false;
    }

    this.initializing = true;

    try {
      const { Memory } = require('mem0ai/oss');

      // Parse DATABASE_URL for pgvector config
      const dbUrl = process.env.DATABASE_URL || '';
      const url = new URL(dbUrl.replace('postgresql://', 'http://'));

      // Bug #1 fix (Apr 2026): Switched embedder + LLM from OpenAI → Gemini.
      // OpenAI quota was exhausted (429s), breaking mem0 entirely. Gemini's
      // OpenAI-compat endpoint accepts the same `openai` provider config —
      // just point baseURL at Google's API and use the new key.
      //
      // gemini-embedding-001 returns 3072-dim vectors by default. We use a
      // Ari's v2 collection avoids the earlier pgvector schema clash.
      // with the old 1536-dim OpenAI vectors. Old memories are orphaned —
      // acceptable since OpenAI 429s meant most weren't being saved anyway.
      const useGemini = !!process.env.GEMINI_API_KEY;
      const geminiBase = 'https://generativelanguage.googleapis.com/v1beta/openai/';

      const config = {
        embedder: useGemini ? {
          provider: 'openai', // mem0 OSS routes via the openai shape
          config: {
            apiKey: process.env.GEMINI_API_KEY,
            model: process.env.MEM0_EMBEDDING_MODEL || 'gemini-embedding-001',
            baseURL: geminiBase,
          },
        } : {
          provider: 'openai',
          config: {
            apiKey: process.env.OPENAI_API_KEY,
            model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
          },
        },
        vectorStore: {
          provider: 'pgvector',
          config: {
            collectionName: useGemini ? 'ari_memories_v2' : 'ari_memories',
            dbname: url.pathname.replace('/', '') || 'postgres',
            user: decodeURIComponent(url.username),
            password: decodeURIComponent(url.password),
            host: url.hostname,
            port: parseInt(url.port) || 5432,
            embeddingModelDims: useGemini ? 3072 : 1536,
            hnsw: true,
            sslmode: 'require',
          },
        },
        llm: useGemini ? {
          provider: 'openai', // OpenAI-compat shape pointing at Gemini
          config: {
            apiKey: process.env.GEMINI_API_KEY,
            model: process.env.MEM0_LLM_MODEL || 'gemini-2.5-flash',
            baseURL: geminiBase,
          },
        } : {
          provider: 'openai',
          config: {
            apiKey: process.env.OPENAI_API_KEY,
            model: process.env.OPENAI_FAST_MODEL || 'gpt-4o-mini',
          },
        },
        disableHistory: true, // We don't need SQLite history tracking
      };

      this.memory = new Memory(config);
      this.initialized = true;
      logger.info(`${LOG_PREFIX} Initialized with pgvector (${url.hostname})`);
      return true;
    } catch (error) {
      logger.error(`${LOG_PREFIX} Initialization failed: ${error.message}`);
      this.initializing = false;
      return false;
    }
  }

  /**
   * Check if Mem0 is available — needs EITHER Gemini (preferred) or OpenAI key.
   * MEM0_ENABLED=false cleanly disables the whole layer (no init attempts,
   * no per-restart error logs) — callers all gate on isAvailable().
   */
  isAvailable() {
    if (process.env.MEM0_ENABLED === 'false') return false;
    return !!(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY);
  }

  /**
   * Add a memory from a conversation message.
   * Mem0 automatically extracts facts, deduplicates, and resolves conflicts.
   *
   * @param {string} message - The user's message containing facts to remember
   * @param {string} userPhone - User identifier
   * @param {object} [metadata] - Optional metadata (category, subject, etc.)
   * @returns {Promise<object>} - The saved memory result
   */
  async add(message, userPhone, metadata = {}) {
    if (!await this.initialize()) return { success: false, error: 'Mem0 not initialized' };

    try {
      const result = await this.memory.add(message, {
        userId: userPhone,
        metadata: {
          category: metadata.category || 'general',
          subject: metadata.subject || null,
          source: 'whatsapp',
        },
      });

      const addedCount = result?.results?.length || 0;
      if (addedCount > 0) {
        logger.info(`${LOG_PREFIX} Added ${addedCount} memory(s) for ${userPhone}`);
      }

      return { success: true, count: addedCount, result };
    } catch (error) {
      logger.error(`${LOG_PREFIX} Add error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Search memories using semantic similarity + entity linking.
   * Returns the most relevant memories for a given query.
   *
   * @param {string} query - The search query
   * @param {string} userPhone - User identifier
   * @param {number} [topK=20] - Number of results to return
   * @returns {Promise<Array>} - Ranked list of relevant memories
   */
  async search(query, userPhone, topK = 20) {
    if (!await this.initialize()) return [];

    try {
      const results = await this.memory.search(query, {
        filters: { user_id: userPhone },
        limit: topK,
      });

      const memories = (results?.results || results || []).map(r => ({
        id: r.id,
        memory: r.memory || r.text || r.content,
        score: r.score || r.similarity || 0,
        metadata: r.metadata || {},
      }));

      logger.info(`${LOG_PREFIX} Search "${query.substring(0, 50)}" for ${userPhone}: ${memories.length} results`);
      return memories;
    } catch (error) {
      logger.error(`${LOG_PREFIX} Search error: ${error.message}`);
      return [];
    }
  }

  /**
   * Get all memories for a user.
   *
   * @param {string} userPhone - User identifier
   * @returns {Promise<Array>} - All memories
   */
  async getAll(userPhone) {
    if (!await this.initialize()) return [];

    try {
      const results = await this.memory.getAll({
        filters: { user_id: userPhone },
      });

      return (results?.results || results || []).map(r => ({
        id: r.id,
        memory: r.memory || r.text || r.content,
        metadata: r.metadata || {},
        createdAt: r.created_at,
      }));
    } catch (error) {
      logger.error(`${LOG_PREFIX} GetAll error: ${error.message}`);
      return [];
    }
  }

  /**
   * Delete a specific memory.
   *
   * @param {string} memoryId - Memory ID to delete
   * @returns {Promise<boolean>}
   */
  async delete(memoryId) {
    if (!await this.initialize()) return false;

    try {
      await this.memory.delete(memoryId);
      return true;
    } catch (error) {
      logger.error(`${LOG_PREFIX} Delete error: ${error.message}`);
      return false;
    }
  }

  /**
   * Delete all memories for a user.
   *
   * @param {string} userPhone - User identifier
   * @returns {Promise<boolean>}
   */
  async deleteAll(userPhone) {
    if (!await this.initialize()) return false;

    try {
      await this.memory.deleteAll({ filters: { userId: userPhone } });
      logger.info(`${LOG_PREFIX} Deleted all memories for ${userPhone}`);
      return true;
    } catch (error) {
      logger.error(`${LOG_PREFIX} DeleteAll error: ${error.message}`);
      return false;
    }
  }
}

module.exports = new Mem0MemoryService();
