/**
 * Deterministic CRM workbook ingestion.
 *
 * The model should never have to copy thousands of spreadsheet rows through a
 * tool call. This module reads the workbook locally, keeps stable identifiers,
 * and gives the persistence layer one idempotency key per group. The executor
 * is deliberately dependency-injected: a database repository can transactionally
 * upsert a group, its contacts, memberships, and the supplied item key.
 */

'use strict';

const crypto = require('node:crypto');

const OPERATION_VERSION = 'ari.crm.contact-workbook.v1';
const DEFAULT_MAX_GROUPS = 100;
const DEFAULT_MAX_RECORDS = 5000;
const DEFAULT_HEADER_SCAN_ROWS = 25;
const DEFAULT_MAX_ATTEMPTS = 3;

const SUMMARY_SHEET_NAMES = new Set([
  'overview',
  'all contacts',
]);

const NAME_HEADERS = new Set([
  'name',
  'full name',
  'contact name',
  'person name',
  'lead name',
]);

const EMAIL_HEADERS = new Set([
  'email',
  'e mail',
  'email address',
  'e mail address',
  'work email',
]);

const PHONE_HEADERS = new Set([
  'phone',
  'phone number',
  'mobile',
  'mobile number',
  'mobile phone',
  'telephone',
  'telephone number',
  'contact number',
]);

const TITLE_HEADERS = new Set([
  'title',
  'job title',
  'role',
  'field',
  'position',
  'job title role field as provided',
]);

const TRANSIENT_ERROR_CODES = new Set([
  '40001', // PostgreSQL serialization failure
  '40P01', // PostgreSQL deadlock
  '55P03', // PostgreSQL lock unavailable
  '57014', // cancelled/statement timeout
  '57P01', // admin shutdown
  '08000',
  '08001',
  '08003',
  '08006',
  '08007',
  '08P01',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'RATE_LIMITED',
]);

class ContactWorkbookError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = 'ContactWorkbookError';
    this.code = code;
    this.details = details;
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizedOwnerIdentity(value) {
  const raw = String(value || '').trim();
  const digits = raw.replace(/\D/g, '');
  return digits || raw.toLocaleLowerCase('en-US');
}

function normalizedGroupName(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('en-US');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function contactWorkbookOperationKey(userPhone, sourceHash) {
  const owner = normalizedOwnerIdentity(userPhone);
  const hash = String(sourceHash || '').trim().toLocaleLowerCase('en-US');
  if (!owner) throw new ContactWorkbookError('A user identity is required', 'missing_user_identity');
  if (!hash) throw new ContactWorkbookError('A source file hash is required', 'missing_source_hash');
  return sha256(`${OPERATION_VERSION}\0${owner}\0${hash}`);
}

function contactWorkbookItemKey(operationKey, groupName) {
  const operation = String(operationKey || '').trim();
  const group = normalizedGroupName(groupName);
  if (!operation || !group) {
    throw new ContactWorkbookError('An operation key and group name are required', 'missing_item_identity');
  }
  return sha256(`${operation}\0group\0${group}`);
}

function workbookSourceHash(buffer) {
  if (Buffer.isBuffer(buffer)) return sha256(buffer);
  if (buffer instanceof Uint8Array) return sha256(Buffer.from(buffer));
  if (buffer instanceof ArrayBuffer) return sha256(Buffer.from(buffer));
  throw new ContactWorkbookError('Workbook content must be a Buffer or byte array', 'invalid_workbook_buffer');
}

function cellText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value).trim();
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(cellText).filter(Boolean).join(' ').trim();
  if (typeof value === 'object') {
    if (value.result !== undefined && value.result !== null) return cellText(value.result);
    if (typeof value.text === 'string') return value.text.trim();
    if (Array.isArray(value.richText)) {
      return value.richText.map((part) => cellText(part?.text)).join('').trim();
    }
    if (typeof value.hyperlink === 'string') return cellText(value.text || value.hyperlink);
  }
  return String(value).trim();
}

