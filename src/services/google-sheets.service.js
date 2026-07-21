const { google } = require('googleapis');
const googleAuthService = require('./google-auth.service');
const aiService = require('./ai.service');
const { withRetry } = require('../utils/retry');
const logger = require('../utils/logger');
const { sanitizeApiQueryString } = require('../utils/security');

class GoogleSheetsService {

  async getSheetData(userPhone, spreadsheetId, range = 'Sheet1') {
    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) {
      return { success: false, error: 'Google not connected. Say "connect google" first.' };
    }

    try {
      const sheets = google.sheets({ version: 'v4', auth: authClient });

      const result = await withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId,
          range
        })
      );

      const rows = result.data.values || [];

      // Get spreadsheet title
      const meta = await sheets.spreadsheets.get({
        spreadsheetId,
        fields: 'properties.title,sheets.properties.title'
      });

      return {
        success: true,
        title: meta.data.properties?.title || 'Untitled',
        sheetNames: meta.data.sheets?.map(s => s.properties?.title) || [],
        rows,
        rowCount: rows.length
      };
    } catch (error) {
      const tokenResult = await googleAuthService.handleTokenError(userPhone, error);
      if (tokenResult.cleared) return { success: false, error: tokenResult.message };
      logger.error('Sheets get data error:', error.message);
      return { success: false, error: 'Failed to read spreadsheet.' };
    }
  }

  async searchSheets(userPhone, searchQuery) {
    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) return { success: false, error: 'Google not connected.' };

    try {
      const drive = google.drive({ version: 'v3', auth: authClient });

      const safeQuery = sanitizeApiQueryString(searchQuery, 200);
      const result = await withRetry(() =>
        drive.files.list({
          q: `mimeType='application/vnd.google-apps.spreadsheet' and trashed=false and (name contains '${safeQuery}' or fullText contains '${safeQuery}')`,
          pageSize: 10,
          fields: 'files(id, name, modifiedTime, webViewLink)',
          orderBy: 'modifiedTime desc'
        })
      );

      return { success: true, sheets: result.data.files || [] };
    } catch (error) {
      const tokenResult = await googleAuthService.handleTokenError(userPhone, error);
      if (tokenResult.cleared) return { success: false, error: tokenResult.message };
      logger.error('Sheets search error:', error.message);
      return { success: false, error: 'Failed to search spreadsheets.' };
    }
  }

  async createSpreadsheet(userPhone, title) {
    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) return { success: false, error: 'Google not connected.' };

    try {
      const sheets = google.sheets({ version: 'v4', auth: authClient });

      const result = await sheets.spreadsheets.create({
        resource: {
          properties: { title },
          sheets: [{ properties: { title: 'Sheet1' } }]
        }
      });

      const spreadsheetId = result.data.spreadsheetId;
      return {
        success: true,
        spreadsheetId,
        title,
        link: result.data.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`
      };
    } catch (error) {
      const tokenResult = await googleAuthService.handleTokenError(userPhone, error);
      if (tokenResult.cleared) return { success: false, error: tokenResult.message };
      logger.error('Sheets create error:', error.message);
      return { success: false, error: 'Failed to create spreadsheet.' };
    }
  }

  async appendRow(userPhone, spreadsheetId, sheetName, values) {
    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) return { success: false, error: 'Google not connected.' };

    try {
      const sheets = google.sheets({ version: 'v4', auth: authClient });

      const result = await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: sheetName || 'Sheet1',
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [Array.isArray(values) ? values : [values]]
        }
      });

      return {
        success: true,
        updatedRange: result.data.updates?.updatedRange,
        updatedRows: result.data.updates?.updatedRows
      };
    } catch (error) {
      const tokenResult = await googleAuthService.handleTokenError(userPhone, error);
      if (tokenResult.cleared) return { success: false, error: tokenResult.message };
      logger.error('Sheets append error:', error.message);
      return { success: false, error: 'Failed to add data to spreadsheet.' };
    }
  }

  async summarizeSheet(userPhone, spreadsheetId) {
    const dataResult = await this.getSheetData(userPhone, spreadsheetId);
    if (!dataResult.success) return dataResult;

    const rows = dataResult.rows;
    if (rows.length === 0) {
      return { success: true, title: dataResult.title, summary: 'The spreadsheet is empty.' };
    }

    // Format as CSV-like text for AI (limit to first 50 rows)
    const preview = rows.slice(0, 50).map(row => row.join(', ')).join('\n');

    try {
      const summary = await aiService.quickAI(
        `Summarize this spreadsheet data concisely (max 200 words). Highlight key numbers, trends, or patterns:\n\nTitle: ${dataResult.title}\nTotal rows: ${rows.length}\n\nData:\n${preview}`,
        { maxTokens: 300 }
      );

      return {
        success: true,
        title: dataResult.title,
        rowCount: rows.length,
        summary
      };
    } catch (error) {
      logger.error('Sheet summarize error:', error.message);
      return { success: false, error: 'Failed to summarize spreadsheet.' };
    }
  }

  extractSpreadsheetId(text) {
    const urlMatch = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (urlMatch) return urlMatch[1];

    const idMatch = text.match(/\b([a-zA-Z0-9_-]{20,})\b/);
    if (idMatch) return idMatch[1];

    return null;
  }

  formatSheetPreview(rows, maxRows = 10) {
    if (!rows || rows.length === 0) return 'Empty spreadsheet.';

    const header = rows[0];
    const dataRows = rows.slice(1, maxRows + 1);

    let preview = `*Columns:* ${header.join(' | ')}\n\n`;
    dataRows.forEach((row, i) => {
      preview += `${i + 1}. ${row.join(' | ')}\n`;
    });

    if (rows.length > maxRows + 1) {
      preview += `\n...and ${rows.length - maxRows - 1} more rows`;
    }

    return preview;
  }
}

module.exports = new GoogleSheetsService();
