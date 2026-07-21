const registry = require('./handler-registry');
const readingListService = require('../services/reading-list.service');
const logger = require('../utils/logger');

registry.register('reading_list', async (message, context) => {
  const { text } = message;
  const { userPhone, intentParams } = context;

  try {
    // ── LLM Params-First Routing ──────────────────────────────────────
    if (intentParams?.action) {
      switch (intentParams.action) {
        case 'save': {
          if (intentParams.url) {
            const category = readingListService.detectCategory(intentParams.url);
            const item = await readingListService.addItem(userPhone, intentParams.url, null, category);

            if (!item) return 'Failed to save bookmark. Please try again.';

            const catEmoji = _categoryEmoji(item.category);
            let response = `Saved!\n━━━━━━━━━━━━\n`;
            if (item.title) {
              response += `Title: ${item.title}\n`;
            }
            response += `URL: ${item.url}\n`;
            response += `${catEmoji} Category: ${_capitalise(item.category)}\n`;
            response += `ID: #${item.id}`;
            return response;
          }
          break;
        }
        case 'list': {
          const showAll = intentParams.show_all || false;
          const status = showAll ? 'all' : 'unread';
          const items = await readingListService.getItems(userPhone, status);

          if (items.length === 0) {
            const label = showAll ? '' : 'unread ';
            return `No ${label}bookmarks found.\n\nSave a link with "save link https://..."!`;
          }

          const unreadCount = items.filter(i => i.status === 'unread').length;
          const headerLabel = showAll ? `${items.length} total` : `${unreadCount} unread`;
          let response = `Reading List (${headerLabel})\n━━━━━━━━━━━━\n`;

          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const statusIcon = item.status === 'read' ? '[read]' : '[unread]';
            const catTag = item.category ? ` [${item.category}]` : '';
            const title = item.title || _truncateUrl(item.url);
            response += `\n${i + 1}. ${statusIcon} ${title}${catTag}\n`;
            if (item.url) {
              response += `   ${item.url}\n`;
            }
            response += `   ID: #${item.id}\n`;
          }

          return response.trim();
        }
        case 'delete': {
          if (intentParams.item_id) {
            const success = await readingListService.deleteItem(userPhone, intentParams.item_id);
            if (!success) return 'Bookmark not found or could not be deleted.';
            return `Bookmark #${intentParams.item_id} deleted.`;
          }
          break;
        }
        case 'mark_read': {
          if (intentParams.item_id) {
            const success = await readingListService.markRead(userPhone, intentParams.item_id);
            if (!success) return 'Item not found or could not be updated.';
            return `Marked #${intentParams.item_id} as read!`;
          }
          break;
        }
        case 'stats': {
          const stats = await readingListService.getStats(userPhone);

          if (stats.total === 0) {
            return 'Reading Stats\n━━━━━━━━━━━━\nNo bookmarks yet.\n\nSave a link with "save link https://..."!';
          }

          let response = `Reading Stats\n━━━━━━━━━━━━\n`;
          response += `Total: ${stats.total}\n`;
          response += `Unread: ${stats.unread}\n`;
          response += `Read: ${stats.read}\n`;

          if (stats.topCategories.length > 0) {
            response += `\nBy Category:\n`;
            for (const cat of stats.topCategories) {
              const emoji = _categoryEmoji(cat.category);
              response += `${emoji} ${_capitalise(cat.category)}: ${cat.count}\n`;
            }
          }

          return response.trim();
        }
        case 'search': {
          if (intentParams.search_query && intentParams.search_query.length >= 2) {
            const items = await readingListService.searchItems(userPhone, intentParams.search_query);

            if (items.length === 0) {
              return `No bookmarks found matching "${intentParams.search_query}".`;
            }

            let response = `Search Results: "${intentParams.search_query}"\n━━━━━━━━━━━━\n`;
            for (let i = 0; i < items.length; i++) {
              const item = items[i];
              const statusIcon = item.status === 'read' ? '[read]' : '[unread]';
              const catTag = item.category ? ` [${item.category}]` : '';
              const title = item.title || _truncateUrl(item.url);
              response += `\n${i + 1}. ${statusIcon} ${title}${catTag}\n`;
              if (item.url) {
                response += `   ${item.url}\n`;
              }
              response += `   ID: #${item.id}\n`;
            }

            return response.trim();
          }
          break;
        }
      }
    }

    // ── Regex Fallback (existing code, unchanged) ─────────────────────
    const lower = text.toLowerCase().trim();

    // ── Delete Bookmark ───────────────────────────────────────────────
    if (/\b(?:delete|remove)\s+(?:bookmark|link|item|reading)\b/i.test(lower)) {
      const idMatch = lower.match(/#?(\d+)/);
      if (!idMatch) {
        return 'Please specify the bookmark ID to delete.\nExample: "delete bookmark #3"';
      }

      const id = parseInt(idMatch[1]);
      const success = await readingListService.deleteItem(userPhone, id);

      if (!success) {
        return 'Bookmark not found or could not be deleted.';
      }

      return `Bookmark #${id} deleted.`;
    }

    // ── Mark as Read ──────────────────────────────────────────────────
    if (/\b(?:mark\s+read|read)\s+#?(\d+)\b/i.test(lower) ||
        /\b#?(\d+)\s+(?:mark\s+)?read\b/i.test(lower)) {
      const idMatch = lower.match(/\b(?:mark\s+read|read)\s+#?(\d+)/i) ||
                       lower.match(/#?(\d+)\s+(?:mark\s+)?read/i);
      if (!idMatch) {
        return 'Please specify which item to mark as read.\nExample: "mark read #3"';
      }

      const id = parseInt(idMatch[1]);
      const success = await readingListService.markRead(userPhone, id);

      if (!success) {
        return 'Item not found or could not be updated.';
      }

      return `Marked #${id} as read!`;
    }

    // ── Reading Stats ─────────────────────────────────────────────────
    if (/\breading\s*stat/i.test(lower) || /\bbookmark\s*stat/i.test(lower)) {
      const stats = await readingListService.getStats(userPhone);

      if (stats.total === 0) {
        return 'Reading Stats\n━━━━━━━━━━━━\nNo bookmarks yet.\n\nSave a link with "save link https://..."!';
      }

      let response = `Reading Stats\n━━━━━━━━━━━━\n`;
      response += `Total: ${stats.total}\n`;
      response += `Unread: ${stats.unread}\n`;
      response += `Read: ${stats.read}\n`;

      if (stats.topCategories.length > 0) {
        response += `\nBy Category:\n`;
        for (const cat of stats.topCategories) {
          const emoji = _categoryEmoji(cat.category);
          response += `${emoji} ${_capitalise(cat.category)}: ${cat.count}\n`;
        }
      }

      return response.trim();
    }

    // ── Search Bookmarks ──────────────────────────────────────────────
    if (/\b(?:search|find)\s+(?:bookmark|link|reading)/i.test(lower)) {
      const searchTerm = text
        .replace(/^.*?\b(?:search|find)\s+(?:bookmarks?|links?|reading\s*list?)[:\s]*/i, '')
        .trim();

      if (!searchTerm || searchTerm.length < 2) {
        return 'Please provide a search term.\nExample: "search bookmarks: react"';
      }

      const items = await readingListService.searchItems(userPhone, searchTerm);

      if (items.length === 0) {
        return `No bookmarks found matching "${searchTerm}".`;
      }

      let response = `Search Results: "${searchTerm}"\n━━━━━━━━━━━━\n`;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const statusIcon = item.status === 'read' ? '[read]' : '[unread]';
        const catTag = item.category ? ` [${item.category}]` : '';
        const title = item.title || _truncateUrl(item.url);
        response += `\n${i + 1}. ${statusIcon} ${title}${catTag}\n`;
        if (item.url) {
          response += `   ${item.url}\n`;
        }
        response += `   ID: #${item.id}\n`;
      }

      return response.trim();
    }

    // ── List Reading List ─────────────────────────────────────────────
    // Only match list intent if there's NO URL in the message
    const hasUrl = /https?:\/\//i.test(lower);
    if (!hasUrl && (
        /\b(?:my|show|list|view|get)\s*(?:reading\s*list|bookmark|saved\s*link)/i.test(lower) ||
        /\b(?:reading\s*list|bookmarks|saved\s*links)\b/i.test(lower))) {
      // Check if user wants all or just unread
      const showAll = /\ball\b/i.test(lower);
      const status = showAll ? 'all' : 'unread';
      const items = await readingListService.getItems(userPhone, status);

      if (items.length === 0) {
        const label = showAll ? '' : 'unread ';
        return `No ${label}bookmarks found.\n\nSave a link with "save link https://..."!`;
      }

      const unreadCount = items.filter(i => i.status === 'unread').length;
      const headerLabel = showAll ? `${items.length} total` : `${unreadCount} unread`;
      let response = `Reading List (${headerLabel})\n━━━━━━━━━━━━\n`;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const statusIcon = item.status === 'read' ? '[read]' : '[unread]';
        const catTag = item.category ? ` [${item.category}]` : '';
        const title = item.title || _truncateUrl(item.url);
        response += `\n${i + 1}. ${statusIcon} ${title}${catTag}\n`;
        if (item.url) {
          response += `   ${item.url}\n`;
        }
        response += `   ID: #${item.id}\n`;
      }

      return response.trim();
    }

    // ── Save Link / Add Bookmark (default) ────────────────────────────
    const { url, remainingText } = readingListService.extractUrlFromText(text);

    if (!url) {
      return 'Please provide a URL to save.\nExample: "save link https://example.com/article"';
    }

    // Use remaining text as title hint, or null to let the service handle it
    const title = remainingText
      ? remainingText
          .replace(/^(?:save|bookmark|add|store)\s*(?:link|url|this|bookmark)?[:\s]*/i, '')
          .replace(/\s+/g, ' ')
          .trim() || null
      : null;

    const category = readingListService.detectCategory(url);
    const item = await readingListService.addItem(userPhone, url, title, category);

    if (!item) {
      return 'Failed to save bookmark. Please try again.';
    }

    const catEmoji = _categoryEmoji(item.category);
    let response = `Saved!\n━━━━━━━━━━━━\n`;
    if (item.title) {
      response += `Title: ${item.title}\n`;
    }
    response += `URL: ${item.url}\n`;
    response += `${catEmoji} Category: ${_capitalise(item.category)}\n`;
    response += `ID: #${item.id}`;

    return response;

  } catch (error) {
    logger.error('Reading list handler error:', error.message);
    return 'Something went wrong with reading list. Please try again.';
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────

function _categoryEmoji(category) {
  const map = {
    tech: '',
    video: '',
    article: '',
    social: '',
    research: '',
    news: '',
    docs: '',
    general: '',
  };
  return map[category] || '';
}

function _truncateUrl(url) {
  if (!url) return 'Untitled';
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.length > 30
      ? parsed.pathname.substring(0, 30) + '...'
      : parsed.pathname;
    return `${parsed.hostname}${path}`;
  } catch {
    return url.length > 50 ? url.substring(0, 50) + '...' : url;
  }
}

function _capitalise(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}
