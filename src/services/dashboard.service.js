const { query } = require('../config/database');
const logger = require('../utils/logger');
const listPositionCache = require('../utils/list-position-cache');
const timeFormat = require('../utils/time-format');
const timezoneService = require('./timezone.service');

class DashboardService {

  // ========== MAIN DASHBOARD ==========
  async getDashboard(userPhone) {
    try {
      const [reminders, memories, lists, images] = await Promise.all([
        this.getReminderStats(userPhone),
        this.getMemoryStats(userPhone),
        this.getListStats(userPhone),
        this.getImageStats(userPhone)
      ]);

      let response = `*Your Dashboard*\n\n`;
      
      // Reminders
      response += `*Reminders*\n`;
      response += `${reminders.pending} pending, ${reminders.sent} sent, ${reminders.total} total\n\n`;
      
      // Memories
      response += `*Memories*\n`;
      response += `${memories.total} saved in ${memories.categories} categories\n\n`;
      
      // Lists
      response += `*Lists*\n`;
      response += `${lists.count} lists, ${lists.items} items\n\n`;
      
      // Images
      response += `*Images*\n`;
      response += `${images.total} saved\n\n`;
      
      response += `_Commands:_\n`;
      response += `- "my reminders"\n`;
      response += `- "my memories"\n`;
      response += `- "my lists"\n`;
      response += `- "my images"`;

      return response;

    } catch (error) {
      logger.error('Dashboard error:', error);
      return 'Could not load dashboard. Try again.';
    }
  }

  // ========== REMINDERS ==========
  async getReminderStats(userPhone) {
    try {
      const result = await query(
        `SELECT 
          COUNT(*) FILTER (WHERE status = 'pending') as pending,
          COUNT(*) FILTER (WHERE status = 'sent') as sent,
          COUNT(*) FILTER (WHERE status = 'completed') as completed,
          COUNT(*) as total
         FROM reminders WHERE user_phone = $1`,
        [userPhone]
      );
      return result.rows[0];
    } catch (error) {
      return { pending: 0, sent: 0, completed: 0, total: 0 };
    }
  }

  async getRemindersView(userPhone) {
    try {
      const result = await query(
        `SELECT * FROM reminders
         WHERE user_phone = $1
         ORDER BY
           CASE status
             WHEN 'pending' THEN 1
             WHEN 'sent' THEN 2
             ELSE 3
           END,
           reminder_time DESC
         LIMIT 20`,
        [userPhone]
      );

      if (result.rows.length === 0) {
        return 'No reminders yet.\n\nSet one: "remind me in 5 min to call mom"';
      }

      // Look up user's timezone ONCE so all formatted rows render in the
      // user's local time (not the server's UTC).
      let userTz = 'Asia/Kolkata';
      try {
        userTz = await timezoneService.getUserTimezone(userPhone);
      } catch (_) { /* default */ }

      // Use continuous global numbering so "cancel reminder 3" always matches position 3
      let response = `*Your Reminders (${result.rows.length})*\n\n`;
      let globalIdx = 1;

      // Accumulator for the position cache — same ordering the user will see.
      const cachedItems = [];

      const pending = result.rows.filter(r => r.status === 'pending');
      const sent = result.rows.filter(r => r.status === 'sent');

      if (pending.length > 0) {
        response += `*Pending (${pending.length})*\n`;
        pending.forEach((r) => {
          const time = this.formatTime(r.reminder_time, userTz);
          const tag = r.is_recurring ? ' (recurring)' : '';
          response += `${globalIdx}. ${r.message}${tag}\n   ${time}\n`;
          cachedItems.push({ position: globalIdx, id: r.id, label: r.message, status: 'pending' });
          globalIdx++;
        });
        response += '\n';
      }

      if (sent.length > 0) {
        response += `*Sent (${sent.length})*\n`;
        sent.slice(0, 5).forEach((r) => {
          const time = this.formatTime(r.reminder_time, userTz);
          response += `${globalIdx}. ${r.message}\n   ${time}\n`;
          cachedItems.push({ position: globalIdx, id: r.id, label: r.message, status: 'sent' });
          globalIdx++;
        });
        response += '\n';
      }

      response += `\n_"cancel reminder [number]" to cancel_`;

      // Remember the EXACT ordered rows the user just saw, so any follow-up
      // "cancel 2" / "delete 3" resolves against this list — not a fresh
      // re-query with a possibly-different ORDER BY.
      listPositionCache.remember(userPhone, 'reminders', cachedItems);

      return response;

    } catch (error) {
      logger.error('Get reminders error:', error);
      return 'Could not load reminders.';
    }
  }

