const { query } = require('../config/database');
const logger = require('../utils/logger');

class ListService {

  constructor() {
    this.schemaReady = false;
  }

  async ensureSchema() {
    if (this.schemaReady) return;
    try {
      await query(`ALTER TABLE list_items ADD COLUMN IF NOT EXISTS priority VARCHAR(10) DEFAULT 'normal'`);
      await query(`ALTER TABLE list_items ADD COLUMN IF NOT EXISTS due_date TIMESTAMP`);
      this.schemaReady = true;
    } catch (e) {
      this.schemaReady = true; // Table might not exist yet
    }
  }

  async createList(userPhone, listName, listType = 'general') {
    try {
      const result = await query(
        `INSERT INTO user_lists (user_phone, list_name, list_type, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_phone, list_name) DO NOTHING
         RETURNING *`,
        [userPhone, listName, listType]
      );
      // Invalidate context cache — lists appear in getContext.
      try { require('../utils/context-cache').bust(userPhone); } catch (e) { /* noop */ }
      return result.rows[0];
    } catch (error) {
      logger.error('Error creating list:', error);
      return null;
    }
  }

  async getOrCreateList(userPhone, listName) {
    try {
      let result = await query(
        `SELECT * FROM user_lists WHERE user_phone = $1 AND LOWER(list_name) = LOWER($2)`,
        [userPhone, listName]
      );
      
      if (result.rows.length === 0) {
        result = await query(
          `INSERT INTO user_lists (user_phone, list_name) VALUES ($1, $2) RETURNING *`,
          [userPhone, listName]
        );
      }
      
      return result.rows[0];
    } catch (error) {
      logger.error('Error getting/creating list:', error);
      return null;
    }
  }

  async addItem(userPhone, listName, itemText) {
    try {
      await this.ensureSchema();
      const list = await this.getOrCreateList(userPhone, listName);
      if (!list) return null;

      // Detect priority from text
      let priority = 'normal';
      let cleanText = itemText;
      if (/\b(urgent|asap|important|high\s*priority)\b/i.test(itemText)) {
        priority = 'high';
        cleanText = itemText.replace(/\s*\b(urgent|asap|important|high\s*priority)\b\s*/gi, ' ').trim();
      } else if (/\b(low\s*priority|whenever|someday)\b/i.test(itemText)) {
        priority = 'low';
        cleanText = itemText.replace(/\s*\b(low\s*priority|whenever|someday)\b\s*/gi, ' ').trim();
      }

      const result = await query(
        `INSERT INTO list_items (list_id, item_text, is_completed, priority, created_at)
         VALUES ($1, $2, false, $3, NOW()) RETURNING *`,
        [list.id, cleanText || itemText, priority]
      );

      // Invalidate context cache — list item counts appear in getContext.
      try { require('../utils/context-cache').bust(userPhone); } catch (e) { /* noop */ }

      return result.rows[0];
    } catch (error) {
      logger.error('Error adding item:', error);
      return null;
    }
  }

  async addMultipleItems(userPhone, listName, items) {
    const added = [];
    for (const item of items) {
      if (item.trim()) {
        const result = await this.addItem(userPhone, listName, item.trim());
        if (result) added.push(result);
      }
    }
    return added;
  }

  async getUserLists(userPhone) {
    try {
      const result = await query(
        `SELECT l.*, 
         COUNT(li.id) as total_items,
         COUNT(CASE WHEN li.is_completed = false THEN 1 END) as pending_items
         FROM user_lists l
         LEFT JOIN list_items li ON l.id = li.list_id
         WHERE l.user_phone = $1
         GROUP BY l.id
         ORDER BY l.created_at DESC`,
        [userPhone]
      );
      return result.rows;
    } catch (error) {
      logger.error('Error getting lists:', error);
      return [];
    }
  }

