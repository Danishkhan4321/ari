'use strict';

/**
 * User Profile Inference Job
 *
 * Weekly cron. For each active user, aggregates their stored Mem0 entries
 * into a structured profile (preferred_name, work_hours, communication_style,
 * key_relationships, ongoing_projects, etc.) and upserts to `user_profiles`.
 * The context-builder reads this on every turn and injects it into the system
 * prompt — making Ari "know" each user the way ChatGPT does.
 *
 * Why weekly (not every turn):
 *   - Aggregation is LLM-based (expensive)
 *   - Profiles evolve slowly — daily would mostly churn on noise
 *   - Keeps infrastructure cost bounded (N users * 1 LLM call/week)
 *
 * Runs every Sunday at 03:00 local (server UTC). Skip flag: USER_PROFILE_JOB_ENABLED=false.
 */

const cron = require('node-cron');
const axios = require('axios');
const { query } = require('../config/database');
const logger = require('../utils/logger');
const llm = require('../services/llm-provider');

const ACTIVE_USER_WINDOW_DAYS = 14; // only profile users active in last 2 weeks
const MAX_USERS_PER_RUN = 200;      // safety cap on cost
const MAX_MEMORIES_PER_USER = 80;   // feed to LLM

class UserProfileJob {
  constructor() {
    this.isRunning = false;
    this.task = null;
  }