  async deleteReminderByIndex(userPhone, index) {
    try {
      // PRIMARY path — use the cached ordered list the user actually saw.
      // This guarantees position N refers to the same row the user picked.
      const cached = listPositionCache.pick(userPhone, 'reminders', index);
      if (cached && cached.id) {
        const lookupResult = await query(
          `SELECT id, message FROM reminders WHERE id = $1 AND user_phone = $2 LIMIT 1`,
          [cached.id, userPhone]
        );
        if (lookupResult.rows.length === 0) {
          return `That reminder has already been removed.`;
        }
        await query(`DELETE FROM reminders WHERE id = $1 AND user_phone = $2`, [cached.id, userPhone]);
        return `Deleted: "${lookupResult.rows[0].message}"`;
      }

      // FALLBACK — no cache (user never saw a list this session, or TTL expired).
      // Re-query with the same ORDER BY as getRemindersView for consistency.
      const result = await query(
        `SELECT id, message FROM reminders
         WHERE user_phone = $1
         ORDER BY
           CASE status WHEN 'pending' THEN 1 WHEN 'sent' THEN 2 ELSE 3 END,
           reminder_time DESC
         LIMIT 20`,
        [userPhone]
      );

      if (index < 1 || index > result.rows.length) {
        return `Invalid number. You have ${result.rows.length} reminders.`;
      }

      const reminder = result.rows[index - 1];
      await query(`DELETE FROM reminders WHERE id = $1 AND user_phone = $2`, [reminder.id, userPhone]);
      return `Deleted: "${reminder.message}"`;

    } catch (error) {
      logger.error('Delete reminder error:', error);
      return 'Could not delete reminder.';
    }
  }

  // ========== MEMORIES ==========
  async getMemoryStats(userPhone) {
    try {
      // memory_trunk is the primary table used by memoryService
      const result = await query(
        `SELECT COUNT(*) as total, COUNT(DISTINCT category) as categories
         FROM memory_trunk WHERE user_phone = $1`,
        [userPhone]
      );
      return result.rows[0];
    } catch (error) {
      // Fallback: try legacy memories table
      try {
        const fallback = await query(
          `SELECT COUNT(*) as total, COUNT(DISTINCT category) as categories
           FROM memories WHERE user_phone = $1`,
          [userPhone]
        );
        return fallback.rows[0];
      } catch (e2) {
        return { total: 0, categories: 0 };
      }
    }
  }

  async getMemoriesView(userPhone) {
    try {
      const result = await query(
        `SELECT * FROM memories 
         WHERE user_phone = $1 
         ORDER BY category, created_at DESC`,
        [userPhone]
      );

      if (result.rows.length === 0) {
        return 'No memories saved yet.\n\nTry: "Remember my wifi is abc123"';
      }

      // Group by category
      const grouped = {};
      result.rows.forEach(m => {
        const cat = m.category || 'general';
        if (!grouped[cat]) grouped[cat] = [];
        grouped[cat].push(m);
      });

      let response = `*Your Memories (${result.rows.length})*\n\n`;

      for (const [category, memories] of Object.entries(grouped)) {
        response += `*${category.charAt(0).toUpperCase() + category.slice(1)}*\n`;
        memories.forEach(m => {
          const value = m.value.length > 50 ? m.value.substring(0, 50) + '...' : m.value;
          response += `- ${m.key_name}: ${value}\n`;
        });
        response += '\n';
      }

      response += `_"forget [key]" to delete_`;

      return response;

    } catch (error) {
      logger.error('Get memories error:', error);
      return 'Could not load memories.';
    }
  }

  // ========== LISTS ==========
  async getListStats(userPhone) {
    try {
      const result = await query(
        `SELECT COUNT(DISTINCT l.id) as count, COUNT(li.id) as items
         FROM user_lists l
         LEFT JOIN list_items li ON li.list_id = l.id
         WHERE l.user_phone = $1`,
        [userPhone]
      );
      return result.rows[0];
    } catch (error) {
      return { count: 0, items: 0 };
    }
  }

  async getListsView(userPhone) {
    try {
      const result = await query(
        `SELECT l.id, l.list_name,
         COUNT(li.id) as total,
         COUNT(li.id) FILTER (WHERE li.is_completed = true) as done
         FROM user_lists l
         LEFT JOIN list_items li ON li.list_id = l.id
         WHERE l.user_phone = $1
         GROUP BY l.id, l.list_name
         ORDER BY l.list_name`,
        [userPhone]
      );

      if (result.rows.length === 0) {
        return 'No lists yet.\n\nTry: "add milk to shopping list"';
      }

      let response = `*Your Lists (${result.rows.length})*\n\n`;

      for (const list of result.rows) {
        response += `*${list.list_name}* (${list.done}/${list.total} done)\n`;
        
        // Get items for this list
        const items = await query(
          `SELECT item_text, is_completed FROM list_items
           WHERE list_id = $1
           ORDER BY is_completed, created_at DESC
           LIMIT 10`,
          [list.id]
        );

        items.rows.forEach(item => {
          const check = item.is_completed ? 'x' : ' ';
          response += `[${check}] ${item.item_text}\n`;
        });
        
        response += '\n';
      }

      response += `_"show [list] list" for full view_`;

      return response;

    } catch (error) {
      logger.error('Get lists error:', error);
      return 'Could not load lists.';
    }
  }

