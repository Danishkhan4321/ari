// dashboard/lib/groups.ts
// Folk-style "groups" — named buckets of contacts/leads. A group can
// hold any mix of `contacts` rows and `sales_leads` rows. We treat them
// uniformly via a member_kind discriminator.
//
// Tables are created lazily on first call so the bot doesn't need a
// migration step to start using them.
import { query } from "./db";

let tableReady = false;

async function ensureTables(): Promise<void> {
  if (tableReady) return;
  if (process.env.ARI_DEMO_MODE === "true") {
    tableReady = true;
    return;
  }
  await query(`
    CREATE TABLE IF NOT EXISTS contact_groups (
      id SERIAL PRIMARY KEY,
      user_phone VARCHAR(20) NOT NULL,
      name VARCHAR(120) NOT NULL,
      emoji VARCHAR(8),
      archived_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await query(`ALTER TABLE contact_groups ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP`);
  await query(`CREATE INDEX IF NOT EXISTS idx_contact_groups_user ON contact_groups(user_phone)`);

  await query(`
    CREATE TABLE IF NOT EXISTS contact_group_members (
      id SERIAL PRIMARY KEY,
      group_id INT NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
      member_kind VARCHAR(10) NOT NULL,        -- 'lead' | 'contact'
      member_id INT NOT NULL,
      added_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (group_id, member_kind, member_id)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_cgm_group ON contact_group_members(group_id)`);

  // Defensive: make sure the two log tables exist so the listGroupMembers
  // join doesn't fail on a fresh deploy where the bot hasn't yet sent
  // any email. They're owned by the bot but cheap to declare here too.
  await query(`
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
  await query(`CREATE INDEX IF NOT EXISTS idx_sent_email_log_user_recipient
               ON sent_email_log(user_phone, recipient_email)`);
  await query(`
    CREATE TABLE IF NOT EXISTS sales_emails_log (
      id SERIAL PRIMARY KEY,
      user_phone VARCHAR(20) NOT NULL,
      lead_id INTEGER,
      email_type VARCHAR(30) NOT NULL,
      subject TEXT,
      gmail_message_id VARCHAR(100),
      sent_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_sales_emails_lead
               ON sales_emails_log(lead_id)`);

  await query(`
    CREATE TABLE IF NOT EXISTS bulk_email_campaigns (
      id SERIAL PRIMARY KEY,
      user_phone VARCHAR(20) NOT NULL,
      group_id INT REFERENCES contact_groups(id) ON DELETE SET NULL,
      subject TEXT NOT NULL,
      body_template TEXT NOT NULL,
      recipient_count INT DEFAULT 0,
      sent_count INT DEFAULT 0,
      failed_count INT DEFAULT 0,
      status VARCHAR(20) DEFAULT 'pending',    -- pending|sending|completed|partial|cancelled
      scheduled_for TIMESTAMP,
      daily_send_limit INT DEFAULT 100,
      archived_at TIMESTAMP,
      error TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      completed_at TIMESTAMP
    )
  `);
  await query(`ALTER TABLE bulk_email_campaigns ADD COLUMN IF NOT EXISTS daily_send_limit INT DEFAULT 100`);
  await query(`ALTER TABLE bulk_email_campaigns ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP`);
  await query(`CREATE INDEX IF NOT EXISTS idx_bec_user ON bulk_email_campaigns(user_phone, created_at DESC)`);

  tableReady = true;
}

export type Group = {
  id: number;
  name: string;
  emoji: string | null;
  member_count: number;
  created_at: string;
  archived_at: string | null;
};

export async function listGroups(userPhone: string): Promise<Group[]> {
  await ensureTables();
  if (process.env.ARI_DEMO_MODE === "true") {
    const groups = await query<Omit<Group, "member_count">>(
      `SELECT id, name, emoji, created_at, archived_at FROM contact_groups WHERE user_phone = $1 ORDER BY id DESC`,
      [userPhone],
    );
    const counts = await query<{ group_id: number; count: string }>(
      `SELECT group_id, COUNT(*)::text AS count FROM contact_group_members GROUP BY group_id`,
    );
    return groups.rows.map(group => ({ ...group, member_count: parseInt(counts.rows.find(row => Number(row.group_id) === Number(group.id))?.count || "0", 10) }));
  }
  const r = await query<Group>(
    `SELECT g.id, g.name, g.emoji, g.created_at, g.archived_at,
            COALESCE(m.cnt, 0)::int AS member_count
       FROM contact_groups g
       LEFT JOIN (
         SELECT group_id, COUNT(*)::int AS cnt FROM contact_group_members GROUP BY group_id
       ) m ON m.group_id = g.id
      WHERE regexp_replace(g.user_phone, '[^0-9]', '', 'g') =
            regexp_replace($1, '[^0-9]', '', 'g')
      ORDER BY g.id DESC`,
    [userPhone]
  );
  return r.rows;
}

export async function createGroup(userPhone: string, name: string, emoji?: string | null): Promise<Group> {
  await ensureTables();
  if (process.env.ARI_DEMO_MODE === "true") {
    const existing = await query<Omit<Group, "member_count">>(`SELECT id, name, emoji, created_at, archived_at FROM contact_groups WHERE user_phone = $1 AND lower(name) = lower($2) LIMIT 1`, [userPhone, name]);
    if (existing.rows[0]) return { ...existing.rows[0], member_count: (await getGroup(userPhone, existing.rows[0].id))?.member_count || 0 };
    const created = await query<Omit<Group, "member_count">>(`INSERT INTO contact_groups (user_phone, name, emoji) VALUES ($1, $2, $3) RETURNING id, name, emoji, created_at, archived_at`, [userPhone, name, emoji || null]);
    return { ...created.rows[0], member_count: 0 };
  }
  const r = await query<Group>(
    `INSERT INTO contact_groups (user_phone, name, emoji) VALUES ($1, $2, $3)
     ON CONFLICT (
       ((CASE
           WHEN regexp_replace(user_phone, '[^0-9]', '', 'g') <> ''
             THEN regexp_replace(user_phone, '[^0-9]', '', 'g')
           ELSE lower(btrim(user_phone))
         END)),
       (lower(btrim(name)))
     )
     DO UPDATE SET user_phone = EXCLUDED.user_phone,
                   emoji = COALESCE(EXCLUDED.emoji, contact_groups.emoji),
                   updated_at = NOW()
     RETURNING id, name, emoji, created_at, archived_at, 0::int AS member_count`,
    [userPhone, name, emoji ?? null]
  );
  return r.rows[0];
}

export async function updateGroup(userPhone: string, id: number, patch: { name?: string; emoji?: string | null; archived?: boolean }): Promise<Group | null> {
  await ensureTables();
  const sets: string[] = [];
  const values: unknown[] = [];
  let index = 1;
  if (patch.name !== undefined) { sets.push(`name = $${index++}`); values.push(patch.name.trim()); }
  if (patch.emoji !== undefined) { sets.push(`emoji = $${index++}`); values.push(patch.emoji || null); }
  if (patch.archived !== undefined) sets.push(`archived_at = ${patch.archived ? "NOW()" : "NULL"}`);
  if (!sets.length) return getGroup(userPhone, id);
  sets.push("updated_at = NOW()");
  values.push(id, userPhone);
  const result = await query<Omit<Group, "member_count">>(
    `UPDATE contact_groups SET ${sets.join(", ")}
      WHERE id = $${index++} AND user_phone = $${index++}
      RETURNING id, name, emoji, created_at, archived_at`,
    values,
  );
  return result.rows[0] ? { ...result.rows[0], member_count: (await getGroup(userPhone, id))?.member_count || 0 } : null;
}

export async function deleteGroup(userPhone: string, id: number): Promise<boolean> {
  await ensureTables();
  if (process.env.ARI_DEMO_MODE === "true") {
    await query(`DELETE FROM contact_group_members WHERE group_id = $1`, [id]);
    const demoResult = await query(`DELETE FROM contact_groups WHERE id = $1 AND user_phone = $2 RETURNING id`, [id, userPhone]);
    return (demoResult.rowCount ?? 0) > 0;
  }
  const r = await query(
    `DELETE FROM contact_groups
      WHERE id = $1
        AND regexp_replace(user_phone, '[^0-9]', '', 'g') =
            regexp_replace($2, '[^0-9]', '', 'g')
      RETURNING id`,
    [id, userPhone]
  );
  return r.rowCount! > 0;
}

export async function getGroup(userPhone: string, id: number): Promise<Group | null> {
  await ensureTables();
  if (process.env.ARI_DEMO_MODE === "true") {
    const group = await query<Omit<Group, "member_count">>(
      `SELECT id, name, emoji, created_at, archived_at
         FROM contact_groups
        WHERE id = $1 AND user_phone = $2`,
      [id, userPhone],
    );
    if (!group.rows[0]) return null;
    const count = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM contact_group_members WHERE group_id = $1`,
      [id],
    );
    return { ...group.rows[0], member_count: parseInt(count.rows[0]?.count || "0", 10) };
  }
  const r = await query<Group>(
    `SELECT g.id, g.name, g.emoji, g.created_at, g.archived_at,
            COALESCE((SELECT COUNT(*) FROM contact_group_members WHERE group_id = g.id),0)::int AS member_count
       FROM contact_groups g
      WHERE g.id = $1
        AND regexp_replace(g.user_phone, '[^0-9]', '', 'g') =
            regexp_replace($2, '[^0-9]', '', 'g')`,
    [id, userPhone]
  );
  return r.rows[0] ?? null;
}

export type GroupMember = {
  member_kind: "lead" | "contact";
  member_id: number;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  title: string | null;
  linkedin_url: string | null;
  website: string | null;
  last_contacted_at: string | null;
};

// Resolve members → real names/emails by joining sales_leads + contacts.
// `last_contacted_at` is computed as the maximum of three sources:
//   1. sales_leads.last_contacted_at (sales tool flow + bulk dashboard)
//   2. MAX(sent_email_log.sent_at) — captures every Ari-sent email,
//      including ones we wouldn't otherwise know about (e.g. emails sent
//      via the bot's `send_email` tool from WhatsApp).
//   3. MAX(sales_emails_log.sent_at) — defensive (some flows write here
//      but not to sent_email_log).
// We coalesce so the "Last contacted" column reflects every Ari-driven
// email automatically — no sync click needed. Emails sent OUTSIDE Ari
// (directly from Gmail UI) cannot be detected without gmail.readonly
// scope, which is intentionally not granted in this Phase 1 deployment.
export async function listGroupMembers(userPhone: string, groupId: number): Promise<GroupMember[]> {
  await ensureTables();
  if (process.env.ARI_DEMO_MODE === "true") {
    const demo = await query<GroupMember>(
      `SELECT m.member_kind, m.member_id,
              COALESCE(l.name, c.name) AS name,
              COALESCE(l.email, c.email) AS email,
              c.phone AS phone,
              COALESCE(l.company, c.company) AS company,
              COALESCE(l.title, c.title) AS title,
              COALESCE(l.linkedin_url, c.linkedin_url) AS linkedin_url,
              COALESCE(l.website, c.website) AS website,
              l.last_contacted_at
         FROM contact_group_members m
         LEFT JOIN sales_leads l ON m.member_kind = 'lead' AND l.id = m.member_id AND l.user_phone = $1
         LEFT JOIN contacts c ON m.member_kind = 'contact' AND c.id = m.member_id AND c.user_phone = $1
        WHERE m.group_id = $2
        ORDER BY name`,
      [userPhone, groupId],
    );
    return demo.rows;
  }
  // Try the full schema (with title / linkedin_url / website columns —
  // added lazily by the import route). Fall back to the legacy schema
  // if the ALTERs haven't run on this DB yet, so the page never errors
  // for fresh deploys.
  try {
    const r = await query<GroupMember>(
      `SELECT m.member_kind, m.member_id,
              COALESCE(l.name, c.name) AS name,
              COALESCE(l.email, c.email) AS email,
              c.phone AS phone,
              COALESCE(l.company, c.company) AS company,
              COALESCE(l.title, c.title) AS title,
              COALESCE(l.linkedin_url, c.linkedin_url) AS linkedin_url,
              COALESCE(l.website, c.website) AS website,
              GREATEST(
                l.last_contacted_at,
                (SELECT MAX(sent_at) FROM sent_email_log
                  WHERE user_phone = $1 AND LOWER(recipient_email) = LOWER(COALESCE(l.email, c.email))),
                (SELECT MAX(sent_at) FROM sales_emails_log
                  WHERE user_phone = $1 AND lead_id = l.id)
              ) AS last_contacted_at
         FROM contact_group_members m
         LEFT JOIN sales_leads l
                ON m.member_kind = 'lead' AND l.id = m.member_id AND l.user_phone = $1
         LEFT JOIN contacts c
                ON m.member_kind = 'contact' AND c.id = m.member_id AND c.user_phone = $1
        WHERE m.group_id = $2
          AND (l.id IS NOT NULL OR c.id IS NOT NULL)
        ORDER BY name ASC`,
      [userPhone, groupId]
    );
    return r.rows;
  } catch {
    const r = await query<Omit<GroupMember, "title" | "linkedin_url" | "website">>(
      `SELECT m.member_kind, m.member_id,
              COALESCE(l.name, c.name) AS name,
              l.email AS email,
              c.phone AS phone,
              l.company AS company,
              GREATEST(
                l.last_contacted_at,
                (SELECT MAX(sent_at) FROM sent_email_log
                  WHERE user_phone = $1 AND LOWER(recipient_email) = LOWER(l.email)),
                (SELECT MAX(sent_at) FROM sales_emails_log
                  WHERE user_phone = $1 AND lead_id = l.id)
              ) AS last_contacted_at
         FROM contact_group_members m
         LEFT JOIN sales_leads l
                ON m.member_kind = 'lead' AND l.id = m.member_id AND l.user_phone = $1
         LEFT JOIN contacts c
                ON m.member_kind = 'contact' AND c.id = m.member_id AND c.user_phone = $1
        WHERE m.group_id = $2
          AND (l.id IS NOT NULL OR c.id IS NOT NULL)
        ORDER BY name ASC`,
      [userPhone, groupId]
    );
    return r.rows.map(row => ({ ...row, title: null, linkedin_url: null, website: null }));
  }
}

export async function addMembers(userPhone: string, groupId: number, members: { kind: "lead" | "contact"; id: number }[]): Promise<number> {
  await ensureTables();
  const owns = await getGroup(userPhone, groupId);
  if (!owns) return 0;
  if (members.length === 0) return 0;

  // Bulk-insert in chunks of 500 with multi-row VALUES + ON CONFLICT
  // DO NOTHING. Previous one-row-per-query loop was the dominant cost
  // for large imports — for 1000 members it'd run 1000 queries × ~150ms
  // each = 150s, which busts Cloudflare's 100s timeout. Now: 2 queries.
  const CHUNK = 500;
  let added = 0;
  for (let i = 0; i < members.length; i += CHUNK) {
    const chunk = members.slice(i, i + CHUNK);
    const placeholders: string[] = [];
    const args: unknown[] = [groupId];
    let idx = 2;
    for (const m of chunk) {
      placeholders.push(`($1, $${idx++}, $${idx++})`);
      args.push(m.kind, m.id);
    }
    const r = await query(
      `INSERT INTO contact_group_members (group_id, member_kind, member_id)
       VALUES ${placeholders.join(", ")}
       ON CONFLICT (group_id, member_kind, member_id) DO NOTHING
       RETURNING id`,
      args
    );
    added += r.rowCount ?? 0;
  }
  return added;
}

export async function removeMember(userPhone: string, groupId: number, kind: "lead" | "contact", id: number): Promise<boolean> {
  await ensureTables();
  const owns = await getGroup(userPhone, groupId);
  if (!owns) return false;
  const r = await query(
    `DELETE FROM contact_group_members WHERE group_id = $1 AND member_kind = $2 AND member_id = $3 RETURNING id`,
    [groupId, kind, id]
  );
  return r.rowCount! > 0;
}

// Bulk variant — single round-trip for any number of members. Splits
// the input into lead-ids and contact-ids and runs ONE DELETE that
// matches both via OR + ANY().
export async function removeMembersBulk(
  userPhone: string,
  groupId: number,
  members: { kind: "lead" | "contact"; id: number }[],
): Promise<number> {
  await ensureTables();
  const owns = await getGroup(userPhone, groupId);
  if (!owns) return 0;
  const leadIds = members.filter(m => m.kind === "lead").map(m => m.id);
  const contactIds = members.filter(m => m.kind === "contact").map(m => m.id);
  if (leadIds.length === 0 && contactIds.length === 0) return 0;
  const r = await query(
    `DELETE FROM contact_group_members
      WHERE group_id = $1
        AND (
          (member_kind = 'lead'    AND member_id = ANY($2::int[]))
          OR (member_kind = 'contact' AND member_id = ANY($3::int[]))
        )
      RETURNING id`,
    [groupId, leadIds, contactIds]
  );
  return r.rowCount ?? 0;
}

// ─── Campaigns ──────────────────────────────────────────────────────────
export type Campaign = {
  id: number;
  group_id: number | null;
  subject: string;
  recipient_count: number;
  sent_count: number;
  failed_count: number;
  status: string;
  scheduled_for: string | null;
  created_at: string;
  completed_at: string | null;
  daily_send_limit: number;
  archived_at: string | null;
  // Tracking metrics — counts come from email_sends rows joined by
  // campaign_id. Older campaigns (before tracking landed) report 0.
  opened_count: number;
  clicked_count: number;
  last_opened_at: string | null;
  last_clicked_at: string | null;
};

export async function listCampaigns(userPhone: string): Promise<Campaign[]> {
  await ensureTables();

  if (process.env.ARI_DEMO_MODE === "true") {
    const campaigns = await query<Omit<Campaign, "opened_count" | "clicked_count" | "last_opened_at" | "last_clicked_at">>(
      `SELECT id, group_id, subject, recipient_count, sent_count, failed_count, status, scheduled_for, created_at, completed_at, daily_send_limit, archived_at
         FROM bulk_email_campaigns WHERE user_phone = $1 ORDER BY id DESC LIMIT 100`,
      [userPhone],
    );
    const events = await query<{ campaign_id: number; opened_at: string | null; clicked_at: string | null }>(
      `SELECT campaign_id, opened_at, clicked_at FROM email_sends WHERE user_phone = $1`,
      [userPhone],
    );
    return campaigns.rows.map(campaign => {
      const rows = events.rows.filter(event => Number(event.campaign_id) === Number(campaign.id));
      const opened = rows.filter(event => Boolean(event.opened_at));
      const clicked = rows.filter(event => Boolean(event.clicked_at));
      return {
        ...campaign,
        opened_count: opened.length,
        clicked_count: clicked.length,
        last_opened_at: opened[0]?.opened_at ?? null,
        last_clicked_at: clicked[0]?.clicked_at ?? null,
      };
    });
  }

  // Self-heal: the bot sends campaigns in a detached background loop and
  // finalizes the row itself. If the bot restarted mid-send, a row can dangle
  // in 'sending' forever. On read, reconcile any 'sending' campaign older than
  // 20 min from its email_sends rows (or cancel it if nothing was recorded).
  // Best-effort + 20-min grace so a legitimately in-flight send isn't touched.
  try {
    await query(
      `UPDATE bulk_email_campaigns c SET
          sent_count = es.sent, failed_count = es.failed,
          status = CASE WHEN es.sent = 0 THEN 'failed'
                        WHEN es.failed = 0 THEN 'completed'
                        ELSE 'partial' END,
          completed_at = COALESCE(c.completed_at, NOW())
        FROM (
          SELECT campaign_id,
                 count(*) FILTER (WHERE send_status = 'sent')  AS sent,
                 count(*) FILTER (WHERE send_status <> 'sent') AS failed
            FROM email_sends WHERE user_phone = $1 GROUP BY campaign_id
        ) es
       WHERE c.id = es.campaign_id AND c.user_phone = $1
         AND c.status = 'sending' AND c.scheduled_for IS NULL
         AND c.created_at < NOW() - INTERVAL '20 minutes'`,
      [userPhone]
    );
    await query(
      `UPDATE bulk_email_campaigns c SET status = 'cancelled', completed_at = NOW()
        WHERE c.user_phone = $1 AND c.status = 'sending' AND c.scheduled_for IS NULL
          AND c.created_at < NOW() - INTERVAL '20 minutes'
          AND NOT EXISTS (SELECT 1 FROM email_sends es WHERE es.campaign_id = c.id)`,
      [userPhone]
    );
  } catch {
    // email_sends may not exist yet on a fresh DB — skip self-heal.
  }

  // Use a left-join + GROUP BY so campaigns without tracking rows still
  // come back (with zero opens/clicks). Wrapped in try/catch fallback so
  // the page works even if email_sends doesn't exist on this DB yet.
  try {
    const r = await query<Campaign>(
      `SELECT
         c.id, c.group_id, c.subject, c.recipient_count, c.sent_count,
         c.failed_count, c.status, c.scheduled_for, c.created_at,
         c.completed_at, c.daily_send_limit, c.archived_at,
         COALESCE(SUM(CASE WHEN es.opened_at  IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS opened_count,
         COALESCE(SUM(CASE WHEN es.clicked_at IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS clicked_count,
         MAX(es.last_opened_at)::text  AS last_opened_at,
         MAX(es.last_clicked_at)::text AS last_clicked_at
         FROM bulk_email_campaigns c
         LEFT JOIN email_sends es ON es.campaign_id = c.id
        WHERE c.user_phone = $1
        GROUP BY c.id
        ORDER BY c.id DESC
        LIMIT 100`,
      [userPhone]
    );
    return r.rows;
  } catch {
    const r = await query<Omit<Campaign, "opened_count" | "clicked_count" | "last_opened_at" | "last_clicked_at">>(
      `SELECT id, group_id, subject, recipient_count, sent_count, failed_count, status, scheduled_for, created_at, completed_at, daily_send_limit, archived_at
         FROM bulk_email_campaigns
        WHERE user_phone = $1
        ORDER BY id DESC
        LIMIT 100`,
      [userPhone]
    );
    return r.rows.map(row => ({ ...row, opened_count: 0, clicked_count: 0, last_opened_at: null, last_clicked_at: null }));
  }
}

export async function recordCampaign(opts: {
  userPhone: string;
  groupId: number | null;
  subject: string;
  bodyTemplate: string;
  recipientCount: number;
  scheduledFor?: Date | null;
  dailySendLimit?: number;
}): Promise<number> {
  await ensureTables();
  const r = await query<{ id: number }>(
    `INSERT INTO bulk_email_campaigns
       (user_phone, group_id, subject, body_template, recipient_count, status, scheduled_for, daily_send_limit)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [opts.userPhone, opts.groupId, opts.subject, opts.bodyTemplate, opts.recipientCount,
     opts.scheduledFor ? "scheduled" : "sending", opts.scheduledFor ? opts.scheduledFor.toISOString() : null,
     Math.max(1, Math.min(2000, Number(opts.dailySendLimit || opts.recipientCount || 100)))]
  );
  return r.rows[0].id;
}

export async function updateCampaign(userPhone: string, id: number, patch: { archived?: boolean; status?: "paused" | "sending" }): Promise<boolean> {
  await ensureTables();
  const sets: string[] = [];
  if (patch.archived !== undefined) sets.push(`archived_at = ${patch.archived ? "NOW()" : "NULL"}`);
  if (patch.status) sets.push(`status = '${patch.status}'`);
  if (!sets.length) return false;
  const result = await query(`UPDATE bulk_email_campaigns SET ${sets.join(", ")} WHERE id = $1 AND user_phone = $2 RETURNING id`, [id, userPhone]);
  return (result.rowCount ?? 0) > 0;
}

export async function deleteCampaign(userPhone: string, id: number): Promise<boolean> {
  await ensureTables();
  const owned = await query<{ status: string }>(`SELECT status FROM bulk_email_campaigns WHERE id = $1 AND user_phone = $2`, [id, userPhone]);
  if (!owned.rows[0] || owned.rows[0].status === "sending") return false;
  await query(`DELETE FROM email_sends WHERE campaign_id = $1 AND user_phone = $2`, [id, userPhone]).catch(() => undefined);
  const result = await query(`DELETE FROM bulk_email_campaigns WHERE id = $1 AND user_phone = $2 RETURNING id`, [id, userPhone]);
  return (result.rowCount ?? 0) > 0;
}

export async function finalizeCampaign(id: number, sent: number, failed: number, status: "completed" | "partial" | "cancelled" = "completed"): Promise<void> {
  await ensureTables();
  await query(
    `UPDATE bulk_email_campaigns
        SET sent_count = $1, failed_count = $2, status = $3, completed_at = NOW()
      WHERE id = $4`,
    [sent, failed, status, id]
  );
}
