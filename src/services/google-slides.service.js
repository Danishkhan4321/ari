const { google } = require('googleapis');
const googleAuthService = require('./google-auth.service');
const aiService = require('./ai.service');
const { withRetry } = require('../utils/retry');
const logger = require('../utils/logger');
const { sanitizeApiQueryString } = require('../utils/security');

/**
 * Google Slides service. Mirrors google-docs.service.js — same five
 * operations (read, search, create, summarize, extract-id) so the
 * handler in webhook.controller.js can stay symmetric across
 * Docs / Sheets / Slides.
 *
 * Uses scopes:
 *   https://www.googleapis.com/auth/presentations          (write)
 *   https://www.googleapis.com/auth/presentations.readonly (read)
 *
 * Search routes through Drive (same as Docs/Sheets) — Slides API itself
 * has no list/search endpoint, so we filter Drive by the Slides MIME type.
 */
class GoogleSlidesService {

  async getPresentationContent(userPhone, presentationId) {
    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) {
      return { success: false, error: 'Google not connected. Say "connect google" first.' };
    }

    try {
      const slides = google.slides({ version: 'v1', auth: authClient });

      const result = await withRetry(() =>
        slides.presentations.get({ presentationId })
      );

      const presentation = result.data;
      const text = this._extractText(presentation.slides || []);

      return {
        success: true,
        title: presentation.title,
        slideCount: (presentation.slides || []).length,
        content: text.slice(0, 5000),
        fullLength: text.length
      };
    } catch (error) {
      const tokenResult = await googleAuthService.handleTokenError(userPhone, error);
      if (tokenResult.cleared) return { success: false, error: tokenResult.message };
      logger.error('Slides get content error:', error.message);
      return { success: false, error: 'Failed to read presentation.' };
    }
  }

  /**
   * Pull plain text from every slide. Walks pageElements → shape → text →
   * textElements → textRun. Skips images, charts, tables-without-text.
   * One slide per paragraph block in the output, separated by blank lines
   * so a downstream summary call can tell slides apart.
   */
  _extractText(slides) {
    const slideTexts = [];
    for (const slide of slides) {
      const parts = [];
      for (const element of slide.pageElements || []) {
        const textContent = element.shape?.text?.textElements;
        if (!textContent) continue;
        for (const elem of textContent) {
          if (elem.textRun?.content) parts.push(elem.textRun.content);
        }
      }
      if (parts.length > 0) slideTexts.push(parts.join('').trim());
    }
    return slideTexts.join('\n\n');
  }

  async searchPresentations(userPhone, searchQuery) {
    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) return { success: false, error: 'Google not connected.' };

    try {
      const drive = google.drive({ version: 'v3', auth: authClient });

      const safeQuery = sanitizeApiQueryString(searchQuery, 200);
      const result = await withRetry(() =>
        drive.files.list({
          q: `mimeType='application/vnd.google-apps.presentation' and trashed=false and (name contains '${safeQuery}' or fullText contains '${safeQuery}')`,
          pageSize: 10,
          fields: 'files(id, name, modifiedTime, webViewLink)',
          orderBy: 'modifiedTime desc'
        })
      );

      return { success: true, presentations: result.data.files || [] };
    } catch (error) {
      const tokenResult = await googleAuthService.handleTokenError(userPhone, error);
      if (tokenResult.cleared) return { success: false, error: tokenResult.message };
      logger.error('Slides search error:', error.message);
      return { success: false, error: 'Failed to search presentations.' };
    }
  }

  async createPresentation(userPhone, title) {
    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) return { success: false, error: 'Google not connected.' };

    try {
      const slides = google.slides({ version: 'v1', auth: authClient });

      const createResult = await slides.presentations.create({
        resource: { title }
      });

      const presentationId = createResult.data.presentationId;

      return {
        success: true,
        presentationId,
        title,
        link: `https://docs.google.com/presentation/d/${presentationId}/edit`
      };
    } catch (error) {
      const tokenResult = await googleAuthService.handleTokenError(userPhone, error);
      if (tokenResult.cleared) return { success: false, error: tokenResult.message };
      logger.error('Slides create error:', error.message);
      return { success: false, error: 'Failed to create presentation.' };
    }
  }

  async summarizePresentation(userPhone, presentationId) {
    const result = await this.getPresentationContent(userPhone, presentationId);
    if (!result.success) return result;

    if (!result.content || result.content.trim().length === 0) {
      return { success: true, title: result.title, slideCount: result.slideCount, summary: 'The presentation appears to be empty (no text content found).' };
    }

    try {
      const summary = await aiService.quickAI(
        `Summarize this presentation concisely (max 200 words). Highlight the main themes and key points:\n\nTitle: ${result.title}\nSlides: ${result.slideCount}\n\n${result.content}`,
        { maxTokens: 300 }
      );

      return {
        success: true,
        title: result.title,
        slideCount: result.slideCount,
        summary
      };
    } catch (error) {
      logger.error('Slides summarize error:', error.message);
      return { success: false, error: 'Failed to summarize presentation.' };
    }
  }

  extractPresentationId(text) {
    // Slides URL: https://docs.google.com/presentation/d/<ID>/edit
    const urlMatch = text.match(/\/presentation\/d\/([a-zA-Z0-9_-]+)/);
    if (urlMatch) return urlMatch[1];

    // Bare ID — Slides IDs are 20+ chars of alphanumeric + dash + underscore
    const idMatch = text.match(/\b([a-zA-Z0-9_-]{20,})\b/);
    if (idMatch) return idMatch[1];

    return null;
  }
}

module.exports = new GoogleSlidesService();
