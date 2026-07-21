const registry = require('./handler-registry');
const teamAnalyticsService = require('../services/team-analytics.service');
const { query } = require('../config/database');
const logger = require('../utils/logger');

registry.register('team_analytics', async (message, context) => {
  const { text } = message;
  const { userPhone, intentParams } = context;

  try {
    // Resolve team admin phone for analytics scoping
    const adminPhone = await _resolveAdminPhone(userPhone);
    if (!adminPhone) {
      return '\u26a0\ufe0f You need to be part of a team to view team analytics.\nAsk your admin to add you with "add team member [name] [phone]"';
    }

    // ── LLM Params-First Routing ──────────────────────────────────────
    if (intentParams?.action) {
      switch (intentParams.action) {
        case 'comparison': {
          const comparison = await teamAnalyticsService.getWeeklyComparison(adminPhone);

          if (!comparison.available) {
            const report = await teamAnalyticsService.generateReport(adminPhone);
            await teamAnalyticsService.saveSnapshot(adminPhone, report);

            return `\ud83d\udcca Not enough data for weekly comparison yet.\n\nI've saved today's snapshot. Check back next week for a comparison!\n\nUse "team analytics" to see your current report.`;
          }

          return _formatComparison(comparison);
        }
        case 'overview': {
          const report = await teamAnalyticsService.generateReport(adminPhone);
          await teamAnalyticsService.saveSnapshot(adminPhone, report);
          const health = await teamAnalyticsService.calculateHealthScore(adminPhone);
          const blocked = await teamAnalyticsService.getBlockedMembers(adminPhone);
          const availability = await teamAnalyticsService.getTeamAvailability(adminPhone);
          return _formatReport(report, { health, blocked, availability });
        }
        case 'workload': {
          const workload = await teamAnalyticsService.getWorkloadDistribution(adminPhone);
          return _formatWorkload(workload);
        }
        case 'blockers': {
          const blocked = await teamAnalyticsService.getBlockedMembers(adminPhone);
          return _formatBlockers(blocked);
        }
        case 'availability': {
          const availability = await teamAnalyticsService.getTeamAvailability(adminPhone);
          return _formatAvailability(availability);
        }
        case 'health': {
          const health = await teamAnalyticsService.calculateHealthScore(adminPhone);
          return _formatHealth(health);
        }
      }
    }

    // ── Regex Fallback (existing code, unchanged) ─────────────────────
    const lower = text.toLowerCase().trim();

    // ── Weekly Comparison ───────────────────────────────────────────────
    if (/^(?:team\s+comparison|this\s+week\s+vs\s+last\s+week|weekly\s+comparison|compare\s+weeks?)$/i.test(lower)) {
      const comparison = await teamAnalyticsService.getWeeklyComparison(adminPhone);

      if (!comparison.available) {
        // Generate and save a snapshot first, then try again
        const report = await teamAnalyticsService.generateReport(adminPhone);
        await teamAnalyticsService.saveSnapshot(adminPhone, report);

        return `\ud83d\udcca Not enough data for weekly comparison yet.\n\nI've saved today's snapshot. Check back next week for a comparison!\n\nUse "team analytics" to see your current report.`;
      }

      return _formatComparison(comparison);
    }

    // ── Team Analytics / Report ─────────────────────────────────────────
    if (/^(?:team\s+analytics?|team\s+report|team\s+stats?|team\s+dashboard|team\s+overview)$/i.test(lower)) {
      const report = await teamAnalyticsService.generateReport(adminPhone);
      await teamAnalyticsService.saveSnapshot(adminPhone, report);
      const health = await teamAnalyticsService.calculateHealthScore(adminPhone);
      const blocked = await teamAnalyticsService.getBlockedMembers(adminPhone);
      const availability = await teamAnalyticsService.getTeamAvailability(adminPhone);
      return _formatReport(report, { health, blocked, availability });
    }

    // ── Fallback ────────────────────────────────────────────────────────
    return '\ud83d\udcca *Team Analytics Commands:*\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u2022 "team analytics" \u2014 full overview\n\u2022 "team comparison" \u2014 this week vs last week\n\u2022 "team workload" \u2014 task distribution\n\u2022 "team blockers" \u2014 who\'s blocked\n\u2022 "team availability" \u2014 who\'s available\n\u2022 "team health" \u2014 health score';

  } catch (error) {
    logger.error('Team analytics handler error:', error.message);
    return '\u274c Something went wrong with team analytics. Please try again.';
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

function _formatReport(report, extras = {}) {
  let response = `\ud83d\udcca Team Analytics\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;

  // Health score summary
  if (extras.health && extras.health.teamSize > 0) {
    response += `${extras.health.emoji} Health Score: ${extras.health.score}/100\n`;
  }

  response += `\ud83d\udc65 Team Size: ${report.teamSize}\n`;

  response += `\n\ud83d\udccb Tasks:\n`;
  response += `  Total: ${report.tasks.total} | Done: ${report.tasks.completed} (${report.tasks.completionRate}%)\n`;

  response += `\n\ud83d\udcdd Standups:\n`;
  response += `  Today: ${report.standups.todayRespondents}`;
  if (report.teamSize > 0) {
    response += `/${report.teamSize} responded (${report.standups.participationRate}%)`;
  }
  response += '\n';

  // Blockers summary
  if (extras.blocked && extras.blocked.length > 0) {
    response += `\n\ud83d\udeab Blockers: ${extras.blocked.length} member(s) blocked\n`;
    for (const b of extras.blocked.slice(0, 3)) {
      response += `  \u2022 ${b.name}: ${b.blocker.substring(0, 60)}\n`;
    }
    if (extras.blocked.length > 3) {
      response += `  ... and ${extras.blocked.length - 3} more\n`;
    }
  }

  // Availability summary
  if (extras.availability) {
    const { onLeave, inFocus } = extras.availability;
    if (onLeave.length > 0 || inFocus.length > 0) {
      response += `\n\ud83d\udfe2 Availability:\n`;
      if (onLeave.length > 0) {
        response += `  On leave: ${onLeave.map(m => m.name).join(', ')}\n`;
      }
      if (inFocus.length > 0) {
        response += `  In focus: ${inFocus.map(m => m.name).join(', ')}\n`;
      }
    }
  }

  response += `\n\ud83d\udea8 Incidents:\n`;
  response += `  Open: ${report.incidents.openCount} | Resolved: ${report.incidents.resolvedThisWeek}\n`;

  response += `\n\ud83d\udcca Polls: ${report.polls.activeCount} active`;

  return response;
}

function _formatWorkload(workload) {
  if (workload.length === 0) {
    return '\ud83d\udccb No team members found.';
  }
  let response = '\ud83d\udccb *Workload Distribution*\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n';
  for (const m of workload) {
    const flag = m.overloaded ? ' \ud83d\udd34 OVERLOADED' : '';
    response += `\u2022 ${m.name}: ${m.pendingCount} pending tasks${flag}\n`;
  }
  return response.trim();
}

function _formatBlockers(blocked) {
  if (blocked.length === 0) {
    return '\u2705 No blockers reported today! The team is clear.';
  }
  let response = '\ud83d\udeab *Team Blockers*\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n';
  for (const b of blocked) {
    response += `\u2022 *${b.name}*: ${b.blocker}\n`;
  }
  return response.trim();
}

function _formatAvailability(availability) {
  const { onLeave, inFocus, available } = availability;
  let response = '\ud83d\udfe2 *Team Availability*\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n';

  if (available.length > 0) {
    response += `\u2705 Available (${available.length}):\n`;
    response += available.map(m => `  \u2022 ${m.name}`).join('\n') + '\n';
  }
  if (onLeave.length > 0) {
    response += `\n\ud83c\udfd6\ufe0f On Leave (${onLeave.length}):\n`;
    response += onLeave.map(m => `  \u2022 ${m.name}`).join('\n') + '\n';
  }
  if (inFocus.length > 0) {
    response += `\n\ud83c\udfaf In Focus (${inFocus.length}):\n`;
    response += inFocus.map(m => `  \u2022 ${m.name}`).join('\n') + '\n';
  }

  if (available.length === 0 && onLeave.length === 0 && inFocus.length === 0) {
    response += 'No team members found.';
  }

  return response.trim();
}

function _formatHealth(health) {
  if (health.teamSize === 0) {
    return '\u26a0\ufe0f No team members found to calculate health score.';
  }
  const b = health.breakdown;
  let response = `${health.emoji} *Team Health Score: ${health.score}/100*\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
  response += `\ud83d\udcdd Standup Participation: ${b.participation}% (weight: 30%)\n`;
  response += `\ud83d\udccb Task Completion: ${b.taskCompletion}% (weight: 30%)\n`;
  response += `\u2705 No-Blockers Rate: ${b.noBlockersRate}% (weight: 20%)\n`;
  response += `\ud83d\udc65 Attendance Rate: ${b.attendanceRate}% (weight: 20%)`;
  return response;
}

function _formatComparison(comparison) {
  let response = `\ud83d\udcca Weekly Comparison\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;

  const thisWeek = comparison.thisWeek;
  const lastWeek = comparison.lastWeek;
  const changes = comparison.changes;

  if (thisWeek && lastWeek) {
    // Tasks
    if (thisWeek.tasks && lastWeek.tasks) {
      const taskTrend = _trendIcon(changes.taskCompletionRate);
      response += `\n\ud83d\udccb Task Completion:\n`;
      response += `  This week: ${thisWeek.tasks.completionRate}%\n`;
      response += `  Last week: ${lastWeek.tasks.completionRate}%\n`;
      response += `  ${taskTrend} ${_formatChange(changes.taskCompletionRate, '%')}\n`;
    }

    // Standups
    if (thisWeek.standups && lastWeek.standups) {
      const standupTrend = _trendIcon(changes.participationRate);
      response += `\n\ud83d\udcdd Standup Participation:\n`;
      response += `  This week: ${thisWeek.standups.participationRate}%\n`;
      response += `  Last week: ${lastWeek.standups.participationRate}%\n`;
      response += `  ${standupTrend} ${_formatChange(changes.participationRate, '%')}\n`;
    }

    // Incidents
    if (thisWeek.incidents && lastWeek.incidents) {
      const incidentTrend = _trendIcon(-changes.openIncidents); // fewer incidents is better
      response += `\n\ud83d\udea8 Open Incidents:\n`;
      response += `  This week: ${thisWeek.incidents.openCount}\n`;
      response += `  Last week: ${lastWeek.incidents.openCount}\n`;
      response += `  ${incidentTrend} ${_formatChange(changes.openIncidents)}\n`;
    }
  } else if (thisWeek) {
    response += '\nOnly this week\'s data is available.\n';
    if (thisWeek.tasks) {
      response += `\ud83d\udccb Task Completion: ${thisWeek.tasks.completionRate}%\n`;
    }
    if (thisWeek.standups) {
      response += `\ud83d\udcdd Standup Participation: ${thisWeek.standups.participationRate}%\n`;
    }
    if (thisWeek.incidents) {
      response += `\ud83d\udea8 Open Incidents: ${thisWeek.incidents.openCount}\n`;
    }
  }

  return response.trim();
}

function _trendIcon(value) {
  if (value > 0) return '\ud83d\udcc8';    // chart increasing
  if (value < 0) return '\ud83d\udcc9';    // chart decreasing
  return '\u2796';                          // minus / no change
}

function _formatChange(value, suffix) {
  const s = suffix || '';
  if (value > 0) return `+${value}${s}`;
  if (value < 0) return `${value}${s}`;
  return `No change`;
}
