// dashboard/lib/team-chat.ts
//
// Team chat — groups + DMs in one schema. A "DM" is just a chat with
// type='dm' and exactly 2 members. A "group" is type='group' with 2+.
//
// Messages from the dashboard are fanned out to each non-self member
// via WhatsApp (the bot owns the credentials). When members reply on
// WhatsApp, the bot's webhook controller looks up the original wamid
// in the `context` field and writes the reply back to the same thread.
//
// Email-based members (someone on the team who doesn't use WhatsApp)
// are NOT supported in v1 — punted to next session because inbound
// email parsing requires domain MX + SendGrid Inbound Parse setup.

import { query } from "@/lib/db";

export type ChatType = "group" | "dm";

export type Chat = {
  id: number;
  team_admin_phone: string;
  team_name: string | null;
  type: ChatType;
  name: string | null;
  created_by: string;
  created_at: string;
  last_message_at: string | null;
  member_count: number;
  unread_count?: number;
  // For DMs only: the other party (computed server-side so the
  // dashboard left rail can show "Ammi" instead of a generic "DM" label).
  partner_phone?: string | null;
  partner_name?: string | null;
};

export type ChatMember = {
  chat_id: number;
  member_phone: string;
  member_name: string | null;
  joined_at: string;
};

export type ChatMessage = {
  id: number;
  chat_id: number;
  from_phone: string;
  from_name: string | null;
  text: string;
  sent_via: "dashboard" | "whatsapp" | "system";
  wamid: string | null;
  reply_to_wamid: string | null;
  created_at: string;
};

