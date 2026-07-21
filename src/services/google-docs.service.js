const { google } = require('googleapis');
const googleAuthService = require('./google-auth.service');
const aiService = require('./ai.service');
const { withRetry } = require('../utils/retry');
const logger = require('../utils/logger');
const { sanitizeApiQueryString } = require('../utils/security');

class GoogleDocsService {

  async appendText(userPhone, documentId, text) {
    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) return { success: false, error: 'Google not connected. Say "connect google" first.' };
    try {
      const docs = google.docs({ version: 'v1', auth: authClient });
      const doc = await withRetry(() => docs.documents.get({ documentId }));
      const content = doc.data.body?.content || [];
      const last = content[content.length - 1];
      const endIndex = Math.max(Number(last?.endIndex || 1) - 1, 1);
      await withRetry(() => docs.documents.batchUpdate({
        documentId,
        resource: { requests: [{ insertText: { location: { index: endIndex }, text } }] },
      }));
      return { success: true };
    } catch (error) {
      const tokenResult = await googleAuthService.handleTokenError(userPhone, error);
      if (tokenResult.cleared) return { success: false, error: tokenResult.message };
      logger.error('Docs append error:', error.message);
      return { success: false, error: 'Failed to append to document.' };
    }
  }

  async getDocContent(userPhone, docId) {
    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) {
      return { success: false, error: 'Google not connected. Say "connect google" first.' };
    }

    try {
      const docs = google.docs({ version: 'v1', auth: authClient });

      const result = await withRetry(() =>
        docs.documents.get({ documentId: docId })
      );

      const doc = result.data;
      const text = this._extractText(doc.body?.content || []);

      return {
        success: true,
        title: doc.title,
        content: text.slice(0, 5000),
        fullLength: text.length
      };
    } catch (error) {
      const tokenResult = await googleAuthService.handleTokenError(userPhone, error);
      if (tokenResult.cleared) return { success: false, error: tokenResult.message };
      logger.error('Docs get content error:', error.message);
      return { success: false, error: 'Failed to read document.' };
    }
  }

  _extractText(content) {
    let text = '';
    for (const element of content) {
      if (element.paragraph) {
        for (const elem of element.paragraph.elements || []) {
          if (elem.textRun) {
            text += elem.textRun.content;
          }
        }
      }
      if (element.table) {
        for (const row of element.table.tableRows || []) {
          for (const cell of row.tableCells || []) {
            text += this._extractText(cell.content || []);
            text += '\t';
          }
          text += '\n';
        }
      }
    }
    return text;
  }

  async searchDocs(userPhone, searchQuery) {
    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) return { success: false, error: 'Google not connected.' };

    try {
      const drive = google.drive({ version: 'v3', auth: authClient });

      const result = await withRetry(() =>
        drive.files.list({
          q: `mimeType='application/vnd.google-apps.document' and trashed=false and (name contains '${sanitizeApiQueryString(searchQuery, 200)}' or fullText contains '${sanitizeApiQueryString(searchQuery, 200)}')`,
          pageSize: 10,
          fields: 'files(id, name, modifiedTime, webViewLink)',
          orderBy: 'modifiedTime desc'
        })
      );

      return { success: true, docs: result.data.files || [] };
    } catch (error) {
      const tokenResult = await googleAuthService.handleTokenError(userPhone, error);
      if (tokenResult.cleared) return { success: false, error: tokenResult.message };
      logger.error('Docs search error:', error.message);
      return { success: false, error: 'Failed to search documents.' };
    }
  }

  async createDoc(userPhone, title, content) {
    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) return { success: false, error: 'Google not connected.' };

    try {
      const docs = google.docs({ version: 'v1', auth: authClient });

      const createResult = await docs.documents.create({
        resource: { title }
      });

      const docId = createResult.data.documentId;

      if (content) {
        await docs.documents.batchUpdate({
          documentId: docId,
          resource: {
            requests: [{
              insertText: {
                location: { index: 1 },
                text: content
              }
            }]
          }
        });
      }

      return {
        success: true,
        docId,
        title,
        link: `https://docs.google.com/document/d/${docId}/edit`
      };
    } catch (error) {
      const tokenResult = await googleAuthService.handleTokenError(userPhone, error);
      if (tokenResult.cleared) return { success: false, error: tokenResult.message };
      logger.error('Docs create error:', error.message);
      return { success: false, error: 'Failed to create document.' };
    }
  }

  async summarizeDoc(userPhone, docId) {
    const docResult = await this.getDocContent(userPhone, docId);
    if (!docResult.success) return docResult;

    try {
      const summary = await aiService.quickAI(
        `Summarize this document concisely (max 200 words):\n\nTitle: ${docResult.title}\n\n${docResult.content}`,
        { maxTokens: 300 }
      );

      return {
        success: true,
        title: docResult.title,
        summary
      };
    } catch (error) {
      logger.error('Doc summarize error:', error.message);
      return { success: false, error: 'Failed to summarize document.' };
    }
  }

  extractDocId(text) {
    // Extract doc ID from Google Docs URL or raw ID
    const urlMatch = text.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
    if (urlMatch) return urlMatch[1];

    // Raw ID (alphanumeric with dashes/underscores, 20+ chars)
    const idMatch = text.match(/\b([a-zA-Z0-9_-]{20,})\b/);
    if (idMatch) return idMatch[1];

    return null;
  }
}

module.exports = new GoogleDocsService();
