const { query } = require('../config/database');
const logger = require('../utils/logger');

class ReadingListService {

  constructor() {
    this.schemaReady = false;
  }

  async ensureSchema() {
    if (this.schemaReady) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS reading_list (
          id SERIAL PRIMARY KEY,
          user_phone VARCHAR(50) NOT NULL,
          url TEXT,
          title VARCHAR(500),
          summary TEXT,
          category VARCHAR(50) DEFAULT 'general',
          status VARCHAR(20) DEFAULT 'unread',
          added_at TIMESTAMP DEFAULT NOW(),
          read_at TIMESTAMP
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_reading_list_user ON reading_list(user_phone)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_reading_list_status ON reading_list(user_phone, status)`);
      this.schemaReady = true;
    } catch (error) {
      logger.error('Error creating reading_list table:', error.message);
    }
  }

  async addItem(userPhone, url, title, category) {
    await this.ensureSchema();
    try {
      // Auto-detect category from URL domain if not provided
      if (!category && url) {
        category = this.detectCategory(url);
      }
      if (!category) {
        category = 'general';
      }

      const result = await query(
        `INSERT INTO reading_list (user_phone, url, title, category)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [userPhone, url, title || null, category]
      );
      return result.rows[0];
    } catch (error) {
      logger.error('Error adding reading list item:', error.message);
      return null;
    }
  }

  detectCategory(url) {
    try {
      const hostname = new URL(url).hostname.toLowerCase();

      if (hostname.includes('github.com') || hostname.includes('gitlab.com') || hostname.includes('stackoverflow.com') || hostname.includes('dev.to') || hostname.includes('hackernews') || hostname.includes('npmjs.com')) {
        return 'tech';
      }
      if (hostname.includes('youtube.com') || hostname.includes('youtu.be') || hostname.includes('vimeo.com') || hostname.includes('twitch.tv')) {
        return 'video';
      }
      if (hostname.includes('medium.com') || hostname.includes('substack.com') || hostname.includes('hashnode.dev') || hostname.includes('blog')) {
        return 'article';
      }
      if (hostname.includes('twitter.com') || hostname.includes('x.com') || hostname.includes('reddit.com') || hostname.includes('linkedin.com') || hostname.includes('facebook.com') || hostname.includes('instagram.com')) {
        return 'social';
      }
      if (hostname.includes('arxiv.org') || hostname.includes('scholar.google') || hostname.includes('researchgate.net') || hostname.includes('pubmed')) {
        return 'research';
      }
      if (hostname.includes('news') || hostname.includes('bbc.') || hostname.includes('cnn.com') || hostname.includes('reuters.com') || hostname.includes('theguardian.com')) {
        return 'news';
      }
      if (hostname.includes('docs.') || hostname.includes('documentation') || hostname.includes('wiki')) {
        return 'docs';
      }

      return 'general';
    } catch (e) {
      return 'general';
    }
  }

  async getItems(userPhone, status) {
    await this.ensureSchema();
    try {
      let sql;
      let params;

      if (status && status !== 'all') {
        sql = `SELECT * FROM reading_list WHERE user_phone = $1 AND status = $2 ORDER BY added_at DESC LIMIT 20`;
        params = [userPhone, status];
      } else {
        sql = `SELECT * FROM reading_list WHERE user_phone = $1 ORDER BY added_at DESC LIMIT 20`;
        params = [userPhone];
      }

      const result = await query(sql, params);
      return result.rows;
    } catch (error) {
      logger.error('Error getting reading list items:', error.message);
      return [];
    }
  }

  async markRead(userPhone, itemId) {
    await this.ensureSchema();
    try {
      const result = await query(
        `UPDATE reading_list SET status = 'read', read_at = NOW()
         WHERE id = $1 AND user_phone = $2
         RETURNING *`,
        [itemId, userPhone]
      );
      return result.rowCount > 0;
    } catch (error) {
      logger.error('Error marking reading list item as read:', error.message);
      return false;
    }
  }

  async deleteItem(userPhone, itemId) {
    await this.ensureSchema();
    try {
      const result = await query(
        `DELETE FROM reading_list WHERE id = $1 AND user_phone = $2 RETURNING *`,
        [itemId, userPhone]
      );
      return result.rowCount > 0;
    } catch (error) {
      logger.error('Error deleting reading list item:', error.message);
      return false;
    }
  }

  async updateSummary(itemId, summary, userPhone) {
    await this.ensureSchema();
    try {
      const result = await query(
        `UPDATE reading_list SET summary = $1 WHERE id = $2 AND user_phone = $3 RETURNING *`,
        [summary, itemId, userPhone]
      );
      return result.rowCount > 0;
    } catch (error) {
      logger.error('Error updating reading list summary:', error.message);
      return false;
    }
  }

  async searchItems(userPhone, searchTerm) {
    await this.ensureSchema();
    try {
      const result = await query(
        `SELECT * FROM reading_list
         WHERE user_phone = $1 AND (title ILIKE $2 OR url ILIKE $2)
         ORDER BY added_at DESC LIMIT 20`,
        [userPhone, `%${searchTerm}%`]
      );
      return result.rows;
    } catch (error) {
      logger.error('Error searching reading list:', error.message);
      return [];
    }
  }

  async getStats(userPhone) {
    await this.ensureSchema();
    try {
      const countResult = await query(
        `SELECT
           COUNT(*) AS total,
           COUNT(CASE WHEN status = 'unread' THEN 1 END) AS unread,
           COUNT(CASE WHEN status = 'read' THEN 1 END) AS read
         FROM reading_list
         WHERE user_phone = $1`,
        [userPhone]
      );

      const categoryResult = await query(
        `SELECT category, COUNT(*) AS count
         FROM reading_list
         WHERE user_phone = $1
         GROUP BY category
         ORDER BY count DESC`,
        [userPhone]
      );

      const row = countResult.rows[0];
      return {
        total: parseInt(row.total) || 0,
        unread: parseInt(row.unread) || 0,
        read: parseInt(row.read) || 0,
        topCategories: categoryResult.rows.map(r => ({ category: r.category, count: parseInt(r.count) }))
      };
    } catch (error) {
      logger.error('Error getting reading list stats:', error.message);
      return { total: 0, unread: 0, read: 0, topCategories: [] };
    }
  }

  extractUrlFromText(text) {
    if (!text) return { url: null, remainingText: text };

    const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;
    const match = text.match(urlRegex);

    if (!match || match.length === 0) {
      return { url: null, remainingText: text };
    }

    const url = match[0];
    const remainingText = text.replace(url, '').replace(/\s+/g, ' ').trim();

    return { url, remainingText };
  }
}

module.exports = new ReadingListService();