export async function ensureChatTables(): Promise<void> {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS team_chats (
        id               SERIAL PRIMARY KEY,
        team_admin_phone VARCHAR(50) NOT NULL,
        team_name        VARCHAR(100),
        type             VARCHAR(10) NOT NULL DEFAULT 'group',
        name             VARCHAR(200),
        created_by       VARCHAR(50) NOT NULL,
        created_at       TIMESTAMP DEFAULT NOW(),
        last_message_at  TIMESTAMP
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_team_chats_admin ON team_chats(team_admin_phone, last_message_at DESC NULLS LAST)`);

    await query(`
      CREATE TABLE IF NOT EXISTS team_chat_members (
        chat_id      INTEGER REFERENCES team_chats(id) ON DELETE CASCADE,
        member_phone VARCHAR(50) NOT NULL,
        member_name  VARCHAR(200),
        joined_at    TIMESTAMP DEFAULT NOW(),
        last_read_at TIMESTAMP,
        last_whatsapp_notified_at TIMESTAMP,
        last_notified_wamid VARCHAR(255),
        PRIMARY KEY (chat_id, member_phone)
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_team_chat_members_phone ON team_chat_members(member_phone)`);
    // Idempotent ALTERs for existing installs that pre-date the unread-notifier
    await query(`ALTER TABLE team_chat_members ADD COLUMN IF NOT EXISTS last_whatsapp_notified_at TIMESTAMP`).catch(() => {});
    await query(`ALTER TABLE team_chat_members ADD COLUMN IF NOT EXISTS last_notified_wamid VARCHAR(255)`).catch(() => {});
    await query(`CREATE INDEX IF NOT EXISTS idx_team_chat_members_notified_wamid ON team_chat_members(last_notified_wamid)`).catch(() => {});

    await query(`
      CREATE TABLE IF NOT EXISTS team_chat_messages (
        id              SERIAL PRIMARY KEY,
        chat_id         INTEGER REFERENCES team_chats(id) ON DELETE CASCADE,
        from_phone      VARCHAR(50) NOT NULL,
        from_name       VARCHAR(200),
        text            TEXT NOT NULL,
        sent_via        VARCHAR(20) NOT NULL DEFAULT 'dashboard',
        wamid           VARCHAR(255),
        reply_to_wamid  VARCHAR(255),
        created_at      TIMESTAMP DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_team_chat_msg_chat ON team_chat_messages(chat_id, created_at DESC)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_team_chat_msg_wamid ON team_chat_messages(wamid)`);
  } catch { /* swallow */ }
}

export async function listChats(adminPhone: string, userPhone: string): Promise<Chat[]> {
  await ensureChatTables();
  if (process.env.ARI_DEMO_MODE === "true") {
    const chats = await query<Omit<Chat, "member_count">>(`SELECT * FROM team_chats WHERE team_admin_phone = $1 ORDER BY id DESC`, [adminPhone]);
    const members = await query<{ chat_id: number; member_phone: string; member_name: string | null }>(`SELECT chat_id, member_phone, member_name FROM team_chat_members`);
    return chats.rows
      .filter(chat => members.rows.some(member => Number(member.chat_id) === Number(chat.id) && member.member_phone === userPhone))
      .map(chat => {
        const chatMembers = members.rows.filter(member => Number(member.chat_id) === Number(chat.id));
        const partner = chat.type === "dm" ? chatMembers.find(member => member.member_phone !== userPhone) : null;
        return { ...chat, member_count: chatMembers.length, unread_count: 0, partner_phone: partner?.member_phone || null, partner_name: partner?.member_name || null };
      });
  }
  const r = await query<Chat & { unread_count: string | number }>(
    `SELECT c.*, COUNT(m.member_phone)::int AS member_count,
       (SELECT COUNT(*)::int FROM team_chat_messages msg
          WHERE msg.chat_id = c.id
            AND msg.from_phone != $2
            AND (
              (SELECT last_read_at FROM team_chat_members WHERE chat_id = c.id AND member_phone = $2) IS NULL
              OR msg.created_at > (SELECT last_read_at FROM team_chat_members WHERE chat_id = c.id AND member_phone = $2)
            )
       ) AS unread_count,
       -- DM partner: the OTHER member's phone+name. NULL for groups.
       CASE WHEN c.type = 'dm' THEN
         (SELECT member_phone FROM team_chat_members
            WHERE chat_id = c.id AND member_phone != $2 LIMIT 1)
       END AS partner_phone,
       CASE WHEN c.type = 'dm' THEN
         (SELECT member_name FROM team_chat_members
            WHERE chat_id = c.id AND member_phone != $2 LIMIT 1)
       END AS partner_name
       FROM team_chats c
       JOIN team_chat_members m ON m.chat_id = c.id
      WHERE c.team_admin_phone = $1
        AND EXISTS (SELECT 1 FROM team_chat_members tm WHERE tm.chat_id = c.id AND tm.member_phone = $2)
   GROUP BY c.id
   ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC
      LIMIT 200`,
    [adminPhone, userPhone]
  );
  return r.rows.map(row => ({ ...row, member_count: Number(row.member_count) || 0, unread_count: Number(row.unread_count) || 0 }));
}

export async function getChat(adminPhone: string, chatId: number, userPhone: string): Promise<{ chat: Chat; members: ChatMember[]; messages: ChatMessage[] } | null> {
  await ensureChatTables();
  // Auth: only members of the chat can read it
  const access = await query<{ ok: number }>(
    `SELECT 1 AS ok FROM team_chat_members WHERE chat_id = $1 AND member_phone = $2 LIMIT 1`,
    [chatId, userPhone]
  );
  if (access.rows.length === 0) return null;

  const c = await query<Chat>(
    `SELECT * FROM team_chats WHERE id = $1 AND team_admin_phone = $2`,
    [chatId, adminPhone]
  );
  if (!c.rows[0]) return null;
  const members = (await query<ChatMember>(
    `SELECT chat_id, member_phone, member_name, joined_at
       FROM team_chat_members WHERE chat_id = $1
      ORDER BY joined_at ASC`,
    [chatId]
  )).rows;
  const messages = (await query<ChatMessage>(
    `SELECT * FROM team_chat_messages
      WHERE chat_id = $1
      ORDER BY created_at ASC
      LIMIT 500`,
    [chatId]
  )).rows;

  // Mark as read up to "now" for this user
  await query(
    `UPDATE team_chat_members SET last_read_at = NOW() WHERE chat_id = $1 AND member_phone = $2`,
    [chatId, userPhone]
  ).catch(() => {});

  return { chat: { ...c.rows[0], member_count: members.length }, members, messages };
}

export async function createChat(
  adminPhone: string,
  data: {
    type: ChatType;
    name: string | null;
    teamName: string | null;
    creatorPhone: string;
    creatorName: string | null;
    memberPhones: string[];
    memberNames: Record<string, string | null>;
  }
): Promise<Chat | null> {
  await ensureChatTables();
  // DM dedupe — if a DM already exists between the creator + the
  // requested other member, reuse it. The API only ever sends ONE
  // phone for DMs (the other party); the creator gets added below.
  // Old check was `length === 2` which never matched, so every click
  // created a new DM. Fixed.
  if (data.type === "dm" && data.memberPhones.length === 1) {
    const otherPhone = data.memberPhones[0];
    const existing = await query<{ id: number }>(
      `SELECT c.id FROM team_chats c
        WHERE c.team_admin_phone = $1 AND c.type = 'dm'
          AND EXISTS (SELECT 1 FROM team_chat_members WHERE chat_id = c.id AND member_phone = $2)
          AND EXISTS (SELECT 1 FROM team_chat_members WHERE chat_id = c.id AND member_phone = $3)
          AND (SELECT COUNT(*) FROM team_chat_members WHERE chat_id = c.id) = 2
        ORDER BY c.id ASC
        LIMIT 1`,
      [adminPhone, data.creatorPhone, otherPhone]
    );
    if (existing.rows[0]) {
      const c = await query<Chat>(`SELECT * FROM team_chats WHERE id = $1`, [existing.rows[0].id]);
      return c.rows[0] ?? null;
    }
  }

  const created = await query<Chat>(
    `INSERT INTO team_chats (team_admin_phone, team_name, type, name, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [adminPhone, data.teamName, data.type, data.name, data.creatorPhone]
  );
  const chat = created.rows[0];
  if (!chat) return null;

  // Insert all members (always include the creator)
  const phones = Array.from(new Set([data.creatorPhone, ...data.memberPhones]));
  for (const p of phones) {
    await query(
      `INSERT INTO team_chat_members (chat_id, member_phone, member_name)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [chat.id, p, data.memberNames[p] || null]
    ).catch(() => {});
  }
  return chat;
}

export async function recordMessage(
  chatId: number,
  data: { fromPhone: string; fromName: string | null; text: string; sentVia: "dashboard" | "whatsapp" | "system"; wamid?: string | null; replyToWamid?: string | null }
): Promise<ChatMessage | null> {
  await ensureChatTables();
  const r = await query<ChatMessage>(
    `INSERT INTO team_chat_messages (chat_id, from_phone, from_name, text, sent_via, wamid, reply_to_wamid)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [chatId, data.fromPhone, data.fromName || null, data.text.slice(0, 4000), data.sentVia, data.wamid || null, data.replyToWamid || null]
  );
  await query(`UPDATE team_chats SET last_message_at = NOW() WHERE id = $1`, [chatId]).catch(() => {});
  return r.rows[0] ?? null;
}

export async function lookupChatByWamid(wamid: string): Promise<{ chat_id: number } | null> {
  await ensureChatTables();
  const r = await query<{ chat_id: number }>(
    `SELECT chat_id FROM team_chat_messages WHERE wamid = $1 ORDER BY id DESC LIMIT 1`,
    [wamid]
  );
  return r.rows[0] ?? null;
}
