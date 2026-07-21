const { query } = require('../config/database');
const logger = require('../utils/logger');

class ContactService {

  constructor() {
    this.tableReady = false;
  }

  // ========== SCHEMA ==========
  async ensureContactsTable() {
    if (this.tableReady) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS contacts (
          id SERIAL PRIMARY KEY,
          user_phone VARCHAR(20) NOT NULL,
          name VARCHAR(100) NOT NULL,
          phone VARCHAR(20) NOT NULL,
          notes TEXT,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_phone)`);
      // Unique constraint on user_phone + lowercased name
      await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_user_name ON contacts(user_phone, LOWER(name))`);
      // Add category column if not exists
      await query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS category VARCHAR(30) DEFAULT 'general'`);
      this.tableReady = true;
    } catch (error) {
      // Table likely already exists
      this.tableReady = true;
    }
  }

  // ========== PHONE NORMALIZATION ==========
  normalizePhone(phone) {
    if (!phone) return null;
    let cleaned = phone.replace(/[\s\-\(\)\+]/g, '');
    // Remove non-digits
    cleaned = cleaned.replace(/\D/g, '');
    // Add India country code if 10 digits
    if (cleaned.length === 10) {
      cleaned = '91' + cleaned;
    }
    if (cleaned.length < 10 || cleaned.length > 15) return null;
    return cleaned;
  }

  // ========== MASK PHONE FOR DISPLAY ==========
  maskPhone(phone) {
    if (!phone || phone.length < 8) return phone || '***';
    // Show first 4 and last 4, mask middle
    // e.g. 916203883088 → +91 6203****3088
    const countryCode = phone.length > 10 ? phone.slice(0, phone.length - 10) : '';
    const number = phone.slice(-10);
    return `+${countryCode} ${number.slice(0, 4)}****${number.slice(-4)}`;
  }

  // ========== SAVE CONTACT ==========
  async saveContact(userPhone, name, contactPhone, notes = null) {
    await this.ensureContactsTable();
    try {
      // Validate name
      const trimmedName = name.trim();
      if (!trimmedName || trimmedName.length < 2) {
        return { success: false, error: 'Name must be at least 2 characters' };
      }
      if (trimmedName.length > 100) {
        return { success: false, error: 'Name is too long (max 100 characters)' };
      }
      if (/^\d+$/.test(trimmedName)) {
        return { success: false, error: 'Name cannot be just numbers' };
      }

      const normalized = this.normalizePhone(contactPhone);
      if (!normalized) {
        return { success: false, error: 'Invalid phone number' };
      }

      const result = await query(
        `INSERT INTO contacts (user_phone, name, phone, notes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         ON CONFLICT (user_phone, LOWER(name))
         DO UPDATE SET phone = $3, notes = COALESCE($4, contacts.notes), updated_at = NOW()
         RETURNING *`,
        [userPhone, name.trim(), normalized, notes]
      );

      const contact = result.rows[0];
      logger.info(`Contact saved: ${name} → ${this.maskPhone(normalized)} by ${userPhone}`);
      // Invalidate context cache — contact names appear in getContext.
      try { require('../utils/context-cache').bust(userPhone); } catch (e) { /* noop */ }
      return { success: true, contact, isUpdate: result.command === 'UPDATE' };
    } catch (error) {
      logger.error('Save contact error:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ========== LOOKUP BY NAME ==========
  async findByName(userPhone, name) {
    await this.ensureContactsTable();
    try {
      // Exact match first
      let result = await query(
        `SELECT * FROM contacts WHERE user_phone = $1 AND LOWER(name) = LOWER($2)`,
        [userPhone, name.trim()]
      );
      if (result.rows.length > 0) return result.rows;

      // Fuzzy match (starts with or contains)
      result = await query(
        `SELECT * FROM contacts WHERE user_phone = $1
         AND (LOWER(name) LIKE LOWER($2) OR LOWER(name) LIKE LOWER($3))
         ORDER BY
           CASE WHEN LOWER(name) = LOWER($4) THEN 0
                WHEN LOWER(name) LIKE LOWER($2) THEN 1
                ELSE 2 END,
           updated_at DESC
         LIMIT 5`,
        [userPhone, `${name.trim()}%`, `%${name.trim()}%`, name.trim()]
      );
      return result.rows;
    } catch (error) {
      logger.error('Find contact error:', error.message);
      return [];
    }
  }

  // ========== LOOKUP BY PHONE ==========
  async findByPhone(userPhone, contactPhone) {
    await this.ensureContactsTable();
    try {
      const normalized = this.normalizePhone(contactPhone);
      if (!normalized) return [];

      const result = await query(
        `SELECT * FROM contacts WHERE user_phone = $1 AND phone = $2`,
        [userPhone, normalized]
      );
      return result.rows;
    } catch (error) {
      return [];
    }
  }

  // ========== GET ALL CONTACTS ==========
  async getAllContacts(userPhone) {
    await this.ensureContactsTable();
    try {
      const result = await query(
        `SELECT * FROM contacts WHERE user_phone = $1 ORDER BY name ASC`,
        [userPhone]
      );
      return result.rows;
    } catch (error) {
      return [];
    }
  }

  // ========== UPDATE CONTACT ==========
  async updateContact(userPhone, name, updates) {
    await this.ensureContactsTable();
    try {
      const existing = await this.findByName(userPhone, name);
      if (existing.length === 0) {
        return { success: false, error: 'Contact not found' };
      }
      if (existing.length > 1) {
        return { success: false, error: 'multiple', matches: existing };
      }

      const contact = existing[0];
      const newPhone = updates.phone ? this.normalizePhone(updates.phone) : contact.phone;
      const newNotes = updates.notes !== undefined ? updates.notes : contact.notes;
      const newName = updates.name || contact.name;

      if (updates.phone && !newPhone) {
        return { success: false, error: 'Invalid phone number' };
      }

      const result = await query(
        `UPDATE contacts SET name = $1, phone = $2, notes = $3, updated_at = NOW()
         WHERE id = $4 RETURNING *`,
        [newName.trim(), newPhone, newNotes, contact.id]
      );

      return { success: true, contact: result.rows[0] };
    } catch (error) {
      logger.error('Update contact error:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ========== DELETE CONTACT ==========
  async deleteContact(userPhone, name) {
    await this.ensureContactsTable();
    try {
      const existing = await this.findByName(userPhone, name);
      if (existing.length === 0) {
        return { success: false, error: 'Contact not found' };
      }
      if (existing.length > 1) {
        return { success: false, error: 'multiple', matches: existing };
      }

      await query(`DELETE FROM contacts WHERE id = $1`, [existing[0].id]);
      logger.info(`Contact deleted: ${name} by ${userPhone}`);
      return { success: true, deleted: existing[0] };
    } catch (error) {
      logger.error('Delete contact error:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ========== FORMAT CONTACT FOR DISPLAY ==========
  formatContact(contact, timezone = 'Asia/Kolkata') {
    const savedDate = new Date(contact.created_at).toLocaleString('en-IN', {
      timeZone: timezone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });

    let text = `*${contact.name}* | ${this.maskPhone(contact.phone)}`;
    text += `\nSaved on ${savedDate}`;
    if (contact.notes) text += `\nNotes: ${contact.notes}`;
    return text;
  }

  formatContactsList(contacts, timezone = 'Asia/Kolkata') {
    if (!contacts || contacts.length === 0) {
      return "No saved contacts.\n\nSave one:\n- \"Save Emily's number: +91XXXXXXXXXX\"\n- \"Save this number as Rahul: 9876543210\"";
    }

    let response = `*Your Contacts (${contacts.length})*\n\n`;
    contacts.forEach((c, i) => {
      response += `${i + 1}. *${c.name}* — ${this.maskPhone(c.phone)}`;
      if (c.notes) response += ` (${c.notes})`;
      response += '\n';
    });

    response += `\n_"delete contact [name]" to remove_`;
    return response;
  }

  // ========== RESOLVE NAME TO PHONE (for reminders) ==========
  // Returns: { found: true, phone, name, ambiguous: false }
  //       or { found: true, ambiguous: true, matches: [...] }
  //       or { found: false }
  async resolveNameToPhone(userPhone, name) {
    const matches = await this.findByName(userPhone, name);

    if (matches.length === 0) {
      return { found: false };
    }

    if (matches.length === 1) {
      return { found: true, phone: matches[0].phone, name: matches[0].name, ambiguous: false };
    }

    // Multiple matches — exact match wins
    const exact = matches.find(m => m.name.toLowerCase() === name.toLowerCase());
    if (exact) {
      return { found: true, phone: exact.phone, name: exact.name, ambiguous: false };
    }

    return { found: true, ambiguous: true, matches };
  }

  // ========== PARSE CONTACT COMMANDS ==========
  parseContactCommand(message, params = null) {
    // Params-first path: if LLM already extracted structured params, use them directly
    if (params && params.action) {
      const result = { action: params.action };
      if (params.name) result.name = params.name;
      if (params.phone) result.phone = params.phone;
      if (params.notes) result.notes = params.notes;
      return result;
    }

    const lower = message.toLowerCase().trim();

    // Show all contacts
    if (/^(show |view |see |list )?(my )?(all )?(saved )?contacts$/i.test(lower) ||
      /^my\s+contacts$/i.test(lower)) {
      return { action: 'list' };
    }

    // Delete contact: "delete contact Emily"
    const deleteMatch = message.match(/^(delete|remove)\s+contact\s+(.+)$/i);
    if (deleteMatch) {
      return { action: 'delete', name: deleteMatch[2].trim() };
    }

    // Save patterns:
    // "Save this number as Emily: +91XXXXXXXXXX"
    // "Save Emily's number: +91XXXXXXXXXX"
    // "Store Emily's number as +91XXXXXXXXXX"
    // "Save contact Emily +91XXXXXXXXXX"
    // "Emily ka number save kar: 9876543210"

    // Pattern: "save [this/the] number as NAME: PHONE"
    const saveAs1 = message.match(/^(?:save|sv|store|keep)\s+(?:this\s+)?number\s+as\s+([a-zA-Z\s]+?)[\s:]+(\+?\d[\d\s\-]{7,15})$/i);
    if (saveAs1) {
      return { action: 'save', name: saveAs1[1].trim(), phone: saveAs1[2].trim() };
    }

    // Pattern: "save NAME's number: PHONE" or "save NAME's number PHONE"
    const savePos = message.match(/^(?:save|sv|store|keep)\s+([a-zA-Z\s]+?)(?:'s|s)?\s+(?:number|phone|contact)[\s:]+(\+?\d[\d\s\-]{7,15})$/i);
    if (savePos) {
      return { action: 'save', name: savePos[1].trim(), phone: savePos[2].trim() };
    }

    // Pattern: "save contact NAME PHONE" or "save contact NAME: PHONE" or "sv contact NAME PHONE"
    const saveContact = message.match(/^(?:save|sv|store|add)\s+contact\s+([a-zA-Z\s]+?)[\s:]+(\+?\d[\d\s\-]{7,15})$/i);
    if (saveContact) {
      return { action: 'save', name: saveContact[1].trim(), phone: saveContact[2].trim() };
    }

    // Pattern: "NAME ka number save kar: PHONE" (Hinglish)
    const hinglishSave = message.match(/^([a-zA-Z\s]+?)\s+ka\s+number\s+(?:save|rakh|store)\s+(?:kar|karo)?[\s:]+(\+?\d[\d\s\-]{7,15})$/i);
    if (hinglishSave) {
      return { action: 'save', name: hinglishSave[1].trim(), phone: hinglishSave[2].trim() };
    }

    // Pattern: "PHONE save as NAME" or "PHONE save kar NAME ke naam se"
    const reverseSave = message.match(/^(\+?\d[\d\s\-]{7,15})\s+(?:save|store)\s+(?:as|kar)\s+([a-zA-Z\s]+?)$/i);
    if (reverseSave) {
      return { action: 'save', name: reverseSave[2].trim(), phone: reverseSave[1].trim() };
    }

    // Pattern: "this is NAME number/numer save this PHONE" / "NAME number save karo PHONE"
    const naturalSave = message.match(/(?:this\s+is\s+|ye\s+|yeh\s+)?([a-zA-Z]+?)(?:'s)?\s+(?:number|numer|phone)\s*[,.]?\s*(?:save|store|rakh)\s+(?:this\s+|kar\s*o?\s*|it\s*)?[:.]?\s*(\+?\d[\d\s\-]{7,15})/i);
    if (naturalSave) {
      return { action: 'save', name: naturalSave[1].trim(), phone: naturalSave[2].trim() };
    }

    // Pattern: "save this PHONE as NAME" / "save PHONE as NAME"
    const savePhoneAs = message.match(/(?:save|store)\s+(?:this\s+)?(\+?\d[\d\s\-]{7,15})\s+(?:as|for|naam)\s+([a-zA-Z\s]+?)$/i);
    if (savePhoneAs) {
      return { action: 'save', name: savePhoneAs[2].trim(), phone: savePhoneAs[1].trim() };
    }

    // Pattern: "PHONE is NAME's number" / "PHONE ye NAME ka number hai"
    const phoneIsName = message.match(/(\+?\d[\d\s\-]{7,15})\s+(?:is|ye|yeh)\s+([a-zA-Z\s]+?)(?:'s|s|ka|ki)?\s+(?:number|numer|phone)/i);
    if (phoneIsName) {
      return { action: 'save', name: phoneIsName[2].trim(), phone: phoneIsName[1].trim() };
    }

    // Pattern: "ye/yeh NAME ka number hai PHONE"
    const yeNameKa = message.match(/(?:ye|yeh|this\s+is)\s+([a-zA-Z]+?)(?:'s)?\s+(?:ka\s+)?(?:number|numer|phone)\s*(?:hai|h|is)?\s*[:.]?\s*(\+?\d[\d\s\-]{7,15})/i);
    if (yeNameKa) {
      return { action: 'save', name: yeNameKa[1].trim(), phone: yeNameKa[2].trim() };
    }

    // Pattern: "remember NAME number PHONE" / "remember NAME's phone PHONE"
    const rememberName = message.match(/(?:remember|save|store)\s+([a-zA-Z]+?)(?:'s)?\s+(?:number|numer|phone)\s*[:.]?\s*(\+?\d[\d\s\-]{7,15})/i);
    if (rememberName) {
      return { action: 'save', name: rememberName[1].trim(), phone: rememberName[2].trim() };
    }

    // Update: "update Emily's number to PHONE"
    const updateMatch = message.match(/^update\s+([a-zA-Z\s]+?)(?:'s)?\s+(?:number|phone|contact)\s+(?:to|with)\s+(\+?\d[\d\s\-]{7,15})$/i);
    if (updateMatch) {
      return { action: 'update', name: updateMatch[1].trim(), phone: updateMatch[2].trim() };
    }

    return null;
  }

  // ========== BULK SAVE CONTACTS ==========
  async bulkSaveContacts(userPhone, contacts) {
    await this.ensureContactsTable();
    const saved = [], updated = [], failed = [];

    // For large imports (50+), use batched INSERT for efficiency
    if (contacts.length > 50) {
      return await this._batchInsertContacts(userPhone, contacts);
    }

    for (const c of contacts) {
      try {
        const name = (c.name || '').trim();
        const phone = (c.phone || '').toString().trim();
        if (!name || name.length < 2) { failed.push({ name: name || '(empty)', phone, reason: 'Invalid name' }); continue; }
        if (/^\d+$/.test(name)) { failed.push({ name, phone, reason: 'Name cannot be just numbers' }); continue; }

        const normalized = this.normalizePhone(phone);
        if (!normalized) { failed.push({ name, phone, reason: 'Invalid phone number' }); continue; }

        const result = await query(
          `INSERT INTO contacts (user_phone, name, phone, created_at, updated_at)
           VALUES ($1, $2, $3, NOW(), NOW())
           ON CONFLICT (user_phone, LOWER(name))
           DO UPDATE SET phone = $3, updated_at = NOW()
           RETURNING *, (xmax = 0) AS is_insert`,
          [userPhone, name, normalized]
        );

        const row = result.rows[0];
        if (row.is_insert) {
          saved.push({ name: row.name, phone: normalized });
        } else {
          updated.push({ name: row.name, phone: normalized });
        }
      } catch (e) {
        failed.push({ name: c.name || '(unknown)', phone: c.phone || '', reason: e.message });
      }
    }

    logger.info(`Bulk contact save for ${userPhone}: saved=${saved.length}, updated=${updated.length}, failed=${failed.length}`);
    return { saved, updated, failed };
  }

  // Batch INSERT for large imports (50+ contacts)
  async _batchInsertContacts(userPhone, contacts) {
    const saved = [], updated = [], failed = [];
    const BATCH_SIZE = 50;

    // Validate and normalize all contacts first
    const validContacts = [];
    for (const c of contacts) {
      const name = (c.name || '').trim();
      const phone = (c.phone || '').toString().trim();
      if (!name || name.length < 2) { failed.push({ name: name || '(empty)', phone, reason: 'Invalid name' }); continue; }
      if (name.length > 100) { failed.push({ name: name.slice(0, 20) + '...', phone, reason: 'Name too long' }); continue; }
      if (/^\d+$/.test(name)) { failed.push({ name, phone, reason: 'Name cannot be just numbers' }); continue; }
      const normalized = this.normalizePhone(phone);
      if (!normalized) { failed.push({ name, phone, reason: 'Invalid phone number' }); continue; }
      validContacts.push({ name, phone: normalized });
    }

    // Insert in batches
    for (let i = 0; i < validContacts.length; i += BATCH_SIZE) {
      const batch = validContacts.slice(i, i + BATCH_SIZE);
      try {
        const values = [];
        const params = [];
        let paramIdx = 1;
        for (const c of batch) {
          values.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, NOW(), NOW())`);
          params.push(userPhone, c.name, c.phone);
          paramIdx += 3;
        }

        const result = await query(
          `INSERT INTO contacts (user_phone, name, phone, created_at, updated_at)
           VALUES ${values.join(', ')}
           ON CONFLICT (user_phone, LOWER(name))
           DO UPDATE SET phone = EXCLUDED.phone, updated_at = NOW()
           RETURNING name, phone, (xmax = 0) AS is_insert`,
          params
        );

        for (const row of result.rows) {
          if (row.is_insert) {
            saved.push({ name: row.name, phone: row.phone });
          } else {
            updated.push({ name: row.name, phone: row.phone });
          }
        }
      } catch (e) {
        // If batch fails, fall back to individual inserts for this batch
        logger.warn(`Batch insert failed, falling back to individual: ${e.message}`);
        for (const c of batch) {
          try {
            const result = await query(
              `INSERT INTO contacts (user_phone, name, phone, created_at, updated_at)
               VALUES ($1, $2, $3, NOW(), NOW())
               ON CONFLICT (user_phone, LOWER(name))
               DO UPDATE SET phone = $3, updated_at = NOW()
               RETURNING *, (xmax = 0) AS is_insert`,
              [userPhone, c.name, c.phone]
            );
            const row = result.rows[0];
            if (row.is_insert) saved.push({ name: row.name, phone: c.phone });
            else updated.push({ name: row.name, phone: c.phone });
          } catch (e2) {
            failed.push({ name: c.name, phone: c.phone, reason: e2.message });
          }
        }
      }
    }

    logger.info(`Batch contact import for ${userPhone}: saved=${saved.length}, updated=${updated.length}, failed=${failed.length} (total: ${contacts.length})`);
    return { saved, updated, failed };
  }

  // ========== PARSE CSV BUFFER ==========
  parseCSV(buffer) {
    const text = buffer.toString('utf-8').replace(/^\uFEFF/, ''); // strip BOM
    const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length === 0) return { contacts: [], error: 'Empty CSV file' };

    // Detect delimiter
    const firstLine = lines[0];
    let delimiter = ',';
    if (firstLine.split('\t').length > firstLine.split(',').length) delimiter = '\t';
    else if (firstLine.split(';').length > firstLine.split(',').length) delimiter = ';';

    // Parse header row
    const headers = this._parseCSVLine(firstLine, delimiter).map(h => h.toLowerCase().trim());
    const nameIdx = headers.findIndex(h => /^(name|contact.?name|full.?name|person|contact)$/i.test(h));
    const phoneIdx = headers.findIndex(h => /^(phone|phone.?number|number|mobile|cell|tel|telephone|contact.?number)$/i.test(h));
    const notesIdx = headers.findIndex(h => /^(notes?|comment|description|label|group|category)$/i.test(h));

    // If no recognizable headers, try to auto-detect from data
    let startLine = 1;
    let nameCol = nameIdx;
    let phoneCol = phoneIdx;
    let notesCol = notesIdx;

    if (nameCol === -1 || phoneCol === -1) {
      // Try auto-detecting: first column with alpha = name, first column with digits = phone
      const sampleCols = this._parseCSVLine(lines.length > 1 ? lines[1] : lines[0], delimiter);
      if (nameCol === -1) nameCol = sampleCols.findIndex(c => /[a-zA-Z]{2,}/.test(c) && !/^\+?\d[\d\s\-]{7,}$/.test(c.trim()));
      if (phoneCol === -1) phoneCol = sampleCols.findIndex((c, i) => i !== nameCol && /\+?\d[\d\s\-]{7,}/.test(c.trim()));

      // If first row looks like data (has phone number), include it
      const firstRowCols = this._parseCSVLine(lines[0], delimiter);
      if (firstRowCols.some(c => /\+?\d[\d\s\-]{7,}/.test(c.trim()))) {
        startLine = 0;
      }
    }

    if (nameCol === -1 || phoneCol === -1) {
      return { contacts: [], error: 'Could not detect Name and Phone columns. Please ensure your CSV has columns named "Name" and "Phone".' };
    }

    const contacts = [];
    for (let i = startLine; i < lines.length; i++) {
      const cols = this._parseCSVLine(lines[i], delimiter);
      const name = (cols[nameCol] || '').trim();
      const phone = (cols[phoneCol] || '').trim();
      if (!name || !phone) continue;
      if (name.length < 2) continue;
      const notes = notesCol >= 0 ? (cols[notesCol] || '').trim() : null;
      contacts.push({ name, phone, ...(notes ? { notes } : {}) });
    }

    return { contacts, delimiter, headerDetected: startLine === 1 };
  }

  // Parse a single CSV line handling quoted fields
  _parseCSVLine(line, delimiter) {
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
        else if (ch === '"') inQuotes = false;
        else current += ch;
      } else {
        if (ch === '"') inQuotes = true;
        else if (ch === delimiter) { fields.push(current); current = ''; }
        else current += ch;
      }
    }
    fields.push(current);
    return fields;
  }

  // ========== GET CONTACT COUNT ==========
  async getContactCount(userPhone) {
    await this.ensureContactsTable();
    try {
      const result = await query(
        `SELECT COUNT(*) as count FROM contacts WHERE user_phone = $1`,
        [userPhone]
      );
      return parseInt(result.rows[0].count) || 0;
    } catch (e) {
      return 0;
    }
  }
}

module.exports = new ContactService();
