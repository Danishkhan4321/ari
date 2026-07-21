/**
 * Team Communications Service
 *
 * Handles:
 *  - Team broadcast message tracking + read receipts (wamid → delivery status)
 *  - Team status aggregation (last active, pending tasks, upcoming reminders)
 *
 * Polling/check-in state is handled by the existing pollService to avoid duplication.
 */

const { query } = require('../config/database');
const logger = require('../utils/logger');

class TeamCommsService {

  constructor() {
    this.tablesCreated = false;
  }

  // ========== SCHEMA ==========

  async ensureTables() {
    if (this.tablesCreated) return;
    try {
      // Track each team broadcast (message/reminder/announcement sent to a team)
      await query(`
        CREATE TABLE IF NOT EXISTS team_messages (
          id          SERIAL PRIMARY KEY,
          admin_phone VARCHAR(20)  NOT NULL,
          team_name   VARCHAR(100),
          message_text TEXT        NOT NULL,
          message_type VARCHAR(30) DEFAULT 'broadcast',
          total_members INTEGER    DEFAULT 0,
          created_at  TIMESTAMP    DEFAULT NOW()
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_team_msg_admin ON team_messages(admin_phone, created_at DESC)`);

      // One row per recipient per broadcast — stores wamid + delivery status
      await query(`
        CREATE TABLE IF NOT EXISTS team_message_recipients (
          id              SERIAL PRIMARY KEY,
          team_message_id INTEGER REFERENCES team_messages(id) ON DELETE CASCADE,
          member_phone    VARCHAR(20)  NOT NULL,
          member_name     VARCHAR(100),
          wamid           VARCHAR(255),
          status          VARCHAR(20)  DEFAULT 'pending',
          status_updated_at TIMESTAMP,
          created_at      TIMESTAMP    DEFAULT NOW(),
          UNIQUE(team_message_id, member_phone)
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_tmr_wamid   ON team_message_recipients(wamid)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_tmr_msg     ON team_message_recipients(team_message_id)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_tmr_phone   ON team_message_recipients(member_phone)`);

      this.tablesCreated = true;
    } catch (e) {
      logger.error('TeamCommsService.ensureTables error:', e.message);
    }
  }

  // ========== BROADCAST TRACKING (READ RECEIPTS) ==========

