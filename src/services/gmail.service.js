const axios = require('axios');
const { google } = require('googleapis');
const googleAuthService = require('./google-auth.service');
const calendarService = require('./calendar.service');
const { query: dbQuery } = require('../config/database');
const { withRetry } = require('../utils/retry');
const logger = require('../utils/logger');
const llm = require('./llm-provider');

class GmailService {

  normalizeSubject(value) {
    const cleaned = String(value || '')
      .replace(/[\r\n]+/g, ' ')
      .replace(/Ã¢Â€Â“|Ã¢Â€Â”|â€“|â€”|–|—/g, ' - ')
      .replace(/Ã¢Â€Â˜|Ã¢Â€Â™|â€˜|â€™|‘|’/g, "'")
      .replace(/Ã¢Â€Âœ|Ã¢Â€Â|â€œ|â€|“|”/g, '"')
      .replace(/Ã¢Â€Â¦|â€¦|…/g, '...')
      .replace(/Â/g, '')
      // Decode common HTML entities
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
      .replace(/\s{2,}/g, ' ')
      .trim();

    return cleaned || 'No Subject';
  }

  decodeHtmlEntities(text) {
    if (!text) return text;
    return String(text)
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
  }

  encodeMimeHeader(value) {
    const cleaned = this.normalizeSubject(value);
    if (!cleaned) return '';
    if (/^[\x20-\x7E]*$/.test(cleaned)) return cleaned;
    return `=?UTF-8?B?${Buffer.from(cleaned, 'utf8').toString('base64')}?=`;
  }