  async getListItems(userPhone, listName) {
    try {
      const listResult = await query(
        `SELECT * FROM user_lists WHERE user_phone = $1 AND LOWER(list_name) = LOWER($2)`,
        [userPhone, listName]
      );
      
      if (listResult.rows.length === 0) return { list: null, items: [] };
      
      const list = listResult.rows[0];
      const itemsResult = await query(
        `SELECT * FROM list_items WHERE list_id = $1 ORDER BY is_completed ASC, created_at DESC`,
        [list.id]
      );
      
      return { list, items: itemsResult.rows };
    } catch (error) {
      logger.error('Error getting list items:', error);
      return { list: null, items: [] };
    }
  }

  async markItemDone(userPhone, listName, itemText) {
    try {
      const { list } = await this.getListItems(userPhone, listName);
      if (!list) return false;

      // Try exact match first, then fuzzy LIKE (avoids ambiguity)
      let result = await query(
        `UPDATE list_items SET is_completed = true, completed_at = NOW()
         WHERE list_id = $1 AND LOWER(item_text) = LOWER($2) AND is_completed = false
         RETURNING *`,
        [list.id, itemText]
      );
      if (result.rowCount === 0) {
        result = await query(
          `UPDATE list_items SET is_completed = true, completed_at = NOW()
           WHERE id = (
             SELECT id FROM list_items
             WHERE list_id = $1 AND LOWER(item_text) LIKE LOWER($2) AND is_completed = false
             ORDER BY created_at DESC LIMIT 1
           ) RETURNING *`,
          [list.id, `%${itemText}%`]
        );
      }
      return result.rowCount > 0;
    } catch (error) {
      logger.error('Error marking item done:', error);
      return false;
    }
  }

  async removeItem(userPhone, listName, itemText) {
    try {
      const { list } = await this.getListItems(userPhone, listName);
      if (!list) return false;

      // Try exact match first, then fuzzy LIKE with LIMIT 1
      let result = await query(
        `DELETE FROM list_items WHERE list_id = $1 AND LOWER(item_text) = LOWER($2) RETURNING *`,
        [list.id, itemText]
      );
      if (result.rowCount === 0) {
        result = await query(
          `DELETE FROM list_items WHERE id = (
             SELECT id FROM list_items
             WHERE list_id = $1 AND LOWER(item_text) LIKE LOWER($2)
             ORDER BY created_at DESC LIMIT 1
           ) RETURNING *`,
          [list.id, `%${itemText}%`]
        );
      }
      return result.rowCount > 0;
    } catch (error) {
      logger.error('Error removing item:', error);
      return false;
    }
  }

  async clearCompleted(userPhone, listName) {
    try {
      const { list } = await this.getListItems(userPhone, listName);
      if (!list) return 0;

      const result = await query(
        `DELETE FROM list_items WHERE list_id = $1 AND is_completed = true`,
        [list.id]
      );
      
      return result.rowCount;
    } catch (error) {
      logger.error('Error clearing completed:', error);
      return 0;
    }
  }

  async clearListItems(userPhone, listName) {
    try {
      const { list } = await this.getListItems(userPhone, listName);
      if (!list) return { found: false, count: 0 };
      const result = await query(
        `DELETE FROM list_items WHERE list_id = $1`,
        [list.id]
      );
      return { found: true, count: Number(result.rowCount || 0) };
    } catch (error) {
      logger.error('Error clearing list:', error);
      return { found: false, count: 0, error: true };
    }
  }

  async deleteList(userPhone, listName) {
    try {
      const { list } = await this.getListItems(userPhone, listName);
      if (!list) return false;

      await query(`DELETE FROM list_items WHERE list_id = $1`, [list.id]);
      await query(`DELETE FROM user_lists WHERE id = $1`, [list.id]);
      
      return true;
    } catch (error) {
      logger.error('Error deleting list:', error);
      return false;
    }
  }

