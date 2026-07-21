/**
 * Outlook Inbox Service
 *
 * Reads and searches Outlook emails via Microsoft Graph API.
 * Mirrors inbox-organizer.service.js (Gmail) but for Outlook/Microsoft 365.
 */

'use strict';

const axios = require('axios');
const microsoftAuthService = require('./microsoft-auth.service');
const aiService = require('./ai.service');
const { withRetry } = require('../utils/retry');
const logger = require('../utils/logger');

const GRAPH_URL = 'https://graph.microsoft.com/v1.0';

function decodeHtmlEntities(text) {
  if (!text) return '';
  return text
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)));
}

class OutlookInboxService {

  async _getClient(userPhone) {
    const token = await microsoftAuthService.getAccessToken(userPhone);
    if (!token) return null;
    return {
      get: (url, config = {}) => axios.get(`${GRAPH_URL}${url}`, {
        ...config,
        headers: { Authorization: `Bearer ${token}`, ...config.headers },
        timeout: 30000,
      }),
      patch: (url, data, config = {}) => axios.patch(`${GRAPH_URL}${url}`, data, {
        ...config,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...config.headers },
        timeout: 30000,
      }),
    };
  }

  async isConnected(userPhone) {
    return await microsoftAuthService.isConnected(userPhone);
  }

  // ========== INBOX SUMMARY ==========

  async getInboxSummary(userPhone, limit = 15) {
    const client = await this._getClient(userPhone);
    if (!client) return { success: false, error: 'Outlook not connected. Say "connect outlook" first.' };

    try {
      const response = await withRetry(() =>
        client.get(`/me/mailFolders/inbox/messages?$top=${limit}&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,bodyPreview,isRead`)
      );

      const messages = response.data.value || [];
      if (messages.length === 0) {
        return { success: true, emails: [], summary: 'Your Outlook inbox is empty.' };
      }

      const emails = messages.map(msg => this._formatEmail(msg));
      const unreadCount = emails.filter(e => !e.isRead).length;

      let summary = `*Outlook Inbox* (${emails.length} emails, ${unreadCount} unread)\n\n`;
      emails.forEach((e, i) => {
        const unread = e.isRead ? '' : ' 🔵';
        summary += `${i + 1}. *${e.subject || '(no subject)'}*${unread}\n   From: ${e.from}\n   ${decodeHtmlEntities(e.snippet).slice(0, 80)}\n\n`;
      });
      summary += '_Reply "read email [number]" to see full content_';

      return { success: true, emails, summary };
    } catch (error) {
      return this._handleError(userPhone, error, 'Get inbox');
    }
  }

  // ========== TODAY'S EMAILS ==========

  async getTodaysEmails(userPhone, limit = 20) {
    const client = await this._getClient(userPhone);
    if (!client) return { success: false, error: 'Outlook not connected. Say "connect outlook" first.' };

    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayISO = today.toISOString();

      const response = await withRetry(() =>
        client.get(`/me/messages?$filter=receivedDateTime ge ${todayISO}&$top=${limit}&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,bodyPreview,isRead`)
      );

      const messages = response.data.value || [];
      if (messages.length === 0) {
        return { success: true, emails: [], summary: 'No Outlook emails received today.' };
      }

      const emails = messages.map(msg => this._formatEmail(msg));

      let summary = `*Today's Outlook Emails* (${emails.length})\n\n`;
      emails.forEach((e, i) => {
        const unread = e.isRead ? '' : ' 🔵';
        summary += `${i + 1}. *${e.subject || '(no subject)'}*${unread}\n   From: ${e.from}\n   ${decodeHtmlEntities(e.snippet).slice(0, 80)}\n\n`;
      });
      summary += '_Reply "read email [number]" to see full content_';

      return { success: true, emails, summary };
    } catch (error) {
      return this._handleError(userPhone, error, 'Today\'s emails');
    }
  }

  // ========== SEARCH ==========

  async searchInbox(userPhone, searchQuery, limit = 10) {
    const client = await this._getClient(userPhone);
    if (!client) return { success: false, error: 'Outlook not connected. Say "connect outlook" first.' };

    try {
      // Microsoft Graph $search supports KQL (Keyword Query Language)
      const response = await withRetry(() =>
        client.get(`/me/messages?$search="${encodeURIComponent(searchQuery)}"&$top=${limit}&$select=id,subject,from,receivedDateTime,bodyPreview,isRead`)
      );

      const messages = response.data.value || [];
      if (messages.length === 0) {
        return { success: true, emails: [], summary: `No Outlook emails found for "${searchQuery}".` };
      }

      const emails = messages.map(msg => this._formatEmail(msg));

      let summary = `*Outlook Search: "${searchQuery}"* (${emails.length} result${emails.length > 1 ? 's' : ''})\n\n`;
      emails.forEach((e, i) => {
        summary += `${i + 1}. *${e.subject || '(no subject)'}*\n   From: ${e.from} | ${e.dateFormatted}\n   ${decodeHtmlEntities(e.snippet).slice(0, 100)}\n\n`;
      });
      summary += '_Reply "read email [number]" to see full content_';

      return { success: true, emails, summary };
    } catch (error) {
      return this._handleError(userPhone, error, 'Search inbox');
    }
  }

  // ========== EMAIL DETAILS ==========

  async getEmailDetails(userPhone, messageId) {
    const client = await this._getClient(userPhone);
    if (!client) return { success: false, error: 'Outlook not connected.' };

    try {
      const response = await withRetry(() =>
        client.get(`/me/messages/${messageId}?$select=id,subject,from,toRecipients,receivedDateTime,body,isRead`)
      );

      const msg = response.data;
      const from = msg.from?.emailAddress
        ? `${msg.from.emailAddress.name || ''} <${msg.from.emailAddress.address}>`
        : 'Unknown';
      const to = (msg.toRecipients || [])
        .map(r => r.emailAddress?.address || '')
        .join(', ');

      // Strip HTML from body
      let body = msg.body?.content || '';
      if (msg.body?.contentType === 'html') {
        body = body
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        body = decodeHtmlEntities(body);
      }

      return {
        success: true,
        email: {
          id: msg.id,
          from,
          to,
          subject: msg.subject || '(no subject)',
          date: msg.receivedDateTime,
          body: body.slice(0, 3000),
        }
      };
    } catch (error) {
      return this._handleError(userPhone, error, 'Get email details');
    }
  }

  // ========== MARK AS READ ==========

  async markAsRead(userPhone, messageId) {
    const client = await this._getClient(userPhone);
    if (!client) return { success: false, error: 'Outlook not connected.' };

    try {
      await withRetry(() =>
        client.patch(`/me/messages/${messageId}`, { isRead: true })
      );
      return { success: true };
    } catch (error) {
      return this._handleError(userPhone, error, 'Mark as read');
    }
  }

  // ========== HELPERS ==========

  _formatEmail(msg) {
    const from = msg.from?.emailAddress
      ? `${msg.from.emailAddress.name || msg.from.emailAddress.address}`
      : 'Unknown';
    const date = msg.receivedDateTime ? new Date(msg.receivedDateTime) : null;
    const dateFormatted = date
      ? date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
      : '';

    return {
      id: msg.id,
      from,
      subject: msg.subject || '(no subject)',
      date: msg.receivedDateTime,
      dateFormatted,
      snippet: msg.bodyPreview || '',
      isRead: msg.isRead !== false,
    };
  }

  async _handleError(userPhone, error, context) {
    const status = error.response?.status;
    logger.error(`[OutlookInbox] ${context} failed for ${userPhone}: ${error.message} (${status})`);

    if (status === 401 || status === 403) {
      const tokenResult = await microsoftAuthService.handleTokenError(userPhone, error);
      if (tokenResult?.cleared) {
        return { success: false, error: 'Your Outlook session expired. Say "connect outlook" to reconnect.' };
      }
      return { success: false, error: 'Outlook access denied. You may need to reconnect with "connect outlook".' };
    }

    if (status === 429) {
      return { success: false, error: 'Too many requests to Outlook. Please wait a moment and try again.' };
    }

    return { success: false, error: `Could not access Outlook emails. Please try again.` };
  }
}

module.exports = new OutlookInboxService();
