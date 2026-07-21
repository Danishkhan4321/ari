const registry = require('./handler-registry');
const knowledgeBaseService = require('../services/knowledge-base.service');
const { query } = require('../config/database');
const logger = require('../utils/logger');

registry.register('knowledge_base', async (message, context) => {
  const { text } = message;
  const { userPhone, intentParams } = context;
  const lower = text.toLowerCase().trim();

  try {
    // Resolve team admin phone for KB scoping
    const adminPhone = await _resolveAdminPhone(userPhone);
    if (!adminPhone) {
      return '\u26a0\ufe0f You need to be part of a team to use the knowledge base.\nAsk your admin to add you with "add team member [name] [phone]"';
    }

    // ── LLM Params-First Routing ────────────────────────────────────────
    if (intentParams?.action) {
      switch (intentParams.action) {
        case 'add': {
          if (intentParams.title && intentParams.content) {
            const article = await knowledgeBaseService.addArticle(
              adminPhone, intentParams.title, intentParams.content, 'general', null, userPhone, null
            );
            if (!article) return '\u274c Failed to add article to knowledge base. Please try again.';
            return `\ud83d\udcda KB Article Added\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\nTitle: ${article.title}\nCategory: ${article.category}\nID: #${article.id}`;
          }
          break;
        }
        case 'search': {
          if (intentParams.search_query) {
            const articles = await knowledgeBaseService.searchArticles(adminPhone, intentParams.search_query);
            if (articles.length === 0) return `\ud83d\udd0d No results found for "${intentParams.search_query}" in the knowledge base.`;
            let response = `\ud83d\udd0d KB Results for '${intentParams.search_query}'\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
            articles.forEach((a, i) => { response += `${i + 1}. [#${a.id}] ${a.title} (${a.category})\n`; });
            return response.trim();
          }
          break;
        }
        case 'categories': {
          const categories = await knowledgeBaseService.getCategories(adminPhone);
          if (categories.length === 0) return '\ud83d\udcda No categories yet. Add articles with "add to kb: Title - Content"';
          let response = '\ud83d\udcda KB Categories\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n';
          categories.forEach(c => { response += `\u2022 ${c.category} (${c.count} article${c.count !== 1 ? 's' : ''})\n`; });
          return response.trim();
        }
        case 'show': {
          if (intentParams.article_id) {
            const articleId = parseInt(intentParams.article_id);
            const article = await knowledgeBaseService.getArticle(adminPhone, articleId);
            if (!article) return `\u26a0\ufe0f Article #${articleId} not found in the knowledge base.`;
            return _formatArticle(article);
          }
          if (intentParams.title) {
            const article = await knowledgeBaseService.getArticleByTitle(adminPhone, intentParams.title);
            if (!article) return `\u26a0\ufe0f Article "${intentParams.title}" not found. Try "search kb: ${intentParams.title}" to search.`;
            return _formatArticle(article);
          }
          break;
        }
        case 'delete': {
          if (intentParams.article_id) {
            const articleId = parseInt(intentParams.article_id);
            const deleted = await knowledgeBaseService.deleteArticle(articleId, adminPhone);
            if (!deleted) return `\u26a0\ufe0f Could not delete article #${articleId}. It may not exist or you don't have permission.`;
            return `\ud83d\uddd1\ufe0f KB article #${articleId} has been deleted.`;
          }
          break;
        }
        case 'list': {
          const articles = await knowledgeBaseService.getRecentArticles(adminPhone, 10);
          if (articles.length === 0) return '\ud83d\udcda Knowledge Base is empty.\n\nAdd articles with "add to kb: Title - Content"';
          let response = `\ud83d\udcda Knowledge Base (${articles.length} recent)\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
          articles.forEach((a, i) => { response += `${i + 1}. [#${a.id}] ${a.title} (${a.category})\n`; });
          response += '\n_"show kb: [title]" or "kb article #ID" for details_';
          return response.trim();
        }
      }
    }

    // ── Regex Fallback ──────────────────────────────────────────────────

    // ── Add Article ─────────────────────────────────────────────────────
    const addMatch = text.match(/^(?:add\s+to\s+kb|kb\s+add|add\s+kb|add\s+to\s+knowledge\s+base|save\s+to\s+kb|document\s+(?:this|that)?)[:\s]+(.+)$/i);
    if (addMatch) {
      const raw = addMatch[1].trim();
      let title = raw;
      let content = raw;

      // Split on " - " to separate title from content
      const dashSplit = raw.match(/^(.+?)\s*-\s+(.+)$/);
      if (dashSplit) {
        title = dashSplit[1].trim();
        content = dashSplit[2].trim();
      }

      const article = await knowledgeBaseService.addArticle(
        adminPhone, title, content, 'general', null, userPhone, null
      );

      if (!article) {
        return '\u274c Failed to add article to knowledge base. Please try again.';
      }

      return `\ud83d\udcda KB Article Added\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\nTitle: ${article.title}\nCategory: ${article.category}\nID: #${article.id}`;
    }

    // ── Search Articles ─────────────────────────────────────────────────
    const searchMatch = text.match(/^(?:search\s+kb|kb\s+search|find\s+(?:in\s+)?kb|look\s+up\s+(?:in\s+)?kb|search\s+knowledge\s+base)[:\s]+(.+)$/i);
    if (searchMatch) {
      const searchTerm = searchMatch[1].trim();
      const articles = await knowledgeBaseService.searchArticles(adminPhone, searchTerm);

      if (articles.length === 0) {
        return `\ud83d\udd0d No results found for "${searchTerm}" in the knowledge base.`;
      }

      let response = `\ud83d\udd0d KB Results for '${searchTerm}'\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
      articles.forEach((a, i) => {
        response += `${i + 1}. [#${a.id}] ${a.title} (${a.category})\n`;
      });
      return response.trim();
    }

    // ── Categories ──────────────────────────────────────────────────────
    if (/^(?:kb\s+categories|knowledge\s*base\s+categories)$/i.test(lower)) {
      const categories = await knowledgeBaseService.getCategories(adminPhone);

      if (categories.length === 0) {
        return '\ud83d\udcda No categories yet. Add articles with "add to kb: Title - Content"';
      }

      let response = '\ud83d\udcda KB Categories\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n';
      categories.forEach(c => {
        response += `\u2022 ${c.category} (${c.count} article${c.count !== 1 ? 's' : ''})\n`;
      });
      return response.trim();
    }

    // ── Show Specific Article by ID ─────────────────────────────────────
    const idMatch = text.match(/^(?:kb\s+article|show\s+kb)\s+#?(\d+)$/i);
    if (idMatch) {
      const articleId = parseInt(idMatch[1]);
      const article = await knowledgeBaseService.getArticle(adminPhone, articleId);

      if (!article) {
        return `\u26a0\ufe0f Article #${articleId} not found in the knowledge base.`;
      }

      return _formatArticle(article);
    }

    // ── Show Specific Article by Title ──────────────────────────────────
    const titleMatch = text.match(/^(?:show\s+kb|kb\s+article)[:\s]+(.+)$/i);
    if (titleMatch) {
      const title = titleMatch[1].trim();
      // Check if it's a numeric ID first
      if (/^#?\d+$/.test(title)) {
        const articleId = parseInt(title.replace('#', ''));
        const article = await knowledgeBaseService.getArticle(adminPhone, articleId);
        if (!article) {
          return `\u26a0\ufe0f Article #${articleId} not found in the knowledge base.`;
        }
        return _formatArticle(article);
      }

      const article = await knowledgeBaseService.getArticleByTitle(adminPhone, title);

      if (!article) {
        return `\u26a0\ufe0f Article "${title}" not found. Try "search kb: ${title}" to search.`;
      }

      return _formatArticle(article);
    }

    // ── Delete Article ──────────────────────────────────────────────────
    const deleteMatch = text.match(/^(?:delete\s+kb|kb\s+delete|remove\s+kb)\s+#?(\d+)$/i);
    if (deleteMatch) {
      const articleId = parseInt(deleteMatch[1]);
      const deleted = await knowledgeBaseService.deleteArticle(articleId, adminPhone);

      if (!deleted) {
        return `\u26a0\ufe0f Could not delete article #${articleId}. It may not exist or you don't have permission.`;
      }

      return `\ud83d\uddd1\ufe0f KB article #${articleId} has been deleted.`;
    }

    // ── Show Recent Articles (default) ──────────────────────────────────
    if (/^(?:kb|knowledge\s*base|show\s+kb)$/i.test(lower)) {
      const articles = await knowledgeBaseService.getRecentArticles(adminPhone, 10);

      if (articles.length === 0) {
        return '\ud83d\udcda Knowledge Base is empty.\n\nAdd articles with "add to kb: Title - Content"';
      }

      let response = `\ud83d\udcda Knowledge Base (${articles.length} recent)\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
      articles.forEach((a, i) => {
        response += `${i + 1}. [#${a.id}] ${a.title} (${a.category})\n`;
      });
      response += '\n_"show kb: [title]" or "kb article #ID" for details_';
      return response.trim();
    }

    // ── Fallback ────────────────────────────────────────────────────────
    return '\ud83d\udcda *Knowledge Base Commands:*\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u2022 "add to kb: Title - Content"\n\u2022 "search kb: keyword"\n\u2022 "kb categories"\n\u2022 "show kb: Title" or "kb article #3"\n\u2022 "delete kb #3"\n\u2022 "kb" \u2014 show recent articles';

  } catch (error) {
    logger.error('Knowledge base handler error:', error.message);
    return '\u274c Something went wrong with the knowledge base. Please try again.';
  }
});

// ── Helper Functions ──────────────────────────────────────────────────────

async function _resolveAdminPhone(userPhone) {
  try {
    let result = await query('SELECT admin_phone FROM teams WHERE admin_phone = $1 LIMIT 1', [userPhone]);
    if (result.rows.length > 0) return userPhone;
    result = await query('SELECT admin_phone FROM teams WHERE member_phone = $1 LIMIT 1', [userPhone]);
    return result.rows.length > 0 ? result.rows[0].admin_phone : null;
  } catch {
    return null;
  }
}

function _formatArticle(article) {
  const date = new Date(article.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  let response = `\ud83d\udcda KB Article #${article.id}\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
  response += `\ud83d\udccc Title: ${article.title}\n`;
  response += `\ud83d\udcc2 Category: ${article.category}\n`;
  response += `\ud83d\udcc5 Added: ${date}\n\n`;
  response += `${article.content}`;
  if (article.tags) {
    response += `\n\n\ud83c\udff7\ufe0f Tags: ${article.tags}`;
  }
  return response;
}
