const { google } = require('googleapis');
const googleAuthService = require('./google-auth.service');
const { withRetry } = require('../utils/retry');
const logger = require('../utils/logger');
const { sanitizeApiQueryString } = require('../utils/security');

class GoogleDriveService {

  async listFiles(userPhone, searchQuery = '', limit = 10) {
    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) {
      return { success: false, error: 'Google not connected. Say "connect google" first.' };
    }

    try {
      const drive = google.drive({ version: 'v3', auth: authClient });

      let q = 'trashed = false';
      if (searchQuery) {
        const safe = sanitizeApiQueryString(searchQuery, 200);
        q += ` and (name contains '${safe}' or fullText contains '${safe}')`;
      }

      const result = await withRetry(() =>
        drive.files.list({
          q,
          pageSize: limit,
          fields: 'files(id, name, mimeType, modifiedTime, webViewLink, size, owners)',
          orderBy: 'modifiedTime desc'
        })
      );

      const files = result.data.files || [];
      return { success: true, files };
    } catch (error) {
      const tokenResult = await googleAuthService.handleTokenError(userPhone, error);
      if (tokenResult.cleared) return { success: false, error: tokenResult.message };
      logger.error('Drive list error:', error.message);
      return { success: false, error: 'Failed to list files.' };
    }
  }

  async getFileContent(userPhone, fileId) {
    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) return { success: false, error: 'Google not connected.' };

    try {
      const drive = google.drive({ version: 'v3', auth: authClient });

      // Get file metadata first
      const meta = await drive.files.get({ fileId, fields: 'name, mimeType' });
      const mimeType = meta.data.mimeType;

      // For Google Docs/Sheets/Slides, export as plain text
      if (mimeType === 'application/vnd.google-apps.document') {
        const result = await drive.files.export({ fileId, mimeType: 'text/plain' });
        return { success: true, content: result.data, name: meta.data.name, type: 'document' };
      }
      if (mimeType === 'application/vnd.google-apps.spreadsheet') {
        const result = await drive.files.export({ fileId, mimeType: 'text/csv' });
        return { success: true, content: result.data, name: meta.data.name, type: 'spreadsheet' };
      }
      if (mimeType === 'application/vnd.google-apps.presentation') {
        const result = await drive.files.export({ fileId, mimeType: 'text/plain' });
        return { success: true, content: result.data, name: meta.data.name, type: 'presentation' };
      }

      // For regular files, try to download text content
      if (mimeType?.startsWith('text/') || mimeType === 'application/json') {
        const result = await drive.files.get({ fileId, alt: 'media' });
        return { success: true, content: String(result.data).slice(0, 5000), name: meta.data.name, type: 'file' };
      }

      return { success: true, content: null, name: meta.data.name, type: 'binary', message: `File "${meta.data.name}" is a ${mimeType} file. Cannot display content in chat.` };
    } catch (error) {
      const tokenResult = await googleAuthService.handleTokenError(userPhone, error);
      if (tokenResult.cleared) return { success: false, error: tokenResult.message };
      logger.error('Drive get content error:', error.message);
      return { success: false, error: 'Failed to read file.' };
    }
  }

  /**
   * Share a Drive file or folder with another user's email.
   *
   * @param {string} userPhone
   * @param {string} fileId
   * @param {string} email - recipient
   * @param {object} [opts]
   * @param {('reader'|'commenter'|'writer')} [opts.role='reader']
   *        - 'reader' (default): view only
   *        - 'commenter': view + comment
   *        - 'writer': edit, upload, add files (use for collaborative folders)
   * @param {string} [opts.message] - optional note included in the Google email
   */
  async shareFile(userPhone, fileId, email, opts = {}) {
    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) return { success: false, error: 'Google not connected.' };

    const role = ['reader', 'commenter', 'writer'].includes(opts.role) ? opts.role : 'reader';

    try {
      const drive = google.drive({ version: 'v3', auth: authClient });

      await drive.permissions.create({
        fileId,
        resource: { type: 'user', role, emailAddress: email },
        sendNotificationEmail: true,
        emailMessage: opts.message || undefined
      });

      const meta = await drive.files.get({
        fileId,
        fields: 'name, webViewLink, mimeType'
      });
      return {
        success: true,
        name: meta.data.name,
        link: meta.data.webViewLink,
        role,
        isFolder: meta.data.mimeType === 'application/vnd.google-apps.folder'
      };
    } catch (error) {
      const tokenResult = await googleAuthService.handleTokenError(userPhone, error);
      if (tokenResult.cleared) return { success: false, error: tokenResult.message };
      logger.error('Drive share error:', error.message);
      return { success: false, error: 'Failed to share file.' };
    }
  }

  async createFolder(userPhone, name) {
    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) return { success: false, error: 'Google not connected.' };

    try {
      const drive = google.drive({ version: 'v3', auth: authClient });

      const result = await drive.files.create({
        resource: {
          name,
          mimeType: 'application/vnd.google-apps.folder'
        },
        fields: 'id, name, webViewLink'
      });

      return { success: true, folder: result.data };
    } catch (error) {
      logger.error('Drive create folder error:', error.message);
      return { success: false, error: 'Failed to create folder.' };
    }
  }

  async uploadFile(userPhone, { name, content, mimeType }) {
    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) return { success: false, error: 'Google not connected.' };

    try {
      const drive = google.drive({ version: 'v3', auth: authClient });
      const { Readable } = require('stream');

      const result = await drive.files.create({
        resource: { name },
        media: {
          mimeType: mimeType || 'text/plain',
          body: Readable.from([content])
        },
        fields: 'id, name, webViewLink'
      });

      return { success: true, file: result.data };
    } catch (error) {
      logger.error('Drive upload error:', error.message);
      return { success: false, error: 'Failed to upload file.' };
    }
  }

  formatFileList(files) {
    if (!files || files.length === 0) return 'No files found.';

    const typeIcons = {
      'application/vnd.google-apps.document': 'Doc',
      'application/vnd.google-apps.spreadsheet': 'Sheet',
      'application/vnd.google-apps.presentation': 'Slides',
      'application/vnd.google-apps.folder': 'Folder',
      'application/pdf': 'PDF',
    };

    return files.map((f, i) => {
      const type = typeIcons[f.mimeType] || 'File';
      const date = new Date(f.modifiedTime).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
      return `${i + 1}. [${type}] *${f.name}*  (${date})`;
    }).join('\n');
  }
}

module.exports = new GoogleDriveService();
