'use strict';

// Bot-side campaign operations (bulk_email_campaigns).
//
// WHY THIS EXISTS: every other domain has a service under src/services that
// handlers can call, but ALL campaign write logic lived in TypeScript under
// dashboard/lib/groups.ts. That asymmetry is the actual reason the agent's
// manage_campaigns tool was read-only — there was nothing on this side to
// call. This mirrors those writes so chat can do what the dashboard does.
//
// Schema note: bulk_email_campaigns.status already defaults to 'pending', and
// nothing ever wrote that state. A "draft" campaign is exactly that row —
// composed and staged, with no send scheduled — which is what makes
// "create a campaign but don't send yet" expressible.

const { query } = require('../config/database');
const logger = require('../utils/logger');

const DRAFT_STATUS = 'pending';
const MAX_SUBJECT = 300;
const MAX_BODY = 8000;

let schemaPromise = null;

/** Mirrors the DDL in dashboard/lib/groups.ts so either side can create it. */
function ensureTables() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = query(`
    CREATE TABLE IF NOT EXISTS bulk_email_campaigns (
      id SERIAL PRIMARY KEY,
      user_phone VARCHAR(50) NOT NULL,
      group_id INTEGER,
      subject TEXT NOT NULL,
      body_template TEXT NOT NULL,
      recipient_count INTEGER NOT NULL DEFAULT 0,
      sent_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      scheduled_for TIMESTAMPTZ,
      daily_send_limit INTEGER,
      archived_at TIMESTAMPTZ,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_bulk_campaigns_user ON bulk_email_campaigns(user_phone, id DESC);
  `).catch((error) => {
    schemaPromise = null;
    throw error;
  });
  return schemaPromise;
}

function phoneCandidates(userPhone) {
  const digits = String(userPhone || '').replace(/\D/g, '');
  return [...new Set([String(userPhone || ''), digits, `+${digits}`].filter(Boolean))];
}

async function listCampaigns(userPhone, { limit = 10 } = {}) {
  await ensureTables();
  const result = await query(
    `SELECT id, group_id, subject, status, recipient_count, sent_count, failed_count,
            scheduled_for, daily_send_limit, archived_at, created_at, completed_at
       FROM bulk_email_campaigns
      WHERE user_phone = ANY($1)
      ORDER BY id DESC
      LIMIT $2`,
    [phoneCandidates(userPhone), Math.max(1, Math.min(50, limit))],
  );
  return result.rows;
}

async function getCampaign(userPhone, { campaignId, subjectQuery } = {}) {
  await ensureTables();
  if (campaignId) {
    const result = await query(
      `SELECT * FROM bulk_email_campaigns WHERE id = $1 AND user_phone = ANY($2)`,
      [Number(campaignId), phoneCandidates(userPhone)],
    );
    return result.rows[0] || null;
  }
  if (subjectQuery) {
    const result = await query(
      `SELECT * FROM bulk_email_campaigns
        WHERE user_phone = ANY($1) AND LOWER(subject) LIKE $2
        ORDER BY id DESC LIMIT 2`,
      [phoneCandidates(userPhone), `%${String(subjectQuery).toLowerCase()}%`],
    );
    if (result.rows.length > 1) {
      const ambiguous = new Error(`Found ${result.rows.length} campaigns matching "${subjectQuery}".`);
      ambiguous.code = 'campaign_ambiguous';
      throw ambiguous;
    }
    return result.rows[0] || null;
  }
  return null;
}

/** Members of a group with a usable email, for recipient counts and sends. */
async function listGroupMembersWithEmail(userPhone, groupId) {
  const result = await query(
    `SELECT m.member_kind,
            m.member_id,
            COALESCE(l.name, c.name) AS name,
            COALESCE(l.email, c.email) AS email,
            COALESCE(l.company, c.company) AS company
       FROM contact_group_members m
       LEFT JOIN sales_leads l ON m.member_kind = 'lead' AND l.id = m.member_id AND l.user_phone = ANY($1)
       LEFT JOIN contacts c ON m.member_kind = 'contact' AND c.id = m.member_id AND c.user_phone = ANY($1)
      WHERE m.group_id = $2
      ORDER BY name`,
    [phoneCandidates(userPhone), Number(groupId)],
  );
  return result.rows.filter((row) => String(row.email || '').includes('@'));
}

/**
 * Create a DRAFT campaign (status 'pending'): composed and staged, nothing
 * sent and nothing scheduled. Starting it is a separate, confirmable step.
 */
async function createDraft(userPhone, { groupId, subject, bodyTemplate, recipientCount, dailySendLimit }) {
  await ensureTables();
  const cleanSubject = String(subject || '').trim().slice(0, MAX_SUBJECT);
  const cleanBody = String(bodyTemplate || '').trim().slice(0, MAX_BODY);
  if (!cleanSubject) throw Object.assign(new Error('A campaign needs a subject.'), { code: 'campaign_subject_required' });
  if (!cleanBody) throw Object.assign(new Error('A campaign needs an email body.'), { code: 'campaign_body_required' });
  const limit = Math.max(1, Math.min(2000, Number(dailySendLimit || recipientCount || 100)));
  const result = await query(
    `INSERT INTO bulk_email_campaigns
       (user_phone, group_id, subject, body_template, recipient_count, status, daily_send_limit)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, subject, status, recipient_count, daily_send_limit`,
    [String(userPhone), groupId ? Number(groupId) : null, cleanSubject, cleanBody,
      Math.max(0, Number(recipientCount || 0)), DRAFT_STATUS, limit],
  );
  return result.rows[0];
}

