const registry = require('./handler-registry');
const incidentService = require('../services/incident.service');
const { query } = require('../config/database');
const logger = require('../utils/logger');

const SEVERITY_EMOJI = {
  critical: '\ud83d\udd34',
  high: '\ud83d\udfe0',
  medium: '\ud83d\udfe1',
  low: '\ud83d\udfe2'
};

registry.register('incident_manage', async (message, context) => {
  const { text } = message;
  const { userPhone, intentParams } = context;
  const lower = text.toLowerCase().trim();

  try {
    // Resolve team admin phone for incident scoping
    const adminPhone = await _resolveAdminPhone(userPhone);
    if (!adminPhone) {
      return '\u26a0\ufe0f You need to be part of a team to use incident management.\nAsk your admin to add you with "add team member [name] [phone]"';
    }

    // ── LLM Params-First Routing ────────────────────────────────────────
    if (intentParams?.action) {
      switch (intentParams.action) {
        case 'report': {
          if (intentParams.title) {
            const severity = intentParams.severity || 'medium';
            const reporterName = await _getTeamMemberName(adminPhone, userPhone);
            const result = await incidentService.reportIncident(adminPhone, intentParams.title, null, severity, userPhone, reporterName);
            if (!result.success) return `\u26a0\ufe0f ${result.error}`;
            const incident = result.incident;
            const sevEmoji = SEVERITY_EMOJI[incident.severity] || SEVERITY_EMOJI.medium;
            let response = `\ud83d\udea8 Incident Reported\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
            response += `ID: #${incident.id}\n`;
            response += `Title: ${incident.title}\n`;
            response += `Severity: ${sevEmoji} ${_capitalize(incident.severity)}\n`;
            response += `Status: Open\n`;
            response += `Reported by: ${reporterName || 'Unknown'}`;
            return response;
          }
          break;
        }
        case 'resolve': {
          if (intentParams.incident_id) {
            const incidentId = parseInt(intentParams.incident_id);
            const notes = intentParams.resolution_notes || null;
            const result = await incidentService.resolveIncident(incidentId, notes, adminPhone);
            if (!result.success) return `\u26a0\ufe0f ${result.error}`;
            const incident = result.incident;
            let response = `\u2705 Incident #${incident.id} Resolved\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
            response += `Title: ${incident.title}\n`;
            if (notes) response += `Resolution: ${notes}\n`;
            return response.trim();
          }
          break;
        }
        case 'assign': {
          if (intentParams.incident_id && intentParams.assignee_name) {
            const incidentId = parseInt(intentParams.incident_id);
            const resolved = await _resolveTeamMember(adminPhone, intentParams.assignee_name);
            if (!resolved) return `\u26a0\ufe0f Could not find team member "${intentParams.assignee_name}".`;
            const result = await incidentService.assignIncident(incidentId, resolved.phone, resolved.name, adminPhone);
            if (!result.success) return `\u26a0\ufe0f ${result.error}`;
            return `\u2705 Incident #${incidentId} assigned to ${resolved.name}.`;
          }
          break;
        }
        case 'escalate': {
          if (intentParams.incident_id) {
            const incidentId = parseInt(intentParams.incident_id);
            const result = await incidentService.escalateIncident(incidentId, adminPhone);
            if (!result.success) return `\u26a0\ufe0f ${result.error}`;
            const incident = result.incident;
            return `\u26a0\ufe0f Incident #${incident.id} Escalated!\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\nTitle: ${incident.title}\nEscalation Count: ${incident.escalation_count}`;
          }
          break;
        }
        case 'status':
        case 'list': {
          const incidents = await incidentService.getIncidents(adminPhone, 'open');
          if (incidents.length === 0) return '\u2705 No open incidents. All clear!';
          let response = `\ud83d\udea8 Open Incidents (${incidents.length})\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
          incidents.forEach((inc, i) => {
            const sevEmoji = SEVERITY_EMOJI[inc.severity] || SEVERITY_EMOJI.medium;
            const assignee = inc.assigned_to_name ? ` \u2192 ${inc.assigned_to_name}` : '';
            const escalated = inc.escalated ? ' \u26a0\ufe0f' : '';
            response += `${i + 1}. [#${inc.id}] ${inc.title}\n`;
            response += `   ${sevEmoji} ${_capitalize(inc.severity)}${assignee}${escalated}\n`;
          });
          return response.trim();
        }
        case 'stats': {
          const stats = await incidentService.getIncidentStats(adminPhone, 30);
          let response = `\ud83d\udcca Incident Report (30 days)\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
          response += `\ud83d\udcdd Total: ${stats.total}\n`;
          response += `\ud83d\udea8 Open: ${stats.open}\n`;
          response += `\u2705 Resolved: ${stats.resolved}\n`;
          if (stats.avgResolutionMins !== null) {
            const hours = Math.floor(stats.avgResolutionMins / 60);
            const mins = stats.avgResolutionMins % 60;
            const avgTime = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
            response += `\u23f1\ufe0f Avg Resolution: ${avgTime}\n`;
          }
          if (stats.bySeverity.length > 0) {
            response += `\nBy Severity:\n`;
            stats.bySeverity.forEach(s => {
              const emoji = SEVERITY_EMOJI[s.severity] || '\u26aa';
              response += `  ${emoji} ${_capitalize(s.severity)}: ${s.count}\n`;
            });
          }
          return response.trim();
        }
      }
    }

    // ── Regex Fallback ──────────────────────────────────────────────────

    // ── Report Incident ─────────────────────────────────────────────────
    const reportMatch = text.match(/^(?:report\s+(?:an?\s+)?incident|incident|new\s+incident|raise\s+(?:an?\s+)?incident|log\s+(?:an?\s+)?incident)[:\s]+(.+)$/i);
    if (reportMatch) {
      const raw = reportMatch[1].trim();
      const { title, severity } = _parseIncidentDetails(raw);

      // Get reporter name from team
      const reporterName = await _getTeamMemberName(adminPhone, userPhone);

      const result = await incidentService.reportIncident(
        adminPhone, title, null, severity, userPhone, reporterName
      );

      if (!result.success) {
        return `\u26a0\ufe0f ${result.error}`;
      }

      const incident = result.incident;
      const sevEmoji = SEVERITY_EMOJI[incident.severity] || SEVERITY_EMOJI.medium;

      let response = `\ud83d\udea8 Incident Reported\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
      response += `ID: #${incident.id}\n`;
      response += `Title: ${incident.title}\n`;
      response += `Severity: ${sevEmoji} ${_capitalize(incident.severity)}\n`;
      response += `Status: Open\n`;
      response += `Reported by: ${reporterName || 'Unknown'}`;
      return response;
    }

    // ── Resolve Incident ────────────────────────────────────────────────
    const resolveMatch = text.match(/^(?:resolve|close|fix|mark\s+(?:as\s+)?resolved)\s+incident\s+#?(\d+)[:\s]*(.*)$/i);
    if (resolveMatch) {
      const incidentId = parseInt(resolveMatch[1]);
      const notes = resolveMatch[2] ? resolveMatch[2].trim() : null;

      const result = await incidentService.resolveIncident(incidentId, notes, adminPhone);

      if (!result.success) {
        return `\u26a0\ufe0f ${result.error}`;
      }

      const incident = result.incident;
      let response = `\u2705 Incident #${incident.id} Resolved\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
      response += `Title: ${incident.title}\n`;
      if (notes) {
        response += `Resolution: ${notes}\n`;
      }
      return response.trim();
    }

    // ── Assign Incident ─────────────────────────────────────────────────
    const assignMatch = text.match(/^assign\s+incident\s+#?(\d+)\s+to\s+(.+)$/i);
    if (assignMatch) {
      const incidentId = parseInt(assignMatch[1]);
      const assigneeName = assignMatch[2].trim();

      const resolved = await _resolveTeamMember(adminPhone, assigneeName);
      if (!resolved) {
        return `\u26a0\ufe0f Could not find team member "${assigneeName}".`;
      }

      const result = await incidentService.assignIncident(incidentId, resolved.phone, resolved.name, adminPhone);

      if (!result.success) {
        return `\u26a0\ufe0f ${result.error}`;
      }

      return `\u2705 Incident #${incidentId} assigned to ${resolved.name}.`;
    }

    // ── Escalate Incident ───────────────────────────────────────────────
    const escalateMatch = lower.match(/^escalate\s+incident\s+#?(\d+)$/);
    if (escalateMatch) {
      const incidentId = parseInt(escalateMatch[1]);
      const result = await incidentService.escalateIncident(incidentId, adminPhone);

      if (!result.success) {
        return `\u26a0\ufe0f ${result.error}`;
      }

      const incident = result.incident;
      return `\u26a0\ufe0f Incident #${incident.id} Escalated!\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\nTitle: ${incident.title}\nEscalation Count: ${incident.escalation_count}`;
    }

    // ── Incident Stats ──────────────────────────────────────────────────
    if (/^(?:incident\s+stats?|incident\s+report|incident\s+summary)$/i.test(lower)) {
      const stats = await incidentService.getIncidentStats(adminPhone, 30);

      let response = `\ud83d\udcca Incident Report (30 days)\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
      response += `\ud83d\udcdd Total: ${stats.total}\n`;
      response += `\ud83d\udea8 Open: ${stats.open}\n`;
      response += `\u2705 Resolved: ${stats.resolved}\n`;

      if (stats.avgResolutionMins !== null) {
        const hours = Math.floor(stats.avgResolutionMins / 60);
        const mins = stats.avgResolutionMins % 60;
        const avgTime = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
        response += `\u23f1\ufe0f Avg Resolution: ${avgTime}\n`;
      }

      if (stats.bySeverity.length > 0) {
        response += `\nBy Severity:\n`;
        stats.bySeverity.forEach(s => {
          const emoji = SEVERITY_EMOJI[s.severity] || '\u26aa';
          response += `  ${emoji} ${_capitalize(s.severity)}: ${s.count}\n`;
        });
      }

      return response.trim();
    }

    // ── Show Incidents (status / open incidents) ────────────────────────
    if (/^(?:incident\s+status|show\s+incidents?|open\s+incidents?|incidents?)$/i.test(lower)) {
      const incidents = await incidentService.getIncidents(adminPhone, 'open');

      if (incidents.length === 0) {
        return '\u2705 No open incidents. All clear!';
      }

      let response = `\ud83d\udea8 Open Incidents (${incidents.length})\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
      incidents.forEach((inc, i) => {
        const sevEmoji = SEVERITY_EMOJI[inc.severity] || SEVERITY_EMOJI.medium;
        const assignee = inc.assigned_to_name ? ` \u2192 ${inc.assigned_to_name}` : '';
        const escalated = inc.escalated ? ' \u26a0\ufe0f' : '';
        response += `${i + 1}. [#${inc.id}] ${inc.title}\n`;
        response += `   ${sevEmoji} ${_capitalize(inc.severity)}${assignee}${escalated}\n`;
      });
      return response.trim();
    }

    // ── Fallback ────────────────────────────────────────────────────────
    return '\ud83d\udea8 *Incident Commands:*\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u2022 "report incident: API is down - critical"\n\u2022 "incident status" or "open incidents"\n\u2022 "resolve incident #3: fixed the timeout"\n\u2022 "assign incident #3 to Rahul"\n\u2022 "escalate incident #3"\n\u2022 "incident stats"';

  } catch (error) {
    logger.error('Incident handler error:', error.message);
    return '\u274c Something went wrong with incident management. Please try again.';
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

async function _resolveTeamMember(adminPhone, nameOrPhone) {
  try {
    const lower = nameOrPhone.toLowerCase().trim();
    const result = await query(
      'SELECT member_phone, member_name FROM teams WHERE admin_phone = $1 ORDER BY member_name',
      [adminPhone]
    );
    const members = result.rows;

    // Exact name match
    let match = members.find(m => m.member_name.toLowerCase() === lower);
    if (match) return { phone: match.member_phone, name: match.member_name };

    // Partial name match
    match = members.find(m => m.member_name.toLowerCase().includes(lower));
    if (match) return { phone: match.member_phone, name: match.member_name };

    return null;
  } catch {
    return null;
  }
}

async function _getTeamMemberName(adminPhone, memberPhone) {
  try {
    const result = await query(
      'SELECT member_name FROM teams WHERE admin_phone = $1 AND member_phone = $2 LIMIT 1',
      [adminPhone, memberPhone]
    );
    return result.rows.length > 0 ? result.rows[0].member_name : null;
  } catch {
    return null;
  }
}

function _parseIncidentDetails(raw) {
  let title = raw;
  let severity = 'medium';

  // Extract severity from suffix: "API is down - critical" or "login broken - high"
  const severityMatch = title.match(/\s*[-\u2013\u2014]\s*(critical|high|medium|low)\s*$/i);
  if (severityMatch) {
    severity = severityMatch[1].toLowerCase();
    title = title.replace(severityMatch[0], '').trim();
  }

  return { title, severity };
}

function _capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}
