'use strict';

/**
 * Short Link Service
 *
 * Generates tiny redirect slugs for long S3 presigned URLs.
 * Instead of sending a 500+ char presigned URL to users on WhatsApp, we send
 *   http://127.0.0.1:43100/r/<8-char-slug>
 * which is ~32 chars total. The GET /r/:slug handler (in index.js) looks up
 * the S3 key, generates a FRESH presigned URL on each click, and 302-redirects
 * the user to it.
 *
 * Because we generate fresh URLs per click, short links NEVER expire
 * (the underlying S3 object is permanent).
 *
 * Table: recording_links (slug PK, s3_key, s3_bucket, user_phone, click_count)
 */

const crypto = require('crypto');
const { query } = require('../config/database');
const logger = require('../utils/logger');

const SLUG_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'; // no 0/O/1/l/I
const SLUG_LENGTH = 8;
const APP_BASE_URL = (process.env.APP_BASE_URL || 'http://127.0.0.1:43100').replace(/\/$/, '');

class ShortLinkService {
  constructor() {
    this.schemaReady = false;
  }

  async ensureSchema() {
    if (this.schemaReady) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS recording_links (
          slug VARCHAR(16) PRIMARY KEY,
          s3_key TEXT NOT NULL,
          s3_bucket TEXT,
          user_phone VARCHAR(50) NOT NULL,
          created_at TIMESTAMP DEFAULT NOW(),
          click_count INTEGER DEFAULT 0,
          last_accessed_at TIMESTAMP
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_recording_links_user ON recording_links(user_phone)`);
      this.schemaReady = true;
    } catch (e) {
      logger.error(`[ShortLink] ensureSchema error: ${e.message}`);
    }
  }

  /**
   * Generate a random slug from the unambiguous alphabet.
   * 56^8 = ~96 trillion combinations — collision essentially impossible.
   */
  generateSlug() {
    const bytes = crypto.randomBytes(SLUG_LENGTH);
    let slug = '';
    for (let i = 0; i < SLUG_LENGTH; i++) {
      slug += SLUG_ALPHABET[bytes[i] % SLUG_ALPHABET.length];
    }
    return slug;
  }

  /**
   * Create a short link for an S3 object. Retries on (extremely unlikely) slug collision.
   *
   * @param {{ s3Key: string, s3Bucket: string, userPhone: string }} params
   * @returns {Promise<{ slug: string, url: string }>}
   */
  async createForRecording({ s3Key, s3Bucket, userPhone }) {
    if (!s3Key || !userPhone) {
      throw new Error('short-link: s3Key and userPhone are required');
    }
    await this.ensureSchema();

    for (let attempt = 0; attempt < 5; attempt++) {
      const slug = this.generateSlug();
      try {
        await query(
          `INSERT INTO recording_links (slug, s3_key, s3_bucket, user_phone)
           VALUES ($1, $2, $3, $4)`,
          [slug, s3Key, s3Bucket || null, userPhone]
        );
        const url = `${APP_BASE_URL}/r/${slug}`;
        logger.info(`[ShortLink] Created ${slug} for ${userPhone} -> ${s3Key}`);
        return { slug, url };
      } catch (e) {
        // Unique constraint violation — retry with a new slug
        if (e.code === '23505' && attempt < 4) {
          logger.warn(`[ShortLink] Slug collision on ${slug} (attempt ${attempt + 1}), retrying`);
          continue;
        }
        throw e;
      }
    }
    throw new Error('short-link: failed to generate unique slug after 5 attempts');
  }

  /**
   * Resolve a slug to its S3 object. Returns null if not found.
   * Bumps click_count and last_accessed_at on each resolution.
   *
   * @param {string} slug
   * @returns {Promise<{ s3Key: string, s3Bucket: string|null, userPhone: string }|null>}
   */
  async resolveSlug(slug) {
    if (!slug || typeof slug !== 'string') return null;
    // Validate alphabet to avoid DB lookup for obvious garbage / injection attempts
    if (!/^[A-Za-z0-9]{4,16}$/.test(slug)) return null;

    try {
      await this.ensureSchema();
      const result = await query(
        `UPDATE recording_links
         SET click_count = click_count + 1, last_accessed_at = NOW()
         WHERE slug = $1
         RETURNING s3_key, s3_bucket, user_phone`,
        [slug]
      );
      if (!result.rows.length) return null;
      const row = result.rows[0];
      return {
        s3Key: row.s3_key,
        s3Bucket: row.s3_bucket,
        userPhone: row.user_phone,
      };
    } catch (e) {
      logger.error(`[ShortLink] resolveSlug error for ${slug}: ${e.message}`);
      return null;
    }
  }
}

module.exports = new ShortLinkService();