  async ensureSchema() {
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS user_profiles (
          phone_number VARCHAR(50) PRIMARY KEY,
          profile JSONB NOT NULL DEFAULT '{}'::jsonb,
          memories_count INT DEFAULT 0,
          last_updated TIMESTAMPTZ DEFAULT NOW(),
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_user_profiles_updated ON user_profiles(last_updated DESC)`);
    } catch (e) {
      logger.error('[UserProfileJob] Schema error: ' + e.message);
    }
  }

  start() {
    if (process.env.USER_PROFILE_JOB_ENABLED === 'false') {
      logger.info('[UserProfileJob] Disabled via env flag');
      return;
    }

    this.ensureSchema().catch(() => {});

    // Every Sunday at 03:00 server time. Override via env USER_PROFILE_CRON.
    const schedule = process.env.USER_PROFILE_CRON || '0 3 * * 0';
    this.task = cron.schedule(schedule, () => this.runOnce().catch(err => {
      logger.error('[UserProfileJob] run error: ' + err.message);
    }), { timezone: process.env.DEFAULT_TIMEZONE || 'UTC' });

    logger.info(`[UserProfileJob] Scheduled: ${schedule}`);
  }

  stop() {
    if (this.task) {
      this.task.stop();
      this.task = null;
    }
  }

  /**
   * Main run — iterate active users, infer profile for each.
   */
  async runOnce() {
    if (this.isRunning) {
      logger.warn('[UserProfileJob] Skipping — previous run still in progress');
      return;
    }
    this.isRunning = true;
    const startMs = Date.now();

    try {
      const activeUsers = await this._getActiveUsers();
      logger.info(`[UserProfileJob] Starting: ${activeUsers.length} active users`);

      let updated = 0, skipped = 0, errored = 0;
      for (const userPhone of activeUsers) {
        try {
          const inferred = await this._inferForUser(userPhone);
          if (inferred) {
            await this._upsertProfile(userPhone, inferred.profile, inferred.memoriesCount);
            updated++;
          } else {
            skipped++;
          }
        } catch (e) {
          logger.warn(`[UserProfileJob] ${userPhone}: ${e.message}`);
          errored++;
        }
      }

      const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
      logger.info(`[UserProfileJob] Done in ${elapsed}s: ${updated} updated, ${skipped} skipped, ${errored} errored`);

      // Piggyback weekly memory-trunk prune. pruneMemoryTrunk() exists in
      // memory.service but was never wired up; memory_trunk grew unbounded
      // for every user. Keep the most recent 200 entries per user, drop
      // the rest. Cheap window-function delete, runs once a week with the
      // profile job. Set MEMORY_PRUNE_ENABLED=false to disable.
      if (process.env.MEMORY_PRUNE_ENABLED !== 'false') {
        try {
          const memoryService = require('../services/memory.service');
          const keepPerUser = parseInt(process.env.MEMORY_PRUNE_KEEP || '200', 10);
          const r = await memoryService.pruneMemoryTrunk({ keepPerUser, dryRun: false });
          logger.info(`[UserProfileJob] Memory prune: kept ${keepPerUser}/user, deleted ${r?.deleted ?? '?'}`);
        } catch (e) {
          logger.warn(`[UserProfileJob] Memory prune skipped: ${e.message}`);
        }
      }
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Users who sent a message in last N days, cap at MAX_USERS_PER_RUN.
   */
  async _getActiveUsers() {
    try {
      const { rows } = await query(
        `SELECT DISTINCT user_phone FROM conversation_history
         WHERE created_at > NOW() - INTERVAL '${ACTIVE_USER_WINDOW_DAYS} days'
           AND role = 'user'
         ORDER BY user_phone
         LIMIT $1`,
        [MAX_USERS_PER_RUN]
      );
      return rows.map(r => r.user_phone).filter(Boolean);
    } catch (e) {
      logger.error('[UserProfileJob] active-user query failed: ' + e.message);
      return [];
    }
  }

  /**
   * Infer the profile for one user by summarizing their Mem0 entries via LLM.
   * Returns null if the user has too few memories to infer meaningfully.
   */
  async _inferForUser(userPhone) {
    const mem0Service = require('../services/mem0-memory.service');
    if (!mem0Service.isAvailable || !mem0Service.isAvailable()) return null;

    // Broad empty search returns everything for this user — use search with
    // a generic query, then slice to top N.
    const memories = await mem0Service.search('', userPhone, MAX_MEMORIES_PER_USER).catch(() => []);
    if (!Array.isArray(memories) || memories.length < 5) {
      return null; // not enough to infer
    }

    const apiKey = llm.apiKey();
    if (!apiKey) return null;

    const joined = memories
      .map(m => m.memory || m.text || '')
      .filter(Boolean)
      .slice(0, MAX_MEMORIES_PER_USER)
      .map(m => `- ${m}`)
      .join('\n');

    const prompt = `You are a profile summarizer. Given the facts below about a user, output a JSON object with these fields:
{
  "preferred_name": "string or null",
  "primary_language": "en | hi | hinglish | other",
  "communication_style": "formal | casual | brief | detailed",
  "work_context": "short string or null (what they do / work on)",
  "key_people": ["array of names they frequently reference"],
  "ongoing_projects": ["array of 1-3 projects/themes they talk about"],
  "preferences": ["array of 1-5 preference statements like 'prefers Hindi mornings'"]
}

Output ONLY the JSON object, no preamble, no markdown.

Facts:
${joined}`;

    try {
      const taskModel = llm.modelFor('nightly_profile') || llm.fastModel();
      const response = await llm.chatCompletion(
        {
          model: taskModel,
          messages: [
            { role: 'system', content: 'You output only valid JSON. No markdown.' },
            { role: 'user', content: prompt },
          ],
          temperature: 0.1,
          max_tokens: 500,
          response_format: { type: 'json_object' },
        },
        { task: 'nightly_profile', timeout: 30000 }
      );
      try { require('../services/model-usage-tracker.service').log({ task: 'nightly_profile', model: taskModel, usage: response?.data?.usage }); } catch (_) {}
      // Robust JSON extraction — Claude via Bedrock sometimes wraps JSON in prose
      // when response_format isn't fully honored; extract the first JSON object.
      const raw = response.data?.choices?.[0]?.message?.content || '{}';
      const jsonMatch = String(raw).match(/\{[\s\S]*\}/);
      const profile = JSON.parse(jsonMatch ? jsonMatch[0] : '{}');
      return { profile, memoriesCount: memories.length };
    } catch (e) {
      logger.warn(`[UserProfileJob] LLM infer failed for ${userPhone}: ${e.message}`);
      return null;
    }
  }

  async _upsertProfile(userPhone, profile, memoriesCount) {
    await query(
      `INSERT INTO user_profiles (phone_number, profile, memories_count, last_updated)
       VALUES ($1, $2::jsonb, $3, NOW())
       ON CONFLICT (phone_number)
       DO UPDATE SET profile = EXCLUDED.profile,
                     memories_count = EXCLUDED.memories_count,
                     last_updated = NOW()`,
      [userPhone, JSON.stringify(profile || {}), memoriesCount || 0]
    );
  }

  /**
   * Convenience: get the stored profile for a user. Used by context-builder.
   */
  async getProfile(userPhone) {
    try {
      const { rows } = await query(
        `SELECT profile FROM user_profiles WHERE phone_number = $1`,
        [userPhone]
      );
      if (!rows.length) return null;
      return rows[0].profile || null;
    } catch {
      return null;
    }
  }
}

module.exports = new UserProfileJob();
