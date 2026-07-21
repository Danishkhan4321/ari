'use strict';

const logger = require('../utils/logger');

const MAX_FACT_LENGTH = 4000;
const MAX_KEY_LENGTH = 160;
const MAX_SUBJECT_LENGTH = 160;
const ALLOWED_CATEGORIES = new Set([
  'general', 'personal', 'preferences', 'work', 'people', 'health', 'travel',
  'finance', 'family', 'friends', 'vehicle',
]);

function normalizeIdentifier(value, fallback = '') {
  const normalized = String(value || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_KEY_LENGTH);
  return normalized || fallback;
}

function deriveFactParts(fact, hints = {}) {
  const rawFact = String(fact || '').normalize('NFKC').trim();
  const explicitSubject = normalizeIdentifier(hints.subject, 'user');
  const explicitKey = normalizeIdentifier(hints.key);

  if (explicitKey) {
    return { subject: explicitSubject, key: explicitKey, value: rawFact };
  }

  const possessive = rawFact.match(/^my\s+(.{1,100}?)\s+(?:is|are|=)\s+(.+)$/i);
  if (possessive) {
    return {
      subject: 'user',
      key: normalizeIdentifier(possessive[1], 'fact'),
      value: possessive[2].trim(),
    };
  }

  const preference = rawFact.match(/^i\s+(?:prefer|like|want)\s+(.+)$/i);
  if (preference) {
    return { subject: 'user', key: 'preference', value: preference[1].trim() };
  }

  return { subject: explicitSubject, key: 'fact', value: rawFact };
}

function isSensitiveFact({ fact, key, subject }) {
  const combined = `${subject || ''} ${key || ''} ${fact || ''}`;
  const sensitiveLabel = /\b(password|passwd|pwd|pin|cvv|cvc|otp|one[ -]?time password|ssn|social[ -]?security|credit[ -]?card|debit[ -]?card|card[ -]?number|api[ -]?key|access[ -]?token|refresh[ -]?token|private[ -]?key|client[ -]?secret|secret[ -]?key|seed phrase|recovery phrase)\b/i;
  const cardNumber = /\b(?:\d[ -]*?){13,19}\b/;
  const ssn = /\b\d{3}-\d{2}-\d{4}\b/;
  const commonSecret = /\b(?:sk|pk|ghp|github_pat|xox[baprs]|eyJ)[-_A-Za-z0-9.]{8,}\b/;
  return sensitiveLabel.test(combined) || cardNumber.test(combined) || ssn.test(combined) || commonSecret.test(combined);
}

function normalizeCategory(category) {
  const value = normalizeIdentifier(category, 'general');
  return ALLOWED_CATEGORIES.has(value) ? value : 'general';
}

function projectionKey(subject, key) {
  return subject === 'user' ? key : `${subject}/${key}`;
}