function normalizedHeader(value) {
  return cellText(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-US')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function headerKind(value) {
  const header = normalizedHeader(value);
  if (!header) return null;
  if (NAME_HEADERS.has(header)) return 'name';
  if (EMAIL_HEADERS.has(header) || /(^| )email( |$)/.test(header)) return 'email';
  if (PHONE_HEADERS.has(header)
      || /(^| )(phone|mobile|telephone)( |$)/.test(header)) return 'phone';
  if (TITLE_HEADERS.has(header)
      || /(^| )(job title|role|position)( |$)/.test(header)) return 'title';
  return null;
}

function rowValues(row) {
  if (Array.isArray(row)) return row;
  if (Array.isArray(row?.values)) {
    return row.values.length > 0 && row.values[0] === undefined
      ? row.values.slice(1)
      : row.values;
  }
  return [];
}

function discoverHeader(rows, scanRows) {
  const stop = Math.min(rows.length, scanRows);
  for (let rowIndex = 0; rowIndex < stop; rowIndex += 1) {
    const values = rowValues(rows[rowIndex]);
    const columns = {};
    for (let columnIndex = 0; columnIndex < values.length; columnIndex += 1) {
      const kind = headerKind(values[columnIndex]);
      if (kind && columns[kind] === undefined) columns[kind] = columnIndex;
    }
    if (columns.name !== undefined
        && (columns.email !== undefined || columns.phone !== undefined)) {
      return { rowIndex, columns };
    }
  }
  return null;
}

function normalizeEmail(value) {
  return cellText(value).toLocaleLowerCase('en-US');
}

function normalizePhone(value) {
  return cellText(value).replace(/\D/g, '');
}

function rowIsEmpty(values) {
  return values.every((value) => !cellText(value));
}

function stableIdentifierKeys(record) {
  const keys = [];
  if (record.email) keys.push(`email:${record.email}`);
  if (record.phone) keys.push(`phone:${record.phone}`);
  return keys;
}

function recordIdentityKeys(record) {
  const name = normalizedGroupName(record.name);
  return stableIdentifierKeys(record).map((key) => `${key}\0name:${name}`);
}

function mergeRecord(existing, incoming) {
  return {
    ...existing,
    name: existing.name || incoming.name,
    email: existing.email || incoming.email,
    phone: existing.phone || incoming.phone,
    title: existing.title || incoming.title,
  };
}

function parseContactWorkbookSheets(sheets, options = {}) {
  if (!Array.isArray(sheets)) {
    throw new ContactWorkbookError('Workbook sheets must be an array', 'invalid_workbook_sheets');
  }

  const maxGroups = positiveInteger(options.maxGroups, DEFAULT_MAX_GROUPS);
  const maxRecords = positiveInteger(options.maxRecords, DEFAULT_MAX_RECORDS);
  const headerScanRows = positiveInteger(options.headerScanRows, DEFAULT_HEADER_SCAN_ROWS);
  const skippedSheets = [];
  const errors = [];
  const warnings = [];
  const groups = [];
  const groupsByName = new Map();
  let totalRecords = 0;

  for (let sheetIndex = 0; sheetIndex < sheets.length; sheetIndex += 1) {
    const sheet = sheets[sheetIndex] || {};
    const sheetName = cellText(sheet.name) || `Sheet ${sheetIndex + 1}`;
    const normalizedSheet = normalizedGroupName(sheetName);
    const rows = Array.isArray(sheet.rows) ? sheet.rows : [];

    if (SUMMARY_SHEET_NAMES.has(normalizedSheet)) {
      skippedSheets.push({ name: sheetName, reason: 'summary_sheet' });
      continue;
    }

    const header = discoverHeader(rows, headerScanRows);
    if (!header) {
      skippedSheets.push({ name: sheetName, reason: 'contact_headers_not_found' });
      continue;
    }

    let group = groupsByName.get(normalizedSheet);
    if (!group) {
      if (groups.length >= maxGroups) {
        throw new ContactWorkbookError(
          `Workbook group limit exceeded (${maxGroups})`,
          'workbook_group_limit_exceeded',
          { maxGroups, sheetName }
        );
      }
      group = {
        name: sheetName.slice(0, 120),
        sheetNames: [sheetName],
        records: [],
      };
      Object.defineProperty(group, '_recordIndexes', {
        value: new Map(),
        enumerable: false,
      });
      Object.defineProperty(group, '_identifierNames', {
        value: new Map(),
        enumerable: false,
      });
      groups.push(group);
      groupsByName.set(normalizedSheet, group);
    } else {
      group.sheetNames.push(sheetName);
    }

    for (let rowIndex = header.rowIndex + 1; rowIndex < rows.length; rowIndex += 1) {
      const values = rowValues(rows[rowIndex]);
      if (rowIsEmpty(values)) continue;

      const name = cellText(values[header.columns.name]);
      const email = header.columns.email === undefined
        ? ''
        : normalizeEmail(values[header.columns.email]);
      const phone = header.columns.phone === undefined
        ? ''
        : normalizePhone(values[header.columns.phone]);
      const title = header.columns.title === undefined
        ? ''
        : cellText(values[header.columns.title]);

      if (!name) {
        if (email || phone || title) {
          errors.push({
            code: 'missing_contact_name',
            sheet: sheetName,
            row: rowIndex + 1,
            message: 'Contact row has no name',
          });
        }
        continue;
      }
      if (!email && !phone) {
        errors.push({
          code: 'missing_stable_identifier',
          sheet: sheetName,
          row: rowIndex + 1,
          name,
          message: 'Contact row has neither email nor phone',
        });
        continue;
      }

      const record = {
        name,
        email,
        phone,
        title,
        sourceRow: rowIndex + 1,
      };
      const normalizedName = normalizedGroupName(name);
      const sharedTypes = [];
      for (const key of stableIdentifierKeys(record)) {
        const priorNames = group._identifierNames.get(key) || new Set();
        if (priorNames.size > 0 && !priorNames.has(normalizedName)) {
          sharedTypes.push(key.slice(0, key.indexOf(':')));
        }
        priorNames.add(normalizedName);
        group._identifierNames.set(key, priorNames);
      }
      if (sharedTypes.length > 0) {
        warnings.push({
          code: 'shared_contact_identifier',
          sheet: sheetName,
          row: rowIndex + 1,
          name,
          identifierTypes: [...new Set(sharedTypes)],
          message: 'A different named contact shares an email or phone; both people were preserved.',
        });
      }
      const identityKeys = recordIdentityKeys(record);
      const existingIndex = identityKeys
        .map((key) => group._recordIndexes.get(key))
        .find((index) => index !== undefined);

      if (existingIndex !== undefined) {
        group.records[existingIndex] = mergeRecord(group.records[existingIndex], record);
        for (const key of recordIdentityKeys(group.records[existingIndex])) {
          group._recordIndexes.set(key, existingIndex);
        }
        continue;
      }

      if (totalRecords >= maxRecords) {
        throw new ContactWorkbookError(
          `Workbook record limit exceeded (${maxRecords})`,
          'workbook_record_limit_exceeded',
          { maxRecords, sheetName, row: rowIndex + 1 }
        );
      }
      const index = group.records.length;
      group.records.push(record);
      for (const key of identityKeys) group._recordIndexes.set(key, index);
      totalRecords += 1;
    }
  }

  return {
    groups,
    totalRecords,
    skippedSheets,
    errors,
    warnings,
  };
}

function workbookBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  throw new ContactWorkbookError('Workbook content must be a Buffer or byte array', 'invalid_workbook_buffer');
}

