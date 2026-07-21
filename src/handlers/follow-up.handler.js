const registry = require('./handler-registry');
const followUpService = require('../services/follow-up.service');
const logger = require('../utils/logger');

registry.register('follow_up_manage', async (message, context) => {
  const { text } = message;
  const { userPhone, intentParams } = context;

  try {
    // ── LLM Params-First Routing ──────────────────────────────────────
    if (intentParams?.action) {
      switch (intentParams.action) {
        case 'create': {
          if (intentParams.subject) {
            const priority = intentParams.priority || 'normal';
            const dueDate = intentParams.due_time
              ? followUpService.parseDueTime(intentParams.due_time, context.userTimezone)
              : null;
            if (intentParams.due_time && !dueDate) {
              return `I couldn't parse the follow-up due time "${intentParams.due_time}". Try an ISO date/time or a clear phrase such as "next Friday at 3pm".`;
            }
            const result = await followUpService.addFollowUp(
              userPhone,
              intentParams.contact_name || null,
              intentParams.subject,
              dueDate,
              priority
            );
            if (!result.success) return `${result.error}`;

            const f = result.followUp;
            let response = `Follow-up Created\n━━━━━━━━━━━━\n`;
            if (f.contact_name) {
              response += `Contact: ${f.contact_name}\n`;
            }
            response += `Subject: ${f.subject}\n`;
            response += `Due: ${f.due_date ? _formatDueDate(new Date(f.due_date)) : 'Not set'}\n`;
            response += `Priority: ${_capitalise(f.priority)}\n`;
            response += `ID: #${f.id}`;
            return response;
          }
          break;
        }
        case 'complete': {
          if (intentParams.follow_up_id) {
            const result = await followUpService.completeFollowUp(userPhone, intentParams.follow_up_id);
            if (!result.success) return `${result.error}`;

            const f = result.followUp;
            let response = `Follow-up Completed!\n━━━━━━━━━━━━\n`;
            if (f.contact_name) {
              response += `Contact: ${f.contact_name}\n`;
            }
            response += `Subject: ${f.subject}`;
            return response;
          }
          break;
        }
        case 'delete': {
          if (intentParams.follow_up_id) {
            const result = await followUpService.deleteFollowUp(userPhone, intentParams.follow_up_id);
            if (!result.success) return `${result.error}`;

            const f = result.followUp;
            return `Follow-up Deleted\n━━━━━━━━━━━━\n${f.contact_name ? f.contact_name + ' — ' : ''}${f.subject}`;
          }
          break;
        }
        case 'list': {
          const showAll = false; // default to pending
          const status = showAll ? 'all' : 'pending';
          const followUps = await followUpService.getFollowUps(userPhone, status);

          if (followUps.length === 0) {
            return `No ${status === 'pending' ? 'pending ' : ''}follow-ups found.\n\nCreate one with "follow up with Rahul about proposal on Friday"!`;
          }

          const statusLabel = showAll ? 'All' : 'Pending';
          let response = `Your Follow-ups (${statusLabel})\n━━━━━━━━━━━━\n`;

          for (let i = 0; i < Math.min(followUps.length, 15); i++) {
            const f = followUps[i];
            const contact = f.contact_name || 'No contact';
            const dueStr = f.due_date ? _formatDueDate(new Date(f.due_date)) : 'No due date';
            const statusIcon = f.status === 'completed' ? '[done]' : _isDueOrOverdue(f.due_date) ? '[overdue]' : '[pending]';
            const priorityIcon = f.priority === 'high' ? ' [high]' : f.priority === 'low' ? ' [low]' : '';

            response += `\n${i + 1}. ${contact} — ${f.subject}${priorityIcon}\n`;
            response += `   ${statusIcon} Due: ${dueStr} (ID: #${f.id})\n`;
          }

          if (followUps.length > 15) {
            response += `\n... and ${followUps.length - 15} more`;
          }

          return response.trim();
        }
      }
    }

    // ── Regex Fallback (existing code, unchanged) ─────────────────────
    const lower = text.toLowerCase().trim();

    // ── Delete Follow-up ──────────────────────────────────────────────
    if (/\b(?:delete|remove)\s+follow[\s-]?up\b/i.test(lower)) {
      const idMatch = lower.match(/#?(\d+)/);
      if (!idMatch) {
        return 'Please specify the follow-up ID to delete.\nExample: "delete follow-up #3"';
      }

      const id = parseInt(idMatch[1]);
      const result = await followUpService.deleteFollowUp(userPhone, id);

      if (!result.success) {
        return `${result.error}`;
      }

      const f = result.followUp;
      return `Follow-up Deleted\n━━━━━━━━━━━━\n${f.contact_name ? f.contact_name + ' — ' : ''}${f.subject}`;
    }

    // ── Complete Follow-up ────────────────────────────────────────────
    if (/\b(?:complete|done|finish|mark)\s+follow[\s-]?up\b/i.test(lower) ||
        /\bfollow[\s-]?up\s+(?:complete|done|finished)\b/i.test(lower)) {
      const idMatch = lower.match(/#?(\d+)/);
      if (!idMatch) {
        return 'Please specify the follow-up ID to complete.\nExample: "complete follow-up #3"';
      }

      const id = parseInt(idMatch[1]);
      const result = await followUpService.completeFollowUp(userPhone, id);

      if (!result.success) {
        return `${result.error}`;
      }

      const f = result.followUp;
      let response = `Follow-up Completed!\n━━━━━━━━━━━━\n`;
      if (f.contact_name) {
        response += `Contact: ${f.contact_name}\n`;
      }
      response += `Subject: ${f.subject}`;
      return response;
    }

    // ── List Follow-ups ───────────────────────────────────────────────
    if (/\b(?:my|show|list|view|get|pending|all)\s*follow[\s-]?ups?\b/i.test(lower) ||
        /\bfollow[\s-]?up\s*(?:list|all)\b/i.test(lower)) {
      const showAll = /\ball\b/i.test(lower);
      const status = showAll ? 'all' : 'pending';
      const followUps = await followUpService.getFollowUps(userPhone, status);

      if (followUps.length === 0) {
        return `No ${status === 'pending' ? 'pending ' : ''}follow-ups found.\n\nCreate one with "follow up with Rahul about proposal on Friday"!`;
      }

      const statusLabel = showAll ? 'All' : 'Pending';
      let response = `Your Follow-ups (${statusLabel})\n━━━━━━━━━━━━\n`;

      for (let i = 0; i < Math.min(followUps.length, 15); i++) {
        const f = followUps[i];
        const contact = f.contact_name || 'No contact';
        const dueStr = f.due_date ? _formatDueDate(new Date(f.due_date)) : 'No due date';
        const statusIcon = f.status === 'completed' ? '[done]' : _isDueOrOverdue(f.due_date) ? '[overdue]' : '[pending]';
        const priorityIcon = f.priority === 'high' ? ' [high]' : f.priority === 'low' ? ' [low]' : '';

        response += `\n${i + 1}. ${contact} — ${f.subject}${priorityIcon}\n`;
        response += `   ${statusIcon} Due: ${dueStr} (ID: #${f.id})\n`;
      }

      if (followUps.length > 15) {
        response += `\n... and ${followUps.length - 15} more`;
      }

      return response.trim();
    }

    // ── Add Follow-up (default) ───────────────────────────────────────
    const parsed = followUpService.parseFollowUpFromText(text);

    const priority = _detectPriority(lower);

    const result = await followUpService.addFollowUp(
      userPhone,
      parsed.contactName,
      parsed.subject,
      parsed.dueDate,
      priority
    );

    if (!result.success) {
      return `${result.error}`;
    }

    const f = result.followUp;
    let response = `Follow-up Created\n━━━━━━━━━━━━\n`;
    if (f.contact_name) {
      response += `Contact: ${f.contact_name}\n`;
    }
    response += `Subject: ${f.subject}\n`;
    response += `Due: ${f.due_date ? _formatDueDate(new Date(f.due_date)) : 'Not set'}\n`;
    response += `Priority: ${_capitalise(f.priority)}\n`;
    response += `ID: #${f.id}`;

    return response;

  } catch (error) {
    logger.error('Follow-up handler error:', error.message);
    return 'Something went wrong with follow-ups. Please try again.';
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────

function _formatDueDate(date) {
  if (!date || isNaN(date.getTime())) return 'Not set';

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((dueDay - today) / (1000 * 60 * 60 * 24));

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const formatted = `${dayNames[date.getDay()]}, ${monthNames[date.getMonth()]} ${date.getDate()}`;

  if (diffDays === 0) return `Today (${formatted})`;
  if (diffDays === 1) return `Tomorrow (${formatted})`;
  if (diffDays < 0) return `Overdue (${formatted})`;
  if (diffDays <= 7) return `${formatted}`;
  return `${formatted}`;
}

function _isDueOrOverdue(dueDate) {
  if (!dueDate) return false;
  return new Date(dueDate) <= new Date();
}

function _detectPriority(lower) {
  if (/\b(?:urgent|high\s*priority|important|asap|critical)\b/i.test(lower)) return 'high';
  if (/\b(?:low\s*priority|not\s*urgent|whenever|no\s*rush)\b/i.test(lower)) return 'low';
  return 'normal';
}

function _capitalise(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}
