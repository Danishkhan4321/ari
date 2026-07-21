const { google } = require('googleapis');
const googleAuthService = require('./google-auth.service');
const aiService = require('./ai.service');
const { withRetry } = require('../utils/retry');
const logger = require('../utils/logger');

// Decode HTML entities from Gmail snippets
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

class InboxOrganizerService {

  async getInboxSummary(userPhone, limit = 15) {
    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) {
      return { success: false, error: 'Google not connected. Say "connect google" first.' };
    }

    try {
      const gmail = google.gmail({ version: 'v1', auth: authClient });

      const listResult = await withRetry(() =>
        gmail.users.messages.list({
          userId: 'me',
          q: 'is:unread in:inbox',
          maxResults: limit
        })
      );

      const messages = listResult.data.messages || [];
      if (messages.length === 0) {
        return { success: true, emails: [], summary: 'Your inbox is clean! No unread emails.' };
      }

      const emails = await Promise.all(
        messages.map(msg => this._getEmailHeaders(gmail, msg.id))
      );

      const categorized = await this.categorizeEmails(emails);
      const summary = this._formatSummary(categorized, emails.length);

      return { success: true, emails: categorized, summary };
    } catch (error) {
      return this._handleGmailError(userPhone, error, 'Inbox summary');
    }
  }

  async getTodaysEmails(userPhone, limit = 20) {
    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) {
      return { success: false, error: 'Google not connected. Say "connect google" first.' };
    }

    try {
      const gmail = google.gmail({ version: 'v1', auth: authClient });

      // Gmail uses epoch seconds for after: filter
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const epochSeconds = Math.floor(todayStart.getTime() / 1000);

      const listResult = await withRetry(() =>
        gmail.users.messages.list({
          userId: 'me',
          q: `in:inbox after:${epochSeconds}`,
          maxResults: limit
        })
      );

      const messages = listResult.data.messages || [];
      if (messages.length === 0) {
        return { success: true, emails: [], summary: 'No emails received today yet.' };
      }

      const emails = await Promise.all(
        messages.map(msg => this._getEmailHeaders(gmail, msg.id))
      );

      let summary = `*Today's Emails* (${emails.length})\n\n`;
      emails.forEach((e, i) => {
        const from = e.from.replace(/<[^>]+>/, '').trim().slice(0, 30);
        const unread = e.labelIds.includes('UNREAD') ? ' (new)' : '';
        summary += `${i + 1}. *${e.subject || '(no subject)'}*${unread}\n   From: ${from}\n   ${decodeHtmlEntities(e.snippet).slice(0, 80)}\n\n`;
      });

      summary += '_Reply "read email [number]" to see full content_';
      return { success: true, emails, summary };
    } catch (error) {
      return this._handleGmailError(userPhone, error, 'Today emails');
    }
  }

  async _getEmailHeaders(gmail, messageId) {
    const result = await withRetry(() =>
      gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date']
      })
    );

    const headers = result.data.payload?.headers || [];
    const getHeader = (name) => headers.find(h => h.name === name)?.value || '';

    return {
      id: messageId,
      from: getHeader('From'),
      subject: getHeader('Subject'),
      date: getHeader('Date'),
      snippet: result.data.snippet || '',
      labelIds: result.data.labelIds || []
    };
  }

  async categorizeEmails(emails) {
    if (emails.length === 0) return { urgent: [], action_needed: [], fyi: [], newsletters: [], promotions: [] };

    const emailList = emails.map((e, i) =>
      `${i + 1}. From: ${e.from}\n   Subject: ${e.subject}\n   Preview: ${decodeHtmlEntities(e.snippet).slice(0, 100)}`
    ).join('\n\n');

    try {
      const prompt = `Categorize these emails into exactly these categories: urgent, action_needed, fyi, newsletters, promotions.
Return JSON only: {"urgent": [1,3], "action_needed": [2], "fyi": [4], "newsletters": [5], "promotions": []}
Use the email numbers. Each email must appear in exactly one category.

Emails:
${emailList}`;

      const response = await aiService.quickAI(prompt);
      const parsed = JSON.parse(response.match(/\{[\s\S]*\}/)?.[0] || '{}');

      const result = { urgent: [], action_needed: [], fyi: [], newsletters: [], promotions: [] };

      for (const [category, indices] of Object.entries(parsed)) {
        if (result[category] && Array.isArray(indices)) {
          result[category] = indices
            .map(idx => emails[idx - 1])
            .filter(Boolean);
        }
      }

      // Catch any uncategorized emails
      const categorized = new Set(Object.values(result).flat().map(e => e?.id));
      for (const email of emails) {
        if (!categorized.has(email.id)) {
          result.fyi.push(email);
        }
      }

      return result;
    } catch (error) {
      logger.warn('AI categorization failed, falling back:', error.message);
      return { urgent: [], action_needed: [], fyi: emails, newsletters: [], promotions: [] };
    }
  }

  async getEmailDetails(userPhone, messageId) {
    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) return { success: false, error: 'Google not connected.' };

    try {
      const gmail = google.gmail({ version: 'v1', auth: authClient });
      const result = await withRetry(() =>
        gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' })
      );

      const headers = result.data.payload?.headers || [];
      const getHeader = (name) => headers.find(h => h.name === name)?.value || '';

      const body = this._extractBody(result.data.payload);

      return {
        success: true,
        email: {
          id: messageId,
          from: getHeader('From'),
          to: getHeader('To'),
          subject: getHeader('Subject'),
          date: getHeader('Date'),
          body: body.slice(0, 3000)
        }
      };
    } catch (error) {
      return this._handleGmailError(userPhone, error, 'Email details');
    }
  }

  _extractBody(payload) {
    if (!payload) return '';

    // Direct body
    if (payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }

    // Multipart - look for text/plain first, then text/html
    const parts = payload.parts || [];
    for (const part of parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
    }
    for (const part of parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        const html = Buffer.from(part.body.data, 'base64').toString('utf-8');
        // Strip HTML tags for readable text
        return html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      }
    }

    // Nested multipart (e.g. multipart/alternative inside multipart/mixed)
    for (const part of parts) {
      if (part.parts) {
        const nested = this._extractBody(part);
        if (nested) return nested;
      }
    }

    return '';
  }

  async markAsRead(userPhone, messageId) {
    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) return { success: false, error: 'Google not connected.' };

    try {
      const gmail = google.gmail({ version: 'v1', auth: authClient });
      await gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        resource: { removeLabelIds: ['UNREAD'] }
      });
      return { success: true };
    } catch (error) {
      logger.error('Mark as read error:', error.message);
      return { success: false, error: 'Failed to mark as read.' };
    }
  }

  async markAsUnread(userPhone, messageId) {
    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) return { success: false, error: 'Google not connected.' };

    try {
      const gmail = google.gmail({ version: 'v1', auth: authClient });
      await gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        resource: { addLabelIds: ['UNREAD'] }
      });
      return { success: true };
    } catch (error) {
      logger.error('Mark as unread error:', error.message);
      return { success: false, error: 'Failed to mark as unread.' };
    }
  }

  async archiveEmail(userPhone, messageId) {
    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) return { success: false, error: 'Google not connected.' };

    try {
      const gmail = google.gmail({ version: 'v1', auth: authClient });
      await gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        resource: { removeLabelIds: ['INBOX'] }
      });
      return { success: true };
    } catch (error) {
      logger.error('Archive email error:', error.message);
      return { success: false, error: 'Failed to archive email.' };
    }
  }

  async listLabels(userPhone) {
    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) return { success: false, error: 'Google not connected.' };

    try {
      const gmail = google.gmail({ version: 'v1', auth: authClient });
      const result = await gmail.users.labels.list({ userId: 'me' });
      const labels = (result.data.labels || []).map(l => ({
        id: l.id,
        name: l.name,
        type: l.type === 'user' ? 'user' : 'system'
      }));
      return { success: true, labels };
    } catch (error) {
      logger.error('List labels error:', error.message);
      return { success: false, error: 'Failed to list labels.' };
    }
  }

  async findLabelIdByName(userPhone, labelName) {
    const result = await this.listLabels(userPhone);
    if (!result.success) return null;
    const target = labelName.toLowerCase().trim();
    const match = result.labels.find(l => l.name.toLowerCase() === target);
    return match ? match.id : null;
  }

  async createLabel(userPhone, labelName) {
    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) return { success: false, error: 'Google not connected.' };

    try {
      const gmail = google.gmail({ version: 'v1', auth: authClient });
      const result = await gmail.users.labels.create({
        userId: 'me',
        resource: {
          name: labelName,
          labelListVisibility: 'labelShow',
          messageListVisibility: 'show'
        }
      });
      return { success: true, label: { id: result.data.id, name: result.data.name } };
    } catch (error) {
      logger.error('Create label error:', error.message);
      return { success: false, error: 'Failed to create label.' };
    }
  }

  async applyLabel(userPhone, messageId, labelName) {
    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) return { success: false, error: 'Google not connected.' };

    try {
      let labelId = await this.findLabelIdByName(userPhone, labelName);
      if (!labelId) {
        const created = await this.createLabel(userPhone, labelName);
        if (!created.success) return created;
        labelId = created.label.id;
      }

      const gmail = google.gmail({ version: 'v1', auth: authClient });
      await gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        resource: { addLabelIds: [labelId] }
      });
      return { success: true };
    } catch (error) {
      logger.error('Apply label error:', error.message);
      return { success: false, error: 'Failed to apply label.' };
    }
  }

  async removeLabel(userPhone, messageId, labelName) {
    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) return { success: false, error: 'Google not connected.' };

    try {
      const labelId = await this.findLabelIdByName(userPhone, labelName);
      if (!labelId) {
        return { success: false, error: `Label "${labelName}" not found.` };
      }

      const gmail = google.gmail({ version: 'v1', auth: authClient });
      await gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        resource: { removeLabelIds: [labelId] }
      });
      return { success: true };
    } catch (error) {
      logger.error('Remove label error:', error.message);
      return { success: false, error: 'Failed to remove label.' };
    }
  }

  /**
   * Find a contact by name by searching the user's Gmail history.
   * Returns matched people as { name, email, frequency } sorted by most frequent.
   * Uses gmail.readonly scope — no extra contacts scope needed.
   */
  async findContactInEmails(userPhone, name) {
    if (!name || !String(name).trim()) return { success: false, error: 'Empty name' };

    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) return { success: false, error: 'Google not connected.' };

    try {
      const gmail = google.gmail({ version: 'v1', auth: authClient });
      const trimmed = String(name).trim();

      // Search both directions: emails from them AND emails to them
      const query = `from:${trimmed} OR to:${trimmed}`;
      const listResult = await withRetry(() =>
        gmail.users.messages.list({
          userId: 'me',
          q: query,
          maxResults: 20
        })
      );

      const messages = listResult.data.messages || [];
      if (messages.length === 0) return { success: true, matches: [] };

      // Fetch headers for each match
      const headerResults = await Promise.all(
        messages.map(msg =>
          gmail.users.messages.get({
            userId: 'me',
            id: msg.id,
            format: 'metadata',
            metadataHeaders: ['From', 'To', 'Cc']
          }).catch(() => null)
        )
      );

      // Aggregate name+email pairs across all results
      const emailMap = new Map(); // email -> { name, email, frequency }
      const lower = trimmed.toLowerCase();

      for (const result of headerResults) {
        if (!result) continue;
        const headers = result.data.payload?.headers || [];
        const fromHeader = headers.find(h => h.name === 'From')?.value || '';
        const toHeader = headers.find(h => h.name === 'To')?.value || '';
        const ccHeader = headers.find(h => h.name === 'Cc')?.value || '';

        // Parse "Name <email@example.com>" or "email@example.com" from all header values
        const allAddresses = [fromHeader, toHeader, ccHeader]
          .filter(Boolean)
          .join(', ');

        // Split comma-separated addresses (basic — ignores quoted commas)
        const parts = allAddresses.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
        for (const rawPart of parts) {
          const parsed = this._parseEmailAddress(rawPart);
          if (!parsed || !parsed.email) continue;

          // Only keep matches where the name OR local-part of the email contains the query
          const parsedNameLower = (parsed.name || '').toLowerCase();
          const localPart = parsed.email.split('@')[0].toLowerCase();
          const matchesQuery =
            parsedNameLower.includes(lower) ||
            localPart.includes(lower);

          if (!matchesQuery) continue;

          const existing = emailMap.get(parsed.email.toLowerCase());
          if (existing) {
            existing.frequency += 1;
            // Prefer the entry with a real name over email-only
            if (!existing.name && parsed.name) existing.name = parsed.name;
          } else {
            emailMap.set(parsed.email.toLowerCase(), {
              name: parsed.name || parsed.email.split('@')[0],
              email: parsed.email,
              frequency: 1
            });
          }
        }
      }

      const matches = Array.from(emailMap.values())
        .sort((a, b) => b.frequency - a.frequency)
        .slice(0, 5);

      return { success: true, matches };
    } catch (error) {
      logger.error('Find contact in emails error:', error.message);
      return { success: false, error: 'Failed to search Gmail for contact.' };
    }
  }

  /**
   * Parse a "Name <email@host>" header value into { name, email }.
   * Handles quoted names, unquoted names, and bare emails.
   */
  _parseEmailAddress(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;

    // Match: "Optional Name" <email@host> OR Name <email@host> OR email@host
    const angleMatch = trimmed.match(/^(?:"?([^"<]*?)"?\s*)?<([^>]+)>$/);
    if (angleMatch) {
      return {
        name: (angleMatch[1] || '').trim() || null,
        email: angleMatch[2].trim()
      };
    }
    // Plain email
    if (/^[^\s]+@[^\s]+$/.test(trimmed)) {
      return { name: null, email: trimmed };
    }
    return null;
  }

  async searchInbox(userPhone, searchQuery, limit = 10, folder = 'inbox') {
    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) return { success: false, error: 'Google not connected.' };

    try {
      const gmail = google.gmail({ version: 'v1', auth: authClient });

      // Add folder qualifier if not already present
      let q = searchQuery;
      if (folder === 'sent' && !q.includes('in:sent')) {
        q = `in:sent ${q}`;
      } else if (folder === 'inbox' && !q.includes('in:inbox') && !q.includes('in:sent')) {
        // default inbox behavior — no qualifier needed, Gmail defaults to all
      }
      // folder === 'all' means no qualifier

      const listResult = await withRetry(() =>
        gmail.users.messages.list({
          userId: 'me',
          q,
          maxResults: limit
        })
      );

      const messages = listResult.data.messages || [];
      if (messages.length === 0) {
        return { success: true, emails: [], summary: `No emails found for "${searchQuery}".` };
      }

      // Get headers + snippet for each result
      const emails = await Promise.all(
        messages.map(msg => this._getEmailHeaders(gmail, msg.id))
      );

      const folderLabel = folder === 'sent' ? 'Sent' : folder === 'all' ? 'All Mail' : 'Search';
      let summary = `*${folderLabel}: "${searchQuery}"* (${emails.length} result${emails.length > 1 ? 's' : ''})\n\n`;
      emails.forEach((e, i) => {
        const from = e.from.replace(/<[^>]+>/, '').trim().slice(0, 30);
        const date = e.date ? new Date(e.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '';
        summary += `${i + 1}. *${e.subject || '(no subject)'}*\n   From: ${from} | ${date}\n   ${decodeHtmlEntities(e.snippet).slice(0, 100)}\n\n`;
      });

      summary += '_Reply "read email [number]" to see full content_';
      return { success: true, emails, summary };
    } catch (error) {
      return this._handleGmailError(userPhone, error, 'Search inbox');
    }
  }

  async searchSentEmails(userPhone, recipientQuery, limit = 10) {
    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) return { success: false, error: 'Google not connected.' };

    try {
      const gmail = google.gmail({ version: 'v1', auth: authClient });

      // Build query: search sent folder for emails to this recipient
      const isEmail = /[\w.+\-]+@[\w\-]+\.[a-zA-Z]{2,}/.test(recipientQuery);
      const q = isEmail
        ? `in:sent to:${recipientQuery}`
        : `in:sent to:${recipientQuery} OR in:sent ${recipientQuery}`;

      const listResult = await withRetry(() =>
        gmail.users.messages.list({
          userId: 'me',
          q,
          maxResults: limit
        })
      );

      const messages = listResult.data.messages || [];
      if (messages.length === 0) {
        return { success: true, emails: [], summary: `No sent emails found for "${recipientQuery}".` };
      }

      const emails = await Promise.all(
        messages.map(msg => this._getEmailHeaders(gmail, msg.id))
      );

      return { success: true, emails };
    } catch (error) {
      return this._handleGmailError(userPhone, error, 'Search sent');
    }
  }

  async getEmailThread(userPhone, messageId) {
    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) return { success: false, error: 'Google not connected.' };

    try {
      const gmail = google.gmail({ version: 'v1', auth: authClient });

      // First get the message to find its threadId
      const msgResult = await withRetry(() =>
        gmail.users.messages.get({ userId: 'me', id: messageId, format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] })
      );
      const threadId = msgResult.data.threadId;

      // Now get the full thread
      const threadResult = await withRetry(() =>
        gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' })
      );

      const threadMessages = (threadResult.data.messages || []).map(msg => {
        const headers = msg.payload?.headers || [];
        const getHeader = (name) => headers.find(h => h.name === name)?.value || '';
        return {
          id: msg.id,
          threadId: msg.threadId,
          from: getHeader('From'),
          to: getHeader('To'),
          subject: getHeader('Subject'),
          date: getHeader('Date'),
          body: this._extractBody(msg.payload).slice(0, 2000),
          labelIds: msg.labelIds || []
        };
      });

      return { success: true, threadId, messages: threadMessages };
    } catch (error) {
      return this._handleGmailError(userPhone, error, 'Email thread');
    }
  }

  async _handleGmailError(userPhone, error, context) {
    // Check for scope/permission errors
    const errMsg = error.message || '';
    const errStatus = error.response?.status || error.code;

    logger.error(`${context} error [${errStatus}]: ${errMsg}`);

    if (errStatus === 403 || errMsg.includes('insufficient') || errMsg.includes('Insufficient Permission') || errMsg.includes('PERMISSION_DENIED')) {
      return {
        success: false,
        error: 'Gmail read permission not granted. Please say "disconnect google" then "connect google" to re-authorize with updated permissions.'
      };
    }

    const tokenResult = await googleAuthService.handleTokenError(userPhone, error);
    if (tokenResult.cleared) return { success: false, error: tokenResult.message };

    return { success: false, error: `Failed to access Gmail. Try again.` };
  }

  _formatSummary(categorized, totalCount) {
    let summary = `*Inbox Summary* (${totalCount} unread)\n\n`;

    const sections = [
      { key: 'urgent', emoji: '!', label: 'Urgent' },
      { key: 'action_needed', emoji: '>', label: 'Action Needed' },
      { key: 'fyi', emoji: '-', label: 'FYI' },
      { key: 'newsletters', emoji: '#', label: 'Newsletters' },
      { key: 'promotions', emoji: '$', label: 'Promotions' }
    ];

    for (const section of sections) {
      const emails = categorized[section.key] || [];
      if (emails.length === 0) continue;

      summary += `*${section.label}* (${emails.length}):\n`;
      emails.forEach(e => {
        const from = e.from.replace(/<[^>]+>/, '').trim().slice(0, 30);
        summary += `${section.emoji} ${from}: ${e.subject || '(no subject)'}\n`;
      });
      summary += '\n';
    }

    summary += '_Reply "read email 1" to see full content_';
    return summary;
  }

  // ── Auto-Labeling Helpers ────────────────────────────────────────

  /**
   * Fetch unread inbox emails newer than a given timestamp.
   * Used by the auto-label cron job for incremental processing.
   */
  async getUnreadSince(userPhone, afterTimestamp, limit = 20) {
    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) return [];

    try {
      const gmail = google.gmail({ version: 'v1', auth: authClient });
      const epochSeconds = afterTimestamp
        ? Math.floor(new Date(afterTimestamp).getTime() / 1000)
        : Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000); // default: last 24h

      const listResult = await withRetry(() =>
        gmail.users.messages.list({
          userId: 'me',
          q: `is:unread in:inbox after:${epochSeconds}`,
          maxResults: limit,
        })
      );

      const messages = listResult.data.messages || [];
      if (messages.length === 0) return [];

      const emails = [];
      for (const msg of messages) {
        try {
          const detail = await withRetry(() =>
            gmail.users.messages.get({
              userId: 'me',
              id: msg.id,
              format: 'metadata',
              metadataHeaders: ['From', 'Subject', 'Date'],
            })
          );

          const headers = detail.data.payload?.headers || [];
          const getHeader = (name) => headers.find(h => h.name === name)?.value || '';

          emails.push({
            id: msg.id,
            from: getHeader('From'),
            subject: getHeader('Subject'),
            snippet: detail.data.snippet || '',
            internalDate: detail.data.internalDate,
            labelIds: detail.data.labelIds || [],
          });
        } catch (err) {
          logger.warn(`[InboxOrganizer] Failed to fetch email ${msg.id}: ${err.message}`);
        }
      }

      return emails;
    } catch (error) {
      logger.error('[InboxOrganizer] getUnreadSince error:', error.message);
      return [];
    }
  }

  /**
   * Apply labels to multiple emails efficiently.
   * Caches label IDs per call to avoid repeated lookups.
   * @param {string} userPhone
   * @param {Array<{messageId: string, labelName: string}>} assignments
   */
  async batchApplyLabels(userPhone, assignments) {
    if (!assignments || assignments.length === 0) return { applied: 0 };

    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) return { applied: 0, error: 'Not connected' };

    const gmail = google.gmail({ version: 'v1', auth: authClient });
    const labelIdCache = {}; // labelName → labelId
    let applied = 0;

    for (const { messageId, labelName } of assignments) {
      try {
        // Get or create label (cached within this call)
        if (!labelIdCache[labelName]) {
          let labelId = await this.findLabelIdByName(userPhone, labelName);
          if (!labelId) {
            const created = await this.createLabel(userPhone, labelName);
            if (created.success) labelId = created.label.id;
          }
          if (labelId) labelIdCache[labelName] = labelId;
        }

        const labelId = labelIdCache[labelName];
        if (!labelId) continue;

        await gmail.users.messages.modify({
          userId: 'me',
          id: messageId,
          resource: { addLabelIds: [labelId] },
        });
        applied++;
      } catch (err) {
        logger.warn(`[InboxOrganizer] Failed to label ${messageId} as "${labelName}": ${err.message}`);
      }
    }

    return { applied };
  }
}

module.exports = new InboxOrganizerService();