  /**
   * Start tracking a new team broadcast.
   * Returns the team_messages row so caller can attach wamids per recipient.
   */
  async createTeamMessage(adminPhone, teamName, messageText, messageType, members) {
    await this.ensureTables();
    try {
      const msg = await query(
        `INSERT INTO team_messages (admin_phone, team_name, message_text, message_type, total_members)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [adminPhone, teamName || null, messageText, messageType, members.length]
      );
      const msgId = msg.rows[0].id;

      // Pre-create recipient rows so we can update them when wamids arrive
      for (const m of members) {
        await query(
          `INSERT INTO team_message_recipients (team_message_id, member_phone, member_name)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [msgId, m.member_phone, m.member_name || m.member_phone]
        ).catch(() => {});
      }
      return msg.rows[0];
    } catch (e) {
      logger.error('createTeamMessage error:', e.message);
      return null;
    }
  }

  /** Called right after a message is sent to record the wamid for that recipient. */
  async updateRecipientWamid(teamMessageId, memberPhone, wamid) {
    if (!wamid) return;
    try {
      await query(
        `UPDATE team_message_recipients
         SET wamid = $3, status = 'sent', status_updated_at = NOW()
         WHERE team_message_id = $1 AND member_phone = $2`,
        [teamMessageId, memberPhone, wamid]
      );
    } catch (e) { /* non-critical */ }
  }

  /**
   * Called from the WA STATUS webhook handler.
   * Maps wamid → delivery status update across ALL team messages.
   */
  async updateDeliveryStatus(wamid, status) {
    if (!wamid || !status) return;
    try {
      await query(
        `UPDATE team_message_recipients
         SET status = $2, status_updated_at = NOW()
         WHERE wamid = $1`,
        [wamid, status]
      );
    } catch (e) { /* non-critical */ }
  }

  /**
   * For non-WhatsApp platform sends where no wamid is returned.
   * Marks the recipient as 'sent' immediately so they don't stay "pending" forever.
   * Only updates rows that don't already have a wamid (avoids overwriting WA tracking).
   */
  async markRecipientSent(teamMessageId, memberPhone) {
    if (!teamMessageId || !memberPhone) return;
    try {
      await query(
        `UPDATE team_message_recipients
         SET status = 'sent', status_updated_at = NOW()
         WHERE team_message_id = $1 AND member_phone = $2 AND wamid IS NULL`,
        [teamMessageId, memberPhone]
      );
    } catch (e) { /* non-critical */ }
  }

  async markRecipientFailed(teamMessageId, memberPhone) {
    if (!teamMessageId || !memberPhone) return;
    try {
      await query(
        `UPDATE team_message_recipients
         SET status = 'failed', status_updated_at = NOW()
         WHERE team_message_id = $1 AND member_phone = $2`,
        [teamMessageId, memberPhone]
      );
    } catch (e) { /* non-critical */ }
  }

  /**
   * The one place a team broadcast is sent. Both entry points use it — the
   * dashboard Broadcasts composer and "tell the team ..." in chat — so every
   * broadcast leaves a team_messages row with per-recipient read receipts
   * instead of vanishing into WhatsApp untracked.
   *
   * `send` is injectable so the chat path can keep its own send timeout.
   */
  async sendBroadcast({ adminPhone, teamName, messageText, members, send = null, pauseMs = 0 }) {
    const messagingService = require('./messaging.service');
    const deliver = typeof send === 'function'
      ? send
      : (phone, text) => messagingService.send(phone, text);
    const unique = [];
    const seen = new Set();
    for (const member of Array.isArray(members) ? members : []) {
      const phone = String(member?.member_phone || '').replace(/\D/g, '');
      if (!/^\d{8,15}$/.test(phone) || seen.has(phone)) continue;
      seen.add(phone);
      unique.push({
        member_phone: phone,
        member_name: typeof member.member_name === 'string' && member.member_name.trim()
          ? member.member_name.trim().slice(0, 100)
          : phone,
      });
    }
    if (unique.length === 0) throw new Error('No valid team recipients');

    const tracked = await this.createTeamMessage(adminPhone, teamName, messageText, 'broadcast', unique);
    if (!tracked?.id) throw new Error('Could not create broadcast tracking row');

    let sent = 0;
    const failedRecipients = [];
    for (const member of unique) {
      try {
        const wamid = await deliver(member.member_phone, messageText);
        if (typeof wamid === 'string' && wamid) {
          await this.updateRecipientWamid(tracked.id, member.member_phone, wamid);
        } else {
          await this.markRecipientSent(tracked.id, member.member_phone);
        }
        sent++;
      } catch (error) {
        logger.warn(`Team broadcast delivery failed for one recipient (${error?.name || 'error'})`);
        await this.markRecipientFailed(tracked.id, member.member_phone);
        failedRecipients.push({ name: member.member_name, phone: member.member_phone });
      }
      if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }

    return {
      ok: true,
      team_message_id: tracked.id,
      total: unique.length,
      sent,
      failed: failedRecipients.length,
      failed_recipients: failedRecipients,
    };
  }

  /** Returns the latest team broadcast + per-recipient statuses for an admin. */
  async getReadReceipts(adminPhone, teamName = null) {
    await this.ensureTables();
    try {
      const params = teamName ? [adminPhone, teamName] : [adminPhone];
      const teamFilter = teamName ? `AND team_name = $2` : '';

      const msg = await query(
        `SELECT * FROM team_messages
         WHERE admin_phone = $1 ${teamFilter}
         ORDER BY created_at DESC LIMIT 1`,
        params
      );
      if (!msg.rows.length) return null;

      const recipients = await query(
        `SELECT * FROM team_message_recipients
         WHERE team_message_id = $1 ORDER BY member_name`,
        [msg.rows[0].id]
      );

      return { message: msg.rows[0], recipients: recipients.rows };
    } catch (e) {
      logger.error('getReadReceipts error:', e.message);
      return null;
    }
  }

  formatReadReceipts(data) {
    const { message, recipients } = data;
    const preview = message.message_text.length > 60
      ? message.message_text.slice(0, 60) + '…'
      : message.message_text;

    const groups = { read: [], delivered: [], sent: [], pending: [], failed: [] };
    for (const r of recipients) {
      const key = groups[r.status] ? r.status : 'pending';
      groups[key].push(r.member_name || r.member_phone);
    }

    const sentAt = new Date(message.created_at).toLocaleString('en-IN', {
      hour: 'numeric', minute: '2-digit', hour12: true,
      day: 'numeric', month: 'short'
    });

    let text = `*Delivery Status*\n_"${preview}"_\n_Sent ${sentAt}_\n\n`;
    if (groups.read.length)      text += `*Seen* (${groups.read.length}): ${groups.read.join(', ')}\n`;
    if (groups.delivered.length) text += `*Delivered* (${groups.delivered.length}): ${groups.delivered.join(', ')}\n`;
    if (groups.sent.length)      text += `*Sent* (${groups.sent.length}): ${groups.sent.join(', ')}\n`;
    if (groups.pending.length)   text += `*Pending* (${groups.pending.length}): ${groups.pending.join(', ')}\n`;
    if (groups.failed.length)    text += `*Failed* (${groups.failed.length}): ${groups.failed.join(', ')}\n`;

    return text.trim();
  }

  // ========== TEAM STATUS ==========

  /**
   * Aggregate activity data for each member in a team:
   *   - last time they messaged the bot
   *   - count of their pending tasks
   *   - count of their upcoming reminders (next 24 h)
   */
  async getTeamStatus(adminPhone, teamName = null) {
    await this.ensureTables();
    try {
      const members = await query(
        teamName
          ? `SELECT DISTINCT member_phone, member_name FROM teams WHERE admin_phone = $1 AND LOWER(team_name) = LOWER($2) ORDER BY member_name`
          : `SELECT DISTINCT member_phone, member_name FROM teams WHERE admin_phone = $1 ORDER BY member_name`,
        teamName ? [adminPhone, teamName] : [adminPhone]
      );
      if (!members.rows.length) return [];

      const phones = members.rows.map(m => m.member_phone);

      // Last active (latest user message in conversation_history)
      const activity = await query(
        `SELECT user_phone,
                MAX(created_at) AS last_seen
         FROM conversation_history
         WHERE user_phone = ANY($1) AND role = 'user'
         GROUP BY user_phone`,
        [phones]
      );
      const activityMap = Object.fromEntries(activity.rows.map(r => [r.user_phone, r.last_seen]));

      // Pending task count per member
      const tasks = await query(
        `SELECT assigned_to AS phone, COUNT(*) AS count
         FROM tasks
         WHERE assigned_to = ANY($1) AND status = 'pending'
         GROUP BY assigned_to`,
        [phones]
      );
      const taskMap = Object.fromEntries(tasks.rows.map(r => [r.phone, parseInt(r.count)]));

      // Upcoming reminders (next 24 h)
      const reminders = await query(
        `SELECT user_phone AS phone, COUNT(*) AS count
         FROM reminders
         WHERE user_phone = ANY($1)
           AND status = 'pending'
           AND reminder_time BETWEEN NOW() AND NOW() + INTERVAL '24 hours'
         GROUP BY user_phone`,
        [phones]
      );
      const reminderMap = Object.fromEntries(reminders.rows.map(r => [r.phone, parseInt(r.count)]));

      return members.rows.map(m => ({
        name:        m.member_name,
        phone:       m.member_phone,
        lastSeen:    activityMap[m.member_phone] || null,
        pendingTasks: taskMap[m.member_phone] || 0,
        upcomingReminders: reminderMap[m.member_phone] || 0
      }));
    } catch (e) {
      logger.error('getTeamStatus error:', e.message);
      return [];
    }
  }

  formatTeamStatus(members, teamName, timezone = 'Asia/Kolkata') {
    const label = teamName ? `*${teamName} team*` : '*All Teams*';
    let text = `${label} Status\n\n`;

    const now = Date.now();
    for (const m of members) {
      const lastSeenText = m.lastSeen
        ? this._relativeTime(now - new Date(m.lastSeen).getTime())
        : 'never';

      const active = m.lastSeen && (now - new Date(m.lastSeen).getTime()) < 24 * 60 * 60 * 1000;
      const dot = active ? '[active]' : '[inactive]';

      text += `${dot} *${m.name}*\n`;
      text += `   Last seen: ${lastSeenText}`;
      if (m.pendingTasks)        text += ` • ${m.pendingTasks} task${m.pendingTasks !== 1 ? 's' : ''}`;
      if (m.upcomingReminders)   text += ` • ${m.upcomingReminders} reminder${m.upcomingReminders !== 1 ? 's' : ''}`;
      text += '\n';
    }

    const active = members.filter(m => m.lastSeen && (now - new Date(m.lastSeen).getTime()) < 24 * 60 * 60 * 1000).length;
    text += `\n${active}/${members.length} active in last 24h`;
    return text.trim();
  }

  _relativeTime(ms) {
    const min = Math.floor(ms / 60000);
    if (min < 60)   return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24)    return `${hr}h ago`;
    const days = Math.floor(hr / 24);
    return `${days}d ago`;
  }
}

module.exports = new TeamCommsService();
