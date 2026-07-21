const registry = require('./handler-registry');
const focusService = require('../services/focus.service');
const logger = require('../utils/logger');

registry.register('focus_mode', async (message, context) => {
  const { text } = message;
  const { userPhone, intentParams } = context;

  try {
    // ── LLM Params-First Routing ──────────────────────────────────────
    if (intentParams?.action) {
      switch (intentParams.action) {
        case 'stop': {
          const result = await focusService.endSession(userPhone);
          if (!result.success) return `${result.error}`;

          const session = result.session;
          const actualMins = result.actualDurationMins;
          const modeLabel = _formatMode(session.mode);

          let response = `Focus session complete!\n━━━━━━━━━━━━\n`;
          response += `Duration: ${actualMins} min${actualMins !== 1 ? 's' : ''}\n`;
          response += `Mode: ${modeLabel}\n`;
          if (session.label) {
            response += `Label: ${session.label}\n`;
          }
          response += `\nGreat work!`;
          return response;
        }
        case 'stats': {
          const period = intentParams.period || 'today';
          const stats = await focusService.getStats(userPhone, period);
          const periodLabel = _formatPeriodLabel(period);

          if (stats.totalSessions === 0) {
            return `Focus Stats (${periodLabel})\n━━━━━━━━━━━━\nNo completed sessions found for this period.\n\nStart one with "start focus" or "pomodoro 25 mins"!`;
          }

          let response = `Focus Stats (${periodLabel})\n━━━━━━━━━━━━\n`;
          response += `Sessions: ${stats.totalSessions}\n`;
          response += `Total: ${stats.totalMinutes} min${stats.totalMinutes !== 1 ? 's' : ''}\n`;
          response += `Average: ${stats.avgDuration} min${stats.avgDuration !== 1 ? 's' : ''}\n`;
          response += `Longest: ${stats.longestSession} min${stats.longestSession !== 1 ? 's' : ''}`;
          return response;
        }
        case 'status': {
          const session = await focusService.getActiveSession(userPhone);

          if (!session) {
            return `No active focus session.\n\nStart one with "start focus" or "pomodoro 25 mins"!`;
          }

          const startTime = new Date(session.start_time);
          const elapsed = Math.round((Date.now() - startTime.getTime()) / (1000 * 60));
          const remaining = Math.max(0, session.duration_mins - elapsed);
          const modeLabel = _formatMode(session.mode);

          let response = `Focus Session Active\n━━━━━━━━━━━━\n`;
          response += `Duration: ${session.duration_mins} mins\n`;
          response += `Elapsed: ${elapsed} min${elapsed !== 1 ? 's' : ''}\n`;
          response += `Remaining: ${remaining} min${remaining !== 1 ? 's' : ''}\n`;
          response += `Mode: ${modeLabel}`;
          if (session.label) {
            response += `\nLabel: ${session.label}`;
          }
          return response;
        }
        case 'start': {
          const duration = intentParams.duration_minutes || 25;
          const mode = intentParams.mode || 'focus';
          const label = intentParams.label || null;

          const result = await focusService.startSession(userPhone, duration, mode, label);
          if (!result.success) return `${result.error}`;

          const modeLabel = _formatMode(mode);
          let response = `Focus mode started!\n━━━━━━━━━━━━\n`;
          response += `Duration: ${duration} min${duration !== 1 ? 's' : ''}\n`;
          response += `Mode: ${modeLabel}`;
          if (label) {
            response += `\nLabel: ${label}`;
          }
          response += `\n\nI'll notify you when time's up. Stay focused!`;
          return response;
        }
      }
    }

    // ── Regex Fallback (existing code, unchanged) ─────────────────────
    const lower = text.toLowerCase().trim();

    // ── Determine sub-action ──────────────────────────────────────────

    if (/\b(?:end|stop|cancel|finish|done)\s*(?:focus|pomodoro|deep\s*work|session)?\b/i.test(lower) ||
        /\b(?:focus|pomodoro|deep\s*work|session)\s*(?:end|stop|done|finish|cancel)\b/i.test(lower) ||
        /\bdone\s+focusing\b/i.test(lower)) {
      // ── End Session ─────────────────────────────────────────────────
      const result = await focusService.endSession(userPhone);

      if (!result.success) {
        return `${result.error}`;
      }

      const session = result.session;
      const actualMins = result.actualDurationMins;
      const modeLabel = _formatMode(session.mode);

      let response = `Focus session complete!\n━━━━━━━━━━━━\n`;
      response += `Duration: ${actualMins} min${actualMins !== 1 ? 's' : ''}\n`;
      response += `Mode: ${modeLabel}\n`;
      if (session.label) {
        response += `Label: ${session.label}\n`;
      }
      response += `\nGreat work!`;
      return response;
    }

    if (/\b(?:focus\s*stat|focus\s*summar|productivity\s*stat|focus\s*report)/i.test(lower)) {
      // ── Stats ───────────────────────────────────────────────────────
      const period = _detectPeriod(lower);
      const stats = await focusService.getStats(userPhone, period);
      const periodLabel = _formatPeriodLabel(period);

      if (stats.totalSessions === 0) {
        return `Focus Stats (${periodLabel})\n━━━━━━━━━━━━\nNo completed sessions found for this period.\n\nStart one with "start focus" or "pomodoro 25 mins"!`;
      }

      let response = `Focus Stats (${periodLabel})\n━━━━━━━━━━━━\n`;
      response += `Sessions: ${stats.totalSessions}\n`;
      response += `Total: ${stats.totalMinutes} min${stats.totalMinutes !== 1 ? 's' : ''}\n`;
      response += `Average: ${stats.avgDuration} min${stats.avgDuration !== 1 ? 's' : ''}\n`;
      response += `Longest: ${stats.longestSession} min${stats.longestSession !== 1 ? 's' : ''}`;
      return response;
    }

    if (/\b(?:focus\s*status|am\s*i\s*(?:in\s*)?focus|current\s*(?:focus|session)|active\s*(?:focus|session))/i.test(lower)) {
      // ── Status ──────────────────────────────────────────────────────
      const session = await focusService.getActiveSession(userPhone);

      if (!session) {
        return `No active focus session.\n\nStart one with "start focus" or "pomodoro 25 mins"!`;
      }

      const startTime = new Date(session.start_time);
      const elapsed = Math.round((Date.now() - startTime.getTime()) / (1000 * 60));
      const remaining = Math.max(0, session.duration_mins - elapsed);
      const modeLabel = _formatMode(session.mode);

      let response = `Focus Session Active\n━━━━━━━━━━━━\n`;
      response += `Duration: ${session.duration_mins} mins\n`;
      response += `Elapsed: ${elapsed} min${elapsed !== 1 ? 's' : ''}\n`;
      response += `Remaining: ${remaining} min${remaining !== 1 ? 's' : ''}\n`;
      response += `Mode: ${modeLabel}`;
      if (session.label) {
        response += `\nLabel: ${session.label}`;
      }
      return response;
    }

    // ── Default: Start Session ──────────────────────────────────────
    const duration = _extractDuration(lower);
    const mode = _detectMode(lower);
    const label = _extractLabel(text, lower);

    const result = await focusService.startSession(userPhone, duration, mode, label);

    if (!result.success) {
      return `${result.error}`;
    }

    const modeLabel = _formatMode(mode);
    let response = `Focus mode started!\n━━━━━━━━━━━━\n`;
    response += `Duration: ${duration} min${duration !== 1 ? 's' : ''}\n`;
    response += `Mode: ${modeLabel}`;
    if (label) {
      response += `\nLabel: ${label}`;
    }
    response += `\n\nI'll notify you when time's up. Stay focused!`;
    return response;

  } catch (error) {
    logger.error('Focus handler error:', error.message);
    return 'Something went wrong with focus mode. Please try again.';
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────

function _extractDuration(lower) {
  // "focus for 25 mins", "pomodoro 45 minutes", "deep work 1 hour", "focus 90m"
  const hourMinMatch = lower.match(/(\d+)\s*h(?:ours?)?\s*(?:and\s*)?(\d+)?\s*m(?:ins?|inutes?)?/);
  if (hourMinMatch) {
    return parseInt(hourMinMatch[1]) * 60 + (parseInt(hourMinMatch[2]) || 0);
  }

  const hourMatch = lower.match(/(\d+)\s*h(?:ours?)?/);
  if (hourMatch) {
    return parseInt(hourMatch[1]) * 60;
  }

  const minMatch = lower.match(/(\d+)\s*m(?:ins?|inutes?)?/);
  if (minMatch) {
    return parseInt(minMatch[1]);
  }

  // Bare number: "focus 25", "pomodoro 30"
  const bareNumber = lower.match(/(?:focus|pomodoro|deep\s*work)\s+(?:for\s+)?(\d+)\b/);
  if (bareNumber) {
    return parseInt(bareNumber[1]);
  }

  return 25; // default
}

function _detectMode(lower) {
  if (/\bpomodoro\b/i.test(lower)) return 'pomodoro';
  if (/\bdeep\s*work\b/i.test(lower)) return 'deepwork';
  return 'focus';
}

function _formatMode(mode) {
  switch (mode) {
    case 'pomodoro': return 'Pomodoro';
    case 'deepwork': return 'Deep Work';
    default: return 'Focus';
  }
}

function _detectPeriod(lower) {
  if (/\bweek\b/i.test(lower)) return 'week';
  if (/\bmonth\b/i.test(lower)) return 'month';
  return 'today';
}

function _formatPeriodLabel(period) {
  switch (period) {
    case 'week': return 'This Week';
    case 'month': return 'This Month';
    default: return 'Today';
  }
}

function _extractLabel(original, lower) {
  // "focus on project report", "pomodoro: writing", "deep work — coding"
  const labelPatterns = [
    /(?:focus|pomodoro|deep\s*work)\s+(?:on|for)\s+(.+?)(?:\s+for\s+\d+|\s+\d+\s*(?:m|h|min)|\s*$)/i,
    /(?:focus|pomodoro|deep\s*work)\s*[:\-—]\s*(.+?)(?:\s+for\s+\d+|\s+\d+\s*(?:m|h|min)|\s*$)/i,
  ];

  for (const pattern of labelPatterns) {
    const match = original.match(pattern);
    if (match && match[1]) {
      const label = match[1].replace(/\s+\d+\s*(?:m|h|min|mins|minutes?|hours?).*$/i, '').trim();
      if (label.length >= 2 && !/^(?:start|begin|mode|session)$/i.test(label)) {
        return label;
      }
    }
  }

  return null;
}
