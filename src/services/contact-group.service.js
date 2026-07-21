/**
 * Contact groups — bot-side access to the SAME tables the dashboard's
 * Contacts → Groups section uses (dashboard/lib/groups.ts):
 *
 *   contact_groups(id, user_phone, name, emoji, created_at, updated_at)
 *   contact_group_members(group_id, member_kind 'lead'|'contact', member_id)
 *
 * The DDL below is copied from the dashboard so whichever side runs first
 * creates an identical schema.
 *
 * Phone-format note: the bot normalizes user ids to bare digits
 * ("9190…"), while the desktop dashboard session uses a plus-prefixed
 * phone ("+9190…"). Reads therefore match BOTH variants, and writes use
 * the dashboard's canonical phone when we can derive it (so a group
 * created from chat shows up in the dashboard immediately).
 */

'use strict';

const database = require('../config/database');

function phoneCandidates(userPhone) {
  const raw = String(userPhone || '').trim();
  const digits = raw.replace(/\D/g, '');
  const set = new Set([raw]);
  if (digits) {
    set.add(digits);
    set.add(`+${digits}`);
  }
  return [...set].filter(Boolean);
}

// The phone format the dashboard queries with. In desktop mode that's
// ARI_DESKTOP_USER_PHONE ("+9190…"); in production the dashboard session
// phone IS the bot's format, so the raw phone is already correct.
function canonicalWritePhone(userPhone) {
  // Canonical identity is digits-only everywhere (webhook, dashboard bridge,
  // desktop session). Writing any other format makes rows invisible to
  // exact-equality reads on other surfaces.
  const digits = String(userPhone || '').replace(/\D/g, '');
  return digits || String(userPhone || '').trim();
}

