const { query } = require('../config/database');
const logger = require('../utils/logger');
const axios = require('axios');
const timezoneService = require('./timezone.service');

const memoryService = require('./memory.service');
const contactService = require('./contact.service');
const llm = require('./llm-provider');

// Resolved once at require time — Ari loads dotenv before any service
// module is required, so these values reflect the active provider.
const apiKey = llm.apiKey();
const apiUrl = llm.chatUrl();
const model = llm.fastModel();

class ReminderService {

  constructor() {
    this.dayMap = {
      'sunday': 0, 'sun': 0, 'monday': 1, 'mon': 1, 'tuesday': 2, 'tue': 2,
      'wednesday': 3, 'wed': 3, 'thursday': 4, 'thu': 4, 'friday': 5, 'fri': 5,
      'saturday': 6, 'sat': 6
    };
  }

  // ========== TIMEZONE HELPERS ==========
  getZonedParts(date, timeZone) {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    });
    const parts = dtf.formatToParts(date);
    const map = {};
    for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value;
    return {
      year: parseInt(map.year), month: parseInt(map.month), day: parseInt(map.day),
      hour: parseInt(map.hour), minute: parseInt(map.minute), second: parseInt(map.second)
    };
  }

  zonedWallTimeToUtcDate({ year, month, day, hour, minute, second = 0 }, timeZone) {
    // Compute the zone's offset by asking what wall-clock time our UTC guess
    // maps to in `timeZone`, then subtracting. Works for any zone (positive or
    // negative offset, fractional offsets, DST) because we use absolute epoch
    // math instead of day-of-month arithmetic — so it doesn't break across
    // month/year boundaries the way the previous formula did.
    const targetMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);
    let guessMs = targetMs;
    for (let i = 0; i < 3; i++) {
      const actual = this.getZonedParts(new Date(guessMs), timeZone);
      const actualMs = Date.UTC(
        actual.year, actual.month - 1, actual.day,
        actual.hour, actual.minute, actual.second, 0
      );
      const diff = targetMs - actualMs;
      if (diff === 0) break;
      guessMs += diff;
    }
    return new Date(guessMs);
  }

  addDaysInZone(parts, daysToAdd, timeZone) {
    const noonUtc = this.zonedWallTimeToUtcDate(
      { year: parts.year, month: parts.month, day: parts.day, hour: 12, minute: 0, second: 0 }, timeZone
    );
    const shifted = new Date(noonUtc.getTime() + daysToAdd * 86400000);
    const newLocal = this.getZonedParts(shifted, timeZone);
    return { year: newLocal.year, month: newLocal.month, day: newLocal.day };
  }

  // ========== ABSOLUTE-DATE REGEX EXTRACTOR ==========
  // Deterministic fallback when the LLM drops specific_date.
  // Returns "YYYY-MM-DD" in the user's timezone or null.
  // Patterns handled (in priority order):
  //   "25th May" / "25 May" / "1st Jan" / "25 May 2027"
  //   "May 25" / "May 25th" / "Dec 25 2026"
  //   "next Friday" / "this Saturday" (incl. short forms)
  // Skipped on purpose: "5/25" (US vs EU ambiguity).
  extractAbsoluteDate(message, timeZone) {
    if (!message || typeof message !== 'string') return null;
    const lower = message.toLowerCase();

    const monthMap = {
      jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
      apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
      aug: 8, august: 8, sep: 9, sept: 9, september: 9,
      oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
    };
    const monthAlt = 'jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sept|sep|september|oct|october|nov|november|dec|december';
    const dowMap = {
      sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
      wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
      fri: 5, friday: 5, sat: 6, saturday: 6,
    };

    let day = null, month = null, year = null;

    // "25th May" / "25 May" / "25 May 2027"
    let m = lower.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthAlt})\\b(?:[,\\s]+(\\d{4}))?`, 'i'));
    if (m) {
      day = parseInt(m[1]);
      month = monthMap[m[2]];
      year = m[3] ? parseInt(m[3]) : null;
    }

    // "May 25" / "May 25th" / "Dec 25 2026"
    if (!day) {
      m = lower.match(new RegExp(`\\b(${monthAlt})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:[,\\s]+(\\d{4}))?`, 'i'));
      if (m) {
        month = monthMap[m[1]];
        day = parseInt(m[2]);
        year = m[3] ? parseInt(m[3]) : null;
      }
    }

    // "next Friday" / "this Saturday"
    if (!day) {
      m = lower.match(/\b(next|this)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\b/i);
      if (m) {
        const which = m[1].toLowerCase();
        const targetDow = dowMap[m[2].toLowerCase()];
        if (targetDow !== undefined) {
          const nowLocal = this.getZonedParts(new Date(), timeZone);
          // Day-of-week in the user's timezone — compute via a UTC date that
          // matches the local Y-M-D, since DOW is timezone-invariant for a date.
          const todayUtc = new Date(Date.UTC(nowLocal.year, nowLocal.month - 1, nowLocal.day));
          const todayDow = todayUtc.getUTCDay();
          let daysAhead = (targetDow - todayDow + 7) % 7;
          if (which === 'next' && daysAhead === 0) daysAhead = 7;
          // "this Friday" on Friday = today (caller will reject if time-of-day already past).
          const resolved = this.addDaysInZone(nowLocal, daysAhead, timeZone);
          return `${resolved.year}-${String(resolved.month).padStart(2, '0')}-${String(resolved.day).padStart(2, '0')}`;
        }
      }
    }

    if (day && month) {
      // Reject obvious invalid days early
      if (day < 1 || day > 31) return null;
      if (month === 2 && day > 29) return null;
      if ([4, 6, 9, 11].includes(month) && day > 30) return null;

      const nowLocal = this.getZonedParts(new Date(), timeZone);
      if (!year) {
        // No year given — pick this year if month/day still future, else next year.
        year = nowLocal.year;
        const cand = Date.UTC(year, month - 1, day);
        const today = Date.UTC(nowLocal.year, nowLocal.month - 1, nowLocal.day);
        if (cand < today) year += 1;
      }
      // Final sanity: year within sensible bounds
      if (year < 2000 || year > 2100) return null;
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }

    return null;
  }

  // ========== EXTRACT TARGET PHONE ==========
  extractTargetPhone(message, senderPhone) {
    if (!message) return null;

    // Patterns to find phone numbers after "remind"
    const patterns = [
      /remind\s+\+?(\d{1,4}[\s-]?\d{6,10})/i,        // remind +91 6203883088
      /remind\s+(\d{10,14})/i,                        // remind 916203883088  
      /send\s+reminder\s+to\s+\+?(\d{10,14})/i,      // send reminder to ...
      /reminder\s+(?:to|for)\s+\+?(\d{10,14})/i,     // reminder to/for ...
      /\+?(\d{10,14})\s+ko\s+remind/i,               // ... ko remind (Hindi)
      /\+?(\d{10,14})\s+ko\s+yaad/i,                 // ... ko yaad (Hindi)
    ];

    for (const pattern of patterns) {
      const match = message.match(pattern);
      if (match) {
        let phone = match[1].replace(/[\s-]/g, '').replace(/\D/g, '');

        // Add India country code if 10 digits
        if (phone.length === 10) {
          phone = '91' + phone;
        }

        // Check it's not sender's own number
        const senderClean = (senderPhone || '').replace(/\D/g, '');
        if (phone === senderClean || phone.endsWith(senderClean.slice(-10))) {
          logger.info('Target phone is same as sender, ignoring');
          return null;
        }

        logger.info(`Extracted target phone: ${phone}`);
        return phone;
      }
    }

    // Check if there is a name like "remind emily to...", "send reminder to emily", "reminder for emily"
    const namePatterns = [
      /remind\s+([a-zA-Z]+)(?=\s+to|\s+that|\s+about|\s+in|\s+at|\s+ko)/i,          // remind emily to...
      /(?:send\s+)?(?:reminder|rmeinder|remindr)\s+(?:to|for)\s+([a-zA-Z]+)/i,       // send reminder to emily / reminder for emily
      /([a-zA-Z]+)\s+ko\s+(?:remind|yaad\s*dila|bol|bata)/i,                          // emily ko remind kar / emily ko yaad dila
      /([a-zA-Z]+)\s+ko\s+\d{1,2}[:\s]/i,                                             // emily ko 12:10 ... (X ko [time])
      /([a-zA-Z]+)\s+ko\s+(?:.*?\s+)?(?:remind|reminder|yaad)/i,                      // emily ko ... reminder/remind (with stuff between)
    ];

    for (const namePattern of namePatterns) {
      const nameMatch = message.match(namePattern);
      if (nameMatch) {
        const name = nameMatch[1].toLowerCase();
        const skipWords = ['me', 'us', 'my', 'mujhe', 'hum', 'set', 'a', 'the', 'this', 'that', 'every', 'send', 'today', 'tomorrow', 'aj', 'aaj', 'kal', 'like', 'bro', 'dude', 'man', 'yaar', 'bruh', 'lol', 'about', 'around', 'maybe', 'just', 'also', 'all'];
        if (!skipWords.includes(name)) {
          logger.info(`Extracted target name: ${name}`);
          return { type: 'name', value: name, originalName: nameMatch[1] };
        }
      }
    }

    return null;
  }

  // Clean phone from message
  cleanMessageOfPhone(message, extractedTarget) {
    let msg = message
      .replace(/remind\s+\+?\d[\d\s-]{9,14}/gi, 'remind me')
      .replace(/send\s+reminder\s+to\s+\+?\d[\d\s-]{9,14}/gi, 'remind me')
      .replace(/\+?\d{10,14}\s+ko\s+(remind|yaad)/gi, 'remind me');

    if (extractedTarget && extractedTarget.type === 'name') {
      const name = extractedTarget.value;
      msg = msg
        .replace(new RegExp(`remind\\s+${name}`, 'gi'), 'remind me')
        .replace(new RegExp(`(?:send\\s+)?(?:reminder|rmeinder|remindr)\\s+(?:to|for)\\s+${name}`, 'gi'), 'remind me')
        .replace(new RegExp(`${name}\\s+ko\\s+(?:remind|yaad\\s*dila|bol|bata)`, 'gi'), 'remind me')
        .replace(new RegExp(`${name}\\s+ko\\b`, 'gi'), ''); // "somnath ko 12:10..." → remove name
    }

    return msg.trim();
  }

  // ========== ENSURE SCHEMA ==========
  async ensureRemindersSchema() {
    try {
      await query(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS target_phone VARCHAR(20)`);
      await query(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS is_recurring BOOLEAN DEFAULT FALSE`);
      await query(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS recurrence_pattern VARCHAR(20)`);
      await query(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS recurrence_time VARCHAR(10)`);
      await query(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS next_occurrence TIMESTAMP`);
      await query(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS message_type VARCHAR(20) DEFAULT 'reminder'`);
      await query(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS recurrence_days VARCHAR(100)`);
      await query(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS except_days VARCHAR(100)`);
      await query(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS priority VARCHAR(10) DEFAULT 'normal'`);
      await query(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0`);
      await query(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS snooze_until TIMESTAMP`);
      await query(`CREATE INDEX IF NOT EXISTS idx_reminders_target ON reminders(target_phone)`);
      return true;
    } catch (error) {
      logger.error('Schema error:', error.message);
      return false;
    }
  }

  // ========== MAIN PARSING FUNCTION ==========
  async parseAndCreateReminder(userPhone, message, userTimezone = 'Asia/Kolkata', recentContact = null, params = null) {
    try {
      logger.info(`=== Parsing Reminder ===`);
      logger.info(`Message: "${message}"`);
      logger.info(`Sender: ${userPhone}, Timezone: ${userTimezone}`);
      if (params) logger.info(`LLM params: ${JSON.stringify(params)}`);
      if (recentContact) logger.info(`Recent contact: ${recentContact.name} (${recentContact.phone})`);

      // ── LLM Params-First Path ─────────────────────────────────────────
      // If the LLM already extracted entities, use them directly instead of regex.
      // Time parsing still uses AI/regex on the full_text since LLM doesn't extract time.
      if (params?.reminder_message) {
        logger.info(`Using LLM-extracted params for reminder`);

        let targetPhone = params.target_phone || null;
        let targetName = params.target_name || null;

        // Resolve target name to phone if name provided but no phone
        if (!targetPhone && targetName && targetName.toLowerCase() !== 'me' && targetName.toLowerCase() !== 'team') {
          logger.info(`LLM params: resolving target name "${targetName}" to phone`);
          const contactResult = await contactService.resolveNameToPhone(userPhone, targetName);
          if (contactResult.found && !contactResult.ambiguous) {
            targetPhone = contactResult.phone;
            targetName = contactResult.name;
            logger.info(`Resolved "${targetName}" from contacts → ${targetPhone}`);
          } else if (contactResult.found && contactResult.ambiguous) {
            return {
              success: false,
              needsContactClarification: true,
              targetName,
              matches: contactResult.matches
            };
          } else {
            targetPhone = await memoryService.findPhoneForName(userPhone, targetName);
            if (!targetPhone) {
              return {
                success: false,
                needsPhoneNumber: true,
                targetName
              };
            }
            logger.info(`Resolved "${targetName}" from memory → ${targetPhone}`);
          }
        }

        // Effective timezone: ALWAYS the sender's. When the user says "remind
        // Akash at 12:58", they mean 12:58 in THEIR wall-clock. Both Akash
        // (India) and Mahaprasad (USA) should receive the reminder at the
        // exact same absolute moment (12:58 IST in this example), even if
        // it's a different local time on their end. Previously we overrode
        // to the recipient's timezone, which made cross-timezone delegated
        // reminders fire at the wrong moment for non-IST recipients.
        const effectiveTimezone = userTimezone;

        // Use full_text for time parsing (AI/regex still needed for that)
        const fullText = params.full_text || message;

        // Route recurring vs one-time
        if (params.is_recurring || this.isRecurringRequest(fullText)) {
          return await this.parseRecurringReminder(userPhone, fullText, effectiveTimezone, targetPhone);
        }

        // One-time: parse time from full text, but override the message with LLM-extracted one
        const aiResult = await this.parseWithAI(fullText, effectiveTimezone);
        if (aiResult.success) {
          let reminderMsg = params.reminder_message;

          // Apr 28 2026 — RC9 fix: strip the imperative reminder-verb if the LLM
          // accidentally included it in the extracted message. Without this,
          // "kal subah 7am ko gym jaane ki yaad dilao" gets stored with the
          // verb "yaad dilao" still inside, so the reminder fires saying
          // "REMINDER: gym jaane ki yaad dilao" (= "remind me to go to gym")
          // which is recursive nonsense. Same for English ("remind me to X")
          // and Devanagari ("याद दिलाओ").
          reminderMsg = this._stripReminderVerbs(reminderMsg);

          const msg = (reminderMsg || '').trim().toLowerCase();
          if (!msg || msg.length < 2 || /^(reminder|no specific|nothing|undefined|null|n\/a)$/i.test(msg)) {
            return { success: false, needsClarification: true, time: aiResult.reminderTime };
          }

          // CONTEXT-BLEED GUARD — validate that the LLM's reminder_message
          // actually relates to the user's current message. If the LLM
          // pulled stray text from older conversation history (which has
          // happened in production), fall back to what the AI-time parser
          // extracted from the CURRENT turn, or flag for clarification.
          try {
            const { checkTextFromUser } = require('../utils/llm-output-validator');
            const check = checkTextFromUser(reminderMsg, fullText || message);
            if (check.suspicious) {
              logger.warn({
                userPhone,
                llmMsg: reminderMsg,
                userText: (fullText || message).slice(0, 120),
                overlap: check.overlap,
                reason: check.reason
              }, 'LLM reminder_message failed user-text overlap check — falling back');

              // Prefer the AI time-parser's own extracted message (it operates
              // on the CURRENT user turn only), then regex, then clarify.
              if (aiResult.reminderMessage && aiResult.reminderMessage.length > 2
                  && !/^(reminder|no specific)$/i.test(aiResult.reminderMessage)) {
                reminderMsg = aiResult.reminderMessage;
              } else {
                return {
                  success: false,
                  needsClarification: true,
                  clarificationReason: 'could not confirm what to remind — please say it once more',
                  time: aiResult.reminderTime
                };
              }
            }
          } catch (e) {
            logger.debug(`reminder text validator skipped: ${e.message}`);
          }

          const finalTarget = targetPhone || aiResult.targetPhone || null;
          const saved = await this.createReminder(userPhone, reminderMsg, aiResult.reminderTime, finalTarget);
          if (saved) {
            return {
              success: true,
              reminderId: saved.id,
              message: reminderMsg,
              time: aiResult.reminderTime,
              targetPhone: finalTarget,
              ambiguousTimeResolved: aiResult.ambiguousTimeResolved || null,
              silentRollForward: aiResult.silentRollForward || null
            };
          }
        }

        // Fallback: regex time parsing with LLM-extracted message
        const regexResult = this.parseWithRegex(fullText, effectiveTimezone);
        if (regexResult.success) {
          const reminderMsg = params.reminder_message;
          const saved = await this.createReminder(userPhone, reminderMsg, regexResult.reminderTime, targetPhone);
          if (saved) {
            return {
              success: true,
              reminderId: saved.id,
              message: reminderMsg,
              time: regexResult.reminderTime,
              targetPhone
            };
          }
        }

        // If time parsing failed even with params, fall through to full legacy path
        logger.info(`LLM params path: time parsing failed, falling through to legacy path`);
      }

      // ── Legacy Path (regex extraction) ────────────────────────────────

      // Check if message refers to "the person I just saved" / "last saved contact"
      const refersToRecent = /\b(person|contact|number|one)\b.*\b(just|recently|last)\s+(saved|added|stored)\b/i.test(message)
        || /\b(just|recently|last)\s+(saved|added|stored)\b.*\b(person|contact|number|one)\b/i.test(message)
        || /\b(the\s+)?(new|last|recent)\s+(contact|person|number)\b/i.test(message);

      if (refersToRecent && recentContact) {
        logger.info(`Resolved "recently saved" → ${recentContact.name} (${recentContact.phone})`);
        const cleanedMsg = message
          .replace(/\b(for|to)\s+(the\s+)?(person|contact|number|one)\s+(whose\s+number\s+)?(i\s+)?(just|recently|last)\s+(saved|added|stored)\b/gi, '')
          .replace(/\b(for|to)\s+(the\s+)?(new|last|recent)\s+(contact|person|number)\b/gi, '')
          .replace(/\s+/g, ' ').trim();
        return await this.parseOneTimeReminder(userPhone, cleanedMsg, userTimezone, recentContact.phone);
      }

      // Check if reminder is for someone else
      let targetPhone = null;
      let targetName = null;

      const extractedTarget = this.extractTargetPhone(message, userPhone);
      let cleanedMessage = message;

      if (extractedTarget) {
        cleanedMessage = this.cleanMessageOfPhone(message, extractedTarget);
        if (typeof extractedTarget === 'string') {
          targetPhone = extractedTarget;
        } else if (extractedTarget.type === 'name') {
          targetName = extractedTarget.value;
          logger.info(`Looking up contact for target name: ${targetName}`);

          // Step 1: Try saved contacts first
          const contactResult = await contactService.resolveNameToPhone(userPhone, targetName);
          if (contactResult.found && !contactResult.ambiguous) {
            targetPhone = contactResult.phone;
            targetName = contactResult.name; // Use canonical name from contacts
            logger.info(`Resolved "${targetName}" from contacts → ${targetPhone}`);
          } else if (contactResult.found && contactResult.ambiguous) {
            // Multiple contact matches — return info for the controller to ask
            logger.info(`Ambiguous contact match for "${targetName}", ${contactResult.matches.length} found`);
            return {
              success: false,
              needsContactClarification: true,
              targetName,
              matches: contactResult.matches
            };
          } else {
            // Step 2: Fall back to direct memory lookup (bypasses AI privacy filter)
            logger.info(`No contact found for "${targetName}", trying direct memory lookup...`);
            targetPhone = await memoryService.findPhoneForName(userPhone, targetName);
            if (!targetPhone) {
              logger.info(`Could not resolve phone for "${targetName}" — not in contacts or memory`);
              return {
                success: false,
                needsPhoneNumber: true,
                targetName
              };
            }
            logger.info(`Resolved "${targetName}" from memory → ${targetPhone}`);
          }
        }
      }

      // Effective timezone: ALWAYS the sender's wall-clock.
      // See companion fix above for full rationale. Short version: "remind
      // Akash at 12:58" means 12:58 in the SENDER's timezone, not Akash's.
      const effectiveTimezone = userTimezone;
      if (targetPhone) {
        logger.info(`*** REMINDER FOR ANOTHER PERSON: ${targetPhone} (interpreting time in sender's tz=${userTimezone}) ***`);
      }

      // Check if recurring
      if (this.isRecurringRequest(cleanedMessage)) {
        logger.info(`Passing targetPhone to parseRecurringReminder: ${targetPhone}`);
        return await this.parseRecurringReminder(userPhone, cleanedMessage, effectiveTimezone, targetPhone);
      }

      logger.info(`Passing targetPhone to parseOneTimeReminder: ${targetPhone}`);
      return await this.parseOneTimeReminder(userPhone, cleanedMessage, effectiveTimezone, targetPhone);

    } catch (error) {
      logger.error('Parse error:', error);
      return { success: false };
    }
  }

  isRecurringRequest(message) {
    const lower = message.toLowerCase();
    return /every\s*(day|daily|morning|evening|night|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|week|weekday|weekend)|everyday|daily\s+at|weekday|weekend|har\s*din|rozana|roz\s|roz\b|pratidina|hamesha|chaque\s+jour|cada\s+d[ií]a|jeden\s+tag|ogni\s+giorno/i.test(lower);
  }

  // ========== ONE-TIME REMINDER ==========
  async parseOneTimeReminder(userPhone, message, timezone, targetPhone = null) {
    const aiResult = await this.parseWithAI(message, timezone);

    if (aiResult.success) {
      logger.info(`AI parsed: ${aiResult.reminderTime.toISOString()}`);
      logger.info(`Message: "${aiResult.reminderMessage}"`);

      // if AI returned a targetPhone, use it (though in our flow targetPhone is resolved before AI step usually)
      let finalTargetPhone = aiResult.targetPhone || targetPhone;

      // Extract phone from contacts/memory if AI caught a targetName but we have no phone
      if (!finalTargetPhone && aiResult.targetName && aiResult.targetName.toLowerCase() !== 'me' && aiResult.targetName.toLowerCase() !== 'us') {
        const targetSearchName = aiResult.targetName;

        logger.info(`AI caught a target name "${targetSearchName}", looking up in contacts...`);

        // Try contacts first
        const contactResult = await contactService.resolveNameToPhone(userPhone, targetSearchName);
        if (contactResult.found && !contactResult.ambiguous) {
          finalTargetPhone = contactResult.phone;
          logger.info(`Resolved AI targetName "${targetSearchName}" from contacts → ${finalTargetPhone}`);
        } else if (!contactResult.found) {
          // Fall back to direct memory lookup (bypasses AI privacy filter)
          logger.info(`Not in contacts, trying direct memory lookup for "${targetSearchName}"...`);
          finalTargetPhone = await memoryService.findPhoneForName(userPhone, targetSearchName);
          if (finalTargetPhone) {
            logger.info(`Resolved AI targetName "${targetSearchName}" from memory → ${finalTargetPhone}`);
          }
        }
      }

      // Check if reminder message is too vague
      const msg = (aiResult.reminderMessage || '').trim().toLowerCase();
      if (!msg || msg.length < 2 || /^(reminder|no specific|nothing|undefined|null|n\/a)$/i.test(msg)) {
        return { success: false, needsClarification: true, time: aiResult.reminderTime };
      }

      const saved = await this.createReminder(userPhone, aiResult.reminderMessage, aiResult.reminderTime, finalTargetPhone);

      if (saved) {
        return {
          success: true,
          reminderId: saved.id,
          message: aiResult.reminderMessage,
          time: aiResult.reminderTime,
          targetPhone: finalTargetPhone,
          ambiguousTimeResolved: aiResult.ambiguousTimeResolved || null
        };
      }
    }

    // Fallback to regex
    logger.info(`AI failed, falling back to regex. Using targetPhone: ${targetPhone}`);
    const regexResult = this.parseWithRegex(message, timezone);
    if (regexResult.success) {
      logger.info(`Regex parsed time: ${regexResult.reminderTime} message: ${regexResult.reminderMessage} passing targetPhone: ${targetPhone}`);
      const saved = await this.createReminder(userPhone, regexResult.reminderMessage, regexResult.reminderTime, targetPhone);
      if (saved) {
        return {
          success: true,
          reminderId: saved.id,
          message: regexResult.reminderMessage,
          time: regexResult.reminderTime,
          targetPhone,
          targetName: null
        };
      }
    }

    return { success: false };
  }

  // ========== PARSE ONLY (no DB insert) — used for team broadcasts ==========
  async parseReminderTimeAndMessage(userPhone, message, timezone) {
    try {
      const aiResult = await this.parseWithAI(message, timezone);
      if (aiResult.success) {
        const msg = (aiResult.reminderMessage || '').trim();
        if (msg && msg.length >= 2) {
          return { success: true, reminderMessage: msg, reminderTime: aiResult.reminderTime };
        }
      }
      const regexResult = this.parseWithRegex(message, timezone);
      if (regexResult.success) {
        return { success: true, reminderMessage: regexResult.reminderMessage, reminderTime: regexResult.reminderTime };
      }
      return { success: false };
    } catch (e) {
      logger.error('parseReminderTimeAndMessage error:', e);
      return { success: false };
    }
  }

  async parseWithAI(message, timezone) {
    try {
      const now = new Date();

      // Pre-process time expressions that confuse the AI
      // "tonight 10pm" / "10pm tonight" → always means today at 22:00 (not "in 10 hours")
      let processedMessage = message
        .replace(/\btonight\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi, (_, h, m, ap) => {
          let hrs = parseInt(h);
          if (ap.toLowerCase() === 'pm' && hrs < 12) hrs += 12;
          if (ap.toLowerCase() === 'am' && hrs === 12) hrs = 0;
          return `at ${hrs}:${(m || '00').padStart(2, '0')} today`;
        })
        .replace(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s+tonight\b/gi, (_, h, m, ap) => {
          let hrs = parseInt(h);
          if (ap.toLowerCase() === 'pm' && hrs < 12) hrs += 12;
          if (ap.toLowerCase() === 'am' && hrs === 12) hrs = 0;
          return `at ${hrs}:${(m || '00').padStart(2, '0')} today`;
        })
        // "this evening" / "this morning" → disambiguate time-of-day
        .replace(/\bthis\s+evening\b/gi, 'tonight')
        .replace(/\bthis\s+morning\b/gi, 'today morning')
        // FIX #7 (Apr 27 2026 — Bucket A06): expand "in N days" / "in N hours"
        // / "in N weeks" relative phrases into minutes_from_now equivalents
        // BEFORE the LLM sees them. The LLM's schema only supports
        // minutes_from_now / specific_time, so multi-day relatives like "in 2
        // days" were silently rejected with "Couldn't understand the time".
        .replace(/\bin\s+(\d+)\s+days?\b/gi, (_, n) => `in ${parseInt(n) * 24 * 60} minutes`)
        .replace(/\bin\s+(\d+)\s+weeks?\b/gi, (_, n) => `in ${parseInt(n) * 7 * 24 * 60} minutes`)
        .replace(/\bin\s+(\d+)\s+hours?\b/gi, (_, n) => `in ${parseInt(n) * 60} minutes`);

      const localTime = now.toLocaleString('en-IN', { timeZone: timezone });

      const taskModel = llm.modelFor('reminder_parse') || model;
      const response = await llm.chatCompletion({
        model: taskModel,
        messages: [
          { role: 'system', content: `Parse reminder from user message. Output ONLY valid JSON.

CRITICAL RULES:
1. "reminder_message" must contain ONLY the action/task to be reminded about. Strip command words (remind, set reminder, alert, yaad dilana, bhejna), time expressions, phone numbers, and recipient info.
2. Users write in English, Hindi, Hinglish (Hindi+English mix), and many other languages. You MUST understand ALL of them.
3. HINGLISH IS VERY COMMON. Key Hinglish/Hindi words:
   - "mein" / "me" in Hindi = "in/about/what" (NOT the English "me"). Example: "10:30 mein kya ladle" = "what to bring at 10:30"
   - "ke liye" = "for" (person). "somnath ke liye" = "for somnath"
   - "ko" = "to/at". "5 baje ko" = "at 5 o'clock"
   - "baje" = "o'clock". "7 baje" = "at 7"
   - "kal" = "tomorrow", "aaj" = "today", "parso" = "day after tomorrow"
   - "subah" = "morning", "shaam/sham" = "evening", "dopahar" = "afternoon", "raat" = "night"
   - "yaad dilana/dilao" = "remind". "yaad rakhna" = "remember"
   - "karo/kar" = "do". "set karo" = "set it"
   - "bhejna/bhej" = "send". "reminder bhejna" = "send reminder"
   - "kya ladle/kya laye/kya lana" = "what to bring"
   - "ak/ek" = "one/a"
   - "ghante" = "hours", "minute/min" = "minutes"
4. When user says "X ke liye reminder ... [message]", X is the TARGET PERSON, and the part after time is the reminder message.
4b. ★★ CRITICAL TARGET RULE ★★ If the message is "call X at Y" / "meet X at Y" / "email X at Y" / "message X at Y" — X is NOT the target_name. The USER wants to be reminded to do the action (call, meet, email) TO X. Set target_name=null. Example: "call mahaprasad at 6pm" → {target_name: null, reminder_message: "call mahaprasad"}. WRONG: target_name="mahaprasad". ONLY set target_name when user EXPLICITLY delegates the reminder — e.g., "remind Rahul at 5pm", "Rahul ko reminder bhejna", "X ke liye reminder".
5. "mein" / "me" / "ma" after a time (e.g., "10:30 mein", "12:10 am ma") means "at/in" — it is NOT a person name or English "me".
6. Parse time in 24hr format. CRITICAL AM/PM RULES:
   - "12:10 am" = "00:10" (midnight). "12:10 pm" = "12:10" (noon).
   - "1 am" = "01:00", "1 pm" = "13:00"
   - If user explicitly says "am" or "pm", ALWAYS respect it.
   - "10:30" without am/pm: check context — "subah" = morning, "shaam/raat" = evening/night.
7. COMMA-SEPARATED MESSAGES: When user writes "[command], [message]" — the part AFTER the comma is usually the actual reminder message. Example: "reminder bhejna aj, bhabhi ji namaste" → message is "bhabhi ji namaste", NOT "bhejna".
8. "bhejna" / "bhej" = "send" (command word, NOT a message). "karo" / "kar" = "do" (command word). Strip these from reminder_message.
9. ABSOLUTE DATES → "specific_date" (YYYY-MM-DD). If the user mentions a specific calendar date — "19th May", "May 19", "Dec 25", "12/25", "next Friday", "this Saturday", "parso/day after tomorrow", "in 3 days" — set "specific_date" to the resolved date in YYYY-MM-DD form, using the Current date you're given for year disambiguation:
   - "19th May" / "May 19" / "May 19th" → "YYYY-05-19" (use the year that makes it FUTURE; if May 19 has already passed this year, use next year)
   - "December 25" / "25 December" / "12/25" → "YYYY-12-25" (same future-only rule)
   - "next Friday" → the next Friday strictly after today
   - "this Saturday" → the upcoming Saturday (today if today is Saturday and time hasn't passed, else the next one)
   - "parso" / "day after tomorrow" → today + 2 days
   - "in 3 days" / "3 days later" → today + 3 days
   - IMPORTANT: "tomorrow" / "kal" ALONE keeps using is_tomorrow=true and specific_date=null. Only use specific_date for dates that are NOT today and NOT tomorrow.
   - When specific_date is set, is_tomorrow MUST be false.

Examples:
- "call mahaprasad at 6pm" → {"minutes_from_now": null, "specific_time": "18:00", "is_tomorrow": false, "reminder_message": "call mahaprasad", "target_name": null, "target_phone": null}  ★ SELF-reminder ★
- "meet emily tomorrow at 10am" → {"minutes_from_now": null, "specific_time": "10:00", "is_tomorrow": true, "reminder_message": "meet emily", "target_name": null, "target_phone": null}  ★ SELF-reminder ★
- "remind me at 5pm to call mom" → {"minutes_from_now": null, "specific_time": "17:00", "is_tomorrow": false, "reminder_message": "call mom", "target_name": null, "target_phone": null}
- "somnath ke liye 10:30 ka reminder set karo, mein kya ladle" → {"minutes_from_now": null, "specific_time": "10:30", "is_tomorrow": false, "reminder_message": "kya ladle", "target_name": "somnath", "target_phone": null}
- "somnath ke liye ak reminder bhejna 10:30 mein kya ladle" → {"minutes_from_now": null, "specific_time": "10:30", "is_tomorrow": false, "reminder_message": "kya ladle", "target_name": "somnath", "target_phone": null}
- "somnath ko 12:10 am ma reminder bhejna aj, bhabhi ji namaste" → {"minutes_from_now": null, "specific_time": "00:10", "is_tomorrow": false, "reminder_message": "bhabhi ji namaste", "target_name": "somnath", "target_phone": null}
- "kal subah 7 baje yaad dilana gym jaana hai" → {"minutes_from_now": null, "specific_time": "07:00", "is_tomorrow": true, "reminder_message": "gym jaana hai", "target_name": null, "target_phone": null}
- "bhai mujhe kal 9 baje yaad dilana office jaana hai" → {"minutes_from_now": null, "specific_time": "09:00", "is_tomorrow": true, "reminder_message": "office jaana hai", "target_name": null, "target_phone": null}
- "30 min baad call karna hai" → {"minutes_from_now": 30, "specific_time": null, "is_tomorrow": false, "reminder_message": "call karna hai", "target_name": null, "target_phone": null}
- "remind emily at 6pm to call me back" → {"minutes_from_now": null, "specific_time": "18:00", "is_tomorrow": false, "reminder_message": "call me back", "target_name": "emily", "target_phone": null}
- "rappeler à 15h d'appeler le médecin" → {"minutes_from_now": null, "specific_time": "15:00", "is_tomorrow": false, "reminder_message": "appeler le médecin", "target_name": null, "target_phone": null}
- "recuérdame a las 3pm comprar leche" → {"minutes_from_now": null, "specific_time": "15:00", "is_tomorrow": false, "reminder_message": "comprar leche", "target_name": null, "target_phone": null}
(For the next 4 examples assume Current is 2026-05-15 IST. In your real reply, recompute "specific_date" from the actual Current shown in the user message. Always emit a real YYYY-MM-DD string — never a placeholder, never with angle brackets.)
- "remind me on 19th May at 11:55am to take rabish injection" → {"minutes_from_now": null, "specific_time": "11:55", "specific_date": "2026-05-19", "is_tomorrow": false, "reminder_message": "take rabish injection", "target_name": null, "target_phone": null}
- "remind me on December 25 at 9am to wish family" → {"minutes_from_now": null, "specific_time": "09:00", "specific_date": "2026-12-25", "is_tomorrow": false, "reminder_message": "wish family", "target_name": null, "target_phone": null}
- "remind me next Friday at 6pm to submit report" → {"minutes_from_now": null, "specific_time": "18:00", "specific_date": "2026-05-22", "is_tomorrow": false, "reminder_message": "submit report", "target_name": null, "target_phone": null}
- "parso 10 baje gym jaana hai" → {"minutes_from_now": null, "specific_time": "10:00", "specific_date": "2026-05-17", "is_tomorrow": false, "reminder_message": "gym jaana hai", "target_name": null, "target_phone": null}` },
          {
            role: 'user', content: `Current: ${localTime} (${timezone})
Message: "${processedMessage}"

JSON: {"minutes_from_now": number|null, "specific_time": "HH:MM"|null, "specific_date": "YYYY-MM-DD"|null, "is_tomorrow": bool, "reminder_message": "extracted action only", "target_name": "name"|null, "target_phone": "phone"|null}` }
        ],
        temperature: 0.1,
        max_tokens: 200,
      }, { task: 'reminder_parse', timeout: 10000 });

      try {
        const tracker = require('./model-usage-tracker.service');
        tracker.log({ task: 'reminder_parse', model: taskModel, usage: response?.data?.usage });
      } catch (_) {}

      const content = response.data.choices[0].message.content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { success: false };

      const parsed = JSON.parse(jsonMatch[0]);

      // Sanity-overrides for date/time fields the LLM is unreliable about.
      // Gemini Flash in particular drops "tomorrow" in mixed-language sentences
      // and silently omits specific_date for explicit calendar dates ("25th
      // May", "next Friday"). We post-process with deterministic regex so the
      // bot's behavior doesn't depend on the model's mood.
      try {
        const lower = message.toLowerCase();

        // (1) Absolute-date regex extractor — runs BEFORE tomorrow/parso so
        // explicit calendar dates always beat day-relative phrases.
        if (!parsed.specific_date) {
          const detected = this.extractAbsoluteDate(message, timezone);
          if (detected) {
            parsed.specific_date = detected;
            parsed.is_tomorrow = false;
            logger.warn(`Reminder parse: LLM omitted specific_date — regex extracted "${detected}" from message`);
          }
        }

        // (2) "tomorrow" / "kal" override — but only if no specific_date wins above.
        const saidTomorrow = /\b(tomorrow|tmrw|tmr|kal)\b/i.test(lower)
          && !/\b(parso|day\s+after\s+tomorrow)\b/i.test(lower);
        const saidParso = /\b(parso|day\s+after\s+tomorrow)\b/i.test(lower);
        if (saidTomorrow && parsed.is_tomorrow === false && !parsed.specific_date) {
          logger.warn(`Reminder parse: user said "tomorrow" but LLM returned is_tomorrow=false — overriding`);
          parsed.is_tomorrow = true;
        }
        if (saidParso && !parsed.specific_date) {
          const nowLocal = this.getZonedParts(new Date(), timezone);
          const dayAfter = this.addDaysInZone(nowLocal, 2, timezone);
          parsed.specific_date = `${dayAfter.year}-${String(dayAfter.month).padStart(2, '0')}-${String(dayAfter.day).padStart(2, '0')}`;
          parsed.is_tomorrow = false;
          logger.warn(`Reminder parse: user said "parso/day after tomorrow" — setting specific_date=${parsed.specific_date}`);
        }
      } catch (e) {
        logger.warn(`Reminder parse: date sanity-check failed (non-fatal): ${e.message}`);
      }

      let reminderTime;

      if (parsed.minutes_from_now) {
        reminderTime = new Date(Date.now() + parsed.minutes_from_now * 60 * 1000);
      } else if (parsed.specific_time) {
        let [hours, minutes] = parsed.specific_time.split(':').map(Number);

        // Detect whether the user explicitly said am / pm / morning / night etc.
        // If not, AND the given hour is in the 1-12 range, we'll use the
        // nearest-AM/PM resolver below so the user isn't silently rolled to
        // tomorrow when they meant "tonight".
        const lowerMsg = message.toLowerCase();
        const explicitAm = /\b\d{1,2}(?::\d{2})?\s*am\b/i.test(lowerMsg);
        const explicitPm = /\b\d{1,2}(?::\d{2})?\s*pm\b/i.test(lowerMsg);
        const qualifierMorning = /\b(morning|subah|sabah|dawn|early)\b/i.test(lowerMsg);
        const qualifierEvening = /\b(evening|night|tonight|raat|shaam|sham|pm)\b/i.test(lowerMsg);
        const has24HourSignal = hours >= 13 || /\b(\d{1,2}):(\d{2})\b/.test(lowerMsg) && hours >= 13;
        const explicitAmPm = explicitAm || explicitPm;
        const hasQualifier = qualifierMorning || qualifierEvening;
        const isAmbiguous = !explicitAmPm && !hasQualifier && !has24HourSignal
          && hours >= 1 && hours <= 12 && !parsed.is_tomorrow;

        // Explicit AM/PM — respect it (existing behavior).
        if (explicitAm && hours === 12) {
          hours = 0;
          logger.info(`AM/PM fix: user said AM, correcting hour 12 → 0`);
        } else if (explicitPm && hours < 12) {
          hours += 12;
          logger.info(`AM/PM fix: user said PM, correcting hour ${hours - 12} → ${hours}`);
        }

        // Bug-2 fix: explicit calendar date wins over today/tomorrow guessing.
        // The schema used to be is_tomorrow=bool only, so dates like "19th May"
        // collapsed to today/tomorrow. Now the LLM emits specific_date=YYYY-MM-DD
        // when the user names a date, and we honor it directly.
        if (parsed.specific_date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.specific_date)) {
          const [y, mo, d] = parsed.specific_date.split('-').map(Number);
          // Sanity: month 1-12, day 1-31. Defer real validity (Feb 30 etc.) to
          // zonedWallTimeToUtcDate, which normalizes via Date.UTC arithmetic.
          if (y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
            reminderTime = this.zonedWallTimeToUtcDate(
              { year: y, month: mo, day: d, hour: hours, minute: minutes, second: 0 },
              timezone
            );
            // Reject past dates — the LLM occasionally picks a stale year.
            // 60s grace so a reminder set for "11:55am today" right at 11:54:30 still works.
            if (reminderTime.getTime() < Date.now() - 60 * 1000) {
              logger.warn(`Reminder parse: explicit date ${parsed.specific_date} ${parsed.specific_time} resolves to the past — rejecting`);
              return { success: false, reason: 'past_date' };
            }
            logger.info(`Reminder parse: using explicit date ${parsed.specific_date} ${parsed.specific_time} (${timezone})`);
            return {
              success: true,
              reminderTime,
              reminderMessage: parsed.reminder_message || 'Reminder',
              targetName: parsed.target_name || null,
              targetPhone: parsed.target_phone || null
            };
          }
          logger.warn(`Reminder parse: specific_date out of range, ignoring: ${parsed.specific_date}`);
        }

        if (isAmbiguous) {
          // User said "10:30" with no AM/PM/morning/night qualifier — pick the
          // NEAREST FUTURE occurrence across today-AM / today-PM / tomorrow-AM / tomorrow-PM.
          // This replaces the old "if hour passed, roll to tomorrow" behavior
          // which silently shifted reminders by 12-24 hours in the common case.
          try {
            const { resolveAmbiguousTime } = require('../utils/tool-validation');
            const ambRes = await resolveAmbiguousTime({
              hour12: hours === 0 ? 12 : hours,
              minute: minutes,
              userPhone: '__dummy__',    // real phone not used; we pass timezone via userPhone lookup
              now: new Date()
            });
            // resolveAmbiguousTime uses the passed phone's tz, but we want `timezone` (this arg).
            // Easy path: recompute candidates here locally to honor the explicit `timezone`.
            const nowLocal = this.getZonedParts(new Date(), timezone);
            const amHour = hours === 0 || hours === 12 ? (hours === 12 ? 0 : 0) : hours;
            const pmHour = hours === 12 ? 12 : hours + 12;
            const tomorrow = this.addDaysInZone(nowLocal, 1, timezone);
            const cands = [
              { label: 'am-today',    at: this.zonedWallTimeToUtcDate({ ...nowLocal, hour: amHour, minute: minutes, second: 0 }, timezone) },
              { label: 'pm-today',    at: this.zonedWallTimeToUtcDate({ ...nowLocal, hour: pmHour, minute: minutes, second: 0 }, timezone) },
              { label: 'am-tomorrow', at: this.zonedWallTimeToUtcDate({ ...tomorrow, hour: amHour, minute: minutes, second: 0 }, timezone) },
              { label: 'pm-tomorrow', at: this.zonedWallTimeToUtcDate({ ...tomorrow, hour: pmHour, minute: minutes, second: 0 }, timezone) }
            ].map(c => ({ ...c, deltaMs: c.at.getTime() - Date.now() })).filter(c => c.deltaMs > 0).sort((a, b) => a.deltaMs - b.deltaMs);
            if (cands.length === 0) {
              // All candidates in past (shouldn't be possible with tomorrow set); bail.
              return { success: false };
            }
            reminderTime = cands[0].at;
            logger.info({ picked: cands[0].label, deltaMin: Math.round(cands[0].deltaMs / 60000) },
              `Nearest AM/PM resolved (ambiguous "${parsed.specific_time}")`);
            // NOTE: we also store the ambiguity signal in case caller wants to confirm with user.
            return {
              success: true,
              reminderTime,
              reminderMessage: parsed.reminder_message || 'Reminder',
              targetName: parsed.target_name || null,
              targetPhone: parsed.target_phone || null,
              ambiguousTimeResolved: cands[0].label
            };
          } catch (e) {
            logger.warn(`nearest-AM/PM resolver failed, falling back to original logic: ${e.message}`);
            // Fall through to the original branch below
          }
        }

        const nowLocal = this.getZonedParts(new Date(), timezone);
        let targetDate = { year: nowLocal.year, month: nowLocal.month, day: nowLocal.day };
        let silentRollMinutes = 0;  // >0 if we silently rolled into tomorrow

        if (parsed.is_tomorrow || (hours * 60 + minutes) <= (nowLocal.hour * 60 + nowLocal.minute)) {
          // Only flag as "silent roll" when the USER did NOT explicitly
          // say tomorrow — that's the ambiguous case where the rollforward
          // might surprise them.
          if (!parsed.is_tomorrow) {
            const minutesPast = (nowLocal.hour * 60 + nowLocal.minute) - (hours * 60 + minutes);
            silentRollMinutes = minutesPast;
          }
          targetDate = this.addDaysInZone(nowLocal, 1, timezone);
        }

        reminderTime = this.zonedWallTimeToUtcDate({ ...targetDate, hour: hours, minute: minutes, second: 0 }, timezone);

        // Surface a rollforward flag when the user said "today at X" but X
        // was >6 hours in the past. The handler can use this to confirm
        // ("I scheduled for tomorrow — or did you mean a later time?")
        // instead of silently committing.
        if (silentRollMinutes > 360) {
          return {
            success: true,
            reminderTime,
            reminderMessage: parsed.reminder_message || 'Reminder',
            targetName: parsed.target_name || null,
            targetPhone: parsed.target_phone || null,
            silentRollForward: {
              rolledFrom: `${hours}:${String(minutes).padStart(2, '0')} today`,
              rolledTo: `${hours}:${String(minutes).padStart(2, '0')} tomorrow`,
              hoursPast: Math.round(silentRollMinutes / 60)
            }
          };
        }
      } else {
        return { success: false };
      }

      return {
        success: true,
        reminderTime,
        reminderMessage: parsed.reminder_message || 'Reminder',
        targetName: parsed.target_name || null,
        targetPhone: parsed.target_phone || null
      };
    } catch (error) {
      logger.error('AI parse error:', error.message);
      return { success: false };
    }
  }

  parseWithRegex(message, timezone) {
    const lower = message.toLowerCase();
    let reminderTime = null;
    let reminderMessage = message;
    let isTomorrow = /\b(tomorrow|kal|parso)\b/i.test(lower);

    // "in X minutes"
    const inMatch = lower.match(/(?:in|after)\s+(\d+)\s*(min|hour|hr)/i);
    if (inMatch) {
      let mins = parseInt(inMatch[1]);
      if (inMatch[2].includes('hour') || inMatch[2].includes('hr')) mins *= 60;
      reminderTime = new Date(Date.now() + mins * 60 * 1000);
      reminderMessage = this.extractMessage(message);
    }

    // "X min baad/later/mein" (Hindi: "5 min baad")
    const baadMatch = lower.match(/(\d+)\s*(min|hour|ghante?)\s*(baad|later|mein|me)/i);
    if (!reminderTime && baadMatch) {
      let mins = parseInt(baadMatch[1]);
      if (baadMatch[2].includes('hour') || baadMatch[2].includes('ghant')) mins *= 60;
      reminderTime = new Date(Date.now() + mins * 60 * 1000);
      reminderMessage = this.extractMessage(message);
    }

    // "X baje" (Hindi: "7 baje" = at 7 o'clock)
    const bajeMatch = lower.match(/(\d{1,2})(?::(\d{2}))?\s*baje/i);
    if (!reminderTime && bajeMatch) {
      let hours = parseInt(bajeMatch[1]);
      const minutes = parseInt(bajeMatch[2] || '0');
      // Contextual am/pm: subah=morning, shaam/raat=evening/night
      if (/subah|morning/i.test(lower) && hours > 12) hours -= 12;
      if (/shaam|sham|evening|raat|night/i.test(lower) && hours < 12) hours += 12;

      const nowLocal = this.getZonedParts(new Date(), timezone);
      let targetDate = { year: nowLocal.year, month: nowLocal.month, day: nowLocal.day };
      if (isTomorrow) {
        targetDate = this.addDaysInZone(nowLocal, 1, timezone);
      } else if ((hours * 60 + minutes) <= (nowLocal.hour * 60 + nowLocal.minute)) {
        targetDate = this.addDaysInZone(nowLocal, 1, timezone);
      }
      reminderTime = this.zonedWallTimeToUtcDate({ ...targetDate, hour: hours, minute: minutes, second: 0 }, timezone);
      reminderMessage = this.extractMessage(message);
    }

    // Standalone "X:XX am/pm" or "X am/pm" without "at" prefix (e.g., "12:10 am ma")
    const standaloneAmPm = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
    if (!reminderTime && standaloneAmPm) {
      let hours = parseInt(standaloneAmPm[1]);
      const minutes = parseInt(standaloneAmPm[2] || '0');
      if (standaloneAmPm[3].toLowerCase() === 'pm' && hours < 12) hours += 12;
      if (standaloneAmPm[3].toLowerCase() === 'am' && hours === 12) hours = 0;

      const nowLocal = this.getZonedParts(new Date(), timezone);
      let targetDate = { year: nowLocal.year, month: nowLocal.month, day: nowLocal.day };
      if (isTomorrow || /\baaj\b|\baj\b|\btoday\b/i.test(lower)) {
        // "today/aaj/aj" — keep today unless time passed
        if ((hours * 60 + minutes) <= (nowLocal.hour * 60 + nowLocal.minute)) {
          targetDate = this.addDaysInZone(nowLocal, 1, timezone);
        }
      } else if ((hours * 60 + minutes) <= (nowLocal.hour * 60 + nowLocal.minute)) {
        targetDate = this.addDaysInZone(nowLocal, 1, timezone);
      }
      reminderTime = this.zonedWallTimeToUtcDate({ ...targetDate, hour: hours, minute: minutes, second: 0 }, timezone);
      reminderMessage = this.extractMessage(message);
    }

    // "at X pm" / "X:XX" / "X am/pm"
    const atMatch = lower.match(/(?:at|@|ka)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (!reminderTime && atMatch) {
      let hours = parseInt(atMatch[1]);
      const minutes = parseInt(atMatch[2] || '0');
      if (atMatch[3]?.toLowerCase() === 'pm' && hours < 12) hours += 12;
      if (atMatch[3]?.toLowerCase() === 'am' && hours === 12) hours = 0;
      // If no am/pm specified and time looks like it could be PM (1-6), assume PM
      if (!atMatch[3] && hours >= 1 && hours <= 6 && !/subah|morning/i.test(lower)) hours += 12;

      const nowLocal = this.getZonedParts(new Date(), timezone);
      let targetDate = { year: nowLocal.year, month: nowLocal.month, day: nowLocal.day };
      if (isTomorrow) {
        targetDate = this.addDaysInZone(nowLocal, 1, timezone);
      } else if ((hours * 60 + minutes) <= (nowLocal.hour * 60 + nowLocal.minute)) {
        targetDate = this.addDaysInZone(nowLocal, 1, timezone);
      }

      reminderTime = this.zonedWallTimeToUtcDate({ ...targetDate, hour: hours, minute: minutes, second: 0 }, timezone);
      reminderMessage = this.extractMessage(message);
    }

    // Bare time like "10:30" without "at" prefix (common in Hinglish: "10:30 mein kya ladle")
    const bareTimeMatch = lower.match(/\b(\d{1,2}):(\d{2})\b/);
    if (!reminderTime && bareTimeMatch) {
      let hours = parseInt(bareTimeMatch[1]);
      const minutes = parseInt(bareTimeMatch[2]);
      if (hours <= 23 && minutes <= 59) {
        if (/subah|morning/i.test(lower) && hours > 12) hours -= 12;
        if (/shaam|sham|evening|raat|night/i.test(lower) && hours < 12) hours += 12;

        const nowLocal = this.getZonedParts(new Date(), timezone);
        let targetDate = { year: nowLocal.year, month: nowLocal.month, day: nowLocal.day };
        if (isTomorrow) {
          targetDate = this.addDaysInZone(nowLocal, 1, timezone);
        } else if ((hours * 60 + minutes) <= (nowLocal.hour * 60 + nowLocal.minute)) {
          targetDate = this.addDaysInZone(nowLocal, 1, timezone);
        }
        reminderTime = this.zonedWallTimeToUtcDate({ ...targetDate, hour: hours, minute: minutes, second: 0 }, timezone);
        reminderMessage = this.extractMessage(message);
      }
    }

    if (!reminderTime) return { success: false };
    return { success: true, reminderTime, reminderMessage: reminderMessage || 'Reminder' };
  }

  /**
   * Strip imperative reminder-verbs that the LLM sometimes leaves attached to
   * the extracted reminder_message. Designed to be safe to run on any string —
   * it only removes recognised verb tails/heads, never the substantive content.
   *
   * Examples:
   *   "gym jaane ki yaad dilao"  → "gym jaane ki"
   *   "remind me to call mom"    → "call mom"
   *   "गोली खाने की याद दिलाओ"   → "गोली खाने की"
   *   "call dad at 7pm"          → "call dad" (time tail also removed)
   */
  _stripReminderVerbs(text) {
    if (!text || typeof text !== 'string') return text;
    let out = text.trim();

    // English head-verbs: "remind me to ...", "remind X to ..."
    out = out.replace(/^remind(\s+(me|us|mujhe|\+?\d[\d\s-]{7,}))?\s+(to|that|of|about)\s+/i, '');
    out = out.replace(/^(set\s+)?(a\s+|ak\s+|ek\s+)?reminder\s+(to|for|that|about|of)\s+/i, '');

    // Hinglish / Hindi tail-verbs: "... yaad dilao/dila/dilana/dilade/dila do/dilana hai"
    // and Devanagari "याद दिलाओ/दिला/दिलाना/दिला दो"
    out = out.replace(/\s*\b(ki\s+|ka\s+|ke\s+|kee\s+)?yaad\s*(dilana|dilao|dila(?:\s+do)?|dilade|rakhna|rakho)\s*(hai|chahiye|chahiy)?\s*$/i, '');
    out = out.replace(/\s*\bya[ae]?d\s+rakh(na|o|en)?\s*$/i, '');
    out = out.replace(/\s*याद\s*(दिलाओ|दिला|दिलाना|दिला\s+दो|दिलादे|रखना|रखो)\s*(है|चाहिए)?\s*$/u, '');

    // Hinglish tail-verbs: "... set karo/kar do/lagao/bhej do/bhejna"
    out = out.replace(/\s*\b(set\s*(karo|kar\s*do|kr\s*do)?|lagao|bhej(\s*do|na)?)\s*$/i, '');

    // Trailing "ko" connector ("X ko" → "X")
    out = out.replace(/\s+ko\s*$/i, '');

    // Trailing punctuation/whitespace + collapse spaces
    out = out.replace(/[\s,.;:!?]+$/g, '').replace(/\s{2,}/g, ' ').trim();

    // If we stripped down to nothing, return the original
    return out.length >= 2 ? out : text.trim();
  }

  extractMessage(msg) {
    // If message has a comma, the part after the last comma is often the actual message
    // e.g., "somnath ko 12:10 am ma reminder bhejna aj, bhabhi ji namaste" → "bhabhi ji namaste"
    const commaIdx = msg.lastIndexOf(',');
    if (commaIdx > 0) {
      const afterComma = msg.slice(commaIdx + 1).trim();
      // Only use after-comma part if it looks like actual content (not a time/command)
      if (afterComma.length >= 3 && !/^\d{1,2}(:\d{2})?\s*(am|pm)?$/i.test(afterComma) && !/^(at|in|on|by|set|remind)\b/i.test(afterComma)) {
        return afterComma;
      }
    }

    let cleaned = msg
      // Remove target name patterns FIRST: "X ke liye" (before other cleanups consume "ke liye")
      .replace(/\b[a-zA-Z]+\s+ke\s+liye\s*/gi, '')
      // Remove Hinglish command phrases (before generic "reminder" removal to avoid partial matches)
      .replace(/\b(ke\s+liye\s+)?(ak|ek)\s+reminder\s+(set\s*karo?|bhejna|bhej)\s*/gi, '')
      .replace(/^(yaad\s*(dilana|dilao|dila|rakhna)|reminder\s*(set\s*karo?|bhejna|bhej|lagao))\s*/gi, '')
      .replace(/\b(mujhe|hume|humko|bhai)\s+/gi, '')
      .replace(/\b(yaad\s*(dilana|dilao|dila))\b/gi, '')
      // Remove "set reminder", "remind me/us/+91...", "remind NAME"
      .replace(/^(set\s+)?(a\s+|ak\s+|ek\s+)?reminder\s*/gi, '')
      .replace(/remind\s+(me|us|mujhe|\+?\d[\d\s-]*)\s*/gi, '')
      .replace(/remind\s+[a-zA-Z]+\s+/gi, '') // "remind emily"
      // Remove time expressions (order matters — specific before general)
      .replace(/(?:in|after)\s+\d+\s*(min(ute)?s?|hours?|hrs?|ghante?|baje)/gi, '')
      .replace(/\d+\s*(min|hour|ghante?)\s*(baad|later)/gi, '')
      .replace(/(?:at|@)\s*\d{1,2}(:\d{2})?\s*(am|pm)?/gi, '')
      .replace(/\b\d{1,2}:\d{2}\s*(ka|ke|ki)?\s*/g, '')
      .replace(/\b\d{1,2}\s*baje\b/gi, '')
      .replace(/\b(tomorrow|kal|parso|today|aaj|subah|shaam|sham|raat|dopahar)\b/gi, '')
      // Remove target phone numbers
      .replace(/(?:for|to)\s+\+?\d[\d\s-]{7,}/gi, '')
      // Remove Hinglish filler/connectors at start
      .replace(/^[\s,.]*(to|that|for|ko|pe)\s+/i, '')
      // Remove trailing command words
      .replace(/[\s,.]*(karo?|kar|set|bhej|bhejna)\s*$/i, '')
      // "mein" at the start when preceded by time removal = part of the message, keep it
      // But "mein" right after a comma = separator, remove
      .replace(/^[\s,]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned || 'Reminder';
  }

  // ========== CREATE REMINDER ==========
  async createReminder(userPhone, message, reminderTime, targetPhone = null) {
    try {
      // Normalize: strip leading '+' so phone format is consistent (e.g. '917595977796')
      if (targetPhone) targetPhone = targetPhone.replace(/^\+/, '');

      // WHO RECEIVES = targetPhone if specified, else sender
      const sendTo = targetPhone || userPhone;

      // Detect priority from message
      let priority = 'normal';
      if (/\b(urgent|asap|critical|immediately|important)\b/i.test(message)) {
        priority = 'high';
      } else if (/\b(low\s*priority|whenever|no\s*rush)\b/i.test(message)) {
        priority = 'low';
      }

      logger.info(`=== Creating Reminder ===`);
      logger.info(`Created by: ${userPhone}`);
      logger.info(`Send to: ${sendTo}`);
      logger.info(`Time (UTC): ${reminderTime.toISOString()}`);
      logger.info(`Message: "${message}" [${priority}]`);

      const result = await query(
        `INSERT INTO reminders (user_phone, target_phone, message, reminder_time, status, created_at, is_recurring, priority)
         VALUES ($1, $2, $3, $4, 'pending', NOW(), FALSE, $5)
         RETURNING *`,
        [userPhone, sendTo, message, reminderTime.toISOString(), priority]
      );

      const reminder = result.rows[0];
      logger.info(`Reminder #${reminder.id} created → will be sent to ${sendTo}`);

      // Invalidate user-context cache so the new reminder shows up on next message.
      try { require('../utils/context-cache').bustMany([userPhone, sendTo]); } catch (e) { /* noop */ }

      return reminder;
    } catch (error) {
      logger.error('Create error:', error);
      return null;
    }
  }

  // ========== RECURRING ==========
  async parseRecurringReminder(userPhone, message, timezone, targetPhone = null) {
    // Use LLM to intelligently parse recurring reminders instead of fragile regex
    const { pattern, time, exceptDays, reminderMessage } = await this._parseRecurringWithLLM(message, timezone);

    const [hours, minutes] = time.split(':').map(Number);
    const nowLocal = this.getZonedParts(new Date(), timezone);
    let targetDate = { year: nowLocal.year, month: nowLocal.month, day: nowLocal.day };

    // For day-of-week patterns (weekly_mon, weekly_tue, etc.), advance to the NEXT occurrence
    const isWeeklyPattern = pattern.startsWith('weekly_');
    if (isWeeklyPattern) {
      const dayAbbrev = pattern.split('_')[1]; // e.g. "mon", "tue"
      const targetDayNum = this.dayMap[dayAbbrev];
      if (targetDayNum !== undefined) {
        const currentDayNum = new Date().getDay();
        let daysAhead = targetDayNum - currentDayNum;
        if (daysAhead < 0 || (daysAhead === 0 && (hours * 60 + minutes) <= (nowLocal.hour * 60 + nowLocal.minute))) {
          daysAhead += 7;
        }
        if (daysAhead > 0) {
          targetDate = this.addDaysInZone(nowLocal, daysAhead, timezone);
        }
      }
    } else if ((hours * 60 + minutes) <= (nowLocal.hour * 60 + nowLocal.minute)) {
      targetDate = this.addDaysInZone(nowLocal, 1, timezone);
    }

    const nextOccurrence = this.zonedWallTimeToUtcDate({ ...targetDate, hour: hours, minute: minutes, second: 0 }, timezone);
    const sendTo = targetPhone || userPhone;

    const result = await query(
      `INSERT INTO reminders (user_phone, target_phone, message, reminder_time, status, created_at, is_recurring, recurrence_pattern, recurrence_time, next_occurrence, except_days)
       VALUES ($1, $2, $3, $4, 'pending', NOW(), TRUE, $5, $6, $7, $8)
       RETURNING *`,
      [userPhone, sendTo, reminderMessage, nextOccurrence.toISOString(), pattern, time, nextOccurrence.toISOString(), exceptDays]
    );

    logger.info(`Recurring reminder #${result.rows[0].id} created for ${sendTo}${exceptDays ? ` (except: ${exceptDays})` : ''}`);

    return { success: true, isRecurring: true, message: reminderMessage, pattern, time: nextOccurrence, targetPhone, exceptDays: exceptDays ? exceptDays.split(',') : null };
  }

  /**
   * Use LLM to parse recurring reminder — extracts schedule, except-days, and clean reminder text.
   * Falls back to regex if LLM fails.
   */
  async _parseRecurringWithLLM(message, timezone) {
    let pattern = 'daily';
    let time = '09:00';
    let exceptDays = null;
    let reminderMessage = 'Reminder';

    try {
      const apiKey = llm.apiKey();
      if (!apiKey) return this._parseRecurringWithRegex(message);

      const apiUrl = llm.chatUrl();
      const model = llm.fastModel();

      const response = await axios.post(apiUrl, {
        model,
        messages: [
          {
            role: 'system',
            content: `You parse recurring reminder messages. Extract ONLY the actual reminder content — strip all scheduling instructions.

Return JSON:
{
  "pattern": "daily" | "weekdays" | "weekends" | "weekly" | "weekly_mon" | "weekly_tue" | "weekly_wed" | "weekly_thu" | "weekly_fri" | "weekly_sat" | "weekly_sun",
  "time": "HH:MM" (24hr format),
  "except_days": ["sun","mon",...] or null (days to SKIP),
  "reminder_message": "the actual thing to be reminded about"
}

Rules:
- "every day" / "daily" / "har din" / "rozana" → pattern: "daily"
- "every weekday" → pattern: "weekdays"
- "every weekend" → pattern: "weekends"
- "every Monday" → pattern: "weekly_mon"
- "except Sunday" → except_days: ["sun"]
- "except Saturday and Sunday" → except_days: ["sat","sun"]

For reminder_message:
- ONLY include what the user wants to be reminded ABOUT
- REMOVE all scheduling words: "remind me", "every day", "at 3 pm", "except sunday", "daily", "set reminder"
- REMOVE Hindi/Hinglish commands: "yaad dilana", "har din", "rozana"
- The reminder text is the ACTION or THING, not the instruction
- If no clear reminder text, use "Reminder"

Examples:
- "remind me every day at 3 pm except sunday to check message" → message: "check message", pattern: "daily", time: "15:00", except: ["sun"]
- "every morning at 9am remind me to take medicine" → message: "take medicine", pattern: "daily", time: "09:00", except: null
- "har din 8 baje yaad dilao exercise karo" → message: "exercise karo", pattern: "daily", time: "08:00", except: null
- "remind me every weekday at 10am to check emails" → message: "check emails", pattern: "weekdays", time: "10:00", except: null
- "every friday at 5pm remind me team standup" → message: "team standup", pattern: "weekly_fri", time: "17:00", except: null

Output ONLY valid JSON.`
          },
          { role: 'user', content: message }
        ],
        temperature: 0.1,
        max_tokens: 200,
      }, {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 10000,
      });

      const content = response.data.choices[0].message.content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        pattern = parsed.pattern || 'daily';
        time = parsed.time || '09:00';
        reminderMessage = parsed.reminder_message || 'Reminder';
        if (parsed.except_days && Array.isArray(parsed.except_days) && parsed.except_days.length > 0) {
          exceptDays = parsed.except_days.map(d => d.toLowerCase().slice(0, 3)).join(',');
        }
        logger.info(`[Reminder] LLM parsed recurring: pattern=${pattern}, time=${time}, except=${exceptDays}, msg="${reminderMessage}"`);
      } else {
        return this._parseRecurringWithRegex(message);
      }
    } catch (error) {
      logger.warn(`[Reminder] LLM recurring parse failed: ${error.message}, falling back to regex`);
      return this._parseRecurringWithRegex(message);
    }

    return { pattern, time, exceptDays, reminderMessage };
  }

  /**
   * Regex fallback for recurring reminder parsing (used when LLM is unavailable)
   */
  _parseRecurringWithRegex(message) {
    const lower = message.toLowerCase();
    let pattern = 'daily';
    let time = '09:00';

    const dayOfWeekMatch = lower.match(/every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i);
    if (dayOfWeekMatch) {
      pattern = `weekly_${dayOfWeekMatch[1].toLowerCase().slice(0, 3)}`;
    } else if (/every\s*week\b/i.test(lower)) {
      pattern = 'weekly';
    } else if (/weekday/i.test(lower)) {
      pattern = 'weekdays';
    } else if (/weekend/i.test(lower)) {
      pattern = 'weekends';
    }

    const timeMatch = lower.match(/(?:at|@)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1]);
      const minutes = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
      if (timeMatch[3]?.toLowerCase() === 'pm' && hours < 12) hours += 12;
      if (timeMatch[3]?.toLowerCase() === 'am' && hours === 12) hours = 0;
      time = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
    }

    let exceptDays = null;
    const exceptMatch = lower.match(/except\s+((?:(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)(?:\s*(?:,|and|&)\s*)?)+)/i);
    if (exceptMatch) {
      const dayNames = exceptMatch[1].match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)\b/gi);
      if (dayNames) {
        exceptDays = dayNames.map(d => d.toLowerCase().slice(0, 3)).join(',');
      }
    }

    const reminderMessage = message
      .replace(/\bevery\s*(day|daily|morning|evening|night|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|week|weekday|weekend)\b/gi, '')
      .replace(/\bdaily\b|\bremind\s+me\b|\bat\s+\d{1,2}(:\d{2})?\s*(am|pm)?\b/gi, '')
      .replace(/\bhar\s*din\b|\brozana?\b/gi, '')
      .replace(/\bexcept\s+((?:(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)(?:\s*(?:,|and|&)\s*)?)+)/gi, '')
      .trim() || 'Reminder';

    return { pattern, time, exceptDays, reminderMessage };
  }

  // ========== SCHEDULED MESSAGES ==========
  async createScheduledMessage(senderPhone, recipientPhone, message, sendTime) {
    try {
      const result = await query(
        `INSERT INTO reminders (user_phone, target_phone, message, reminder_time, status, created_at, is_recurring, message_type)
         VALUES ($1, $2, $3, $4, 'pending', NOW(), FALSE, 'scheduled_message')
         RETURNING *`,
        [senderPhone, recipientPhone, message, sendTime.toISOString()]
      );

      logger.info(`Scheduled message #${result.rows[0].id} from ${senderPhone} to ${recipientPhone} at ${sendTime.toISOString()}`);
      return result.rows[0];
    } catch (error) {
      logger.error('Error creating scheduled message:', error.message);
      return null;
    }
  }

  parseScheduledMessageCommand(message) {
    // "send message to Emily at 9am tomorrow: don't forget the report"
    const match = message.match(/^(?:send\s+(?:a\s+)?message|message)\s+(?:to\s+)?(\w+)\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)?\s*:\s*(.+)$/i);
    if (match) {
      return {
        recipientName: match[1].trim(),
        timeStr: match[2].trim(),
        dayStr: match[3] ? match[3].trim() : null,
        message: match[4].trim()
      };
    }

    // "schedule message to Emily at 9am: text"
    const schedMatch = message.match(/^schedule\s+(?:a\s+)?message\s+(?:to\s+)?(\w+)\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)?\s*:\s*(.+)$/i);
    if (schedMatch) {
      return {
        recipientName: schedMatch[1].trim(),
        timeStr: schedMatch[2].trim(),
        dayStr: schedMatch[3] ? schedMatch[3].trim() : null,
        message: schedMatch[4].trim()
      };
    }

    return null;
  }

  parseScheduledTime(timeStr, dayStr, timezone) {
    try {
      // Parse time
      let match = timeStr.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
      if (!match) return null;

      let hours = parseInt(match[1]);
      const minutes = match[2] ? parseInt(match[2]) : 0;
      const ampm = match[3]?.toLowerCase();

      if (ampm === 'pm' && hours < 12) hours += 12;
      if (ampm === 'am' && hours === 12) hours = 0;

      const nowLocal = this.getZonedParts(new Date(), timezone);
      let targetDate = { year: nowLocal.year, month: nowLocal.month, day: nowLocal.day };

      if (dayStr) {
        const lowerDay = dayStr.toLowerCase();
        if (lowerDay === 'tomorrow') {
          targetDate = this.addDaysInZone(nowLocal, 1, timezone);
        } else if (lowerDay !== 'today') {
          // Day of week
          const dayMap = { 'sunday': 0, 'monday': 1, 'tuesday': 2, 'wednesday': 3, 'thursday': 4, 'friday': 5, 'saturday': 6 };
          const targetDay = dayMap[lowerDay];
          if (targetDay !== undefined) {
            const currentDay = new Date().getDay();
            let daysAhead = targetDay - currentDay;
            if (daysAhead <= 0) daysAhead += 7;
            targetDate = this.addDaysInZone(nowLocal, daysAhead, timezone);
          }
        }
      } else {
        // No day specified - if time has passed, schedule for tomorrow
        if ((hours * 60 + minutes) <= (nowLocal.hour * 60 + nowLocal.minute)) {
          targetDate = this.addDaysInZone(nowLocal, 1, timezone);
        }
      }

      return this.zonedWallTimeToUtcDate({ ...targetDate, hour: hours, minute: minutes, second: 0 }, timezone);
    } catch (error) {
      logger.error('Error parsing scheduled time:', error.message);
      return null;
    }
  }

  // ========== HELPERS ==========
  async getPendingReminders(userPhone) {
    const result = await query(`SELECT * FROM reminders WHERE user_phone = $1 AND status = 'pending' ORDER BY reminder_time`, [userPhone]);
    return result.rows;
  }

  async getRecurringReminders(userPhone) {
    const result = await query(`SELECT * FROM reminders WHERE user_phone = $1 AND is_recurring = TRUE AND status != 'cancelled'`, [userPhone]);
    return result.rows;
  }

  async markAsCompleted(id, userPhone) {
    await query(`UPDATE reminders SET status = 'completed' WHERE id = $1 AND user_phone = $2`, [id, userPhone]);
  }

  async cancelRecurringReminder(id, userPhone) {
    await query(`UPDATE reminders SET status = 'cancelled' WHERE id = $1 AND user_phone = $2`, [id, userPhone]);
  }

  async cancelReminder(id, userPhone) {
    await query(`UPDATE reminders SET status = 'cancelled' WHERE id = $1 AND user_phone = $2`, [id, userPhone]);
  }

  async rescheduleReminder(id, newTime, userPhone) {
    // Fix: reminder_time is TIMESTAMPTZ, next_occurrence is TIMESTAMP. Using the
    // same $1 across both causes "inconsistent types deduced for parameter $1".
    // Use $1 for the TIMESTAMPTZ column and $2 for the TIMESTAMP column, both
    // with the same ISO string value.
    await query(
      `UPDATE reminders SET reminder_time = $1, next_occurrence = CASE WHEN is_recurring THEN $2 ELSE next_occurrence END WHERE id = $3 AND user_phone = $4`,
      [newTime.toISOString(), newTime.toISOString(), id, userPhone]
    );
  }

  // ========== SNOOZE ==========
  async snoozeReminder(userPhone, reminderId, snoozeMinutes = 10) {
    try {
      const snoozeUntil = new Date(Date.now() + snoozeMinutes * 60 * 1000);
      const result = await query(
        `UPDATE reminders SET snooze_until = $1, status = 'pending'
         WHERE id = $2 AND user_phone = $3 RETURNING *`,
        [snoozeUntil.toISOString(), reminderId, userPhone]
      );
      if (result.rows.length === 0) return { success: false, error: 'Reminder not found' };
      return { success: true, reminder: result.rows[0], snoozeUntil };
    } catch (error) {
      logger.error('Error snoozing reminder:', error.message);
      return { success: false, error: error.message };
    }
  }

  async snoozeLastReminder(userPhone, snoozeMinutes = 10) {
    try {
      const result = await query(
        `SELECT * FROM reminders WHERE user_phone = $1 AND status = 'sent'
         ORDER BY reminder_time DESC LIMIT 1`,
        [userPhone]
      );
      if (result.rows.length === 0) return { success: false, error: 'No recent reminder to snooze' };
      return await this.snoozeReminder(userPhone, result.rows[0].id, snoozeMinutes);
    } catch (error) {
      logger.error('Error snoozing last reminder:', error.message);
      return { success: false, error: error.message };
    }
  }
}

module.exports = new ReminderService();