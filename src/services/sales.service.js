const { query } = require('../config/database');
const aiService = require('./ai.service');
const gmailService = require('./gmail.service');
const inboxOrganizerService = require('./inbox-organizer.service');
const googleAuthService = require('./google-auth.service');
const { google } = require('googleapis');
const { withRetry } = require('../utils/retry');
const logger = require('../utils/logger');
const llm = require('./llm-provider');

class SalesService {

  constructor() {
    this.tableReady = false;
  }

  // ========== SCHEMA ==========
  async ensureTable() {
    if (this.tableReady) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS sales_leads (
          id SERIAL PRIMARY KEY,
          user_phone VARCHAR(20) NOT NULL,
          name VARCHAR(150) NOT NULL,
          email VARCHAR(200),
          company VARCHAR(150),
          stage VARCHAR(30) DEFAULT 'new',
          notes TEXT,
          source VARCHAR(100),
          deal_value NUMERIC(12,2),
          last_contacted_at TIMESTAMP,
          next_followup_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_sales_leads_user ON sales_leads(user_phone)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_sales_leads_stage ON sales_leads(user_phone, stage)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_sales_leads_email ON sales_leads(user_phone, LOWER(email))`);

      await query(`
        CREATE TABLE IF NOT EXISTS sales_emails_log (
          id SERIAL PRIMARY KEY,
          user_phone VARCHAR(20) NOT NULL,
          lead_id INTEGER REFERENCES sales_leads(id) ON DELETE CASCADE,
          email_type VARCHAR(30) NOT NULL,
          subject TEXT,
          gmail_message_id VARCHAR(100),
          sent_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_sales_emails_lead ON sales_emails_log(lead_id)`);

      this.tableReady = true;
    } catch (error) {
      logger.error('Error creating sales tables:', error.message);
    }
  }

  // ========== VALID STAGES ==========
  get STAGES() {
    return ['new', 'contacted', 'replied', 'meeting', 'proposal', 'negotiation', 'closed_won', 'closed_lost'];
  }

  // The tool schema and users say "won"/"lost"; the pipeline stores
  // closed_won/closed_lost. Normalize every stage input through this map so
  // deal-closing is reachable from chat.
  normalizeStage(stage) {
    const s = String(stage || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
    if (!s) return null;
    const aliases = {
      won: 'closed_won',
      lost: 'closed_lost',
      close_won: 'closed_won',
      close_lost: 'closed_lost',
      closedwon: 'closed_won',
      closedlost: 'closed_lost',
    };
    const normalized = aliases[s] || s;
    return this.STAGES.includes(normalized) ? normalized : null;
  }

  stageLabel(stage) {
    const labels = {
      new: 'New',
      contacted: 'Contacted',
      replied: 'Replied',
      meeting: 'Meeting',
      proposal: 'Proposal',
      negotiation: 'Negotiation',
      closed_won: 'Won',
      closed_lost: 'Lost'
    };
    return labels[stage] || stage;
  }

  stageEmoji(stage) {
    const emojis = {
      new: '*',
      contacted: '>',
      replied: '<',
      meeting: '#',
      proposal: '$',
      negotiation: '~',
      closed_won: '+',
      closed_lost: '-'
    };
    return emojis[stage] || '-';
  }

  // ========== ADD LEAD ==========
  async addLead(userPhone, { name, email, company, notes, source, dealValue, stage }) {
    await this.ensureTable();
    try {
      const result = await query(
        `INSERT INTO sales_leads (user_phone, name, email, company, notes, source, deal_value, stage)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [userPhone, name.trim(), email || null, company || null, notes || null,
         source || null, dealValue || null, stage || 'new']
      );
      logger.info(`Lead added: ${name} by ${userPhone}`);
      return { success: true, lead: result.rows[0] };
    } catch (error) {
      logger.error('Add lead error:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ========== UPDATE LEAD STAGE ==========
  async updateStage(userPhone, leadId, newStage) {
    await this.ensureTable();
    newStage = this.normalizeStage(newStage) || newStage;
    if (!this.STAGES.includes(newStage)) {
      return { success: false, error: `Invalid stage. Valid: ${this.STAGES.join(', ')} (also accepts "won"/"lost")` };
    }
    try {
      const result = await query(
        `UPDATE sales_leads SET stage = $1, updated_at = NOW()
         WHERE id = $2 AND user_phone = $3 RETURNING *`,
        [newStage, leadId, userPhone]
      );
      if (result.rows.length === 0) return { success: false, error: 'Lead not found.' };
      return { success: true, lead: result.rows[0] };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // ========== UPDATE LEAD FIELDS ==========
  async updateLead(userPhone, leadId, updates) {
    await this.ensureTable();
    try {
      const fields = [];
      const values = [];
      let idx = 1;

      for (const [key, val] of Object.entries(updates)) {
        if (['name', 'email', 'company', 'notes', 'source', 'deal_value', 'stage', 'next_followup_at',
          'title', 'phone', 'linkedin_url', 'website', 'priority', 'location'].includes(key)) {
          fields.push(`${key} = $${idx}`);
          values.push(val);
          idx++;
        }
      }
      if (fields.length === 0) return { success: false, error: 'Nothing to update.' };

      fields.push(`updated_at = NOW()`);
      values.push(leadId, userPhone);

      const result = await query(
        `UPDATE sales_leads SET ${fields.join(', ')}
         WHERE id = $${idx} AND user_phone = $${idx + 1} RETURNING *`,
        values
      );
      if (result.rows.length === 0) return { success: false, error: 'Lead not found.' };
      return { success: true, lead: result.rows[0] };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // ========== ARCHIVE / RESTORE ==========
  // archived_at is added by the dashboard CRM (dashboard/lib/crm.ts); installs
  // that have only ever run the bot won't have it yet, so add it idempotently
  // before the first write instead of failing the turn.
  async ensureArchivedColumn() {
    if (this.archivedColumnReady) return;
    await query('ALTER TABLE sales_leads ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP');
    this.archivedColumnReady = true;
  }

  async setLeadArchived(userPhone, leadId, archived) {
    await this.ensureTable();
    try {
      await this.ensureArchivedColumn();
      const result = await query(
        `UPDATE sales_leads SET archived_at = ${archived ? 'NOW()' : 'NULL'}, updated_at = NOW()
         WHERE id = $1 AND user_phone = $2 RETURNING *`,
        [leadId, userPhone]
      );
      if (result.rows.length === 0) return { success: false, error: 'Lead not found.' };
      return { success: true, lead: result.rows[0] };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // "I called them today" — stamps the same column the dashboard shows as
  // "Last contact" and optionally appends a note about what was said.
  async markLeadContacted(userPhone, leadId, note = null) {
    await this.ensureTable();
    try {
      const trimmed = String(note || '').trim();
      const result = await query(
        `UPDATE sales_leads
            SET last_contacted_at = NOW(),
                notes = CASE WHEN $1::text IS NULL THEN notes
                             WHEN notes IS NULL OR notes = '' THEN $1::text
                             ELSE notes || E'\\n' || $1::text END,
                updated_at = NOW()
          WHERE id = $2 AND user_phone = $3 RETURNING *`,
        [trimmed || null, leadId, userPhone]
      );
      if (result.rows.length === 0) return { success: false, error: 'Lead not found.' };
      return { success: true, lead: result.rows[0] };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // ========== DELETE LEAD ==========
  async deleteLead(userPhone, leadId) {
    await this.ensureTable();
    try {
      const result = await query(
        `DELETE FROM sales_leads WHERE id = $1 AND user_phone = $2 RETURNING name`,
        [leadId, userPhone]
      );
      if (result.rows.length === 0) return { success: false, error: 'Lead not found.' };
      return { success: true, name: result.rows[0].name };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // ========== FIND LEADS ==========
  async findByName(userPhone, name) {
    await this.ensureTable();
    try {
      let result = await query(
        `SELECT * FROM sales_leads WHERE user_phone = $1 AND LOWER(name) = LOWER($2)`,
        [userPhone, name.trim()]
      );
      if (result.rows.length > 0) return result.rows;

      result = await query(
        `SELECT * FROM sales_leads WHERE user_phone = $1
         AND (LOWER(name) LIKE LOWER($2) OR LOWER(company) LIKE LOWER($2))
         ORDER BY updated_at DESC LIMIT 5`,
        [userPhone, `%${name.trim()}%`]
      );
      return result.rows;
    } catch (error) {
      return [];
    }
  }

  async findByEmail(userPhone, email) {
    await this.ensureTable();
    try {
      const result = await query(
        `SELECT * FROM sales_leads WHERE user_phone = $1 AND LOWER(email) = LOWER($2)`,
        [userPhone, email.trim()]
      );
      return result.rows;
    } catch (error) {
      return [];
    }
  }

  // ========== LIST LEADS ==========
  async getLeads(userPhone, { stage, limit } = {}) {
    await this.ensureTable();
    try {
      let sql = `SELECT * FROM sales_leads WHERE user_phone = $1`;
      const params = [userPhone];

      if (stage) {
        sql += ` AND stage = $2`;
        params.push(stage);
      }

      sql += ` ORDER BY
        CASE stage
          WHEN 'new' THEN 1 WHEN 'contacted' THEN 2 WHEN 'replied' THEN 3
          WHEN 'meeting' THEN 4 WHEN 'proposal' THEN 5 WHEN 'negotiation' THEN 6
          WHEN 'closed_won' THEN 7 WHEN 'closed_lost' THEN 8
        END,
        updated_at DESC`;

      if (limit) {
        sql += ` LIMIT $${params.length + 1}`;
        params.push(limit);
      }

      const result = await query(sql, params);
      return result.rows;
    } catch (error) {
      return [];
    }
  }

  // ========== LEADS DUE FOR FOLLOW-UP ==========
  async getFollowupsDue(userPhone) {
    await this.ensureTable();
    try {
      const result = await query(
        `SELECT * FROM sales_leads
         WHERE user_phone = $1
         AND next_followup_at IS NOT NULL
         AND next_followup_at <= NOW()
         AND stage NOT IN ('closed_won', 'closed_lost')
         ORDER BY next_followup_at ASC`,
        [userPhone]
      );
      return result.rows;
    } catch (error) {
      return [];
    }
  }

  // ========== PIPELINE SUMMARY ==========
  async getPipelineSummary(userPhone) {
    await this.ensureTable();
    try {
      const result = await query(
        `SELECT stage, COUNT(*) as count, COALESCE(SUM(deal_value), 0) as total_value
         FROM sales_leads WHERE user_phone = $1
         GROUP BY stage ORDER BY
           CASE stage
             WHEN 'new' THEN 1 WHEN 'contacted' THEN 2 WHEN 'replied' THEN 3
             WHEN 'meeting' THEN 4 WHEN 'proposal' THEN 5 WHEN 'negotiation' THEN 6
             WHEN 'closed_won' THEN 7 WHEN 'closed_lost' THEN 8
           END`,
        [userPhone]
      );

      const followups = await this.getFollowupsDue(userPhone);

      const emailCount = await query(
        `SELECT COUNT(*) as count FROM sales_emails_log
         WHERE user_phone = $1 AND sent_at > NOW() - INTERVAL '7 days'`,
        [userPhone]
      );

      return {
        stages: result.rows,
        followupsDue: followups.length,
        emailsThisWeek: parseInt(emailCount.rows[0].count)
      };
    } catch (error) {
      return { stages: [], followupsDue: 0, emailsThisWeek: 0 };
    }
  }

  // ========== FORMAT LEAD FOR DISPLAY ==========
  formatLead(lead) {
    let text = `*${lead.name}*`;
    if (lead.company) text += ` @ ${lead.company}`;
    text += ` | ${this.stageLabel(lead.stage)}`;
    if (lead.email) text += `\nEmail: ${lead.email}`;
    if (lead.deal_value) text += `\nDeal: ${Number(lead.deal_value).toLocaleString('en-IN', { style: 'currency', currency: 'INR' })}`;
    if (lead.notes) text += `\nNotes: ${lead.notes}`;
    if (lead.next_followup_at) {
      const fDate = new Date(lead.next_followup_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
      text += `\nFollow-up: ${fDate}`;
    }
    if (lead.last_contacted_at) {
      const lDate = new Date(lead.last_contacted_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
      text += `\nLast contacted: ${lDate}`;
    }
    text += ` (ID: ${lead.id})`;
    return text;
  }

  formatLeadsList(leads) {
    if (!leads || leads.length === 0) {
      return 'No leads found.\n\nAdd one: _"new lead John from Acme, john@acme.com, interested in premium plan"_';
    }

    let response = `*Sales Pipeline* (${leads.length} lead${leads.length > 1 ? 's' : ''})\n\n`;

    let currentStage = null;
    for (const lead of leads) {
      if (lead.stage !== currentStage) {
        currentStage = lead.stage;
        response += `*--- ${this.stageLabel(currentStage)} ---*\n`;
      }
      response += `${this.stageEmoji(lead.stage)} *${lead.name}*`;
      if (lead.company) response += ` @ ${lead.company}`;
      if (lead.deal_value) response += ` | ${Number(lead.deal_value).toLocaleString('en-IN')}`;
      if (lead.next_followup_at && new Date(lead.next_followup_at) <= new Date()) {
        response += ' (follow-up due!)';
      }
      response += ` (ID: ${lead.id})\n`;
    }

    response += '\n_"lead details [name]" for full info_';
    return response;
  }

  formatPipelineSummary(summary) {
    let text = '*Sales Summary*\n\n';

    let totalLeads = 0;
    let totalValue = 0;
    for (const s of summary.stages) {
      const count = parseInt(s.count);
      const value = parseFloat(s.total_value);
      totalLeads += count;
      totalValue += value;
      text += `${this.stageEmoji(s.stage)} *${this.stageLabel(s.stage)}:* ${count}`;
      if (value > 0) text += ` (${value.toLocaleString('en-IN')})`;
      text += '\n';
    }

    text += `\n*Total:* ${totalLeads} leads`;
    if (totalValue > 0) text += ` | Pipeline value: ${totalValue.toLocaleString('en-IN', { style: 'currency', currency: 'INR' })}`;
    text += `\n*Emails sent (7d):* ${summary.emailsThisWeek}`;
    if (summary.followupsDue > 0) {
      text += `\n*Follow-ups due:* ${summary.followupsDue} leads need attention!`;
    }
    return text;
  }

  // ========== SALES EMAIL DRAFTING ==========
  async draftSalesEmail(userPhone, lead, emailType, customInstructions = '') {
    try {
      const apiUrl = llm.chatUrl();
      const model = llm.fastModel();

      const axios = require('axios');

      // Get previous emails to this lead for context
      const prevEmails = await query(
        `SELECT email_type, subject, sent_at FROM sales_emails_log
         WHERE lead_id = $1 ORDER BY sent_at DESC LIMIT 5`,
        [lead.id]
      );

      const emailHistory = prevEmails.rows.length > 0
        ? `\nPrevious emails sent to this lead:\n${prevEmails.rows.map(e => `- ${e.email_type}: "${e.subject}" on ${new Date(e.sent_at).toLocaleDateString('en-IN')}`).join('\n')}`
        : '\nNo previous emails sent to this lead.';

      const templateGuide = {
        cold_outreach: 'Write a cold outreach email. Tone: curious and respectful — you\'re starting a conversation, not closing a deal. Be concise (3-4 sentences), mention something specific about their company, ask ONE question. Never say "exciting opportunity" or "I\'d love to pick your brain".',
        followup: 'Write a follow-up email. Tone: brief and direct. Reference something specific from before — don\'t re-pitch. 2-3 sentences max. End with a specific ask.',
        proposal: 'Write a proposal email. Tone: confident and structured. Lead with the outcome they care about, not features. Keep under 6 sentences.',
        meeting_request: 'Write a meeting request. Tone: casual and specific. Suggest 2 exact times, explain the "why" in one sentence. 3 sentences max.',
        thank_you: 'Write a thank-you email. Tone: genuine and brief. Mention ONE specific thing from the conversation. 2-3 sentences.',
        check_in: 'Write a check-in email. Tone: light and helpful. Ask ONE specific question, not "how\'s everything going". 2-3 sentences.',
        closing: 'Write a closing email. Tone: enthusiastic but professional. Confirm specifics, express genuine excitement. Keep under 5 sentences.'
      };

      const guide = templateGuide[emailType] || templateGuide.followup;

      const salesModel = llm.modelFor('sales_email') || model;
      const response = await llm.chatCompletion({
        model: salesModel,
        messages: [
          {
            role: 'system',
            content: `You are a professional sales email writer. ${guide}

Lead context:
- Name: ${lead.name}
- Company: ${lead.company || 'Unknown'}
- Stage: ${lead.stage}
- Notes: ${lead.notes || 'None'}
- Deal value: ${lead.deal_value || 'Not specified'}
${emailHistory}
${customInstructions ? `\nUser's specific instructions: ${customInstructions}` : ''}

Output ONLY valid JSON:
{"subject": "...", "body": "..."}

Rules:
- Write like a real person, not a mail merge template
- First sentence must be specific — NEVER "I hope this email finds you well" or "I'm reaching out to explore synergies"
- Use "Hi [FirstName]," — not "Dear" anything
- Short sentences (12-15 words avg), max 5-6 sentences total
- End with a specific, low-friction ask
- NEVER use: "synergize", "leverage", "circle back", "touch base", "moving forward", "cutting-edge", "robust"
- Do NOT include sign-off (the user's email client adds their signature)
- Use [text](url) markdown for any links
- Output ONLY the JSON, nothing else`
          },
          { role: 'user', content: `Draft a ${emailType.replace('_', ' ')} email for ${lead.name}${lead.company ? ` at ${lead.company}` : ''}.` }
        ],
        temperature: 0.4,
        max_tokens: 600,
      }, { task: 'sales_email', timeout: 15000 });
      try { require('./model-usage-tracker.service').log({ task: 'sales_email', model: salesModel, usage: response?.data?.usage }); } catch (_) {}

      const content = response.data.choices[0].message.content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { success: false, error: 'Could not draft email. Try again?' };

      const parsed = JSON.parse(jsonMatch[0]);
      const subject = parsed.subject || `Following up — ${lead.name}`;
      const body = parsed.body || '';
      const htmlBody = gmailService.bodyToHtml(body);

      return { success: true, to: lead.email, subject, body, htmlBody, emailType };
    } catch (error) {
      logger.error('draftSalesEmail error:', error.message);
      return { success: false, error: 'Could not draft email. Try again?' };
    }
  }

  // ========== SEND SALES EMAIL (uses gmail service) ==========
  async sendSalesEmail(userPhone, lead, draft) {
    const result = await gmailService.sendEmail(userPhone, {
      to: draft.to,
      subject: draft.subject,
      htmlBody: draft.htmlBody
    });

    if (result.success) {
      // Log the email
      await query(
        `INSERT INTO sales_emails_log (user_phone, lead_id, email_type, subject, gmail_message_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [userPhone, lead.id, draft.emailType || 'custom', draft.subject, result.messageId]
      );

      // Update lead's last contacted time and auto-advance stage if 'new'
      const updates = { last_contacted_at: new Date().toISOString() };
      if (lead.stage === 'new') updates.stage = 'contacted';
      await this.updateLead(userPhone, lead.id, updates);
    }

    return result;
  }

  // ========== CHECK FOR LEAD REPLIES ==========
  async checkLeadReplies(userPhone) {
    await this.ensureTable();
    try {
      const leads = await query(
        `SELECT * FROM sales_leads WHERE user_phone = $1
         AND email IS NOT NULL
         AND stage NOT IN ('closed_won', 'closed_lost')`,
        [userPhone]
      );

      if (leads.rows.length === 0) return { success: true, replies: [], summary: 'No active leads with emails to check.' };

      const authClient = await googleAuthService.getAuthClient(userPhone);
      if (!authClient) return { success: false, error: 'Google not connected.' };

      const gmail = google.gmail({ version: 'v1', auth: authClient });
      const replies = [];

      // Check emails from each lead (last 7 days)
      for (const lead of leads.rows) {
        try {
          const listResult = await withRetry(() =>
            gmail.users.messages.list({
              userId: 'me',
              q: `from:${lead.email} newer_than:7d`,
              maxResults: 3
            })
          );

          const messages = listResult.data.messages || [];
          if (messages.length > 0) {
            // Get latest message snippet
            const msg = await withRetry(() =>
              gmail.users.messages.get({
                userId: 'me',
                id: messages[0].id,
                format: 'metadata',
                metadataHeaders: ['Subject', 'Date']
              })
            );

            const headers = msg.data.payload?.headers || [];
            const subject = headers.find(h => h.name === 'Subject')?.value || '';
            const date = headers.find(h => h.name === 'Date')?.value || '';

            replies.push({
              lead,
              messageCount: messages.length,
              latestSubject: subject,
              latestDate: date,
              snippet: msg.data.snippet
            });

            // Auto-advance to 'replied' if still at 'contacted'
            if (lead.stage === 'contacted') {
              await this.updateStage(userPhone, lead.id, 'replied');
            }
          }
        } catch (err) {
          // Skip individual lead errors
        }
      }

      if (replies.length === 0) {
        return { success: true, replies: [], summary: 'No replies from leads in the last 7 days.' };
      }

      let summary = `*Lead Replies* (${replies.length})\n\n`;
      for (const r of replies) {
        summary += `> *${r.lead.name}*`;
        if (r.lead.company) summary += ` (${r.lead.company})`;
        summary += `\n  ${r.messageCount} email${r.messageCount > 1 ? 's' : ''} | "${r.latestSubject}"\n  ${r.snippet.slice(0, 100)}\n\n`;
      }
      summary += '_Reply "read email from [lead name]" for details_';

      return { success: true, replies, summary };
    } catch (error) {
      logger.error('checkLeadReplies error:', error.message);
      return { success: false, error: 'Could not check replies.' };
    }
  }

  // ========== AI PARSE SALES COMMAND ==========
  async parseCommand(message, params = null) {
    // Params-first path: if LLM already extracted structured params, use them directly
    if (params && params.action) {
      switch (params.action) {
        case 'add_lead':
          return { action: 'add', raw: params.full_text || message, leadName: params.lead_name, company: params.company };
        case 'move_stage':
          return { action: 'move', target: params.lead_name || '', newStage: this.normalizeStage(params.stage) || (params.stage || '').replace(/[-\s]/g, '_') };
        case 'list':
          return { action: 'list', stage: this.normalizeStage(params.stage) || params.stage || null };
        case 'details':
          return { action: 'details', target: params.lead_name || '' };
        case 'delete':
          return { action: 'delete', target: params.lead_name || '' };
        case 'update': {
          const fields = {};
          for (const key of ['email', 'company', 'title', 'source', 'notes', 'deal_value',
            'linkedin_url', 'website', 'priority', 'phone', 'location']) {
            if (params[key] !== undefined && params[key] !== null && params[key] !== '') {
              fields[key] = params[key];
            }
          }
          return { action: 'update', target: params.lead_name || '', fields };
        }
        case 'summary':
          return { action: 'summary' };
        case 'archive':
        case 'restore':
          return { action: params.action, target: params.lead_name || '' };
        case 'mark_contacted':
          return { action: 'mark_contacted', target: params.lead_name || '', notes: params.notes || null };
        case 'cold_email':
          return { action: 'sales_email', target: params.lead_name || '', emailType: 'cold_outreach' };
        case 'follow_up':
        case 'follow_up_email':
          return { action: 'followup', target: params.lead_name || '' };
        case 'set_follow_up':
          return { action: 'set_followup', target: params.lead_name || '', timeRaw: params.due_time || '' };
      }
    }

    // Existing regex fallback
    const lower = message.toLowerCase().trim();

    // Add lead: "new lead John from Acme, john@acme.com, interested in premium"
    const addMatch = lower.match(/^(?:new|add)\s+lead\s+(.+)/i);
    if (addMatch) {
      return { action: 'add', raw: addMatch[1] };
    }

    // Move/update stage: "move John to proposal", "mark lead 5 as meeting"
    const moveMatch = message.match(/^(?:move|update|change|mark)\s+(?:lead\s+)?(.+?)\s+(?:to|as|stage)\s+(\w+)/i);
    if (moveMatch) {
      return { action: 'move', target: moveMatch[1].trim(), newStage: moveMatch[2].trim().toLowerCase() };
    }

    // View all leads: "my leads", "show leads", "sales pipeline"
    if (/^(?:my |show |view |list |all )?(?:leads?|sales pipeline|pipeline)$/i.test(lower)) {
      return { action: 'list' };
    }

    // Filter by stage: "leads in meeting stage", "new leads", "contacted leads"
    const stageFilter = lower.match(/^(?:show |list |view )?(?:leads?\s+(?:in\s+)?)?(\w+)\s+(?:leads?|stage)$/i);
    if (stageFilter && this.STAGES.includes(stageFilter[1])) {
      return { action: 'list', stage: stageFilter[1] };
    }

    // Lead details: "lead details John", "lead info 5"
    const detailMatch = message.match(/^(?:lead|sales)\s+(?:details?|info)\s+(.+)/i);
    if (detailMatch) {
      return { action: 'details', target: detailMatch[1].trim() };
    }

    // Delete lead: "delete lead John", "remove lead 5"
    const deleteMatch = message.match(/^(?:delete|remove)\s+lead\s+(.+)/i);
    if (deleteMatch) {
      return { action: 'delete', target: deleteMatch[1].trim() };
    }

    // Archive/restore a lead: "archive lead John", "restore lead 5"
    const archiveMatch = message.match(/^(?:archive|unarchive|restore)\s+lead\s+(.+)/i);
    if (archiveMatch) {
      const restoring = /^(?:unarchive|restore)/i.test(message.trim());
      return { action: restoring ? 'restore' : 'archive', target: archiveMatch[1].trim() };
    }

    // Log an interaction: "mark John as contacted", "called John today"
    const contactedMatch = message.match(/^(?:mark|log)\s+(?:lead\s+)?(.+?)\s+as\s+contacted$/i);
    if (contactedMatch) {
      return { action: 'mark_contacted', target: contactedMatch[1].trim(), notes: null };
    }

    // Sales summary: "sales summary", "pipeline summary", "sales stats"
    if (/^(?:sales|pipeline)\s+(?:summary|stats|overview|dashboard|report)$/i.test(lower)) {
      return { action: 'summary' };
    }

    // Follow-up email: "follow up with John", "send followup to lead 3"
    const followupMatch = message.match(/^(?:follow[\s-]?up|chase|ping)\s+(?:with\s+|to\s+)?(?:lead\s+)?(.+)/i);
    if (followupMatch) {
      return { action: 'followup', target: followupMatch[1].trim() };
    }

    // Sales email: "cold email John", "send proposal to lead 5", "sales email to John about demo"
    const emailMatch = message.match(/^(?:send\s+)?(?:cold[\s-]?(?:email|outreach)|proposal|meeting[\s-]?request|thank[\s-]?you|check[\s-]?in|closing)\s+(?:email\s+)?(?:to\s+)?(?:lead\s+)?(.+)/i);
    if (emailMatch) {
      const typeMatch = lower.match(/^(?:send\s+)?(cold[\s-]?(?:email|outreach)|proposal|meeting[\s-]?request|thank[\s-]?you|check[\s-]?in|closing)/i);
      const emailType = typeMatch ? typeMatch[1].replace(/[\s-]+/g, '_').replace('outreach', 'outreach').replace('cold_email', 'cold_outreach') : 'followup';
      return { action: 'sales_email', target: emailMatch[1].trim(), emailType: emailType.replace('cold_outreach', 'cold_outreach') };
    }

    // Check replies: "did any leads reply", "lead replies", "check lead replies"
    if (/^(?:did\s+)?(?:any\s+)?lead(?:s)?\s+repl(?:y|ies|ied)|check\s+lead\s+replies?|lead\s+replies?$/i.test(lower)) {
      return { action: 'check_replies' };
    }

    // Follow-ups due: "follow-ups due", "pending follow-ups"
    if (/^(?:pending\s+)?follow[\s-]?ups?\s+(?:due|pending|overdue)$|^due\s+follow[\s-]?ups?$/i.test(lower)) {
      return { action: 'followups_due' };
    }

    // Update lead notes: "lead note 5: had a great call"
    const noteMatch = message.match(/^lead\s+note\s+(.+?)[\s:]+(.+)/i);
    if (noteMatch) {
      return { action: 'add_note', target: noteMatch[1].trim(), notes: noteMatch[2].trim() };
    }

    // Set follow-up: "follow up with John in 3 days"
    const setFollowup = message.match(/^(?:set\s+)?follow[\s-]?up\s+(?:with\s+|for\s+)?(?:lead\s+)?(.+?)\s+(?:in|on|at|by)\s+(.+)/i);
    if (setFollowup) {
      return { action: 'set_followup', target: setFollowup[1].trim(), timeRaw: setFollowup[2].trim() };
    }

    return null;
  }

  // ========== AI PARSE LEAD FROM NATURAL TEXT ==========
  async parseLeadFromText(text) {
    try {
      const result = await aiService.quickAI(
        `Extract lead info from: "${text}"

Output ONLY valid JSON: {"name": "...", "email": "...", "company": "...", "notes": "...", "dealValue": null, "source": "..."}
- name is REQUIRED
- email, company, notes, dealValue, source are optional (null if not mentioned)
- dealValue should be a number if mentioned (e.g. "50k deal" → 50000)
- notes should capture any extra context the user mentioned (interest, product, etc.)`,
        { temperature: 0, maxTokens: 200 }
      );

      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      return JSON.parse(jsonMatch[0]);
    } catch (error) {
      return null;
    }
  }

  // ========== RESOLVE LEAD (by name or ID) ==========
  async resolveLead(userPhone, target) {
    // Try as numeric ID first
    const idMatch = target.match(/^#?(\d+)$/);
    if (idMatch) {
      const result = await query(
        `SELECT * FROM sales_leads WHERE id = $1 AND user_phone = $2`,
        [parseInt(idMatch[1]), userPhone]
      );
      if (result.rows.length > 0) return { found: true, lead: result.rows[0] };
      return { found: false };
    }

    // Try by name
    const leads = await this.findByName(userPhone, target);
    if (leads.length === 0) return { found: false };
    if (leads.length === 1) return { found: true, lead: leads[0] };

    // Multiple matches
    return { found: true, ambiguous: true, matches: leads };
  }
}

module.exports = new SalesService();
