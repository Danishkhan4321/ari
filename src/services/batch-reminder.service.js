const axios = require('axios');
const logger = require('../utils/logger');
const reminderService = require('./reminder.service');
const llm = require('./llm-provider');

const apiKey = llm.apiKey();
const apiUrl = llm.chatUrl();
const model = llm.fastModel();

class BatchReminderService {

  // Detect if message contains multiple reminders
  isBatchReminder(message) {
    const lower = message.toLowerCase();

    // Numbered list: "1. ... 2. ... 3. ..."
    if (/\b[1-3]\s*[.)]\s*.+\b[2-4]\s*[.)]/s.test(message)) return true;

    // "and" separated reminders with times
    if ((lower.match(/\bat\s+\d/g) || []).length >= 2) return true;
    if ((lower.match(/\bin\s+\d+\s*(min|hour)/g) || []).length >= 2) return true;

    // Explicit batch keywords
    if (/\b(multiple|batch|all these|set these)\s+reminder/i.test(lower)) return true;

    // Bullet or dash separated with times
    if (/[-*]\s*.+(?:at|in)\s+\d/m.test(message) && (message.match(/[-*]\s+/g) || []).length >= 2) return true;

    // Newline separated reminders each with time
    const lines = message.split('\n').filter(l => l.trim());
    if (lines.length >= 2) {
      const linesWithTime = lines.filter(l => /\d+\s*(am|pm|min|hour|baje)|at\s+\d/i.test(l));
      if (linesWithTime.length >= 2) return true;
    }

    return false;
  }

  // Parse and create multiple reminders from a single message
  async parseAndCreateBatch(userPhone, message, timezone = 'Asia/Kolkata') {
    try {
      const reminders = await this.parseWithAI(message, timezone);

      if (!reminders || reminders.length === 0) {
        return { success: false, error: 'Could not parse multiple reminders' };
      }

      // Extract target from original message so all batch reminders preserve it
      const targetInfo = reminderService.extractTargetPhone(message, userPhone);
      let targetPrefix = 'remind me';
      if (targetInfo && targetInfo.type === 'name') {
        targetPrefix = `remind ${targetInfo.originalName}`;
      } else if (targetInfo && typeof targetInfo === 'string') {
        targetPrefix = `remind ${targetInfo}`;
      }

      const results = [];
      const errors = [];

      for (const reminder of reminders) {
        try {
          const result = await reminderService.parseAndCreateReminder(
            userPhone,
            `${targetPrefix} ${reminder.time_expression} to ${reminder.message}`,
            timezone
          );

          if (result.success) {
            results.push({
              message: result.message,
              time: result.time,
              isRecurring: result.isRecurring || false
            });
          } else {
            errors.push(reminder.message);
          }
        } catch (e) {
          logger.error(`Batch reminder error for "${reminder.message}":`, e.message);
          errors.push(reminder.message);
        }
      }

      if (results.length === 0) {
        return { success: false, error: 'Could not create any reminders' };
      }

      return {
        success: true,
        created: results,
        failed: errors,
        total: reminders.length
      };

    } catch (error) {
      logger.error('Batch reminder parse error:', error.message);
      return { success: false, error: 'Failed to parse batch reminders' };
    }
  }

  async parseWithAI(message, timezone) {
    try {
      const now = new Date();
      const localTime = now.toLocaleString('en-IN', { timeZone: timezone });

      const response = await axios.post(apiUrl, {
        model,
        messages: [
          {
            role: 'system',
            content: `Extract ALL individual reminders from the user message. Output ONLY valid JSON array.
Each reminder should have:
- "message": the task/action (cleaned, no time info)
- "time_expression": the time expression to use (e.g., "at 5pm", "in 30 minutes", "tomorrow at 9am", "every day at 8am")

Example input: "remind me at 3pm to call mom, at 5pm to buy groceries, and tomorrow at 9am to send email"
Example output: [{"message":"call mom","time_expression":"at 3pm"},{"message":"buy groceries","time_expression":"at 5pm"},{"message":"send email","time_expression":"tomorrow at 9am"}]`
          },
          {
            role: 'user',
            content: `Current: ${localTime} (${timezone})\nMessage: "${message}"`
          }
        ],
        temperature: 0.1,
        max_tokens: 500
      }, {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 8000
      });

      const content = response.data.choices[0].message.content;
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      return null;
    } catch (error) {
      logger.error('Batch AI parse error:', error.message);
      return null;
    }
  }

  // Format batch creation response
  formatBatchResponse(result, timezone) {
    if (!result.success) return result.error;

    let response = `*${result.created.length} reminder${result.created.length > 1 ? 's' : ''} set*\n`;

    result.created.forEach((r, i) => {
      const time = new Date(r.time);
      const timeStr = time.toLocaleString('en-IN', {
        timeZone: timezone,
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        day: 'numeric',
        month: 'short'
      });
      response += `\n${i + 1}. "${r.message}" - ${timeStr}`;
    });

    if (result.failed.length > 0) {
      response += `\n\nCouldn't set ${result.failed.length}:`;
      result.failed.forEach(f => {
        response += `\n- "${f}"`;
      });
    }

    return response;
  }
}

module.exports = new BatchReminderService();
