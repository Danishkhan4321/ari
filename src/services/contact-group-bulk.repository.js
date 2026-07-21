/**
 * PostgreSQL persistence adapter for deterministic CRM workbook imports.
 *
 * A group is the transaction boundary. The group row, exact-identity CRM
 * people, synchronized memberships, and completed item checkpoint commit
 * together. If the connection drops around COMMIT, retrying the same item key
 * either observes the completed checkpoint or safely repeats a rolled-back
 * transaction.
 */

'use strict';

const database = require('../config/database');

const DEFAULT_INSERT_CHUNK_SIZE = 200;
const MAX_INSERT_CHUNK_SIZE = 1000;
const MAX_LEAD_TITLE_LENGTH = 200;
const KEY_PATTERN = /^[a-f0-9]{64}$/i;

function repositoryError(message, code, details = null) {
  const error = new Error(message);
  error.name = 'ContactGroupBulkRepositoryError';
  error.code = code;
  if (details) error.details = details;
  return error;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizedOwnerIdentity(value) {
  const raw = String(value || '').trim();
  const digits = raw.replace(/\D/g, '');
  return digits || raw.toLocaleLowerCase('en-US');
}

function ownerPhoneCandidates(value) {
  const raw = String(value || '').trim();
  const digits = raw.replace(/\D/g, '');
  const values = new Set();
  if (raw) values.add(raw);
  if (digits) {
    values.add(digits);
    values.add(`+${digits}`);
  }
  const desktopPhone = String(process.env.ARI_DESKTOP_USER_PHONE || '').trim();
  if (desktopPhone && digits && desktopPhone.replace(/\D/g, '') === digits) {
    values.add(desktopPhone);
  }
  return [...values];
}

function canonicalOwnerPhone(value) {
  const raw = String(value || '').trim();
  const digits = raw.replace(/\D/g, '');
  const desktopPhone = String(process.env.ARI_DESKTOP_USER_PHONE || '').trim();
  if (desktopPhone && digits && desktopPhone.replace(/\D/g, '') === digits) {
    return desktopPhone;
  }
  return raw;
}

function normalizedPersonName(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('en-US');
}

function displayPersonName(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizedEmail(value) {
  return String(value || '').trim().toLocaleLowerCase('en-US');
}

function normalizedPhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function cleanTitle(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function cleanGroupName(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function assertKey(value, field) {
  const key = String(value || '').trim();
  if (!KEY_PATTERN.test(key)) {
    throw repositoryError(`${field} must be a 64 character hexadecimal key`, 'invalid_bulk_key', { field });
  }
  return key.toLocaleLowerCase('en-US');
}

function normalizeRecord(record, index) {
  const name = displayPersonName(record?.name);
  const email = normalizedEmail(record?.email);
  const phone = normalizedPhone(record?.phone);
  const title = cleanTitle(record?.title);
  if (!name) {
    throw repositoryError('A CRM record has no name', 'invalid_contact_record', { index, field: 'name' });
  }
  if (name.length > 150) {
    throw repositoryError('A CRM record name exceeds 150 characters', 'invalid_contact_record', {
      index,
      field: 'name',
      sourceRow: record?.sourceRow || null,
    });
  }
  if (!email && !phone) {
    throw repositoryError('A CRM record has neither email nor phone', 'invalid_contact_record', {
      index,
      field: 'identifier',
      sourceRow: record?.sourceRow || null,
    });
  }
  if (email.length > 200) {
    throw repositoryError('A CRM record email exceeds 200 characters', 'invalid_contact_record', {
      index,
      field: 'email',
      sourceRow: record?.sourceRow || null,
    });
  }
  if (phone.length > 20) {
    throw repositoryError('A CRM record phone exceeds 20 digits', 'invalid_contact_record', {
      index,
      field: 'phone',
      sourceRow: record?.sourceRow || null,
    });
  }
  return {
    name,
    normalizedName: normalizedPersonName(name),
    email,
    phone,
    title,
    leadTitle: title.slice(0, MAX_LEAD_TITLE_LENGTH),
    roleNotes: title.length > MAX_LEAD_TITLE_LENGTH
      ? `Imported role / field:\n${title}`
      : '',
    sourceRow: record?.sourceRow || null,
  };
}

function normalizeSyncInput(input = {}) {
  const operationKey = assertKey(input.operationKey, 'operationKey');
  const itemKey = assertKey(input.itemKey || input.idempotencyKey, 'itemKey');
  const userPhone = String(input.userPhone || '').trim();
  const userIdentity = normalizedOwnerIdentity(input.userIdentity || userPhone);
  const groupName = cleanGroupName(input.group?.name);
  if (!userPhone || !userIdentity) {
    throw repositoryError('A user phone is required for CRM workbook sync', 'missing_user_identity');
  }
  if (!groupName || groupName.length > 120) {
    throw repositoryError('A CRM group name between 1 and 120 characters is required', 'invalid_group_name');
  }
  if (!Array.isArray(input.group?.records)) {
    throw repositoryError('CRM group records must be an array', 'invalid_group_records');
  }
  const records = input.group.records.map(normalizeRecord);
  return {
    operationKey,
    itemKey,
    userPhone,
    userIdentity,
    ownerCandidates: ownerPhoneCandidates(userPhone),
    writePhone: canonicalOwnerPhone(userPhone),
    sourceHash: String(input.sourceHash || '').trim(),
    sourceName: String(input.sourceName || 'contacts.xlsx'),
    totalGroups: nonNegativeInteger(input.totalGroups),
    totalRecords: nonNegativeInteger(input.totalRecords, records.length),
    attempt: positiveInteger(input.attempt, 1),
    groupName,
    records,
  };
}

function chunks(values, size) {
  const output = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

function jsonValue(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function parsedJson(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function identityKey(type, identifier, name) {
  return `${type}:${identifier}\0name:${normalizedPersonName(name)}`;
}

function candidateIndexes(leadRows = [], contactRows = []) {
  const email = new Map();
  const phone = new Map();
  const add = (map, type, value, row, kind) => {
    const identifier = type === 'email' ? normalizedEmail(value) : normalizedPhone(value);
    if (!identifier) return;
    const key = identityKey(type, identifier, row.name);
    if (!map.has(key)) {
      map.set(key, { kind, id: Number(row.id) });
    }
  };

  // Email-bearing CRM entries conventionally live in sales_leads.
  for (const row of leadRows) add(email, 'email', row.email, row, 'lead');
  for (const row of contactRows) add(email, 'email', row.email, row, 'contact');
  // Phone-only address-book entries conventionally live in contacts.
  for (const row of contactRows) add(phone, 'phone', row.phone, row, 'contact');
  for (const row of leadRows) add(phone, 'phone', row.phone, row, 'lead');
  return { email, phone };
}

function mergeCandidateIndexes(target, source) {
  for (const [key, value] of source.email) if (!target.email.has(key)) target.email.set(key, value);
  for (const [key, value] of source.phone) if (!target.phone.has(key)) target.phone.set(key, value);
  return target;
}

function resolveRecord(record, indexes) {
  if (record.email) {
    const byEmail = indexes.email.get(identityKey('email', record.email, record.normalizedName));
    if (byEmail) return byEmail;
  }
  if (record.phone) {
    const byPhone = indexes.phone.get(identityKey('phone', record.phone, record.normalizedName));
    if (byPhone) return byPhone;
  }
  return null;
}

async function fetchExactCandidates(queryable, ownerCandidates, records) {
  const emails = [...new Set(records.map((record) => record.email).filter(Boolean))];
  const phones = [...new Set(records.map((record) => record.phone).filter(Boolean))];
  const leadResult = await queryable.query(
    `/* crm-bulk:match-leads */
     SELECT id,
            name,
            LOWER(BTRIM(email)) AS email,
            regexp_replace(phone, '[^0-9]', '', 'g') AS phone
       FROM sales_leads
      WHERE user_phone = ANY($1::text[])
        AND (
          LOWER(BTRIM(email)) = ANY($2::text[])
          OR regexp_replace(phone, '[^0-9]', '', 'g') = ANY($3::text[])
        )
      ORDER BY id ASC`,
    [ownerCandidates, emails, phones]
  );
  const contactResult = await queryable.query(
    `/* crm-bulk:match-contacts */
     SELECT id,
            name,
            LOWER(BTRIM(email)) AS email,
            regexp_replace(phone, '[^0-9]', '', 'g') AS phone
       FROM contacts
      WHERE user_phone = ANY($1::text[])
        AND (
          LOWER(BTRIM(email)) = ANY($2::text[])
          OR regexp_replace(phone, '[^0-9]', '', 'g') = ANY($3::text[])
        )
      ORDER BY id ASC`,
    [ownerCandidates, emails, phones]
  );
  return candidateIndexes(leadResult.rows, contactResult.rows);
}

async function insertLeadChunk(queryable, input, records) {
  if (records.length === 0) return [];
  const result = await queryable.query(
    `/* crm-bulk:insert-leads */
     WITH input(name, normalized_name, email, phone, title, notes) AS (
       SELECT *
         FROM UNNEST(
           $3::text[],
           $4::text[],
           $5::text[],
           $6::text[],
           $7::text[],
           $8::text[]
         )
     )
     INSERT INTO sales_leads
       (user_phone, name, email, phone, title, notes, source, created_at, updated_at)
     SELECT $2,
            input.name,
            NULLIF(input.email, ''),
            NULLIF(input.phone, ''),
            NULLIF(input.title, ''),
            NULLIF(input.notes, ''),
            'workbook_import',
            NOW(),
            NOW()
       FROM input
      WHERE NOT EXISTS (
        SELECT 1
          FROM sales_leads existing
         WHERE existing.user_phone = ANY($1::text[])
           AND LOWER(regexp_replace(BTRIM(existing.name), '\\s+', ' ', 'g')) = input.normalized_name
           AND (
             (input.email <> '' AND LOWER(BTRIM(existing.email)) = input.email)
             OR (input.phone <> '' AND regexp_replace(existing.phone, '[^0-9]', '', 'g') = input.phone)
           )
      )
        AND NOT EXISTS (
        SELECT 1
          FROM contacts existing
         WHERE existing.user_phone = ANY($1::text[])
           AND LOWER(regexp_replace(BTRIM(existing.name), '\\s+', ' ', 'g')) = input.normalized_name
           AND (
             (input.email <> '' AND LOWER(BTRIM(existing.email)) = input.email)
             OR (input.phone <> '' AND regexp_replace(existing.phone, '[^0-9]', '', 'g') = input.phone)
           )
      )
     RETURNING id,
               name,
               LOWER(BTRIM(email)) AS email,
               regexp_replace(phone, '[^0-9]', '', 'g') AS phone`,
    [
      input.ownerCandidates,
      input.writePhone,
      records.map((record) => record.name),
      records.map((record) => record.normalizedName),
      records.map((record) => record.email),
      records.map((record) => record.phone),
      records.map((record) => record.leadTitle),
      records.map((record) => record.roleNotes),
    ]
  );
  return result.rows;
}

async function updateMatchedPeople(queryable, input, records, members, createdKeys) {
  const byKind = { lead: [], contact: [] };
  for (let index = 0; index < records.length; index += 1) {
    const member = members[index];
    const key = `${member.kind}:${member.id}`;
    if (!createdKeys.has(key)) byKind[member.kind].push({ id: member.id, record: records[index] });
  }

  if (byKind.lead.length > 0) {
    await queryable.query(
      `/* crm-bulk:update-leads */
       UPDATE sales_leads target
          SET user_phone = $2,
              email = COALESCE(NULLIF(BTRIM(target.email), ''), NULLIF(input.email, '')),
              phone = COALESCE(NULLIF(BTRIM(target.phone), ''), NULLIF(input.phone, '')),
              title = COALESCE(NULLIF(BTRIM(target.title), ''), NULLIF(input.title, '')),
              notes = CASE
                WHEN input.notes = '' THEN target.notes
                WHEN target.notes IS NULL OR BTRIM(target.notes) = '' THEN input.notes
                WHEN POSITION(input.notes IN target.notes) > 0 THEN target.notes
                ELSE target.notes || E'\\n\\n' || input.notes
              END,
              updated_at = NOW()
         FROM UNNEST($3::integer[], $4::text[], $5::text[], $6::text[], $7::text[])
           AS input(id, email, phone, title, notes)
        WHERE target.id = input.id
          AND target.user_phone = ANY($1::text[])`,
      [
        input.ownerCandidates,
        input.writePhone,
        byKind.lead.map((entry) => entry.id),
        byKind.lead.map((entry) => entry.record.email),
        byKind.lead.map((entry) => entry.record.phone),
        byKind.lead.map((entry) => entry.record.leadTitle),
        byKind.lead.map((entry) => entry.record.roleNotes),
      ]
    );
  }

  if (byKind.contact.length > 0) {
    await queryable.query(
      `/* crm-bulk:update-contacts */
       UPDATE contacts target
          SET user_phone = $2,
              email = COALESCE(NULLIF(BTRIM(target.email), ''), NULLIF(input.email, '')),
              phone = COALESCE(NULLIF(BTRIM(target.phone), ''), NULLIF(input.phone, '')),
              title = COALESCE(NULLIF(BTRIM(target.title), ''), NULLIF(input.title, '')),
              updated_at = NOW()
         FROM UNNEST($3::integer[], $4::text[], $5::text[], $6::text[])
           AS input(id, email, phone, title)
        WHERE target.id = input.id
          AND target.user_phone = ANY($1::text[])`,
      [
        input.ownerCandidates,
        input.writePhone,
        byKind.contact.map((entry) => entry.id),
        byKind.contact.map((entry) => entry.record.email),
        byKind.contact.map((entry) => entry.record.phone),
        byKind.contact.map((entry) => entry.record.title),
      ]
    );
  }
}

async function ensureOperation(queryable, input) {
  await queryable.query(
    `/* crm-bulk:ensure-operation */
     INSERT INTO ari_crm_bulk_jobs
       (operation_key, user_phone, source_hash, source_name, status,
        total_groups, total_records, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'running', $5, $6, NOW(), NOW())
     ON CONFLICT (operation_key) DO UPDATE
       SET user_phone = EXCLUDED.user_phone,
           source_hash = EXCLUDED.source_hash,
           source_name = EXCLUDED.source_name,
           total_groups = GREATEST(ari_crm_bulk_jobs.total_groups, EXCLUDED.total_groups),
           total_records = GREATEST(ari_crm_bulk_jobs.total_records, EXCLUDED.total_records),
           status = CASE
             WHEN ari_crm_bulk_jobs.status = 'success' THEN ari_crm_bulk_jobs.status
             ELSE 'running'
           END,
           updated_at = NOW()`,
    [
      input.operationKey,
      input.writePhone,
      input.sourceHash || 'unknown',
      input.sourceName,
      input.totalGroups,
      input.totalRecords,
    ]
  );
}

async function ensureItem(queryable, input) {
  await queryable.query(
    `/* crm-bulk:ensure-item */
     INSERT INTO ari_crm_bulk_job_items
       (operation_key, item_key, group_name, status, records_total,
        attempt_count, created_at, started_at, updated_at)
     VALUES ($1, $2, $3, 'running', $4, $5, NOW(), NOW(), NOW())
     ON CONFLICT (operation_key, item_key) DO UPDATE
       SET group_name = EXCLUDED.group_name,
           records_total = GREATEST(ari_crm_bulk_job_items.records_total, EXCLUDED.records_total),
           attempt_count = GREATEST(ari_crm_bulk_job_items.attempt_count, EXCLUDED.attempt_count),
           status = CASE
             WHEN ari_crm_bulk_job_items.status = 'completed' THEN 'completed'
             ELSE 'running'
           END,
           started_at = COALESCE(ari_crm_bulk_job_items.started_at, NOW()),
           updated_at = NOW()`,
    [input.operationKey, input.itemKey, input.groupName, input.records.length, input.attempt]
  );
}

async function completedItem(queryable, operationKey, itemKey) {
  const result = await queryable.query(
    `/* crm-bulk:completed-item */
     SELECT status, result
       FROM ari_crm_bulk_job_items
      WHERE operation_key = $1
        AND item_key = $2
        AND status = 'completed'
      FOR UPDATE`,
    [operationKey, itemKey]
  );
  return result.rows[0] || null;
}

function resultCount(result, camelName, snakeName) {
  return nonNegativeInteger(result?.[camelName] ?? result?.[snakeName], 0);
}

function createContactGroupBulkRepository(options = {}) {
  const pool = options.pool || database.pool;
  const requestedChunkSize = positiveInteger(options.insertChunkSize, DEFAULT_INSERT_CHUNK_SIZE);
  const insertChunkSize = Math.min(requestedChunkSize, MAX_INSERT_CHUNK_SIZE);
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new TypeError('createContactGroupBulkRepository requires a PostgreSQL pool');
  }

  async function syncGroup(rawInput) {
    const input = normalizeSyncInput(rawInput);
    const client = await pool.connect();
    let transactionStarted = false;
    try {
      await client.query('BEGIN');
      transactionStarted = true;
      await client.query(
        `/* crm-bulk:owner-lock */
         SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [input.userIdentity]
      );
      await ensureOperation(client, input);
      await ensureItem(client, input);

      const prior = await completedItem(client, input.operationKey, input.itemKey);
      if (prior) {
        const stored = parsedJson(prior.result) || {
          groupName: input.groupName,
          contactsCreated: 0,
          contactsMatched: input.records.length,
          membersAdded: 0,
          membersRemoved: 0,
          recordsSkipped: 0,
        };
        await client.query('COMMIT');
        transactionStarted = false;
        return { ...stored, replayed: true };
      }

      const groupResult = await client.query(
        `/* crm-bulk:group-upsert */
         INSERT INTO contact_groups (user_phone, name, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (
           (
             CASE
               WHEN regexp_replace(user_phone, '[^0-9]', '', 'g') <> ''
                 THEN regexp_replace(user_phone, '[^0-9]', '', 'g')
               ELSE LOWER(BTRIM(user_phone))
             END
           ),
           (LOWER(BTRIM(name)))
         )
         DO UPDATE SET user_phone = EXCLUDED.user_phone,
                       updated_at = NOW()
         RETURNING id, (xmax = 0) AS created`,
        [input.writePhone, input.groupName]
      );
      const group = groupResult.rows[0];
      if (!group?.id) {
        throw repositoryError('CRM group upsert returned no group', 'group_upsert_failed', {
          groupName: input.groupName,
        });
      }

      const indexes = await fetchExactCandidates(client, input.ownerCandidates, input.records);
      const beforeInsert = input.records.map((record) => resolveRecord(record, indexes));
      const unmatched = input.records.filter((_record, index) => !beforeInsert[index]);
      const insertedRows = [];
      for (const chunk of chunks(unmatched, insertChunkSize)) {
        insertedRows.push(...await insertLeadChunk(client, input, chunk));
      }
      mergeCandidateIndexes(indexes, candidateIndexes(insertedRows, []));

      let members = input.records.map((record) => resolveRecord(record, indexes));
      if (members.some((member) => !member)) {
        mergeCandidateIndexes(
          indexes,
          await fetchExactCandidates(
            client,
            input.ownerCandidates,
            input.records.filter((_record, index) => !members[index])
          )
        );
        members = input.records.map((record) => resolveRecord(record, indexes));
      }
      const unresolved = members
        .map((member, index) => member ? null : {
          name: input.records[index].name,
          sourceRow: input.records[index].sourceRow,
        })
        .filter(Boolean);
      if (unresolved.length > 0) {
        throw repositoryError(
          `${unresolved.length} CRM record(s) could not be resolved after insert`,
          'contact_resolution_failed',
          { groupName: input.groupName, records: unresolved.slice(0, 20) }
        );
      }

      const insertedIndexes = candidateIndexes(insertedRows, []);
      const createdKeys = new Set();
      for (const candidate of insertedIndexes.email.values()) {
        createdKeys.add(`${candidate.kind}:${candidate.id}`);
      }
      for (const candidate of insertedIndexes.phone.values()) {
        createdKeys.add(`${candidate.kind}:${candidate.id}`);
      }
      await updateMatchedPeople(client, input, input.records, members, createdKeys);

      const uniqueMembers = [];
      const memberKeys = new Set();
      for (const member of members) {
        const key = `${member.kind}:${member.id}`;
        if (!memberKeys.has(key)) {
          memberKeys.add(key);
          uniqueMembers.push(member);
        }
      }

      const removed = await client.query(
        `/* crm-bulk:remove-members */
         DELETE FROM contact_group_members existing
          WHERE existing.group_id = $1
            AND NOT EXISTS (
              SELECT 1
                FROM UNNEST($2::text[], $3::integer[]) AS target(member_kind, member_id)
               WHERE target.member_kind = existing.member_kind
                 AND target.member_id = existing.member_id
            )
         RETURNING id`,
        [
          Number(group.id),
          uniqueMembers.map((member) => member.kind),
          uniqueMembers.map((member) => member.id),
        ]
      );
      const added = await client.query(
        `/* crm-bulk:add-members */
         INSERT INTO contact_group_members (group_id, member_kind, member_id, added_at)
         SELECT $1, target.member_kind, target.member_id, NOW()
           FROM UNNEST($2::text[], $3::integer[]) AS target(member_kind, member_id)
         ON CONFLICT (group_id, member_kind, member_id) DO NOTHING
         RETURNING id`,
        [
          Number(group.id),
          uniqueMembers.map((member) => member.kind),
          uniqueMembers.map((member) => member.id),
        ]
      );

      const syncResult = {
        groupId: Number(group.id),
        groupName: input.groupName,
        groupCreated: Boolean(group.created),
        contactsCreated: createdKeys.size,
        contactsMatched: uniqueMembers.length - createdKeys.size,
        membersAdded: nonNegativeInteger(added.rowCount),
        membersRemoved: nonNegativeInteger(removed.rowCount),
        recordsSkipped: 0,
        recordsTotal: input.records.length,
        replayed: false,
      };
      const completed = await client.query(
        `/* crm-bulk:complete-item */
         UPDATE ari_crm_bulk_job_items
            SET status = 'completed',
                records_total = $3,
                contacts_created = $4,
                contacts_matched = $5,
                members_added = $6,
                members_removed = $7,
                records_skipped = $8,
                attempt_count = GREATEST(attempt_count, $9),
                error = NULL,
                result = $10::jsonb,
                completed_at = NOW(),
                updated_at = NOW()
          WHERE operation_key = $1
            AND item_key = $2`,
        [
          input.operationKey,
          input.itemKey,
          input.records.length,
          syncResult.contactsCreated,
          syncResult.contactsMatched,
          syncResult.membersAdded,
          syncResult.membersRemoved,
          syncResult.recordsSkipped,
          input.attempt,
          jsonValue(syncResult),
        ]
      );
      if (completed.rowCount !== 1) {
        throw repositoryError('CRM item completion checkpoint was not persisted', 'checkpoint_write_failed', {
          operationKey: input.operationKey,
          itemKey: input.itemKey,
        });
      }
      await client.query(
        `/* crm-bulk:update-progress */
         UPDATE ari_crm_bulk_jobs job
            SET status = 'running',
                completed_groups = (
                  SELECT COUNT(*)::integer
                    FROM ari_crm_bulk_job_items item
                   WHERE item.operation_key = job.operation_key
                     AND item.status = 'completed'
                ),
                updated_at = NOW()
          WHERE operation_key = $1`,
        [input.operationKey]
      );
      await client.query('COMMIT');
      transactionStarted = false;
      return syncResult;
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          error.rollbackError = rollbackError;
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  const checkpointStore = {
    async beginOperation(operation = {}) {
      const operationKey = assertKey(operation.operationKey, 'operationKey');
      const userPhone = String(operation.userPhone || '').trim();
      if (!userPhone) throw repositoryError('A user phone is required', 'missing_user_identity');
      await pool.query(
        `/* crm-bulk:begin-operation */
         INSERT INTO ari_crm_bulk_jobs
           (operation_key, user_phone, source_hash, source_name, status,
            total_groups, total_records, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'running', $5, $6, NOW(), NOW())
         ON CONFLICT (operation_key) DO UPDATE
           SET user_phone = EXCLUDED.user_phone,
               source_hash = EXCLUDED.source_hash,
               source_name = EXCLUDED.source_name,
               total_groups = GREATEST(ari_crm_bulk_jobs.total_groups, EXCLUDED.total_groups),
               total_records = GREATEST(ari_crm_bulk_jobs.total_records, EXCLUDED.total_records),
               status = CASE
                 WHEN ari_crm_bulk_jobs.status = 'success' THEN ari_crm_bulk_jobs.status
                 ELSE 'running'
               END,
               updated_at = NOW()`,
        [
          operationKey,
          canonicalOwnerPhone(userPhone),
          String(operation.sourceHash || 'unknown'),
          String(operation.sourceName || 'contacts.xlsx'),
          nonNegativeInteger(operation.totalGroups),
          nonNegativeInteger(operation.totalRecords),
        ]
      );
    },

    async getItem(operationKeyValue, itemKeyValue) {
      const operationKey = assertKey(operationKeyValue, 'operationKey');
      const itemKey = assertKey(itemKeyValue, 'itemKey');
      const result = await pool.query(
        `/* crm-bulk:get-item */
         SELECT status, result, error, attempt_count
           FROM ari_crm_bulk_job_items
          WHERE operation_key = $1
            AND item_key = $2`,
        [operationKey, itemKey]
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        status: row.status,
        result: parsedJson(row.result),
        error: parsedJson(row.error),
        attempt: nonNegativeInteger(row.attempt_count),
      };
    },

    async saveItem(checkpoint = {}) {
      const operationKey = assertKey(checkpoint.operationKey, 'operationKey');
      const itemKey = assertKey(checkpoint.itemKey, 'itemKey');
      const status = ['pending', 'running', 'completed', 'failed'].includes(checkpoint.status)
        ? checkpoint.status
        : 'running';
      const result = checkpoint.result || null;
      await pool.query(
        `/* crm-bulk:save-item */
         INSERT INTO ari_crm_bulk_job_items
           (operation_key, item_key, group_name, status, records_total,
            contacts_created, contacts_matched, members_added, members_removed,
            records_skipped, attempt_count, error, result, created_at,
            started_at, updated_at, completed_at)
         VALUES (
            $1, $2, $3, $4::varchar(30), $5,
           $6, $7, $8, $9, $10, $11,
           $12::jsonb, $13::jsonb, NOW(),
            CASE WHEN $4::varchar(30) = 'running' THEN NOW() ELSE NULL END,
           NOW(),
            CASE WHEN $4::varchar(30) IN ('completed', 'failed') THEN NOW() ELSE NULL END
         )
         ON CONFLICT (operation_key, item_key) DO UPDATE
           SET group_name = EXCLUDED.group_name,
               records_total = GREATEST(ari_crm_bulk_job_items.records_total, EXCLUDED.records_total),
               contacts_created = CASE
                 WHEN ari_crm_bulk_job_items.status = 'completed' THEN ari_crm_bulk_job_items.contacts_created
                 ELSE GREATEST(ari_crm_bulk_job_items.contacts_created, EXCLUDED.contacts_created)
               END,
               contacts_matched = CASE
                 WHEN ari_crm_bulk_job_items.status = 'completed' THEN ari_crm_bulk_job_items.contacts_matched
                 ELSE GREATEST(ari_crm_bulk_job_items.contacts_matched, EXCLUDED.contacts_matched)
               END,
               members_added = CASE
                 WHEN ari_crm_bulk_job_items.status = 'completed' THEN ari_crm_bulk_job_items.members_added
                 ELSE GREATEST(ari_crm_bulk_job_items.members_added, EXCLUDED.members_added)
               END,
               members_removed = CASE
                 WHEN ari_crm_bulk_job_items.status = 'completed' THEN ari_crm_bulk_job_items.members_removed
                 ELSE GREATEST(ari_crm_bulk_job_items.members_removed, EXCLUDED.members_removed)
               END,
               records_skipped = CASE
                 WHEN ari_crm_bulk_job_items.status = 'completed' THEN ari_crm_bulk_job_items.records_skipped
                 ELSE GREATEST(ari_crm_bulk_job_items.records_skipped, EXCLUDED.records_skipped)
               END,
               attempt_count = GREATEST(ari_crm_bulk_job_items.attempt_count, EXCLUDED.attempt_count),
               status = CASE
                 WHEN ari_crm_bulk_job_items.status = 'completed' THEN 'completed'
                 ELSE EXCLUDED.status
               END,
               error = CASE
                 WHEN ari_crm_bulk_job_items.status = 'completed' THEN ari_crm_bulk_job_items.error
                 ELSE EXCLUDED.error
               END,
               result = CASE
                 WHEN ari_crm_bulk_job_items.status = 'completed' THEN ari_crm_bulk_job_items.result
                 ELSE COALESCE(EXCLUDED.result, ari_crm_bulk_job_items.result)
               END,
               started_at = COALESCE(ari_crm_bulk_job_items.started_at, EXCLUDED.started_at),
               completed_at = CASE
                 WHEN ari_crm_bulk_job_items.status = 'completed' THEN ari_crm_bulk_job_items.completed_at
                 ELSE EXCLUDED.completed_at
               END,
               updated_at = NOW()`,
        [
          operationKey,
          itemKey,
          String(checkpoint.groupName || 'Unknown group'),
          status,
          nonNegativeInteger(checkpoint.recordsTotal),
          resultCount(result, 'contactsCreated', 'contacts_created'),
          resultCount(result, 'contactsMatched', 'contacts_matched'),
          resultCount(result, 'membersAdded', 'members_added'),
          resultCount(result, 'membersRemoved', 'members_removed'),
          resultCount(result, 'recordsSkipped', 'records_skipped'),
          positiveInteger(checkpoint.attempt, 1),
          jsonValue(checkpoint.error),
          jsonValue(result),
        ]
      );
    },

    async finishOperation(result = {}) {
      const operationKey = assertKey(result.operationKey, 'operationKey');
      const status = ['success', 'partial', 'failed'].includes(result.status) ? result.status : 'failed';
      await pool.query(
        `/* crm-bulk:finish-operation */
         UPDATE ari_crm_bulk_jobs
            SET status = $2,
                total_groups = GREATEST(total_groups, $3),
                completed_groups = $4,
                total_records = GREATEST(total_records, $5),
                result = $6::jsonb,
                last_error = $7::jsonb,
                completed_at = NOW(),
                updated_at = NOW()
          WHERE operation_key = $1`,
        [
          operationKey,
          status,
          nonNegativeInteger(result.totalGroups),
          nonNegativeInteger(result.completedGroups),
          nonNegativeInteger(result.totalRecords),
          jsonValue(result),
          Array.isArray(result.errors) && result.errors.length > 0
            ? jsonValue(result.errors)
            : null,
        ]
      );
    },
  };

  /**
   * Does this owner still have a group by this name?
   *
   * A completed checkpoint records that the work RAN, not that its result
   * survives. Groups get deleted afterwards — by the user, by a cleanup, or by
   * an import that landed under a different identity — and replaying the
   * checkpoint then reports "synchronized 15 groups" over a database that has
   * none. Callers use this to confirm the row is still there before trusting
   * the checkpoint.
   */
  async function groupExists({ userPhone, groupName }) {
    const name = String(groupName || '').trim();
    if (!name) return false;
    const result = await query(
      `SELECT 1 FROM contact_groups
        WHERE user_phone = ANY($1::text[]) AND LOWER(BTRIM(name)) = LOWER(BTRIM($2))
        LIMIT 1`,
      [ownerPhoneCandidates(userPhone), name],
    );
    return result.rows.length > 0;
  }

  return { syncGroup, checkpointStore, groupExists };
}

module.exports = {
  canonicalOwnerPhone,
  createContactGroupBulkRepository,
  normalizedEmail,
  normalizedOwnerIdentity,
  normalizedPersonName,
  normalizedPhone,
  ownerPhoneCandidates,
};
