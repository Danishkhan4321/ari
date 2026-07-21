const registry = require('./handler-registry');
const meetingMinutesService = require('../services/meeting-minutes.service');
const { query } = require('../config/database');
const logger = require('../utils/logger');

registry.register('meeting_minutes', async (message, context) => {
  const { text } = message;
  const { userPhone, intentParams } = context;
  const lower = text.toLowerCase().trim();

  try {
    // Optionally resolve team admin phone (meeting minutes work for both team and individual)
    const adminPhone = await _resolveAdminPhone(userPhone);

    // ── LLM Params-First Routing ────────────────────────────────────────
    if (intentParams?.action) {
      switch (intentParams.action) {
        case 'create': {
          if (intentParams.meeting_title && intentParams.meeting_content) {
            const result = await meetingMinutesService.createMinutes(userPhone, intentParams.meeting_title, intentParams.meeting_content, adminPhone);
            if (!result.success) return `\u26a0\ufe0f ${result.error}`;
            return _formatCreatedMinutes(result.minutes, result.structured, intentParams.meeting_title);
          }
          if (intentParams.meeting_title && !intentParams.meeting_content) {
            return `\ud83d\udcdd Please share the meeting notes or transcript, and I'll generate structured minutes.\n\nFormat: meeting notes for ${intentParams.meeting_title}: [your notes here]`;
          }
          break;
        }
        case 'search': {
          if (intentParams.search_query) {
            const results = await meetingMinutesService.searchMinutes(userPhone, intentParams.search_query);
            if (results.length === 0) return `\ud83d\udd0d No meeting minutes found for "${intentParams.search_query}".`;
            let response = `\ud83d\udd0d Meeting Results for '${intentParams.search_query}'\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
            results.forEach((m, i) => {
              const date = new Date(m.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
              response += `${i + 1}. [#${m.id}] ${m.title || 'Untitled'} (${date})\n`;
            });
            return response.trim();
          }
          break;
        }
        case 'action_items': {
          const actionItems = await meetingMinutesService.getActionItems(userPhone);
          if (actionItems.length === 0) return '\u2705 No pending action items from meetings.';
          let response = `\u2705 Action Items from Meetings\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
          let currentMeetingId = null;
          actionItems.forEach((ai, i) => {
            if (ai.meetingId !== currentMeetingId) {
              currentMeetingId = ai.meetingId;
              const date = new Date(ai.meetingDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
              response += `\n\ud83d\udccb ${ai.meetingTitle || 'Untitled'} (${date}):\n`;
            }
            const assignee = ai.assignee ? ` - ${ai.assignee}` : '';
            const deadline = ai.deadline ? ` (by ${ai.deadline})` : '';
            const itemText = typeof ai.item === 'string' ? ai.item : ai.item?.text || ai.item?.item || ai.item;
            response += `  ${i + 1}. ${itemText}${assignee}${deadline}\n`;
          });
          return response.trim();
        }
        case 'last': {
          const minutes = await meetingMinutesService.getRecentMinutes(userPhone, 1);
          if (minutes.length === 0) return '\ud83d\udcdd No meeting minutes found.\n\nCreate one with:\n"meeting notes for [title]: [your notes here]"';
          return _formatMinutesDetail(minutes[0]);
        }
        case 'history': {
          const minutes = await meetingMinutesService.getRecentMinutes(userPhone, 10);
          if (minutes.length === 0) return '\ud83d\udcdd No meeting minutes yet.\n\nCreate one with:\n"meeting notes for [title]: [your notes here]"';
          let response = `\ud83d\udcdd Meeting History (${minutes.length})\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
          minutes.forEach((m, i) => {
            const date = new Date(m.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            const actionCount = _countActionItems(m);
            const actionLabel = actionCount > 0 ? ` | ${actionCount} action items` : '';
            response += `${i + 1}. [#${m.id}] ${m.title || 'Untitled'} (${date})${actionLabel}\n`;
          });
          response += '\n_"meeting summary" to see the latest in detail_';
          return response.trim();
        }
      }
    }

    // ── Regex Fallback ──────────────────────────────────────────────────

    // ── Create Meeting Notes ────────────────────────────────────────────
    const createMatch = text.match(/^(?:create\s+)?meeting\s+notes?\s+(?:for\s+)?([^:]+)[:\s]+(.+)$/is);
    if (createMatch) {
      const title = createMatch[1].trim();
      const rawNotes = createMatch[2].trim();

      const result = await meetingMinutesService.createMinutes(userPhone, title, rawNotes, adminPhone);

      if (!result.success) {
        return `\u26a0\ufe0f ${result.error}`;
      }

      return _formatCreatedMinutes(result.minutes, result.structured, title);
    }

    // ── Create Meeting Notes (title only, no raw notes) ─────────────────
    const titleOnlyMatch = text.match(/^(?:create\s+)?meeting\s+notes?\s+(?:for\s+)?(.+)$/i);
    if (titleOnlyMatch && !_isOtherCommand(lower)) {
      const title = titleOnlyMatch[1].trim();

      // If no content after the title, prompt for notes
      return `\ud83d\udcdd Please share the meeting notes or transcript, and I'll generate structured minutes.\n\nFormat: meeting notes for ${title}: [your notes here]`;
    }

    // ── Search Meeting Minutes ──────────────────────────────────────────
    const searchMatch = text.match(/^search\s+meetings?[:\s]+(.+)$/i);
    if (searchMatch) {
      const searchTerm = searchMatch[1].trim();
      const results = await meetingMinutesService.searchMinutes(userPhone, searchTerm);

      if (results.length === 0) {
        return `\ud83d\udd0d No meeting minutes found for "${searchTerm}".`;
      }

      let response = `\ud83d\udd0d Meeting Results for '${searchTerm}'\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
      results.forEach((m, i) => {
        const date = new Date(m.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        response += `${i + 1}. [#${m.id}] ${m.title || 'Untitled'} (${date})\n`;
      });
      return response.trim();
    }

    // ── Action Items from Meetings ──────────────────────────────────────
    if (/^(?:action\s+items?\s+from\s+meetings?|pending\s+action\s+items?|meeting\s+action\s+items?)$/i.test(lower)) {
      const actionItems = await meetingMinutesService.getActionItems(userPhone);

      if (actionItems.length === 0) {
        return '\u2705 No pending action items from meetings.';
      }

      let response = `\u2705 Action Items from Meetings\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
      let currentMeetingId = null;

      actionItems.forEach((ai, i) => {
        if (ai.meetingId !== currentMeetingId) {
          currentMeetingId = ai.meetingId;
          const date = new Date(ai.meetingDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          response += `\n\ud83d\udccb ${ai.meetingTitle || 'Untitled'} (${date}):\n`;
        }

        const assignee = ai.assignee ? ` - ${ai.assignee}` : '';
        const deadline = ai.deadline ? ` (by ${ai.deadline})` : '';
        const itemText = typeof ai.item === 'string' ? ai.item : ai.item?.item || ai.item;
        response += `  ${i + 1}. ${itemText}${assignee}${deadline}\n`;
      });

      return response.trim();
    }

    // ── Meeting Summary (most recent) ───────────────────────────────────
    if (/^(?:meeting\s+summary|last\s+meeting|recent\s+meeting|latest\s+meeting)$/i.test(lower)) {
      const minutes = await meetingMinutesService.getRecentMinutes(userPhone, 1);

      if (minutes.length === 0) {
        return '\ud83d\udcdd No meeting minutes found.\n\nCreate one with:\n"meeting notes for [title]: [your notes here]"';
      }

      const m = minutes[0];
      return _formatMinutesDetail(m);
    }

    // ── Meeting History ─────────────────────────────────────────────────
    if (/^(?:meeting\s+history|past\s+meetings?|all\s+meetings?|meetings?)$/i.test(lower)) {
      const minutes = await meetingMinutesService.getRecentMinutes(userPhone, 10);

      if (minutes.length === 0) {
        return '\ud83d\udcdd No meeting minutes yet.\n\nCreate one with:\n"meeting notes for [title]: [your notes here]"';
      }

      let response = `\ud83d\udcdd Meeting History (${minutes.length})\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
      minutes.forEach((m, i) => {
        const date = new Date(m.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const actionCount = _countActionItems(m);
        const actionLabel = actionCount > 0 ? ` | ${actionCount} action items` : '';
        response += `${i + 1}. [#${m.id}] ${m.title || 'Untitled'} (${date})${actionLabel}\n`;
      });
      response += '\n_"meeting summary" to see the latest in detail_';
      return response.trim();
    }

    // ── Fallback ────────────────────────────────────────────────────────
    return '\ud83d\udcdd *Meeting Minutes Commands:*\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u2022 "meeting notes for standup: [notes]"\n\u2022 "meeting summary" or "last meeting"\n\u2022 "meeting history"\n\u2022 "search meetings: keyword"\n\u2022 "action items from meetings"';

  } catch (error) {
    logger.error('Meeting minutes handler error:', error.message);
    return '\u274c Something went wrong with meeting minutes. Please try again.';
  }
});

