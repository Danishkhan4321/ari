/**
 * Team workspace — bot-side access to the tables the dashboard's Team pages
 * own (dashboard/lib/broadcast.ts, one-on-one.ts, team-onboarding.ts,
 * team-meta.ts, team-chat.ts).
 *
 * Until now every one of these lived only behind a Next.js route, so Ari could
 * talk about them but never read or change them. Everything here writes the
 * same rows the dashboard reads, so a change made in chat shows up on the
 * Team page and vice versa.
 *
 * Ownership rule: all of these tables are keyed by the TEAM ADMIN's phone. A
 * member can be in a team without owning it, so every call resolves the admin
 * first and refuses rather than guessing.
 */

'use strict';

const database = require('../config/database');
const logger = require('../utils/logger');

const CHAT_TEXT_MAX = 4000;

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeTeamName(value) {
  const trimmed = String(value || '').trim().toLowerCase();
  return trimmed ? trimmed.slice(0, 100) : null;
}

function createTeamWorkspaceService(options = {}) {
  const queryFn = options.queryFn || database.query;
  const schemaPromises = new Map();

  // Each table is created lazily and independently: a workspace that has only
  // ever used broadcasts should not pay for the 1:1 or onboarding DDL.
  function ensure(name, ddl) {
    if (!schemaPromises.has(name)) {
      schemaPromises.set(name, (async () => {
        for (const statement of ddl) await queryFn(statement);
      })().catch((error) => {
        schemaPromises.delete(name);
        throw error;
      }));
    }
    return schemaPromises.get(name);
  }

  const ensureBroadcasts = () => ensure('broadcasts', [
    `CREATE TABLE IF NOT EXISTS team_messages (
       id SERIAL PRIMARY KEY,
       admin_phone VARCHAR(20) NOT NULL,
       team_name VARCHAR(100),
       message_text TEXT NOT NULL,
       message_type VARCHAR(30) DEFAULT 'broadcast',
       total_members INTEGER DEFAULT 0,
       created_at TIMESTAMP DEFAULT NOW()
     )`,
    `CREATE TABLE IF NOT EXISTS team_message_recipients (
       id SERIAL PRIMARY KEY,
       team_message_id INTEGER REFERENCES team_messages(id) ON DELETE CASCADE,
       member_phone VARCHAR(20) NOT NULL,
       member_name VARCHAR(100),
       wamid VARCHAR(255),
       status VARCHAR(20) DEFAULT 'pending',
       status_updated_at TIMESTAMP,
       created_at TIMESTAMP DEFAULT NOW(),
       UNIQUE(team_message_id, member_phone)
     )`,
  ]);

  const ensureOneOnOnes = () => ensure('one_on_ones', [
    `CREATE TABLE IF NOT EXISTS one_on_ones (
       id SERIAL PRIMARY KEY,
       admin_phone VARCHAR(50) NOT NULL,
       team_name VARCHAR(100),
       manager_phone VARCHAR(50) NOT NULL,
       manager_name VARCHAR(255),
       report_phone VARCHAR(50) NOT NULL,
       report_name VARCHAR(255),
       next_at TIMESTAMP NOT NULL,
       cadence_days INT,
       agenda TEXT,
       last_notes TEXT,
       last_notes_at TIMESTAMP,
       last_sent_prep_for TIMESTAMP,
       created_at TIMESTAMP DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_1to1_admin ON one_on_ones(admin_phone)`,
  ]);

  const ensureOnboardings = () => ensure('onboardings', [
    `CREATE TABLE IF NOT EXISTS team_onboardings (
       id SERIAL PRIMARY KEY,
       admin_phone VARCHAR(50) NOT NULL,
       team_name VARCHAR(100),
       member_phone VARCHAR(50) NOT NULL,
       member_name VARCHAR(255),
       started_at TIMESTAMP NOT NULL DEFAULT NOW(),
       manager_phone VARCHAR(50),
       completed_at TIMESTAMP,
       last_nudge_idx INT NOT NULL DEFAULT -1,
       UNIQUE(admin_phone, team_name, member_phone)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_t_onboarding_admin ON team_onboardings(admin_phone)`,
  ]);

  const ensureMemberMeta = () => ensure('member_meta', [
    `CREATE TABLE IF NOT EXISTS team_member_meta (
       id SERIAL PRIMARY KEY,
       admin_phone VARCHAR(50) NOT NULL,
       team_name VARCHAR(100) NOT NULL,
       member_phone VARCHAR(50) NOT NULL,
       birthday DATE,
       joined_at DATE,
       manager_phone VARCHAR(50),
       notes TEXT,
       updated_at TIMESTAMP DEFAULT NOW(),
       UNIQUE(admin_phone, team_name, member_phone)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_tmm_admin ON team_member_meta(admin_phone, team_name)`,
  ]);

  const ensureInviteCodes = () => ensure('invite_codes', [
    `CREATE TABLE IF NOT EXISTS team_invite_codes (
       code VARCHAR(20) PRIMARY KEY,
       admin_phone VARCHAR(50) NOT NULL,
       team_name VARCHAR(100) NOT NULL,
       created_at TIMESTAMP DEFAULT NOW(),
       expires_at TIMESTAMP,
       used_count INT NOT NULL DEFAULT 0
     )`,
  ]);

  const ensureChats = () => ensure('chats', [
    `CREATE TABLE IF NOT EXISTS team_chats (
       id SERIAL PRIMARY KEY,
       team_admin_phone VARCHAR(50) NOT NULL,
       team_name VARCHAR(100),
       type VARCHAR(10) NOT NULL DEFAULT 'group',
       name VARCHAR(200),
       created_by VARCHAR(50) NOT NULL,
       created_at TIMESTAMP DEFAULT NOW(),
       last_message_at TIMESTAMP
     )`,
    `CREATE TABLE IF NOT EXISTS team_chat_members (
       chat_id INT NOT NULL REFERENCES team_chats(id) ON DELETE CASCADE,
       member_phone VARCHAR(50) NOT NULL,
       member_name VARCHAR(255),
       joined_at TIMESTAMP DEFAULT NOW(),
       PRIMARY KEY (chat_id, member_phone)
     )`,
    `CREATE TABLE IF NOT EXISTS team_chat_messages (
       id SERIAL PRIMARY KEY,
       chat_id INT NOT NULL REFERENCES team_chats(id) ON DELETE CASCADE,
       from_phone VARCHAR(50) NOT NULL,
       from_name VARCHAR(255),
       text TEXT NOT NULL,
       sent_via VARCHAR(20) NOT NULL DEFAULT 'dashboard',
       wamid VARCHAR(255),
       reply_to_wamid VARCHAR(255),
       created_at TIMESTAMP DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_tcm_chat ON team_chat_messages(chat_id, created_at DESC)`,
  ]);

  // ========== TEAM / MEMBER RESOLUTION ==========

  /**
   * The caller owns a team, or belongs to one somebody else owns. Writes are
   * admin-only everywhere the dashboard is admin-only, so the caller's role is
   * returned rather than assumed.
   */
  async function resolveTeam(userPhone, teamName = null) {
    const phone = digits(userPhone) || String(userPhone || '');
    const wanted = normalizeTeamName(teamName);
    // The ownership flag has to be IN the select list: Postgres rejects
    // `ORDER BY <expression>` alongside SELECT DISTINCT unless the expression
    // is selected. Ordering by it puts the team the caller actually owns first.
    const rows = await queryFn(
      wanted
        ? `SELECT DISTINCT admin_phone, team_name, (admin_phone = $1) AS is_admin FROM teams
            WHERE LOWER(team_name) = $2 AND (admin_phone = $1 OR member_phone = $1)
            ORDER BY is_admin DESC LIMIT 2`
        : `SELECT DISTINCT admin_phone, team_name, (admin_phone = $1) AS is_admin FROM teams
            WHERE admin_phone = $1 OR member_phone = $1
            ORDER BY is_admin DESC LIMIT 2`,
      wanted ? [phone, wanted] : [phone],
    ).catch((error) => {
      if (error.code === '42P01') return { rows: [] };
      throw error;
    });
    if (!rows.rows || rows.rows.length === 0) return null;
    if (!wanted && rows.rows.length > 1) {
      return { ambiguous: true, teams: rows.rows.map((row) => row.team_name) };
    }
    const row = rows.rows[0];
    return {
      adminPhone: row.admin_phone,
      teamName: row.team_name,
      isAdmin: row.admin_phone === phone,
    };
  }

  async function resolveMember(adminPhone, nameOrPhone) {
    const raw = String(nameOrPhone || '').trim();
    if (!raw) return null;
    const asPhone = digits(raw);
    if (asPhone.length >= 10) {
      const byPhone = await queryFn(
        `SELECT DISTINCT member_phone, member_name FROM teams
          WHERE admin_phone = $1 AND member_phone LIKE $2 LIMIT 2`,
        [adminPhone, `%${asPhone.slice(-10)}`],
      );
      if (byPhone.rows.length === 1) return byPhone.rows[0];
      if (byPhone.rows.length > 1) return { ambiguous: true, name: raw };
      return null;
    }
    // Exact name first; a substring match could nudge the wrong teammate.
    const exact = await queryFn(
      `SELECT DISTINCT member_phone, member_name FROM teams
        WHERE admin_phone = $1 AND LOWER(BTRIM(member_name)) = LOWER(BTRIM($2)) LIMIT 2`,
      [adminPhone, raw],
    );
    if (exact.rows.length === 1) return exact.rows[0];
    if (exact.rows.length > 1) return { ambiguous: true, name: raw };
    return null;
  }

  // ========== BROADCASTS ==========

  async function listBroadcasts(adminPhone, teamName = null, limit = 10) {
    await ensureBroadcasts();
    const params = [adminPhone];
    let filter = '';
    const wanted = normalizeTeamName(teamName);
    if (wanted) { params.push(wanted); filter = `AND m.team_name = $${params.length}`; }
    params.push(Math.min(50, Math.max(1, Number(limit) || 10)));
    const result = await queryFn(
      `SELECT m.id, m.team_name, m.message_text, m.total_members, m.created_at,
              COALESCE(SUM(CASE WHEN r.status IN ('delivered','read') THEN 1 ELSE 0 END), 0)::int AS delivered_count,
              COALESCE(SUM(CASE WHEN r.status = 'read' THEN 1 ELSE 0 END), 0)::int AS read_count,
              COALESCE(SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END), 0)::int AS failed_count
         FROM team_messages m
    LEFT JOIN team_message_recipients r ON r.team_message_id = m.id
        WHERE m.admin_phone = $1 ${filter}
     GROUP BY m.id
     ORDER BY m.created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return result.rows;
  }

  async function getBroadcastRecipients(adminPhone, broadcastId) {
    await ensureBroadcasts();
    const result = await queryFn(
      `SELECT r.member_name, r.member_phone, r.status, r.status_updated_at
         FROM team_message_recipients r
         JOIN team_messages m ON m.id = r.team_message_id
        WHERE r.team_message_id = $1 AND m.admin_phone = $2
        ORDER BY r.member_name NULLS LAST, r.member_phone`,
      [Number(broadcastId), adminPhone],
    );
    return result.rows;
  }

  // ========== 1:1s ==========

  async function listOneOnOnes(adminPhone, limit = 20) {
    await ensureOneOnOnes();
    const result = await queryFn(
      `SELECT * FROM one_on_ones WHERE admin_phone = $1 ORDER BY next_at ASC LIMIT $2`,
      [adminPhone, Math.min(50, Math.max(1, Number(limit) || 20))],
    );
    return result.rows;
  }

  async function scheduleOneOnOne(adminPhone, {
    teamName, managerPhone, managerName, reportPhone, reportName, nextAt, cadenceDays = null, agenda = null,
  }) {
    await ensureOneOnOnes();
    const when = nextAt instanceof Date ? nextAt : new Date(nextAt);
    if (Number.isNaN(when.getTime())) return { error: 'I could not read that date and time.' };
    const result = await queryFn(
      `INSERT INTO one_on_ones
         (admin_phone, team_name, manager_phone, manager_name, report_phone, report_name, next_at, cadence_days, agenda)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [adminPhone, normalizeTeamName(teamName), digits(managerPhone), managerName || null,
        digits(reportPhone), reportName || null, when.toISOString(),
        cadenceDays === null || cadenceDays === undefined ? null : Number(cadenceDays),
        agenda ? String(agenda).slice(0, 2000) : null],
    );
    return { oneOnOne: result.rows[0] };
  }

  async function cancelOneOnOne(adminPhone, id) {
    await ensureOneOnOnes();
    const result = await queryFn(
      `DELETE FROM one_on_ones WHERE id = $1 AND admin_phone = $2 RETURNING *`,
      [Number(id), adminPhone],
    );
    if (!result.rows[0]) return { error: 'No 1:1 with that ID on your team.' };
    return { cancelled: result.rows[0] };
  }

  // ========== ONBOARDING ==========

  async function listOnboardings(adminPhone, limit = 20) {
    await ensureOnboardings();
    const result = await queryFn(
      `SELECT * FROM team_onboardings WHERE admin_phone = $1
        ORDER BY completed_at NULLS FIRST, started_at DESC LIMIT $2`,
      [adminPhone, Math.min(50, Math.max(1, Number(limit) || 20))],
    );
    return result.rows;
  }

  async function startOnboarding(adminPhone, { teamName, memberPhone, memberName, managerPhone = null }) {
    await ensureOnboardings();
    const result = await queryFn(
      `INSERT INTO team_onboardings (admin_phone, team_name, member_phone, member_name, manager_phone)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (admin_phone, team_name, member_phone)
       DO UPDATE SET started_at = NOW(), completed_at = NULL, last_nudge_idx = -1,
                     manager_phone = EXCLUDED.manager_phone
       RETURNING *`,
      [adminPhone, normalizeTeamName(teamName), digits(memberPhone), memberName || null,
        managerPhone ? digits(managerPhone) : null],
    );
    return { onboarding: result.rows[0] };
  }

  async function completeOnboarding(adminPhone, id) {
    await ensureOnboardings();
    const result = await queryFn(
      `UPDATE team_onboardings SET completed_at = NOW()
        WHERE id = $1 AND admin_phone = $2 AND completed_at IS NULL RETURNING *`,
      [Number(id), adminPhone],
    );
    if (!result.rows[0]) return { error: 'No active onboarding with that ID.' };
    return { onboarding: result.rows[0] };
  }

  // ========== MEMBER METADATA ==========

  async function getMemberMeta(adminPhone, teamName) {
    await ensureMemberMeta();
    const result = await queryFn(
      `SELECT m.member_phone, m.birthday::text AS birthday, m.joined_at::text AS joined_at,
              m.manager_phone, m.notes,
              (SELECT member_name FROM teams t
                WHERE t.admin_phone = m.admin_phone AND t.member_phone = m.member_phone LIMIT 1) AS member_name
         FROM team_member_meta m
        WHERE m.admin_phone = $1 AND m.team_name = $2
        ORDER BY member_name NULLS LAST`,
      [adminPhone, normalizeTeamName(teamName)],
    );
    return result.rows;
  }

  async function upsertMemberMeta(adminPhone, teamName, memberPhone, fields = {}) {
    await ensureMemberMeta();
    const patch = {
      birthday: fields.birthday ?? null,
      joined_at: fields.joined_at ?? null,
      manager_phone: fields.manager_phone ? digits(fields.manager_phone) : null,
      notes: fields.notes ?? null,
    };
    if (Object.values(patch).every((value) => value === null)) {
      return { error: 'Nothing to save — give me a birthday, a start date, a manager, or a note.' };
    }
    // COALESCE keeps fields the user did not mention; a partial update must
    // never blank out a birthday somebody set on the dashboard.
    const result = await queryFn(
      `INSERT INTO team_member_meta (admin_phone, team_name, member_phone, birthday, joined_at, manager_phone, notes)
       VALUES ($1, $2, $3, $4::date, $5::date, $6, $7)
       ON CONFLICT (admin_phone, team_name, member_phone)
       DO UPDATE SET birthday = COALESCE(EXCLUDED.birthday, team_member_meta.birthday),
                     joined_at = COALESCE(EXCLUDED.joined_at, team_member_meta.joined_at),
                     manager_phone = COALESCE(EXCLUDED.manager_phone, team_member_meta.manager_phone),
                     notes = COALESCE(EXCLUDED.notes, team_member_meta.notes),
                     updated_at = NOW()
       RETURNING *`,
      [adminPhone, normalizeTeamName(teamName), digits(memberPhone),
        patch.birthday, patch.joined_at, patch.manager_phone, patch.notes],
    );
    return { meta: result.rows[0] };
  }

  // ========== INVITE CODE ==========

  async function getOrCreateInviteCode(adminPhone, teamName) {
    await ensureInviteCodes();
    const team = normalizeTeamName(teamName);
    const existing = await queryFn(
      `SELECT code FROM team_invite_codes
        WHERE admin_phone = $1 AND team_name = $2 AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY created_at DESC LIMIT 1`,
      [adminPhone, team],
    );
    if (existing.rows[0]) return { code: existing.rows[0].code, existed: true };
    const code = require('crypto').randomBytes(5).toString('hex');
    const created = await queryFn(
      `INSERT INTO team_invite_codes (code, admin_phone, team_name, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '30 days')
       ON CONFLICT (code) DO NOTHING RETURNING code`,
      [code, adminPhone, team],
    );
    if (!created.rows[0]) return { error: 'Could not create an invite code. Please try again.' };
    return { code: created.rows[0].code, existed: false };
  }

  // ========== TEAM CHAT ==========

  async function listChats(adminPhone, userPhone, limit = 15) {
    await ensureChats();
    const result = await queryFn(
      `SELECT c.id, c.type, c.name, c.last_message_at,
              (SELECT COUNT(*) FROM team_chat_members m WHERE m.chat_id = c.id)::int AS member_count
         FROM team_chats c
         JOIN team_chat_members me ON me.chat_id = c.id AND me.member_phone = $2
        WHERE c.team_admin_phone = $1
        ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC
        LIMIT $3`,
      [adminPhone, digits(userPhone) || userPhone, Math.min(50, Math.max(1, Number(limit) || 15))],
    );
    return result.rows;
  }

  /**
   * Posts into an existing thread the sender already belongs to. Ari never
   * creates a chat here and never posts into a thread the caller cannot see —
   * membership is the access check, exactly as in the dashboard route.
   */
  async function sendChatMessage(adminPhone, userPhone, { chatId, chatName, text, fromName = null }) {
    await ensureChats();
    const sender = digits(userPhone) || String(userPhone || '');
    const body = String(text || '').trim();
    if (!body) return { error: 'What should I post in that chat?' };

    const params = [adminPhone, sender];
    let selector = '';
    if (chatId) { params.push(Number(chatId)); selector = `AND c.id = $${params.length}`; }
    else if (chatName) { params.push(String(chatName).trim().toLowerCase()); selector = `AND LOWER(COALESCE(c.name, '')) = $${params.length}`; }
    else return { error: 'Which chat should I post in?' };

    const found = await queryFn(
      `SELECT c.id, c.name, me.member_name
         FROM team_chats c
         JOIN team_chat_members me ON me.chat_id = c.id AND me.member_phone = $2
        WHERE c.team_admin_phone = $1 ${selector}
        ORDER BY c.id DESC LIMIT 2`,
      params,
    );
    if (found.rows.length === 0) return { error: 'I could not find a chat by that name that you are a member of.' };
    if (found.rows.length > 1) return { error: 'More than one chat matches that name. Use the chat ID.' };
    const chat = found.rows[0];

    const inserted = await queryFn(
      `INSERT INTO team_chat_messages (chat_id, from_phone, from_name, text, sent_via)
       VALUES ($1, $2, $3, $4, 'whatsapp') RETURNING *`,
      [chat.id, sender, fromName || chat.member_name || null, body.slice(0, CHAT_TEXT_MAX)],
    );
    await queryFn(`UPDATE team_chats SET last_message_at = NOW() WHERE id = $1`, [chat.id])
      .catch((error) => logger.warn(`team chat timestamp update failed: ${error.message}`));
    return { chat, message: inserted.rows[0] };
  }

  return {
    resolveTeam, resolveMember,
    listBroadcasts, getBroadcastRecipients,
    listOneOnOnes, scheduleOneOnOne, cancelOneOnOne,
    listOnboardings, startOnboarding, completeOnboarding,
    getMemberMeta, upsertMemberMeta,
    getOrCreateInviteCode,
    listChats, sendChatMessage,
  };
}

module.exports = {
  createTeamWorkspaceService,
  teamWorkspaceService: createTeamWorkspaceService(),
  normalizeTeamName,
};