  // Convert plain text body to HTML with clickable links and hyperlinked names
  bodyToHtml(body) {
    let html = body;
    // Collect links into array, replace with placeholders before HTML escaping
    const links = [];
    // Markdown-style: [Name](URL)
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, text, url) => {
      links.push({ text, url });
      return `{{LINK_${links.length - 1}}}`;
    });
    // "Name (URL)" pattern
    html = html.replace(/([A-Za-z][A-Za-z\s.]+?)\s*\((https?:\/\/[^\s)]+)\)/g, (_, text, url) => {
      links.push({ text, url });
      return `{{LINK_${links.length - 1}}}`;
    });
    // Raw HTML <a> tags the AI might output
    html = html.replace(/<a\s+href=["'](https?:\/\/[^"']+)["'][^>]*>([^<]+)<\/a>/gi, (_, url, text) => {
      links.push({ text, url });
      return `{{LINK_${links.length - 1}}}`;
    });

    // Escape HTML
    html = html
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Restore link placeholders as proper HTML links
    html = html.replace(/\{\{LINK_(\d+)\}\}/g, (_, idx) => {
      const link = links[parseInt(idx)];
      return `<a href="${link.url}" style="color:#1a73e8">${link.text.trim()}</a>`;
    });

    // Convert any remaining standalone URLs to clickable links
    html = html.replace(/(^|[\s>])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" style="color:#1a73e8">$2</a>');

    // Auto-link bare domain names (e.g. OpenSphere.ai, google.com) that aren't already inside a link
    html = html.replace(/(?<!["\/a-z])([A-Za-z0-9][\w-]*\.(ai|com|org|net|io|co|dev|app|xyz|tech|me|in))\b(?![^<]*<\/a>)/g,
      '<a href="https://$1" style="color:#1a73e8">$1</a>');

    html = html.replace(/\n/g, '<br>');
    return `<div style="font-family:sans-serif;max-width:600px"><p>${html}</p></div>`;
  }

  // Convert body to WhatsApp-friendly preview (strip markdown, show links cleanly)
  previewBody(body) {
    return body
      // [Name](URL) â†’ Name\nURL (name on one line, link below)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1\n$2')
      // Name (URL) â†’ Name\nURL
      .replace(/([A-Za-z][A-Za-z\s.]+?)\s*\((https?:\/\/[^\s)]+)\)/g, '$1\n$2')
      // Strip any raw HTML <a> tags
      .replace(/<a\s+href=["'](https?:\/\/[^"']+)["'][^>]*>([^<]+)<\/a>/gi, '$2\n$1');
  }

  buildMimeMessage(from, to, subject, html, attachments = [], { cc, bcc } = {}) {
    const toList = Array.isArray(to) ? to.join(', ') : to;
    const boundary = `boundary_${Date.now()}`;
    const hasAttachments = attachments && attachments.length > 0;

    // Build common headers
    const headers = [`From: ${from}`, `To: ${toList}`];
    if (cc) headers.push(`Cc: ${Array.isArray(cc) ? cc.join(', ') : cc}`);
    if (bcc) headers.push(`Bcc: ${Array.isArray(bcc) ? bcc.join(', ') : bcc}`);

    if (!hasAttachments) {
      // Simple text+html email (no attachments)
      const message = [
        ...headers,
        `Subject: ${this.encodeMimeHeader(subject)}`,
        `MIME-Version: 1.0`,
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset="UTF-8"',
        '',
        html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' '),
        '',
        `--${boundary}`,
        'Content-Type: text/html; charset="UTF-8"',
        '',
        html,
        '',
        `--${boundary}--`
      ].join('\r\n');
      return Buffer.from(message).toString('base64url');
    }

    // Email with attachments: multipart/mixed wrapping multipart/alternative + attachments
    const altBoundary = `alt_${Date.now()}`;
    const parts = [
      ...headers,
      // Encode the subject (RFC 2047) so non-ASCII characters survive MTA
      // rewriting. The no-attachment branch above already does this; the
      // attachment branch was missing it, which mangled subjects like
      // "नई पदोन्नति – Promotion Announcement".
      `Subject: ${this.encodeMimeHeader(subject)}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      '',
      `--${altBoundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' '),
      '',
      `--${altBoundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      '',
      html,
      '',
      `--${altBoundary}--`
    ];

    // Add each attachment
    for (const att of attachments) {
      const base64Data = att.buffer.toString('base64');
      parts.push(
        '',
        `--${boundary}`,
        `Content-Type: ${att.mimeType || 'application/octet-stream'}; name="${att.fileName}"`,
        `Content-Disposition: attachment; filename="${att.fileName}"`,
        'Content-Transfer-Encoding: base64',
        '',
        base64Data
      );
    }

    parts.push('', `--${boundary}--`);
    return Buffer.from(parts.join('\r\n')).toString('base64url');
  }

  async sendEmail(userPhone, { to, subject, htmlBody, attachments }) {
    try {
      const authClient = await googleAuthService.getAuthClient(userPhone);
      if (!authClient) {
        return { success: false, error: 'Google not connected. Say "connect google" first.' };
      }

      const gmail = google.gmail({ version: 'v1', auth: authClient });
      const senderEmail = await googleAuthService.getGoogleEmail(userPhone);
      const toList = Array.isArray(to) ? to : [to];
      const raw = this.buildMimeMessage(senderEmail, toList, subject, htmlBody, attachments || []);

      const result = await withRetry(() =>
        gmail.users.messages.send({
          userId: 'me',
          resource: { raw }
        })
      );

      // Audit log
      await calendarService.auditLog(userPhone, 'send_email', null, {
        to: toList, subject, messageId: result.data.id
      });

      // Log for follow-up lookups
      await this.logSentEmail(userPhone, {
        to: toList[0], subject,
        messageId: result.data.id, threadId: result.data.threadId
      });

      // Auto-track reply if user has reply tracking enabled
      try {
        const emailPreferencesService = require('./email-preferences.service');
        const replyTrackerService = require('./reply-tracker.service');
        const prefs = await emailPreferencesService.getPreferences(userPhone);
        if (prefs.reply_tracking_enabled) {
          await replyTrackerService.trackEmail(userPhone, {
            messageId: result.data.id,
            threadId: result.data.threadId,
            recipientEmail: toList[0],
            recipientName: null,
            subject,
            sentAt: new Date(),
            waitHours: prefs.reply_tracking_hours || 24,
          });
        }
      } catch (trackErr) {
        logger.warn('Auto-track reply error:', trackErr.message);
      }

      return { success: true, messageId: result.data.id, threadId: result.data.threadId };

    } catch (error) {
      const tokenResult = await googleAuthService.handleTokenError(userPhone, error);
      if (tokenResult.cleared) return { success: false, error: tokenResult.message };

      logger.error('sendEmail error:', error.message);
      // Keep `error` generic (user-facing) but surface the real cause via
      // additive fields so callers can detect systemic failures (quota/429).
      return { success: false, error: 'Failed to send email', reason: String((error && error.message) || ''), code: (error && error.code) || null };
    }
  }

  async sendMeetingConfirmation(userPhone, event, attendees) {
    const startTime = new Date(event.start?.dateTime || event.start).toLocaleString('en-IN', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true
    });
    const endTime = new Date(event.end?.dateTime || event.end).toLocaleTimeString('en-IN', {
      hour: 'numeric', minute: '2-digit', hour12: true
    });

    const title = event.summary || event.title || 'Meeting';
    const to = attendees.map(a => a.email || a);
    const subject = `Meeting Confirmed: ${title}`;

    const html = `
      <div style="font-family:sans-serif;max-width:600px">
        <h2 style="color:#1a73e8">Meeting Confirmed</h2>
        <table style="border-collapse:collapse;width:100%">
          <tr><td style="padding:8px;font-weight:bold">Title:</td><td style="padding:8px">${title}</td></tr>
          <tr><td style="padding:8px;font-weight:bold">When:</td><td style="padding:8px">${startTime} - ${endTime}</td></tr>
          ${event.location ? `<tr><td style="padding:8px;font-weight:bold">Where:</td><td style="padding:8px">${event.location}</td></tr>` : ''}
          <tr><td style="padding:8px;font-weight:bold">Attendees:</td><td style="padding:8px">${to.join(', ')}</td></tr>
        </table>
        ${event.htmlLink ? `<p><a href="${event.htmlLink}" style="color:#1a73e8">View in Google Calendar</a></p>` : ''}
      </div>
    `;

    return this.sendEmail(userPhone, { to, subject, htmlBody: html });
  }

  async sendRescheduleRequest(userPhone, event, newTime, attendees) {
    const title = event.summary || event.title || 'Meeting';
    const to = attendees.map(a => a.email || a);
    const subject = `Meeting Rescheduled: ${title}`;

    const newTimeStr = new Date(newTime).toLocaleString('en-IN', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true
    });

    const html = `
      <div style="font-family:sans-serif;max-width:600px">
        <h2 style="color:#f9a825">Meeting Rescheduled</h2>
        <p><strong>${title}</strong> has been rescheduled.</p>
        <p><strong>New time:</strong> ${newTimeStr}</p>
        ${event.htmlLink ? `<p><a href="${event.htmlLink}" style="color:#1a73e8">View in Google Calendar</a></p>` : ''}
      </div>
    `;

    return this.sendEmail(userPhone, { to, subject, htmlBody: html });
  }

  async sendCancellationNotice(userPhone, event, attendees, reason = '') {
    const title = event.summary || event.title || 'Meeting';
    const to = attendees.map(a => a.email || a);
    const subject = `Meeting Cancelled: ${title}`;

    const html = `
      <div style="font-family:sans-serif;max-width:600px">
        <h2 style="color:#d93025">Meeting Cancelled</h2>
        <p><strong>${title}</strong> has been cancelled.</p>
        ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
      </div>
    `;

    return this.sendEmail(userPhone, { to, subject, htmlBody: html });
  }

  async draftEmailWithAI(userMessage, documentText = null) {
    try {
      // Extract email address from message
      const emailMatch = userMessage.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i);
      if (!emailMatch) {
        return { success: false, error: 'No email address found in your message.' };
      }
      const to = emailMatch[0];

      const apiKey = llm.apiKey();
      const apiUrl = llm.chatUrl();
      const model = llm.fastModel();

      const docContext = documentText
        ? `\n\nATTACHED DOCUMENT CONTENT (use this to personalize the email â€” extract relevant details like name, skills, experience, etc.):\n${documentText.slice(0, 4000)}`
        : '';

      const taskModel = llm.modelFor('email_draft') || model;
      const response = await llm.chatCompletion({
        model: taskModel,
        messages: [
          {
            role: 'system',
            content: `You are an email drafting assistant. Given a user's message about sending an email, extract or generate the email content.

Output ONLY valid JSON with these fields:
- “subject”: the email subject line (specific and clear, not generic)
- “body”: the email body as plain text

EMAIL WRITING RULES:
- Write like a competent professional, not a template. Sound like a real person wrote this
- First sentence should be specific and relevant — NEVER start with “I hope this email finds you well” or “I'm reaching out to...”
- Use recipient's first name: just “Hi [Name],” — not “Dear Sir/Madam”
- Keep sentences short. Average 12-15 words per sentence. One idea per sentence
- End with a specific, low-friction ask — not vague “let me know your thoughts”
- Total length: 3-5 sentences for standard emails, max 8 for detailed ones
- Tone: direct, warm, confident. Not overly formal, not too casual

BANNED EMAIL WORDS (never use these):
“synergize”, “leverage”, “circle back”, “touch base”, “moving forward”, “per our conversation”, “as per”, “please find attached”, “I hope this email finds you well”, “I'm reaching out to”, “Exciting Opportunity”, “Dear Sir/Madam”, “cutting-edge”, “robust solution”

NO PLACEHOLDER OR TEMPLATE TOKENS (this is critical — the email goes to a real recipient):
- NEVER write things like "[Add key metrics here]", "[Your Name]", "[Insert X]", "[fill in details]", "[Add details]", "[Company]", "[Date]", "{name}", "{{topic}}", "<Your name>", "TBD", "TODO".
- If you don't have a specific detail, write a generic but plausible sentence ("I'd like to walk through the highlights and a couple of standout points") — DO NOT leave a fill-in-the-blank.
- If a piece of information is genuinely missing and important, omit that line entirely rather than placeholder it.

OTHER RULES:
- The user may have typos or messy spelling — interpret their intent, don't copy their typos into the email
- If the user provides explicit subject and body (e.g. “subject hello body how are you”), extract them as-is
- If the user asks you to “write” or “draft” about a topic, generate a professional email
- Try to extract the recipient's first name from the email address for a greeting (e.g. “Hi Danish” from danishwork.ai@gmail.com)
- Do NOT include sign-offs like “Best regards” unless the user specified them
- IMPORTANT: If a URL is mentioned alongside a name for hyperlinking, put the name on one line then the link on the NEXT line in markdown format. Example: "John Doe\\n[LinkedIn](https://linkedin.com/in/johndoe)". NEVER output raw HTML tags. ALWAYS use [text](url) for links
- If document content is provided (resume, report, etc.), use it to personalize the email â€” extract the sender's name, key skills, experience, and relevant details to craft a compelling email
- IMPORTANT: If the document contains a LinkedIn URL or any profile link, extract and use the EXACT URL from the document. Do NOT guess or make up URLs. If no LinkedIn URL is found in the document, do NOT add one.
- The document will be attached separately, so don't paste its full contents in the body â€” just reference and use key details
- Output ONLY the JSON object, nothing else`
          },
          {
            role: 'user',
            content: `User message: "${userMessage}"\nRecipient: ${to}${docContext}`
          }
        ],
        temperature: 0.3,
        max_tokens: 800,
      }, { task: 'email_draft', timeout: 15000 });
      try { require('./model-usage-tracker.service').log({ task: 'email_draft', model: taskModel, usage: response?.data?.usage }); } catch (_) {}

      const content = response.data.choices[0].message.content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { success: false, error: 'Could not draft email. Try again?' };
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const subject = this.normalizeSubject(parsed.subject || 'No Subject');
      const rawBody = this.decodeHtmlEntities(parsed.body || '');

      // Apr 28 2026 — RC1 fix: strip any LLM-inserted placeholder tokens
      // like "[Add key metrics here]", "[Your Name]", "{{name}}", "<TBD>"
      // before showing the draft to the user. Without this guard, a careless
      // user could hit "yes" on a draft containing fill-in-the-blank brackets
      // and we'd send literal "[Add details]" to the real recipient.
      const body = this._stripPlaceholderTokens(rawBody);

      const htmlBody = this.bodyToHtml(body);

      return { success: true, to, subject, body, htmlBody };
    } catch (error) {
      logger.error('draftEmailWithAI error:', error.message);
      return { success: false, error: 'Could not draft email. Try again?' };
    }
  }

  /**
   * Strip placeholder/template tokens from LLM-generated email bodies.
   * Patterns covered:
   *   [Add key metrics here]    [Your Name]   [Insert X]   [TBD]   [TODO]
   *   {name}   {{topic}}   <Your name>   <TBD>
   *
   * If a placeholder dominates a paragraph, the whole paragraph is removed.
   * Otherwise the placeholder is removed and surrounding whitespace tidied.
   */
  _stripPlaceholderTokens(body) {
    if (!body) return body;

    // Square-bracket fill-ins: [Add X here], [Your Name], [Insert ...], [TBD], [TODO]
    const sqBracket = /\[[^\]\n]{2,80}\]/g;
    // Curly-brace template tokens: {name}, {{topic}}
    const curly = /\{\{?[^}\n]{1,40}\}?\}/g;
    // Angle placeholders, but NOT URLs / HTML tags / emails: only <Word ...>
    const angle = /<[A-Z][^>\n]{1,40}>/g;

    let cleaned = body;

    // Remove whole lines that are mostly placeholder
    cleaned = cleaned
      .split('\n')
      .filter(line => {
        const stripped = line.replace(sqBracket, '').replace(curly, '').replace(angle, '').trim();
        // If the line is now empty or only punctuation, drop it
        return stripped.length >= 8;
      })
      .join('\n');

    // Then remove any remaining inline placeholders
    cleaned = cleaned.replace(sqBracket, '').replace(curly, '').replace(angle, '');

    // Tidy up double spaces and orphaned punctuation
    cleaned = cleaned
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+([,.;:!?])/g, '$1')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return cleaned;
  }

  // Draft email content WITHOUT requiring an email address (for "draft only" mode)
  async draftEmailContent(userMessage, documentText = null) {
    try {
      const apiKey = llm.apiKey();
      const apiUrl = llm.chatUrl();
      const model = llm.fastModel();

      const docContext = documentText
        ? `\n\nATTACHED DOCUMENT CONTENT:\n${documentText.slice(0, 4000)}`
        : '';

      const response = await axios.post(apiUrl, {
        model,
        messages: [
          {
            role: 'system',
            content: `You are an email drafting assistant. Generate a professional email from the user's request.
Output ONLY valid JSON: {"subject": "...", "body": "..."}
Rules:
- Extract recipient name for greeting if mentioned (e.g. "Hi Rahul,")
- Write like a real professional, not a template — direct, warm, confident
- First sentence should be specific — NEVER "I hope this email finds you well"
- Keep sentences short (12-15 words avg). 3-5 sentences total
- End with a specific ask, not vague "let me know your thoughts"
- NEVER use: "synergize", "leverage", "circle back", "touch base", "moving forward", "per our conversation", "Dear Sir/Madam"
- Do NOT add a sign-off unless the user asks for one
- Output ONLY the JSON object, nothing else`
          },
          { role: 'user', content: `User request: "${userMessage}"${docContext}` }
        ],
        temperature: 0.3,
        max_tokens: 800
      }, {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 15000
      });

      const content = response.data.choices[0].message.content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { success: false, error: 'Could not draft email. Try again?' };

      const parsed = JSON.parse(jsonMatch[0]);
      const subject = this.normalizeSubject(parsed.subject || 'Email Draft');
      const body = this.decodeHtmlEntities(parsed.body || '');
      const htmlBody = this.bodyToHtml(body);
      return { success: true, subject, body, htmlBody };
    } catch (error) {
      logger.error('draftEmailContent error:', error.message);
      return { success: false, error: 'Could not draft email. Try again?' };
    }
  }

  async reviseEmailWithAI(currentDraft, userFeedback) {
    try {
      const apiKey = llm.apiKey();
      const apiUrl = llm.chatUrl();
      const model = llm.fastModel();

      const reviseModel = llm.modelFor('email_draft') || model;
      const response = await llm.chatCompletion({
        model: reviseModel,
        messages: [
          {
            role: 'system',
            content: `You are an email drafting assistant. The user wants to revise an email draft based on their feedback.

Current draft:
To: ${currentDraft.to}
Subject: ${currentDraft.subject}
Body: ${currentDraft.body}

Apply the user's requested changes and output ONLY valid JSON:
{"subject": "...", "body": "..."}

IMPORTANT RULES:
- The user may have typos or messy spelling â€” interpret their intent, don't copy typos
- If user says "yeah" or "yes" followed by more instructions, treat the whole thing as a revision (they're agreeing to the draft AND asking for changes)
- If user asks to add a signature like "Best regards [Name]", add it at the end of the body
- IMPORTANT: If user provides a URL/link and asks to hyperlink/link a name, put the name on one line and the link on the NEXT line using markdown format. Example: "Best Regards,\\nJohn Doe\\n[LinkedIn](https://linkedin.com/in/johndoe)". If user says "keep the link after the name" or "below the name", put name and link on separate lines. NEVER output raw HTML tags. ALWAYS use [text](url) for links. NEVER guess LinkedIn URLs â€” only use what's explicitly provided.
- If user mentions a name to use in the signature, use the correct spelling (fix their typos)
- If user asks to pick/extract/use the recipient's first name (from the email address), parse it from the To address and use it as greeting (e.g. "Hi Danish" from danishwork.ai@gmail.com)
- Keep everything else the same unless the user explicitly asks to change it`
          },
          { role: 'user', content: userFeedback }
        ],
        temperature: 0.3,
        max_tokens: 500,
      }, { task: 'email_draft', timeout: 10000 });
      try { require('./model-usage-tracker.service').log({ task: 'email_draft', model: reviseModel, usage: response?.data?.usage }); } catch (_) {}

      const content = response.data.choices[0].message.content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { success: false, error: 'Could not revise email. Try again?' };
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const subject = this.normalizeSubject(parsed.subject || currentDraft.subject);
      const body = parsed.body || currentDraft.body;
      const htmlBody = this.bodyToHtml(body);

      return { success: true, to: currentDraft.to, subject, body, htmlBody };
    } catch (error) {
      logger.error('reviseEmailWithAI error:', error.message);
      return { success: false, error: 'Could not revise email. Try again?' };
    }
  }

  /**
   * Draft personalized emails for multiple recipients, each with their own context.
   * @param {Array<{email, context}>} recipients - Each has email + personalization context
   * @param {string} userMessage - Original user message
   * @param {string|null} documentText - Extracted CV/resume text
   * @returns {Array<{success, to, subject, body, htmlBody}>}
   */
  async draftPersonalizedBulkEmails(recipients, userMessage, documentText = null) {
    const apiKey = llm.apiKey();
    const apiUrl = llm.chatUrl();
    const model = llm.defaultModel();

    const docContext = documentText
      ? `\n\nSENDER'S RESUME/CV (use to personalize each email â€” extract name, skills, experience, LinkedIn URL etc.):\n${documentText.slice(0, 4000)}`
      : '';

    const recipientList = recipients.map((r, i) =>
      `${i + 1}. Email: ${r.email} | Context: ${r.context}`
    ).join('\n');

    try {
      const response = await axios.post(apiUrl, {
        model,
        messages: [
          {
            role: 'system',
            content: `You are an email drafting assistant. Draft PERSONALIZED emails for multiple recipients. Each recipient has different context (company, role, position they're hiring for).

Output ONLY valid JSON array: [{"to": "email", "subject": "...", "body": "..."}, ...]

Rules:
- Draft a UNIQUE, personalized email for EACH recipient based on their specific context
- Mention the specific company name, position, and recipient's role in each email
- Use the sender's resume/CV details to highlight RELEVANT skills for each specific position
- Keep each email concise and professional but friendly
- Extract recipient's first name from context or email for greeting
- The user may have typos â€” interpret intent, don't copy typos into the email
- IMPORTANT: If the resume/CV contains a LinkedIn URL or profile link, extract and use the EXACT URL. Do NOT guess or make up LinkedIn URLs. If no LinkedIn URL is found, do NOT add one.
- Use [text](url) markdown format for any links. NEVER output raw HTML.
- The resume will be attached separately, so reference key details but don't paste full contents
- Output ONLY the JSON array, nothing else`
          },
          {
            role: 'user',
            content: `Draft personalized emails for these recipients:\n${recipientList}\n\nUser's instruction: "${userMessage}"${docContext}`
          }
        ],
        temperature: 0.3,
        max_tokens: 3000
      }, {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 30000
      });

      const content = response.data.choices[0].message.content;
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        logger.error('draftPersonalizedBulkEmails: no JSON array in response');
        return { success: false, error: 'Could not draft personalized emails. Try again?' };
      }

      const drafts = JSON.parse(jsonMatch[0]);
      const results = drafts.map(d => ({
        success: true,
        to: d.to,
        subject: this.normalizeSubject(d.subject || 'No Subject'),
        body: d.body || '',
        htmlBody: this.bodyToHtml(d.body || '')
      }));

      return { success: true, drafts: results };
    } catch (error) {
      logger.error('draftPersonalizedBulkEmails error:', error.message);
      return { success: false, error: 'Could not draft personalized emails. Try again?' };
    }
  }

  async draftSharedBulkEmail(recipients, userMessage, documentText = null) {
    const apiKey = llm.apiKey();
    const apiUrl = llm.chatUrl();
    const model = llm.fastModel();

    const docContext = documentText
      ? `\n\nATTACHED DOCUMENT CONTENT (extract relevant facts to improve the email):\n${documentText.slice(0, 4000)}`
      : '';

    try {
      const response = await axios.post(apiUrl, {
        model,
        messages: [
          {
            role: 'system',
            content: `You are an email drafting assistant. Draft ONE common email that will be sent to multiple recipients.

Output ONLY valid JSON:
{"subject":"...","body":"..."}

Rules:
- Keep tone professional and concise
- Do not personalize per recipient
- Do not include raw HTML; plain text only
- If links are needed, use markdown [text](url)
- If document content is provided, use it for better context but do not paste it fully`
          },
          {
            role: 'user',
            content: `Recipients: ${recipients.join(', ')}\nUser instruction: "${userMessage}"${docContext}`
          }
        ],
        temperature: 0.3,
        max_tokens: 900
      }, {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 20000
      });

      const content = response.data.choices[0].message.content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { success: false, error: 'Could not draft bulk email. Try again?' };

      const parsed = JSON.parse(jsonMatch[0]);
      const subject = this.normalizeSubject(parsed.subject || 'No Subject');
      const body = parsed.body || '';

      return { success: true, subject, body, htmlBody: this.bodyToHtml(body) };
    } catch (error) {
      logger.error('draftSharedBulkEmail error:', error.message);
      return { success: false, error: 'Could not draft bulk email. Try again?' };
    }
  }

  confirmExternalRecipients(attendees, userEmail) {
    const userDomain = userEmail?.split('@')[1] || '';
    const internal = [];
    const external = [];

    for (const a of attendees) {
      const email = a.email || a;
      const domain = email.split('@')[1] || '';
      if (domain === userDomain) {
        internal.push(email);
      } else {
        external.push(email);
      }
    }

    return { internal, external, hasExternal: external.length > 0 };
  }

  // ========== THREAD-AWARE SENDING ==========

  async sendEmailInThread(userPhone, { to, subject, htmlBody, threadId, attachments }) {
    try {
      const authClient = await googleAuthService.getAuthClient(userPhone);
      if (!authClient) {
        return { success: false, error: 'Google not connected. Say "connect google" first.' };
      }

      const gmail = google.gmail({ version: 'v1', auth: authClient });
      const senderEmail = await googleAuthService.getGoogleEmail(userPhone);
      const toList = Array.isArray(to) ? to : [to];

      // Ensure "Re: " prefix for thread replies
      const threadSubject = subject.startsWith('Re: ') ? subject : `Re: ${subject}`;
      const raw = this.buildMimeMessage(senderEmail, toList, threadSubject, htmlBody, attachments || []);

      const resource = { raw };
      if (threadId) resource.threadId = threadId;

      const result = await withRetry(() =>
        gmail.users.messages.send({ userId: 'me', resource })
      );

      await calendarService.auditLog(userPhone, 'send_email', null, {
        to: toList, subject: threadSubject, messageId: result.data.id, threadId
      });

      // Log sent email for follow-up lookups
      await this.logSentEmail(userPhone, {
        to: toList[0], subject: threadSubject,
        messageId: result.data.id, threadId: result.data.threadId || threadId
      });

      // Auto-track reply if user has reply tracking enabled
      try {
        const emailPreferencesService = require('./email-preferences.service');
        const replyTrackerService = require('./reply-tracker.service');
        const prefs = await emailPreferencesService.getPreferences(userPhone);
        if (prefs.reply_tracking_enabled) {
          await replyTrackerService.trackEmail(userPhone, {
            messageId: result.data.id,
            threadId: result.data.threadId || threadId,
            recipientEmail: toList[0],
            recipientName: null,
            subject: threadSubject,
            sentAt: new Date(),
            waitHours: prefs.reply_tracking_hours || 24,
          });
        }
      } catch (trackErr) {
        logger.warn('Auto-track reply error:', trackErr.message);
      }

      return { success: true, messageId: result.data.id, threadId: result.data.threadId || threadId };
    } catch (error) {
      const tokenResult = await googleAuthService.handleTokenError(userPhone, error);
      if (tokenResult.cleared) return { success: false, error: tokenResult.message };
      logger.error('sendEmailInThread error:', error.message);
      return { success: false, error: 'Failed to send email' };
    }
  }

  // ========== FOLLOW-UP DRAFTING ==========

  async draftFollowUpWithAI(originalThread, userMessage, recipientEmail) {
    try {
      const apiKey = llm.apiKey();
      const apiUrl = llm.chatUrl();
      const model = llm.fastModel();

      // Build thread context from messages
      const threadContext = originalThread.map(msg => {
        const direction = msg.labelIds?.includes('SENT') ? 'SENT' : 'RECEIVED';
        return `[${direction}] From: ${msg.from}\nDate: ${msg.date}\nSubject: ${msg.subject}\n\n${msg.body}`;
      }).join('\n\n---\n\n');

      const response = await axios.post(apiUrl, {
        model,
        messages: [
          {
            role: 'system',
            content: `You are an email follow-up assistant. The user wants to write a follow-up email based on a previous email thread.

PREVIOUS EMAIL THREAD:
${threadContext.slice(0, 4000)}

Output ONLY valid JSON with these fields:
- "subject": the follow-up subject (usually keep the original subject, or add "Re: " prefix)
- "body": the follow-up email body as plain text

Rules:
- Reference the previous conversation naturally (e.g. "Following up on my previous email about...")
- Keep the tone consistent with the original email
- Be concise and professional
- If the user gives specific instructions about what to say, follow them
- Extract recipient's first name from email for greeting if possible
- Do NOT include sign-offs unless the user asks
- Use [text](url) markdown format for any links
- Output ONLY the JSON object`
          },
          {
            role: 'user',
            content: `Write a follow-up to ${recipientEmail}. User instruction: "${userMessage}"`
          }
        ],
        temperature: 0.3,
        max_tokens: 800
      }, {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 15000
      });

      const content = response.data.choices[0].message.content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { success: false, error: 'Could not draft follow-up. Try again?' };
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const subject = this.normalizeSubject(parsed.subject || 'Follow-up');
      const body = this.decodeHtmlEntities(parsed.body || '');
      const htmlBody = this.bodyToHtml(body);

      return { success: true, to: recipientEmail, subject, body, htmlBody };
    } catch (error) {
      logger.error('draftFollowUpWithAI error:', error.message);
      return { success: false, error: 'Could not draft follow-up. Try again?' };
    }
  }

  // ========== SENT EMAIL LOGGING ==========

  async ensureSentLogTable() {
    if (this._sentLogTableCreated) return;
    try {
      await dbQuery(`
        CREATE TABLE IF NOT EXISTS sent_email_log (
          id SERIAL PRIMARY KEY,
          user_phone VARCHAR(20) NOT NULL,
          recipient_email VARCHAR(255) NOT NULL,
          subject TEXT,
          gmail_message_id VARCHAR(100),
          gmail_thread_id VARCHAR(100),
          sent_at TIMESTAMP DEFAULT NOW()
        )
      `);
      // Create index if not exists
      await dbQuery(`
        CREATE INDEX IF NOT EXISTS idx_sent_log_phone_recipient
        ON sent_email_log(user_phone, recipient_email)
      `);
      this._sentLogTableCreated = true;
    } catch (error) {
      logger.warn('ensureSentLogTable:', error.message);
    }
  }

  async logSentEmail(userPhone, { to, subject, messageId, threadId }) {
    try {
      await this.ensureSentLogTable();
      await dbQuery(
        `INSERT INTO sent_email_log (user_phone, recipient_email, subject, gmail_message_id, gmail_thread_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [userPhone, to, subject, messageId, threadId]
      );
    } catch (error) {
      logger.warn('logSentEmail:', error.message);
    }
  }

  async getSentEmailLog(userPhone, recipientEmail, limit = 5) {
    try {
      await this.ensureSentLogTable();
      const result = await dbQuery(
        `SELECT * FROM sent_email_log
         WHERE user_phone = $1 AND recipient_email = $2
         ORDER BY sent_at DESC LIMIT $3`,
        [userPhone, recipientEmail, limit]
      );
      return result.rows || [];
    } catch (error) {
      logger.warn('getSentEmailLog:', error.message);
      return [];
    }
  }

  // ── Reply Tracking ─────────────────────────────────────────────

  /**
   * Check if a Gmail thread has received a reply after a given timestamp.
   * Returns { hasReply, replyFrom, replyDate } — filters out user's own messages.
   */
  async checkForReply(userPhone, threadId, afterTimestamp) {
    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) return { hasReply: false };

    try {
      const gmail = google.gmail({ version: 'v1', auth: authClient });
      const thread = await withRetry(() =>
        gmail.users.threads.get({
          userId: 'me',
          id: threadId,
          format: 'metadata',
          metadataHeaders: ['From', 'Date'],
        })
      );

      const userEmail = await googleAuthService.getGoogleEmail(userPhone);
      const afterMs = new Date(afterTimestamp).getTime();
      const messages = thread.data.messages || [];

      for (const msg of messages) {
        const msgDate = parseInt(msg.internalDate || '0');
        if (msgDate <= afterMs) continue; // Before our sent time

        const fromHeader = (msg.payload?.headers || [])
          .find(h => h.name === 'From')?.value || '';

        // Skip messages from the user themselves
        if (userEmail && fromHeader.toLowerCase().includes(userEmail.toLowerCase())) continue;

        return {
          hasReply: true,
          replyFrom: fromHeader,
          replyDate: new Date(msgDate).toISOString(),
        };
      }

      return { hasReply: false };
    } catch (error) {
      logger.warn(`[Gmail] checkForReply error for thread ${threadId}: ${error.message}`);
      return { hasReply: false };
    }
  }
}

module.exports = new GmailService();