async function loadWorkbookSheets(buffer, options = {}) {
  let ExcelJS = options.ExcelJS;
  if (!ExcelJS) {
    try {
      // Kept lazy so non-workbook CRM actions do not load the XLSX parser.
      ExcelJS = require('exceljs');
    } catch (error) {
      const wrapped = new ContactWorkbookError(
        'XLSX parsing requires the exceljs dependency',
        'exceljs_not_installed'
      );
      wrapped.cause = error;
      throw wrapped;
    }
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(workbookBuffer(buffer));
  return workbook.worksheets.map((worksheet) => {
    const rows = [];
    worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      rows[rowNumber - 1] = values;
    });
    return { name: worksheet.name, rows };
  });
}

async function parseContactWorkbookBuffer(buffer, options = {}) {
  const sheets = await loadWorkbookSheets(buffer, options);
  return parseContactWorkbookSheets(sheets, options);
}

function errorCode(error) {
  return String(error?.code || error?.name || 'bulk_group_failed');
}

function isTransientBulkError(error) {
  const code = errorCode(error).toLocaleUpperCase('en-US');
  if (TRANSIENT_ERROR_CODES.has(code)) return true;
  const status = Number(error?.status || error?.statusCode);
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function serializedError(error, extra = {}) {
  return {
    code: errorCode(error),
    message: String(error?.message || 'Bulk group synchronization failed'),
    ...extra,
  };
}

function defaultRetryDelay(attempt) {
  const delayMs = Math.min(2000, 100 * (2 ** Math.max(0, attempt - 1)));
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Create a resumable workbook executor.
 *
 * `syncGroup` must make the supplied `itemKey` idempotent in the same database
 * transaction as its CRM writes. Checkpoints avoid repeated work after a clean
 * failure; the stable item key closes the crash window between the write and
 * `saveItem`.
 */
function createContactGroupBulkService(options = {}) {
  const loadDocument = options.loadDocument;
  const parseWorkbook = options.parseWorkbookBuffer || parseContactWorkbookBuffer;
  const syncGroup = options.syncGroup;
  const checkpointStore = options.checkpointStore || {};
  // Optional: lets the service verify a completed checkpoint's result still
  // exists before replaying it. Absent, behaviour is unchanged.
  const groupExists = options.groupExists;
  const maxAttempts = positiveInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS);
  const retryDelay = options.retryDelay || defaultRetryDelay;
  const transientError = options.isTransientError || isTransientBulkError;

  if (typeof loadDocument !== 'function') {
    throw new TypeError('createContactGroupBulkService requires loadDocument');
  }
  if (typeof syncGroup !== 'function') {
    throw new TypeError('createContactGroupBulkService requires an idempotent syncGroup');
  }
  if (typeof checkpointStore.getItem !== 'function'
      || typeof checkpointStore.saveItem !== 'function') {
    throw new TypeError('createContactGroupBulkService requires checkpointStore.getItem/saveItem');
  }

  async function syncFromFile(userPhone, input = {}) {
    const document = input.buffer
      ? { buffer: input.buffer, fileName: input.fileName || 'contacts.xlsx' }
      : await loadDocument(userPhone, input);
    if (!document?.buffer) {
      throw new ContactWorkbookError('No workbook was loaded', 'workbook_not_found');
    }

    const sourceBuffer = workbookBuffer(document.buffer);
    const sourceHash = workbookSourceHash(sourceBuffer);
    const operationKey = contactWorkbookOperationKey(userPhone, sourceHash);
    const sourceName = String(document.fileName || input.fileName || 'contacts.xlsx');
    const parsed = await parseWorkbook(sourceBuffer, input.parseOptions || {});
    const operation = {
      operationKey,
      userIdentity: normalizedOwnerIdentity(userPhone),
      userPhone: String(userPhone || '').trim(),
      sourceHash,
      sourceName,
      totalGroups: parsed.groups.length,
      totalRecords: parsed.totalRecords,
    };

    if (typeof checkpointStore.beginOperation === 'function') {
      await checkpointStore.beginOperation(operation);
    }

    const items = [];
    const errors = Array.isArray(parsed.errors)
      ? parsed.errors.map((error) => ({ ...error, phase: 'parse' }))
      : [];
    let completedGroups = 0;
    let failedGroups = 0;
    let replayedGroups = 0;

    for (let index = 0; index < parsed.groups.length; index += 1) {
      const group = parsed.groups[index];
      const itemKey = contactWorkbookItemKey(operationKey, group.name);
      const previous = await checkpointStore.getItem(operationKey, itemKey);
      if (previous?.status === 'completed') {
        // A completed checkpoint proves the work RAN once — not that its result
        // still exists. Groups get deleted afterwards, and replaying the
        // checkpoint then reports "synchronized 15 groups and 2939 people" over
        // a database holding none of them. Worse, it is permanent: every
        // re-upload of the same file replays the same checkpoint, so the user
        // can never import it again and is never told why. Confirm the group is
        // still there; if it is gone, redo the work rather than claim it.
        let stillThere = true;
        if (typeof groupExists === 'function') {
          try {
            stillThere = await groupExists({ userPhone, groupName: group.name });
          } catch (_) {
            // If the check itself fails, prefer redoing the work: syncing is
            // idempotent by name, so a needless repeat is safe, whereas a
            // false "already done" is not.
            stillThere = false;
          }
        }
        if (stillThere) {
          completedGroups += 1;
          replayedGroups += 1;
          items.push({
            itemKey,
            groupName: group.name,
            status: 'completed',
            replayed: true,
            result: previous.result || null,
          });
          continue;
        }
      }
      if (previous?.status === 'failed' && input.retryFailed === false) {
        failedGroups += 1;
        const failure = previous.error || {
          code: 'previous_group_failure',
          message: `Previous synchronization of ${group.name} failed`,
        };
        errors.push({ ...failure, groupName: group.name, itemKey, phase: 'sync' });
        items.push({ itemKey, groupName: group.name, status: 'failed', replayed: true, error: failure });
        continue;
      }

      let attempt = 0;
      let itemResult = null;
      let itemFailure = null;
      while (attempt < maxAttempts) {
        attempt += 1;
        await checkpointStore.saveItem({
          operationKey,
          itemKey,
          groupName: group.name,
          status: 'running',
          attempt,
          recordsTotal: group.records.length,
        });
        try {
          itemResult = await syncGroup({
            ...operation,
            itemKey,
            idempotencyKey: itemKey,
            group,
            groupIndex: index,
            attempt,
          });
          await checkpointStore.saveItem({
            operationKey,
            itemKey,
            groupName: group.name,
            status: 'completed',
            attempt,
            recordsTotal: group.records.length,
            result: itemResult || null,
          });
          break;
        } catch (error) {
          const retryable = Boolean(transientError(error));
          itemFailure = serializedError(error, { retryable, attempt });
          if (retryable && attempt < maxAttempts) {
            await retryDelay(attempt, error);
            continue;
          }
          await checkpointStore.saveItem({
            operationKey,
            itemKey,
            groupName: group.name,
            status: 'failed',
            attempt,
            recordsTotal: group.records.length,
            error: itemFailure,
          });
          break;
        }
      }

      if (itemResult !== null) {
        completedGroups += 1;
        items.push({
          itemKey,
          groupName: group.name,
          status: 'completed',
          replayed: false,
          attempts: attempt,
          result: itemResult,
        });
      } else {
        failedGroups += 1;
        const failure = itemFailure || {
          code: 'bulk_group_failed',
          message: `Synchronization of ${group.name} failed`,
          retryable: false,
          attempt,
        };
        errors.push({ ...failure, groupName: group.name, itemKey, phase: 'sync' });
        items.push({
          itemKey,
          groupName: group.name,
          status: 'failed',
          replayed: false,
          attempts: attempt,
          error: failure,
        });
      }
    }

    let status = 'success';
    if (failedGroups > 0 || errors.length > 0) status = completedGroups > 0 ? 'partial' : 'failed';
    const result = {
      status,
      operationKey,
      sourceHash,
      sourceName,
      totalGroups: parsed.groups.length,
      totalRecords: parsed.totalRecords,
      completedGroups,
      failedGroups,
      replayedGroups,
      skippedSheets: parsed.skippedSheets || [],
      warnings: parsed.warnings || [],
      items,
      errors,
    };

    if (typeof checkpointStore.finishOperation === 'function') {
      await checkpointStore.finishOperation(result);
    }
    return result;
  }

  return { syncFromFile };
}

module.exports = {
  ContactWorkbookError,
  contactWorkbookItemKey,
  contactWorkbookOperationKey,
  createContactGroupBulkService,
  isTransientBulkError,
  loadWorkbookSheets,
  normalizedOwnerIdentity,
  parseContactWorkbookBuffer,
  parseContactWorkbookSheets,
  workbookSourceHash,
};