async function updateCampaignFields(userPhone, campaignId, { archived, status, subject, bodyTemplate, dailySendLimit } = {}) {
  await ensureTables();
  const sets = [];
  const values = [];
  let index = 1;
  if (archived !== undefined) sets.push(archived ? 'archived_at = NOW()' : 'archived_at = NULL');
  if (status) { sets.push(`status = $${index++}`); values.push(status); }
  if (subject !== undefined) { sets.push(`subject = $${index++}`); values.push(String(subject).slice(0, MAX_SUBJECT)); }
  if (bodyTemplate !== undefined) { sets.push(`body_template = $${index++}`); values.push(String(bodyTemplate).slice(0, MAX_BODY)); }
  if (dailySendLimit !== undefined) {
    sets.push(`daily_send_limit = $${index++}`);
    values.push(Math.max(1, Math.min(2000, Number(dailySendLimit))));
  }
  if (sets.length === 0) return null;
  values.push(Number(campaignId), phoneCandidates(userPhone));
  const result = await query(
    `UPDATE bulk_email_campaigns SET ${sets.join(', ')}
      WHERE id = $${index} AND user_phone = ANY($${index + 1})
      RETURNING id, subject, status, archived_at, daily_send_limit`,
    values,
  );
  return result.rows[0] || null;
}

async function deleteCampaign(userPhone, campaignId) {
  await ensureTables();
  const owned = await query(
    `SELECT status FROM bulk_email_campaigns WHERE id = $1 AND user_phone = ANY($2)`,
    [Number(campaignId), phoneCandidates(userPhone)],
  );
  if (!owned.rows[0]) return { deleted: false, reason: 'not_found' };
  // A campaign mid-send must not vanish underneath the sender.
  if (owned.rows[0].status === 'sending') return { deleted: false, reason: 'sending' };
  await query(`DELETE FROM email_sends WHERE campaign_id = $1`, [Number(campaignId)]).catch(() => {});
  const result = await query(
    `DELETE FROM bulk_email_campaigns WHERE id = $1 AND user_phone = ANY($2) RETURNING subject`,
    [Number(campaignId), phoneCandidates(userPhone)],
  );
  return { deleted: Boolean(result.rows[0]), subject: result.rows[0]?.subject || null };
}

/**
 * Draft a reusable campaign template. Placeholders {first_name}/{name}/
 * {company} are what the dashboard composer already compiles per recipient,
 * so a chat-composed body renders identically there.
 */
async function composeDraft({ purpose, tone = 'professional', groupName = '', sampleMember = null, senderName = '' }) {
  const cleanPurpose = String(purpose || '').trim().slice(0, 1200);
  if (cleanPurpose.length < 3) {
    throw Object.assign(new Error('Tell me what the email should say.'), { code: 'campaign_purpose_required' });
  }
  const llm = require('./llm-provider');
  const response = await llm.chatCompletion({
    messages: [
      {
        role: 'system',
        content: `You draft ONE reusable email template for a bulk campaign. Output ONLY valid JSON: {"subject":"...","body":"..."}. Use {first_name}, {name}, or {company} as placeholders where personalisation helps. Tone: ${String(tone).slice(0, 60)}.${senderName ? ` Sign off as ${String(senderName).slice(0, 120)}.` : ''}`,
      },
      {
        role: 'user',
        content: `Purpose: ${cleanPurpose}${groupName ? `\nAudience: the "${String(groupName).slice(0, 120)}" contact group` : ''}${sampleMember?.name ? `\nExample recipient: ${sampleMember.name}${sampleMember.company ? ` at ${sampleMember.company}` : ''}` : ''}`,
      },
    ],
    temperature: 0.4,
    max_tokens: 700,
    ...llm.defaultBodyExtras('default'),
  }, { task: 'email_draft', timeout: 40000 });

  const content = response?.data?.choices?.[0]?.message?.content || '';
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw Object.assign(new Error('The model returned no draft.'), { code: 'campaign_draft_unparsable' });
  let parsed;
  try { parsed = JSON.parse(jsonMatch[0]); } catch (_) {
    throw Object.assign(new Error('The model returned an invalid draft.'), { code: 'campaign_draft_unparsable' });
  }
  const subject = String(parsed.subject || '').trim().slice(0, MAX_SUBJECT);
  const body = String(parsed.body || '').trim().slice(0, MAX_BODY);
  if (!subject || !body) {
    throw Object.assign(new Error('The draft was missing a subject or body.'), { code: 'campaign_draft_incomplete' });
  }
  return { subject, body };
}

/** Render {first_name}/{name}/{company} for one recipient. */
function compileForMember(template, member) {
  const name = String(member?.name || '').trim();
  const firstName = name.split(/\s+/)[0] || name;
  return String(template || '')
    .replaceAll('{first_name}', firstName)
    .replaceAll('{name}', name)
    .replaceAll('{company}', String(member?.company || '').trim());
}

function formatCampaign(row) {
  const stats = `${row.sent_count || 0}/${row.recipient_count || 0} sent`
    + (row.failed_count > 0 ? `, ${row.failed_count} failed` : '');
  const state = row.archived_at ? `${row.status} (archived)` : row.status;
  return `*${row.subject}* (ID: ${row.id})\n   Status: ${state} | ${stats}`;
}

module.exports = {
  ensureTables,
  listCampaigns,
  getCampaign,
  listGroupMembersWithEmail,
  createDraft,
  updateCampaignFields,
  deleteCampaign,
  composeDraft,
  compileForMember,
  formatCampaign,
  DRAFT_STATUS,
};