function createContactGroupService(options = {}) {
  const queryFn = options.queryFn || database.query;
  let schemaPromise = null;

  function ensureSchema() {
    if (schemaPromise) return schemaPromise;
    schemaPromise = (async () => {
      await queryFn(`
        CREATE TABLE IF NOT EXISTS contact_groups (
          id SERIAL PRIMARY KEY,
          user_phone VARCHAR(20) NOT NULL,
          name VARCHAR(120) NOT NULL,
          emoji VARCHAR(8),
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await queryFn(`CREATE INDEX IF NOT EXISTS idx_contact_groups_user ON contact_groups(user_phone)`);
      await queryFn(`
        CREATE TABLE IF NOT EXISTS contact_group_members (
          id SERIAL PRIMARY KEY,
          group_id INT NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
          member_kind VARCHAR(10) NOT NULL,
          member_id INT NOT NULL,
          added_at TIMESTAMP DEFAULT NOW(),
          UNIQUE (group_id, member_kind, member_id)
        )
      `);
      await queryFn(`CREATE INDEX IF NOT EXISTS idx_cgm_group ON contact_group_members(group_id)`);
    })();
    return schemaPromise;
  }

  async function findGroupByName(userPhone, name) {
    await ensureSchema();
    const r = await queryFn(
      `SELECT id, name, emoji FROM contact_groups
        WHERE user_phone = ANY($1) AND LOWER(name) = LOWER($2)
        ORDER BY id DESC LIMIT 1`,
      [phoneCandidates(userPhone), String(name || '').trim()]
    );
    return r.rows[0] || null;
  }

  async function createGroup(userPhone, name, emoji = null) {
    const trimmed = String(name || '').trim().slice(0, 120);
    if (!trimmed) return { error: 'Group name required' };
    await ensureSchema();
    const existing = await findGroupByName(userPhone, trimmed);
    if (existing) return { group: existing, existed: true };
    const r = await queryFn(
      `INSERT INTO contact_groups (user_phone, name, emoji)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING id, name, emoji`,
      [canonicalWritePhone(userPhone), trimmed, emoji || null]
    );
    if (r.rows[0]) return { group: r.rows[0], existed: false };
    const winner = await findGroupByName(userPhone, trimmed);
    if (winner) return { group: winner, existed: true };
    return { error: 'Group creation could not be verified' };
  }

  async function listGroups(userPhone) {
    await ensureSchema();
    const r = await queryFn(
      `SELECT g.id, g.name, g.emoji,
              COALESCE((SELECT COUNT(*) FROM contact_group_members WHERE group_id = g.id), 0)::int AS member_count
         FROM contact_groups g
        WHERE g.user_phone = ANY($1)
        ORDER BY g.id DESC
        LIMIT 50`,
      [phoneCandidates(userPhone)]
    );
    return r.rows;
  }

  // Manual name assignment is intentionally exact. Substring matching (for
  // example "AJ" -> "Raju") can silently put the wrong person in a group.
  // Multiple exact matches are surfaced as ambiguous and never mutated.
  async function resolveMemberByName(userPhone, name) {
    const candidates = phoneCandidates(userPhone);
    const exactName = String(name || '').trim();
    if (!exactName) return null;
    const lead = await queryFn(
      `SELECT id, name FROM sales_leads
        WHERE user_phone = ANY($1) AND LOWER(BTRIM(name)) = LOWER(BTRIM($2))
        ORDER BY id DESC LIMIT 2`,
      [candidates, exactName]
    ).catch(() => ({ rows: [] }));
    const contact = await queryFn(
      `SELECT id, name FROM contacts
        WHERE user_phone = ANY($1) AND LOWER(BTRIM(name)) = LOWER(BTRIM($2))
        ORDER BY id DESC LIMIT 2`,
      [candidates, exactName]
    ).catch(() => ({ rows: [] }));
    const matches = [
      ...lead.rows.map((row) => ({ kind: 'lead', id: row.id, name: row.name })),
      ...contact.rows.map((row) => ({ kind: 'contact', id: row.id, name: row.name })),
    ];
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return { ambiguous: true, name: exactName, matchCount: matches.length };
    return null;
  }

  async function addMembersByNames(userPhone, groupName, memberNames = []) {
    await ensureSchema();
    const group = await findGroupByName(userPhone, groupName);
    if (!group) return { error: `No group named "${groupName}" found` };

    const names = [];
    const seen = new Set();
    for (const value of memberNames) {
      const name = String(value || '').trim();
      const key = name.toLocaleLowerCase();
      if (name && !seen.has(key)) {
        names.push(name);
        seen.add(key);
      }
    }
    const added = [];
    const existing = [];
    const notFound = [];
    const ambiguous = [];
    const rejected = names.slice(100);
    for (const rawName of names.slice(0, 100)) {
      const member = await resolveMemberByName(userPhone, rawName);
      if (!member) { notFound.push(rawName); continue; }
      if (member.ambiguous) { ambiguous.push(rawName); continue; }
      const inserted = await queryFn(
        `INSERT INTO contact_group_members (group_id, member_kind, member_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (group_id, member_kind, member_id) DO NOTHING
         RETURNING id`,
        [group.id, member.kind, member.id]
      );
      if (inserted.rows[0]) added.push(member.name);
      else existing.push(member.name);
    }
    return { group, added, existing, notFound, ambiguous, rejected };
  }

  // Deleting a group never deletes the people in it: contact_group_members
  // rows cascade, the underlying contacts/leads stay untouched.
  // Dashboard PATCH /api/groups/[id] parity: rename, emoji, archive/restore.
  // archived_at may not exist on installs older than the dashboard CRM
  // columns — add it idempotently before touching it.
  let archivedColumnPromise = null;
  function ensureArchivedColumn() {
    if (archivedColumnPromise) return archivedColumnPromise;
    archivedColumnPromise = queryFn(
      'ALTER TABLE contact_groups ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ',
    ).catch((error) => {
      archivedColumnPromise = null;
      throw error;
    });
    return archivedColumnPromise;
  }

  async function updateGroup(userPhone, name, { newName, emoji, archived } = {}) {
    await ensureSchema();
    const existing = await findGroupByName(userPhone, name);
    if (!existing) return { error: `No group named "${String(name || '').trim()}" found` };
    const sets = [];
    const values = [];
    let index = 1;
    if (newName !== undefined && String(newName).trim()) {
      const trimmed = String(newName).trim().slice(0, 120);
      const clash = await findGroupByName(userPhone, trimmed);
      if (clash && clash.id !== existing.id) {
        return { error: `A group named "${trimmed}" already exists` };
      }
      sets.push(`name = $${index++}`);
      values.push(trimmed);
    }
    if (emoji !== undefined) {
      sets.push(`emoji = $${index++}`);
      values.push(emoji || null);
    }
    if (archived !== undefined) {
      await ensureArchivedColumn();
      sets.push(archived ? 'archived_at = NOW()' : 'archived_at = NULL');
    }
    if (sets.length === 0) return { error: 'Nothing to update' };
    values.push(existing.id);
    const r = await queryFn(
      `UPDATE contact_groups SET ${sets.join(', ')} WHERE id = $${index} RETURNING id, name, emoji`,
      values,
    );
    if (!r.rows[0]) return { error: 'Group update could not be verified' };
    return { group: r.rows[0], previousName: existing.name };
  }

  /**
   * Remove named members from a group. Resolution is exact (same rule as
   * addMembersByNames) — a substring match could silently drop the wrong
   * person from a campaign audience.
   */
  async function removeMembersByNames(userPhone, groupName, memberNames = []) {
    await ensureSchema();
    const group = await findGroupByName(userPhone, groupName);
    if (!group) return { error: `No group named "${String(groupName || '').trim()}" found` };
    const removed = [];
    const notFound = [];
    const ambiguous = [];
    for (const rawName of memberNames) {
      const resolved = await resolveMemberByName(userPhone, rawName);
      if (!resolved) { notFound.push(rawName); continue; }
      if (resolved.ambiguous) { ambiguous.push(rawName); continue; }
      const result = await queryFn(
        `DELETE FROM contact_group_members
          WHERE group_id = $1 AND member_kind = $2 AND member_id = $3
          RETURNING id`,
        [group.id, resolved.kind, resolved.id],
      );
      if (result.rows.length > 0) removed.push(resolved.name || rawName);
      else notFound.push(rawName);
    }
    return { group, removed, notFound, ambiguous };
  }

  async function deleteGroup(userPhone, name) {
    await ensureSchema();
    const group = await findGroupByName(userPhone, name);
    if (!group) return { error: `No group named "${name}" found` };
    const r = await queryFn(
      `DELETE FROM contact_groups
        WHERE id = $1 AND user_phone = ANY($2)
        RETURNING id, name`,
      [group.id, phoneCandidates(userPhone)]
    );
    if (!r.rows[0]) return { error: 'Group deletion could not be verified' };
    return { deleted: r.rows[0] };
  }

  async function deleteAllGroups(userPhone) {
    await ensureSchema();
    const r = await queryFn(
      `DELETE FROM contact_groups
        WHERE user_phone = ANY($1)
        RETURNING id, name`,
      [phoneCandidates(userPhone)]
    );
    return { deletedCount: r.rowCount || 0, deleted: r.rows.map((row) => row.name) };
  }

  return { createGroup, findGroupByName, listGroups, addMembersByNames, removeMembersByNames, resolveMemberByName, updateGroup, deleteGroup, deleteAllGroups };
}

module.exports = {
  createContactGroupService,
  contactGroupService: createContactGroupService(),
  phoneCandidates,
  canonicalWritePhone,
};