  parseListCommand(message, params = null) {
    // Params-first path: if LLM already extracted structured params, use them directly
    if (params && params.action && params.list_name) {
      switch (params.action) {
        case 'create':
          return { action: 'create', listName: params.list_name };
        case 'add_item':
          return { action: 'add', items: params.items || (params.item_text ? [params.item_text] : []), listName: params.list_name };
        case 'view':
          return { action: 'show', listName: params.list_name };
        case 'view_all':
          return { action: 'showAll' };
        case 'check_item':
          return { action: 'done', item: params.item_text || '', listName: params.list_name };
        case 'remove_item':
          return { action: 'remove', item: params.item_text || '', listName: params.list_name };
        case 'clear':
          return { action: 'clear', listName: params.list_name };
        case 'clear_completed':
          return { action: 'clearCompleted', listName: params.list_name };
      }
    }
    // Also handle view_all without list_name
    if (params && params.action === 'view_all') {
      return { action: 'showAll' };
    }

    // Existing regex fallback
    const lower = message.toLowerCase();

    const addMatch = message.match(/add\s+(.+?)\s+to\s+(.+?)\s*list/i);
    if (addMatch) {
      const items = addMatch[1].split(/,|and/).map(i => i.trim()).filter(i => i);
      return { action: 'add', items, listName: addMatch[2].trim() };
    }

    const showMatch = message.match(/(?:show|view|see|what's (?:on|in)|my)\s+(.+?)\s*list/i);
    if (showMatch && !lower.includes('all') && !lower.match(/my\s+lists$/)) {
      return { action: 'show', listName: showMatch[1].trim() };
    }

    if (lower.match(/(?:show|view|see)?\s*(?:my|all)\s+lists?$/i)) {
      return { action: 'showAll' };
    }

    const doneMatch = message.match(/(?:done|check|tick|complete)\s+(.+?)\s+(?:from|in|on)\s+(.+?)\s*list/i);
    if (doneMatch) {
      return { action: 'done', item: doneMatch[1].trim(), listName: doneMatch[2].trim() };
    }

    const removeMatch = message.match(/(?:remove|delete)\s+(.+?)\s+(?:from|in|on)\s+(.+?)\s*list/i);
    if (removeMatch) {
      return { action: 'remove', item: removeMatch[1].trim(), listName: removeMatch[2].trim() };
    }

    const clearMatch = message.match(/clear\s+(.+?)\s*list/i);
    if (clearMatch) {
      return { action: 'clear', listName: clearMatch[1].trim() };
    }

    const createMatch = message.match(/(?:create|make|new)\s+(.+?)\s*list/i);
    if (createMatch) {
      return { action: 'create', listName: createMatch[1].trim() };
    }

    return null;
  }

  formatList(listData) {
    const { list, items } = listData;
    
    if (!list) return `List not found. Try "create shopping list" first.`;
    
    if (items.length === 0) {
      return `*${list.list_name} List*\n\nNo items yet.\n\nAdd items: "add milk to ${list.list_name} list"`;
    }

    const pending = items.filter(i => !i.is_completed);
    const done = items.filter(i => i.is_completed);

    let response = `*${list.list_name} List*\n\n`;
    
    if (pending.length > 0) {
      pending.forEach((item, i) => {
        response += `${i + 1}. [ ] ${item.item_text}\n`;
      });
    }

    if (done.length > 0) {
      response += `\n*Done:*\n`;
      done.slice(0, 5).forEach(item => {
        response += `   [x] ${item.item_text}\n`;
      });
      if (done.length > 5) response += `   ...and ${done.length - 5} more\n`;
    }

    response += `\n${pending.length} pending, ${done.length} done`;
    return response;
  }

  formatAllLists(lists) {
    if (lists.length === 0) {
      return `No lists yet.\n\nCreate one: "create shopping list"\nOr add items: "add milk to shopping list"`;
    }

    let response = `*Your Lists:*\n\n`;
    
    lists.forEach((list, i) => {
      const pending = list.pending_items || 0;
      const total = list.total_items || 0;
      response += `${i + 1}. *${list.list_name}* (${pending}/${total} items)\n`;
    });

    response += `\nSay "show [name] list" to view items`;
    return response;
  }
}

module.exports = new ListService();