function createVersionedMemoryService(dependencies = {}) {
  const pool = dependencies.pool || require('../config/database').pool;
  const bustContext = dependencies.bustContext || ((userPhone) => {
    try { require('../utils/context-cache').bust(userPhone); } catch { /* cache is optional */ }
  });

  async function saveExplicitFact(input = {}) {
    const userPhone = String(input.userPhone || '').trim();
    const fact = String(input.fact || '').normalize('NFKC').trim();
    const parts = deriveFactParts(fact, input);
    const category = normalizeCategory(input.category);
    const supersedesKey = normalizeIdentifier(input.supersedes, parts.key);
    const source = normalizeIdentifier(input.source, 'explicit_user').slice(0, 80);
    const sourceRef = input.sourceRef == null ? null : String(input.sourceRef).slice(0, 300);
    const validUntil = input.validUntil || input.valid_until || null;

    if (!userPhone || !fact || fact.length > MAX_FACT_LENGTH || !parts.value) {
      return {
        success: false,
        error: { code: 'invalid_memory_fact', message: 'A user and a non-empty fact are required.' },
      };
    }
    if (parts.subject.length > MAX_SUBJECT_LENGTH || parts.key.length > MAX_KEY_LENGTH) {
      return {
        success: false,
        error: { code: 'invalid_memory_fact', message: 'The memory subject or key is too long.' },
      };
    }
    if (validUntil && Number.isNaN(Date.parse(validUntil))) {
      return {
        success: false,
        error: { code: 'invalid_memory_expiry', message: 'valid_until must be an ISO date or timestamp.' },
      };
    }
    if (isSensitiveFact({ fact, key: parts.key, subject: parts.subject })) {
      return {
        success: false,
        error: {
          code: 'sensitive_memory_rejected',
          message: 'Passwords, tokens, payment-card data, and other secrets are not stored in memory.',
        },
      };
    }

    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');

      // Serialize both sides of a rename/correction. Lock in lexical order so
      // simultaneous inverse corrections cannot deadlock, and so an existing
      // current row under the new key cannot race the partial unique index.
      const semanticKeys = [...new Set([supersedesKey, parts.key])].sort();
      for (const semanticKey of semanticKeys) {
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
          [userPhone, `${parts.subject}:${semanticKey}`]
        );
      }

      const priorResult = await client.query(
        `SELECT id, category, subject, key_name
           FROM ari_agent_memory_fact_versions
          WHERE user_phone = $1
            AND subject = $2
            AND key_name = ANY($3::text[])
            AND is_current = TRUE
          ORDER BY CASE WHEN key_name = $4 THEN 0 ELSE 1 END,
                   observed_at DESC, id DESC
          FOR UPDATE`,
        [userPhone, parts.subject, semanticKeys, supersedesKey]
      );
      const priors = priorResult.rows || [];
      const prior = priors[0] || null;

      if (priors.length > 0) {
        await client.query(
          `UPDATE ari_agent_memory_fact_versions
              SET is_current = FALSE, superseded_at = NOW()
            WHERE id = ANY($1::bigint[]) AND is_current = TRUE`,
          [priors.map((row) => row.id)]
        );
      }

      const inserted = await client.query(
        `INSERT INTO ari_agent_memory_fact_versions
          (user_phone, category, subject, key_name, value, source, source_ref,
           observed_at, valid_until, supersedes_id, is_current, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, $9, TRUE, NOW())
         RETURNING id, user_phone, category, subject, key_name, value, source,
                   source_ref, observed_at, valid_until, supersedes_id, is_current`,
        [
          userPhone,
          category,
          parts.subject,
          parts.key,
          parts.value,
          source,
          sourceRef,
          validUntil,
          prior?.id || null,
        ]
      );

      const currentKey = projectionKey(parts.subject, parts.key);
      // A prior fact may have lived in another category or under another key.
      // Remove its exact old projection before inserting the one current view.
      for (const previous of priors) {
        await client.query(
          `DELETE FROM memory_trunk
            WHERE user_phone = $1 AND category = $2 AND key_name = $3`,
          [
            userPhone,
            previous.category || category,
            projectionKey(previous.subject || parts.subject, previous.key_name),
          ]
        );
      }
      await client.query(
        `INSERT INTO memory_trunk
          (user_phone, category, key_name, value, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         ON CONFLICT (user_phone, category, key_name)
         DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [userPhone, category, currentKey, parts.value]
      );

      await client.query('COMMIT');
      await Promise.resolve(bustContext(userPhone));
      return {
        success: true,
        fact: inserted.rows[0],
        supersededId: prior?.id || null,
      };
    } catch (error) {
      if (client) {
        try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
      }
      logger.error('[VersionedMemory] atomic save failed', {
        error: error?.message || String(error),
        user: userPhone ? 'present' : 'missing',
      });
      return {
        success: false,
        error: { code: 'memory_write_failed', message: 'The memory could not be saved atomically.' },
      };
    } finally {
      if (client && typeof client.release === 'function') client.release();
    }
  }

  async function recallCurrentFacts(input = {}) {
    const userPhone = String(input.userPhone || '').trim();
    const queryText = String(input.query || '').normalize('NFKC').trim().slice(0, 1000);
    const category = input.category ? normalizeCategory(input.category) : null;
    const limit = Math.max(1, Math.min(100, Number.parseInt(input.limit, 10) || 20));
    if (!userPhone) {
      return { success: false, facts: [], error: { code: 'invalid_memory_user', message: 'A user is required.' } };
    }
    try {
      const result = await pool.query(
        `SELECT id, category, subject, key_name, value, observed_at, valid_until, source
           FROM ari_agent_memory_fact_versions
          WHERE user_phone = $1
            AND is_current = TRUE
            AND (valid_until IS NULL OR valid_until > NOW())
            AND ($2::text IS NULL OR category = $2)
            AND ($3::text = ''
              OR key_name ILIKE '%' || $3 || '%'
              OR subject ILIKE '%' || $3 || '%'
              OR value ILIKE '%' || $3 || '%')
          ORDER BY observed_at DESC, id DESC
          LIMIT $4`,
        [userPhone, category, queryText, limit],
      );
      return { success: true, facts: result.rows || [] };
    } catch (error) {
      logger.warn('[VersionedMemory] current recall failed', { code: error?.code, message: error?.message });
      return {
        success: false,
        facts: [],
        versionedUnavailable: error?.code === '42P01',
        error: { code: 'memory_recall_failed', message: 'Current memory facts could not be loaded.' },
      };
    }
  }

  async function forgetCurrentFact(input = {}) {
    const userPhone = String(input.userPhone || '').trim();
    const subject = normalizeIdentifier(input.subject, 'user');
    const key = normalizeIdentifier(input.key);
    if (!userPhone || !key) {
      return { success: false, forgotten: 0, error: { code: 'invalid_memory_key', message: 'A precise memory key is required.' } };
    }
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [userPhone, `${subject}:${key}`]);
      const updated = await client.query(
        `UPDATE ari_agent_memory_fact_versions
            SET is_current = FALSE, superseded_at = NOW()
          WHERE user_phone = $1 AND subject = $2 AND key_name = $3 AND is_current = TRUE
          RETURNING id, category, subject, key_name`,
        [userPhone, subject, key],
      );
      for (const row of updated.rows || []) {
        await client.query(
          `DELETE FROM memory_trunk
            WHERE user_phone = $1 AND category = $2 AND key_name = $3`,
          [userPhone, row.category, projectionKey(row.subject, row.key_name)],
        );
      }
      await client.query('COMMIT');
      if ((updated.rowCount || 0) > 0) await Promise.resolve(bustContext(userPhone));
      return { success: true, forgotten: updated.rowCount || 0 };
    } catch (error) {
      if (client) {
        try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
      }
      logger.error('[VersionedMemory] forget failed', { code: error?.code, message: error?.message });
      return {
        success: false,
        forgotten: 0,
        versionedUnavailable: error?.code === '42P01',
        error: { code: 'memory_forget_failed', message: 'The memory could not be forgotten atomically.' },
      };
    } finally {
      if (client && typeof client.release === 'function') client.release();
    }
  }

  async function clearCurrentFacts(input = {}) {
    const userPhone = String(input.userPhone || '').trim();
    if (!userPhone) {
      return { success: false, cleared: 0, error: { code: 'invalid_memory_user', message: 'A user is required.' } };
    }
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [userPhone]);
      const updated = await client.query(
        `UPDATE ari_agent_memory_fact_versions
            SET is_current = FALSE, superseded_at = NOW()
          WHERE user_phone = $1 AND is_current = TRUE
          RETURNING id`,
        [userPhone],
      );
      await client.query('DELETE FROM memory_trunk WHERE user_phone = $1', [userPhone]);
      await client.query('COMMIT');
      await Promise.resolve(bustContext(userPhone));
      return { success: true, cleared: updated.rowCount || 0 };
    } catch (error) {
      if (client) {
        try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
      }
      logger.error('[VersionedMemory] clear failed', { code: error?.code, message: error?.message });
      return {
        success: false,
        cleared: 0,
        versionedUnavailable: error?.code === '42P01',
        error: { code: 'memory_clear_failed', message: 'Current memory facts could not be cleared.' },
      };
    } finally {
      if (client && typeof client.release === 'function') client.release();
    }
  }

  return { clearCurrentFacts, forgetCurrentFact, recallCurrentFacts, saveExplicitFact };
}

const service = createVersionedMemoryService();

module.exports = {
  ...service,
  createVersionedMemoryService,
  deriveFactParts,
  isSensitiveFact,
  normalizeIdentifier,
};
