const { query } = require('../config/database');
const logger = require('../utils/logger');

class KnowledgeBaseService {

  constructor() {
    this.schemaReady = false;
  }

  async ensureSchema() {
    if (this.schemaReady) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS knowledge_base (
          id SERIAL PRIMARY KEY,
          team_admin_phone VARCHAR(50) NOT NULL,
          title VARCHAR(500) NOT NULL,
          content TEXT NOT NULL,
          category VARCHAR(100) DEFAULT 'general',
          tags TEXT,
          created_by VARCHAR(50) NOT NULL,
          created_by_name VARCHAR(255),
          updated_at TIMESTAMP DEFAULT NOW(),
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_kb_team ON knowledge_base(team_admin_phone)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_kb_category ON knowledge_base(team_admin_phone, category)`);
      this.schemaReady = true;
    } catch (error) {
      logger.error('Error creating knowledge_base table:', error.message);
    }
  }

  async addArticle(adminPhone, title, content, category, tags, createdBy, createdByName) {
    await this.ensureSchema();
    try {
      const result = await query(
        `INSERT INTO knowledge_base (team_admin_phone, title, content, category, tags, created_by, created_by_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [adminPhone, title, content, category || 'general', tags || null, createdBy, createdByName || null]
      );
      return result.rows[0];
    } catch (error) {
      logger.error('Error adding knowledge base article:', error.message);
      return null;
    }
  }

  async searchArticles(adminPhone, searchTerm) {
    await this.ensureSchema();
    try {
      const result = await query(
        `SELECT * FROM knowledge_base
         WHERE team_admin_phone = $1
           AND (title ILIKE $2 OR content ILIKE $2 OR tags ILIKE $2 OR category ILIKE $2)
         ORDER BY updated_at DESC
         LIMIT 10`,
        [adminPhone, `%${searchTerm}%`]
      );
      return result.rows;
    } catch (error) {
      logger.error('Error searching knowledge base articles:', error.message);
      return [];
    }
  }

  async getArticle(adminPhone, articleId) {
    await this.ensureSchema();
    try {
      const result = await query(
        `SELECT * FROM knowledge_base WHERE id = $1 AND team_admin_phone = $2`,
        [articleId, adminPhone]
      );
      return result.rows[0] || null;
    } catch (error) {
      logger.error('Error getting knowledge base article:', error.message);
      return null;
    }
  }

  async getArticleByTitle(adminPhone, title) {
    await this.ensureSchema();
    try {
      const result = await query(
        `SELECT * FROM knowledge_base WHERE team_admin_phone = $1 AND LOWER(title) = LOWER($2)`,
        [adminPhone, title]
      );
      return result.rows[0] || null;
    } catch (error) {
      logger.error('Error getting knowledge base article by title:', error.message);
      return null;
    }
  }

  async updateArticle(articleId, title, content, category, tags, adminPhone) {
    await this.ensureSchema();
    // IDOR fix (May 19 2026 — Batch F1): previously this UPDATE only
    // matched on id, so a user who guessed another team's article id
    // could overwrite the title/content. `deleteArticle` 14 lines below
    // already required adminPhone; this was an oversight when the update
    // path was added. The adminPhone arg is positional-and-optional so
    // older callers still work, but if it's missing we return null and
    // log — defaulting to "open" would be worse than failing closed.
    if (!adminPhone) {
      logger.warn('[KnowledgeBase] updateArticle called without adminPhone — refusing to update');
      return null;
    }
    try {
      const result = await query(
        `UPDATE knowledge_base
         SET title = COALESCE($1, title),
             content = COALESCE($2, content),
             category = COALESCE($3, category),
             tags = COALESCE($4, tags),
             updated_at = NOW()
         WHERE id = $5
           AND team_admin_phone = $6
         RETURNING *`,
        [title, content, category, tags, articleId, adminPhone]
      );
      return result.rows[0] || null;
    } catch (error) {
      logger.error('Error updating knowledge base article:', error.message);
      return null;
    }
  }

  async deleteArticle(articleId, adminPhone) {
    await this.ensureSchema();
    try {
      const result = await query(
        `DELETE FROM knowledge_base WHERE id = $1 AND team_admin_phone = $2 RETURNING *`,
        [articleId, adminPhone]
      );
      return result.rowCount > 0;
    } catch (error) {
      logger.error('Error deleting knowledge base article:', error.message);
      return false;
    }
  }

  async getCategories(adminPhone) {
    await this.ensureSchema();
    try {
      const result = await query(
        `SELECT category, COUNT(*) AS count
         FROM knowledge_base
         WHERE team_admin_phone = $1
         GROUP BY category
         ORDER BY count DESC`,
        [adminPhone]
      );
      return result.rows.map(r => ({ category: r.category, count: parseInt(r.count) }));
    } catch (error) {
      logger.error('Error getting knowledge base categories:', error.message);
      return [];
    }
  }

  async getArticlesByCategory(adminPhone, category) {
    await this.ensureSchema();
    try {
      const result = await query(
        `SELECT * FROM knowledge_base
         WHERE team_admin_phone = $1 AND category = $2
         ORDER BY updated_at DESC`,
        [adminPhone, category]
      );
      return result.rows;
    } catch (error) {
      logger.error('Error getting knowledge base articles by category:', error.message);
      return [];
    }
  }

  async getRecentArticles(adminPhone, limit = 10) {
    await this.ensureSchema();
    try {
      const result = await query(
        `SELECT * FROM knowledge_base
         WHERE team_admin_phone = $1
         ORDER BY updated_at DESC
         LIMIT $2`,
        [adminPhone, limit]
      );
      return result.rows;
    } catch (error) {
      logger.error('Error getting recent knowledge base articles:', error.message);
      return [];
    }
  }
}

module.exports = new KnowledgeBaseService();
