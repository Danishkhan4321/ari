const registry = require('./handler-registry');
const timeTrackingService = require('../services/time-tracking.service');
const logger = require('../utils/logger');

registry.register('time_track', async (message, context) => {
  const { text } = message;
  const { userPhone, intentParams } = context;

  try {
    // ── LLM Params-First Routing ──────────────────────────────────────
    if (intentParams?.action) {
      switch (intentParams.action) {
        case 'start': {
          const task = intentParams.task_description || 'Untitled task';
          const project = intentParams.project || null;

          const result = await timeTrackingService.startTimer(userPhone, task, project);
          if (!result.success) return `\u26a0\ufe0f ${result.error}`;

          const timer = result.entry || result.timer;
          const startTime = new Date(timer.start_time || timer.startedAt || Date.now())
            .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

          let response = `\u23f1\ufe0f Timer Started\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
          response += `Task: ${timer.task_description || timer.task || 'Untitled'}\n`;
          if (timer.project) {
            response += `Project: ${timer.project}\n`;
          }
          response += `Started at: ${startTime}`;
          return response;
        }
        case 'stop': {
          const result = await timeTrackingService.stopTimer(userPhone);
          if (!result.success) return `\u26a0\ufe0f ${result.error}`;

          const entry = result.entry;
          let response = `\u23f1\ufe0f Timer Stopped\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
          response += `Task: ${entry.task_description || entry.task || 'Untitled'}\n`;
          response += `Duration: ${_formatDuration(entry.duration_mins || entry.duration)}\n`;
          if (entry.project) {
            response += `Project: ${entry.project}`;
          }
          return response;
        }
        case 'status': {
          const result = await timeTrackingService.getActiveTimer(userPhone);
          if (!result.success) return `\u26a0\ufe0f ${result.error}`;

          if (!result.timer) {
            return '\u23f1\ufe0f No active timer running.\n\nStart one with "start timer on [task]"!';
          }

          const timer = result.timer;
          const elapsed = _formatDuration(result.elapsed);
          let response = `\u23f1\ufe0f Active Timer\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
          response += `Task: ${timer.task_description || timer.task || 'Untitled'}\n`;
          if (timer.project) {
            response += `Project: ${timer.project}\n`;
          }
          response += `Elapsed: ${elapsed}`;
          return response;
        }
        case 'summary': {
          const period = intentParams.period || 'today';
          const result = await timeTrackingService.getSummary(userPhone, period);
          if (!result.success) return `\u26a0\ufe0f ${result.error}`;

          const summary = result.summary;
          const periodLabel = _formatPeriodLabel(period);

          if (!summary.totalMinutes || summary.totalMinutes === 0) {
            return `\ud83d\udcca Time Summary (${periodLabel})\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\nNo time entries found for this period.\n\nStart tracking with "start timer on [task]"!`;
          }

          let response = `\ud83d\udcca Time Summary (${periodLabel})\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
          response += `Total: ${_formatDuration(summary.totalMinutes)}\n`;

          if (summary.byProject && summary.byProject.length > 0) {
            response += `\nBy Project:`;
            for (const proj of summary.byProject) {
              const pct = summary.totalMinutes > 0
                ? Math.round((proj.minutes / summary.totalMinutes) * 100)
                : 0;
              response += `\n\u2022 ${proj.project || 'No Project'}: ${_formatDuration(proj.minutes)} (${pct}%)`;
            }
          }

          return response;
        }
        case 'log': {
          const period = intentParams.period || 'today';
          const result = await timeTrackingService.getEntries(userPhone, period);
          if (!result.success) return `\u26a0\ufe0f ${result.error}`;

          const entries = result.entries;
          const periodLabel = _formatPeriodLabel(period);

          if (!entries || entries.length === 0) {
            return `\ud83d\udcdd Time Log (${periodLabel})\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\nNo time entries found.\n\nStart tracking with "start timer on [task]"!`;
          }

          let totalMinutes = 0;
          let response = `\ud83d\udcdd Time Log (${periodLabel})\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;

          const displayLimit = Math.min(entries.length, 15);
          for (let i = 0; i < displayLimit; i++) {
            const e = entries[i];
            const dur = _formatDuration(e.duration_mins || e.duration);
            const proj = e.project ? ` [${e.project}]` : '';
            response += `\n${i + 1}. ${e.task_description || e.task || 'Untitled'} \u2014 ${dur}${proj}`;
            totalMinutes += (e.duration_mins || e.duration || 0);
          }

          if (entries.length > displayLimit) {
            response += `\n\n... and ${entries.length - displayLimit} more`;
          }

          response += `\n\n\u23f1\ufe0f Total: ${_formatDuration(totalMinutes)}`;
          return response;
        }
      }
    }

    // ── Regex Fallback (existing code, unchanged) ─────────────────────
    const lower = text.toLowerCase().trim();

    // ── Stop Timer ────────────────────────────────────────────────────
    if (/\b(?:stop|end|finish|pause)\s+(?:timer|tracking|track)\b/i.test(lower)) {
      const result = await timeTrackingService.stopTimer(userPhone);

      if (!result.success) {
        return `\u26a0\ufe0f ${result.error}`;
      }

      const entry = result.entry;
      let response = `\u23f1\ufe0f Timer Stopped\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
      response += `Task: ${entry.task_description || entry.task || 'Untitled'}\n`;
      response += `Duration: ${_formatDuration(entry.duration_mins || entry.duration)}\n`;
      if (entry.project) {
        response += `Project: ${entry.project}`;
      }
      return response;
    }

    // ── Timer Status ──────────────────────────────────────────────────
    if (/\b(?:timer\s*status|active\s*timer|current\s*timer|what\s*am\s*i\s*(?:working|tracking)\s*on)\b/i.test(lower)) {
      const result = await timeTrackingService.getActiveTimer(userPhone);

      if (!result.success) {
        return `\u26a0\ufe0f ${result.error}`;
      }

      if (!result.timer) {
        return '\u23f1\ufe0f No active timer running.\n\nStart one with "start timer on [task]"!';
      }

      const timer = result.timer;
      const elapsed = _formatDuration(result.elapsed);
      let response = `\u23f1\ufe0f Active Timer\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
      response += `Task: ${timer.task_description || timer.task || 'Untitled'}\n`;
      if (timer.project) {
        response += `Project: ${timer.project}\n`;
      }
      response += `Elapsed: ${elapsed}`;
      return response;
    }

    // ── Time Summary ──────────────────────────────────────────────────
    if (/\b(?:time\s*(?:summary|report)|hours?\s*(?:this|today|last)|\btotal\s*hours\b)/i.test(lower)) {
      const period = _detectPeriod(lower);
      const result = await timeTrackingService.getSummary(userPhone, period);

      if (!result.success) {
        return `\u26a0\ufe0f ${result.error}`;
      }

      const summary = result.summary;
      const periodLabel = _formatPeriodLabel(period);

      if (!summary.totalMinutes || summary.totalMinutes === 0) {
        return `\ud83d\udcca Time Summary (${periodLabel})\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\nNo time entries found for this period.\n\nStart tracking with "start timer on [task]"!`;
      }

      let response = `\ud83d\udcca Time Summary (${periodLabel})\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
      response += `Total: ${_formatDuration(summary.totalMinutes)}\n`;

      if (summary.byProject && summary.byProject.length > 0) {
        response += `\nBy Project:`;
        for (const proj of summary.byProject) {
          const pct = summary.totalMinutes > 0
            ? Math.round((proj.minutes / summary.totalMinutes) * 100)
            : 0;
          response += `\n\u2022 ${proj.project || 'No Project'}: ${_formatDuration(proj.minutes)} (${pct}%)`;
        }
      }

      return response;
    }

    // ── Time Entries / Log ────────────────────────────────────────────
    if (/\b(?:time\s*(?:log|entries|entry)|time\s*(?:today|this))\b/i.test(lower)) {
      const period = _detectPeriod(lower);
      const result = await timeTrackingService.getEntries(userPhone, period);

      if (!result.success) {
        return `\u26a0\ufe0f ${result.error}`;
      }

      const entries = result.entries;
      const periodLabel = _formatPeriodLabel(period);

      if (!entries || entries.length === 0) {
        return `\ud83d\udcdd Time Log (${periodLabel})\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\nNo time entries found.\n\nStart tracking with "start timer on [task]"!`;
      }

      let totalMinutes = 0;
      let response = `\ud83d\udcdd Time Log (${periodLabel})\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;

      const displayLimit = Math.min(entries.length, 15);
      for (let i = 0; i < displayLimit; i++) {
        const e = entries[i];
        const dur = _formatDuration(e.duration_mins || e.duration);
        const proj = e.project ? ` [${e.project}]` : '';
        response += `\n${i + 1}. ${e.task_description || e.task || 'Untitled'} \u2014 ${dur}${proj}`;
        totalMinutes += (e.duration_mins || e.duration || 0);
      }

      if (entries.length > displayLimit) {
        response += `\n\n... and ${entries.length - displayLimit} more`;
      }

      response += `\n\n\u23f1\ufe0f Total: ${_formatDuration(totalMinutes)}`;
      return response;
    }

    // ── Start Timer (default) ─────────────────────────────────────────
    if (/\b(?:start|begin)\s+(?:timer|tracking|track)\b/i.test(lower) ||
        /\btrack\s+time\b/i.test(lower)) {
      const parsed = _parseStartTimer(text);

      const result = await timeTrackingService.startTimer(
        userPhone,
        parsed.task,
        parsed.project
      );

      if (!result.success) {
        return `\u26a0\ufe0f ${result.error}`;
      }

      const timer = result.entry || result.timer;
      const startTime = new Date(timer.start_time || timer.startedAt || Date.now())
        .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

      let response = `\u23f1\ufe0f Timer Started\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
      response += `Task: ${timer.task_description || timer.task || 'Untitled'}\n`;
      if (timer.project) {
        response += `Project: ${timer.project}\n`;
      }
      response += `Started at: ${startTime}`;
      return response;
    }

    // ── Fallback ──────────────────────────────────────────────────────
    return '\u23f1\ufe0f Time Tracking Commands:\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u2022 "start timer on [task]" \u2014 start tracking\n\u2022 "stop timer" \u2014 stop current timer\n\u2022 "timer status" \u2014 see active timer\n\u2022 "time log today" \u2014 view entries\n\u2022 "time summary this week" \u2014 view summary';

  } catch (error) {
    logger.error('Time tracking handler error:', error.message);
    return '\u274c Something went wrong with time tracking. Please try again.';
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────

function _formatDuration(minutes) {
  if (!minutes || minutes <= 0) return '0m';
  const hrs = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  if (hrs === 0) return `${mins}m`;
  return `${hrs}h ${mins}m`;
}

function _detectPeriod(lower) {
  if (/\btoday\b/i.test(lower)) return 'today';
  if (/\bweek\b/i.test(lower)) return 'week';
  if (/\bmonth\b/i.test(lower)) return 'month';
  if (/\byesterday\b/i.test(lower)) return 'yesterday';
  return 'today';
}

function _formatPeriodLabel(period) {
  switch (period) {
    case 'today': return 'Today';
    case 'yesterday': return 'Yesterday';
    case 'week': return 'This Week';
    case 'month': return 'This Month';
    default: return 'Today';
  }
}

function _parseStartTimer(text) {
  let task = null;
  let project = null;

  // Try: "start timer on [task] for [project]" / "track time on [task] project [project]"
  const projectMatch = text.match(/\b(?:for|project[:\s])\s*(.+)$/i);
  if (projectMatch) {
    project = projectMatch[1].trim();
    // Remove the project part to extract the task
    text = text.replace(projectMatch[0], '').trim();
  }

  // Extract task description after "on", "for", or ":"
  const taskPatterns = [
    /\b(?:start|begin)\s+(?:timer|tracking|track)\s+(?:on|for)[:\s]+(.+)/i,
    /\btrack\s+time\s+(?:on|for)[:\s]+(.+)/i,
    /\b(?:start|begin)\s+(?:timer|tracking|track)[:\s]+(.+)/i,
    /\btrack\s+time[:\s]+(.+)/i,
  ];

  for (const pattern of taskPatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      task = match[1]
        .replace(/\b(?:for|project)[:\s].*$/i, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (task.length >= 2) break;
      task = null;
    }
  }

  return { task: task || 'Untitled task', project };
}