// ── Helper Functions ──────────────────────────────────────────────────────

async function _resolveAdminPhone(userPhone) {
  try {
    let result = await query('SELECT admin_phone FROM teams WHERE admin_phone = $1 LIMIT 1', [userPhone]);
    if (result.rows.length > 0) return userPhone;
    result = await query('SELECT admin_phone FROM teams WHERE member_phone = $1 LIMIT 1', [userPhone]);
    return result.rows.length > 0 ? result.rows[0].admin_phone : null;
  } catch {
    return null;
  }
}

function _isOtherCommand(lower) {
  return /^(?:meeting\s+summary|meeting\s+history|past\s+meetings?|last\s+meeting|search\s+meetings?|action\s+items?|pending\s+action|meetings?)$/.test(lower);
}

function _formatCreatedMinutes(minutes, structured, title) {
  let response = `\ud83d\udccb Meeting Minutes: ${title}\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;

  if (structured.summary) {
    response += `\n\ud83d\udcdd Summary:\n${structured.summary}\n`;
  }

  if (structured.actionItems && structured.actionItems.length > 0) {
    response += `\n\u2705 Action Items:\n`;
    structured.actionItems.forEach((item, i) => {
      const assignee = item.assignee ? ` - ${item.assignee}` : '';
      const deadline = item.deadline ? ` by ${item.deadline}` : '';
      const itemText = item.item || item;
      response += `${i + 1}. ${itemText}${assignee}${deadline}\n`;
    });
  }

  if (structured.decisions && structured.decisions.length > 0) {
    response += `\n\ud83c\udfaf Decisions:\n`;
    structured.decisions.forEach((d, i) => {
      response += `${i + 1}. ${d}\n`;
    });
  }

  if (structured.keyTopics && structured.keyTopics.length > 0) {
    response += `\n\ud83d\udccc Key Topics:\n`;
    structured.keyTopics.forEach(topic => {
      response += `- ${topic}\n`;
    });
  }

  return response.trim();
}

function _formatMinutesDetail(m) {
  const date = new Date(m.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  let response = `\ud83d\udccb ${m.title || 'Untitled Meeting'} (${date})\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;

  if (m.summary) {
    response += `\n\ud83d\udcdd Summary:\n${m.summary}\n`;
  }

  // Parse action items
  const actionItems = _parseJsonField(m.action_items);
  if (actionItems && actionItems.length > 0) {
    response += `\n\u2705 Action Items:\n`;
    actionItems.forEach((item, i) => {
      const assignee = item.assignee ? ` - ${item.assignee}` : '';
      const deadline = item.deadline ? ` by ${item.deadline}` : '';
      const itemText = item.item || item;
      response += `${i + 1}. ${itemText}${assignee}${deadline}\n`;
    });
  }

  // Parse decisions
  const decisions = _parseJsonField(m.decisions);
  if (decisions && decisions.length > 0) {
    response += `\n\ud83c\udfaf Decisions:\n`;
    decisions.forEach((d, i) => {
      response += `${i + 1}. ${d}\n`;
    });
  }

  return response.trim();
}

function _parseJsonField(field) {
  if (!field) return [];
  if (Array.isArray(field)) return field;
  try {
    const parsed = JSON.parse(field);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function _countActionItems(m) {
  const items = _parseJsonField(m.action_items);
  return items.length;
}