  // ========== IMAGES ==========
  async getImageStats(userPhone) {
    try {
      const result = await query(
        `SELECT COUNT(*) as total FROM user_images WHERE user_phone = $1`,
        [userPhone]
      );
      return result.rows[0];
    } catch (error) {
      return { total: 0 };
    }
  }

  async getImagesView(userPhone) {
    try {
      const result = await query(
        `SELECT * FROM user_images 
         WHERE user_phone = $1 
         ORDER BY created_at DESC
         LIMIT 10`,
        [userPhone]
      );

      if (result.rows.length === 0) {
        return 'No saved images yet.\n\nSend an image and say "save this image"';
      }

      let response = `*Your Saved Images (${result.rows.length})*\n\n`;

      result.rows.forEach((img, i) => {
        const date = this.formatDate(img.created_at);
        const tags = img.tags || 'no tags';
        const desc = img.description 
          ? (img.description.length > 40 ? img.description.substring(0, 40) + '...' : img.description)
          : 'No description';
        
        response += `${i + 1}. ${tags}\n`;
        response += `   ${date}\n`;
        response += `   ${desc}\n\n`;
      });

      response += `_Reply with number to get image_\n`;
      response += `_"delete image [number]" to remove_`;

      return response;

    } catch (error) {
      logger.error('Get images error:', error);
      return 'Could not load images.';
    }
  }

  async getImageByIndex(userPhone, index) {
    try {
      const result = await query(
        `SELECT * FROM user_images 
         WHERE user_phone = $1 
         ORDER BY created_at DESC
         LIMIT 10`,
        [userPhone]
      );

      if (index < 1 || index > result.rows.length) {
        return { success: false, message: `Invalid number. You have ${result.rows.length} images.` };
      }

      const image = result.rows[index - 1];
      return { 
        success: true, 
        url: image.image_url, 
        caption: image.description?.substring(0, 200) || '' 
      };

    } catch (error) {
      return { success: false, message: 'Could not get image.' };
    }
  }

  async deleteImageByIndex(userPhone, index) {
    try {
      const result = await query(
        `SELECT id, tags FROM user_images 
         WHERE user_phone = $1 
         ORDER BY created_at DESC
         LIMIT 10`,
        [userPhone]
      );

      if (index < 1 || index > result.rows.length) {
        return `Invalid number. You have ${result.rows.length} images.`;
      }

      const image = result.rows[index - 1];

      // Defensive: image.id came from a user-scoped SELECT above, so an
      // unscoped DELETE here is currently safe. But adding the
      // user_phone filter makes the contract explicit at the call site
      // — future refactors that reuse this query won't silently drop
      // the scope.
      await query(`DELETE FROM user_images WHERE id = $1 AND user_phone = $2`, [image.id, userPhone]);

      return `Deleted image: ${image.tags || 'untitled'}`;

    } catch (error) {
      logger.error('Delete image error:', error);
      return 'Could not delete image.';
    }
  }

  // ========== HELPERS ==========
  /**
   * Format a datetime for display. The caller MUST pass the user's timezone
   * — without it, the formatter falls back to the server's timezone
   * (UTC on EC2) and everything drifts by the user's offset (−5.5h for IST).
   */
  formatTime(dateStr, tz = 'Asia/Kolkata') {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return '';

    const timeStr = timeFormat.formatInTz(date, tz, { mode: 'time' });

    // "Today" / "Tomorrow" comparison must also happen in the user's tz —
    // otherwise an IST 2:30 AM reminder renders as "yesterday" on a UTC server.
    const today = timeFormat.formatInTz(new Date(), tz, { mode: 'date' });
    const tomorrowDate = timeFormat.formatInTz(new Date(Date.now() + 86400000), tz, { mode: 'date' });
    const renderedDay = timeFormat.formatInTz(date, tz, { mode: 'date' });

    if (renderedDay === today) return `Today ${timeStr}`;
    if (renderedDay === tomorrowDate) return `Tomorrow ${timeStr}`;
    return `${renderedDay} ${timeStr}`;
  }

  formatDate(dateStr) {
    return new Date(dateStr).toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    });
  }
}

module.exports = new DashboardService();
