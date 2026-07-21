/**
 * Team workspace handler — the chat side of the dashboard Team pages.
 *
 * Every write here is admin-scoped, because the underlying tables are keyed by
 * the team admin's phone. A member who is not the admin gets a clear refusal
 * rather than a silent no-op, and no action ever picks a team or a person by
 * fuzzy match.
 */

'use strict';

const registry = require('./handler-registry');
const { teamWorkspaceService: defaultService } = require('../services/team-workspace.service');
const followUpService = require('../services/follow-up.service');
const logger = require('../utils/logger');

const READ_ACTIONS = new Set([
  'list_broadcasts', 'broadcast_status', 'list_one_on_ones',
  'list_onboardings', 'member_info', 'list_chats',
]);

function reply(context, typed, legacy = typed.user_summary) {
  return context?.agentExecution ? typed : legacy;
}

function failure(context, code, userSummary, retryable = false, data = null) {
  return reply(context, {
    status: 'failure',
    user_summary: userSummary,
    data,
    error: { code, category: 'business_rule', retryable, message: userSummary },
  });
}

function waiting(context, userSummary, required = []) {
  return reply(context, {
    status: 'waiting_input',
    user_summary: userSummary,
    data: { required },
  });
}

function ok(context, userSummary, data = null) {
  return reply(context, { status: 'success', user_summary: userSummary, data });
}

function shortDate(value, withTime = true) {
  if (!value) return 'unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('en-IN', withTime
    ? { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
}

function createTeamCommsHandler(options = {}) {
  const service = options.teamWorkspaceService || defaultService;

  return async function handleTeamComms(message, context = {}) {
    const userPhone = context.userPhone || message?.from;
    const params = context.intentParams || {};
    const action = String(params.action || '').trim();

    try {
      const team = await service.resolveTeam(userPhone, params.team_name || null);
      if (!team) {
        return failure(context, 'team_not_found', params.team_name
          ? `You are not in a team called "${String(params.team_name).trim()}". Say "my teams" to see what exists.`
          : 'You do not have a team yet. Create one with "create design team".');
      }
      if (team.ambiguous) {
        return waiting(context,
          `Which team? You are in: ${team.teams.join(', ')}.`, ['team_name']);
      }
      if (!READ_ACTIONS.has(action) && !team.isAdmin) {
        return failure(context, 'team_admin_only',
          `Only the admin of the *${team.teamName}* team can change that.`);
      }

      const requireMember = async (raw, label = 'that person') => {
        const resolved = await service.resolveMember(team.adminPhone, raw);
        if (!resolved) return { error: `${raw} is not on the *${team.teamName}* team. Add them first: "add ${raw} +91… to ${team.teamName} team".` };
        if (resolved.ambiguous) return { error: `More than one member is called "${raw}". Use their phone number so I do not pick the wrong ${label}.` };
        return { member: resolved };
      };

      switch (action) {
        case 'list_broadcasts': {
          const rows = await service.listBroadcasts(team.adminPhone, team.teamName);
          if (rows.length === 0) {
            return ok(context, `No broadcasts sent to *${team.teamName}* yet. Say "tell the team ..." to send one.`, { broadcasts: [] });
          }
          const lines = rows.map((row) => {
            const preview = String(row.message_text || '').replace(/\s+/g, ' ').slice(0, 70);
            return `*#${row.id}* ${shortDate(row.created_at)} — "${preview}"\n   ${row.read_count}/${row.total_members} read, ${row.delivered_count} delivered${row.failed_count ? `, ${row.failed_count} failed` : ''}`;
          });
          return ok(context, `*Broadcasts to ${team.teamName}:*\n\n${lines.join('\n\n')}\n\n_Ask "who read broadcast ${rows[0].id}" for names._`, { broadcasts: rows });
        }

        case 'broadcast_status': {
          let broadcastId = params.broadcast_id;
          if (!broadcastId) {
            const [latest] = await service.listBroadcasts(team.adminPhone, team.teamName, 1);
            if (!latest) return ok(context, `No broadcasts sent to *${team.teamName}* yet.`, { broadcasts: [] });
            broadcastId = latest.id;
          }
          const recipients = await service.getBroadcastRecipients(team.adminPhone, broadcastId);
          if (recipients.length === 0) {
            return failure(context, 'broadcast_not_found', `I could not find broadcast #${broadcastId} on your team.`);
          }
          const buckets = { read: [], delivered: [], sent: [], pending: [], failed: [] };
          for (const person of recipients) {
            const key = buckets[person.status] ? person.status : 'pending';
            buckets[key].push(person.member_name || person.member_phone);
          }
          const parts = [];
          for (const [label, names] of [['Seen', buckets.read], ['Delivered', buckets.delivered],
            ['Sent', buckets.sent], ['Not yet delivered', buckets.pending], ['Failed', buckets.failed]]) {
            if (names.length > 0) parts.push(`*${label}* (${names.length}): ${names.join(', ')}`);
          }
          return ok(context, `*Broadcast #${broadcastId}*\n\n${parts.join('\n')}`, { broadcastId, recipients });
        }

        case 'list_one_on_ones': {
          const rows = await service.listOneOnOnes(team.adminPhone);
          if (rows.length === 0) return ok(context, 'No 1:1s scheduled. Say "schedule a 1:1 with Rahul on Friday 4pm".', { oneOnOnes: [] });
          const lines = rows.map((row) => `*#${row.id}* ${row.manager_name || row.manager_phone} ↔ ${row.report_name || row.report_phone} — ${shortDate(row.next_at)}${row.cadence_days ? ` (every ${row.cadence_days}d)` : ''}${row.agenda ? `\n   ${String(row.agenda).slice(0, 120)}` : ''}`);
          return ok(context, `*Upcoming 1:1s:*\n\n${lines.join('\n')}`, { oneOnOnes: rows });
        }

        case 'schedule_one_on_one': {
          const report = await requireMember(params.member_name, 'report');
          if (report.error) return failure(context, 'team_member_not_found', report.error);
          let manager = { member: { member_phone: userPhone, member_name: message?.name || 'you' } };
          if (params.manager_name) {
            manager = await requireMember(params.manager_name, 'manager');
            if (manager.error) return failure(context, 'team_member_not_found', manager.error);
          }
          const when = followUpService.parseDueTime(params.due_time, context.userTimezone || 'Asia/Kolkata');
          if (!when) return waiting(context, `When should the 1:1 with ${report.member.member_name} happen?`, ['due_time']);
          const result = await service.scheduleOneOnOne(team.adminPhone, {
            teamName: team.teamName,
            managerPhone: manager.member.member_phone,
            managerName: manager.member.member_name,
            reportPhone: report.member.member_phone,
            reportName: report.member.member_name,
            nextAt: when,
            cadenceDays: params.cadence_days ?? null,
            agenda: params.agenda || null,
          });
          if (result.error) return failure(context, 'one_on_one_not_scheduled', result.error);
          const row = result.oneOnOne;
          return ok(context,
            `1:1 with *${row.report_name || report.member.member_name}* scheduled for ${shortDate(row.next_at)}${row.cadence_days ? `, repeating every ${row.cadence_days} days` : ''} (ID: ${row.id}).`,
            { oneOnOne: row });
        }

        case 'cancel_one_on_one': {
          const result = await service.cancelOneOnOne(team.adminPhone, params.one_on_one_id);
          if (result.error) return failure(context, 'one_on_one_not_found', result.error);
          return ok(context, `Cancelled the 1:1 with *${result.cancelled.report_name || result.cancelled.report_phone}* that was set for ${shortDate(result.cancelled.next_at)}.`, result);
        }

        case 'list_onboardings': {
          const rows = await service.listOnboardings(team.adminPhone);
          if (rows.length === 0) return ok(context, 'Nobody is being onboarded right now.', { onboardings: [] });
          const lines = rows.map((row) => `*#${row.id}* ${row.member_name || row.member_phone} — started ${shortDate(row.started_at, false)}${row.completed_at ? ` • completed ${shortDate(row.completed_at, false)}` : ' • in progress'}`);
          return ok(context, `*Onboarding:*\n\n${lines.join('\n')}`, { onboardings: rows });
        }

        case 'start_onboarding': {
          const hire = await requireMember(params.member_name, 'new hire');
          if (hire.error) return failure(context, 'team_member_not_found', hire.error);
          let managerPhone = null;
          if (params.manager_name) {
            const manager = await requireMember(params.manager_name, 'manager');
            if (manager.error) return failure(context, 'team_member_not_found', manager.error);
            managerPhone = manager.member.member_phone;
          }
          const result = await service.startOnboarding(team.adminPhone, {
            teamName: team.teamName,
            memberPhone: hire.member.member_phone,
            memberName: hire.member.member_name,
            managerPhone,
          });
          const row = result.onboarding;
          return ok(context, `Started onboarding for *${row.member_name || hire.member.member_name}* on the ${team.teamName} team (ID: ${row.id}). Ari will send the paced welcome nudges.`, { onboarding: row });
        }

        case 'complete_onboarding': {
          const result = await service.completeOnboarding(team.adminPhone, params.onboarding_id);
          if (result.error) return failure(context, 'onboarding_not_found', result.error);
          return ok(context, `Marked onboarding complete for *${result.onboarding.member_name || result.onboarding.member_phone}*. No further nudges will be sent.`, result);
        }

        case 'member_info': {
          const rows = await service.getMemberMeta(team.adminPhone, team.teamName);
          const wanted = String(params.member_name || '').trim().toLowerCase();
          const filtered = wanted
            ? rows.filter((row) => String(row.member_name || '').trim().toLowerCase() === wanted)
            : rows;
          if (filtered.length === 0) {
            return ok(context, wanted
              ? `No saved details for ${params.member_name} yet. Say "set ${params.member_name}'s birthday to 1996-03-12".`
              : `No member details saved for *${team.teamName}* yet.`, { meta: [] });
          }
          const lines = filtered.map((row) => {
            const bits = [];
            if (row.birthday) bits.push(`birthday ${row.birthday}`);
            if (row.joined_at) bits.push(`joined ${row.joined_at}`);
            if (row.manager_phone) bits.push(`manager ${row.manager_phone}`);
            if (row.notes) bits.push(String(row.notes).slice(0, 120));
            return `*${row.member_name || row.member_phone}* — ${bits.join(' • ') || 'no details'}`;
          });
          return ok(context, lines.join('\n'), { meta: filtered });
        }

        case 'set_member_info': {
          const member = await requireMember(params.member_name);
          if (member.error) return failure(context, 'team_member_not_found', member.error);
          let managerPhone = null;
          if (params.manager_name) {
            const manager = await requireMember(params.manager_name, 'manager');
            if (manager.error) return failure(context, 'team_member_not_found', manager.error);
            managerPhone = manager.member.member_phone;
          }
          const result = await service.upsertMemberMeta(team.adminPhone, team.teamName, member.member.member_phone, {
            birthday: params.birthday || null,
            joined_at: params.start_date || null,
            manager_phone: managerPhone,
            notes: params.notes || null,
          });
          if (result.error) {
            return waiting(context, result.error, ['birthday', 'start_date', 'manager_name', 'notes']);
          }
          const saved = [];
          if (params.birthday) saved.push(`birthday ${params.birthday}`);
          if (params.start_date) saved.push(`start date ${params.start_date}`);
          if (managerPhone) saved.push(`manager ${params.manager_name}`);
          if (params.notes) saved.push('a note');
          return ok(context, `Saved ${saved.join(', ')} for *${member.member.member_name}*.`, result);
        }

        case 'invite_link': {
          const result = await service.getOrCreateInviteCode(team.adminPhone, team.teamName);
          if (result.error) return failure(context, 'invite_code_failed', result.error, true);
          return ok(context,
            `Invite code for *${team.teamName}*: \`${result.code}\`\n\nAsk the new member to send Ari this message:\n_join ari team ${result.code}_\n\n${result.existed ? 'This code was already active.' : 'It works for 30 days.'}`,
            result);
        }

        case 'list_chats': {
          const rows = await service.listChats(team.adminPhone, userPhone);
          if (rows.length === 0) return ok(context, 'You are not in any team chat threads yet. Create one from the dashboard Team → Chat page.', { chats: [] });
          const lines = rows.map((row) => `*#${row.id}* ${row.name || (row.type === 'dm' ? 'Direct message' : 'Group')} — ${row.member_count} members${row.last_message_at ? `, last message ${shortDate(row.last_message_at)}` : ''}`);
          return ok(context, `*Your team chats:*\n\n${lines.join('\n')}`, { chats: rows });
        }

        case 'send_chat_message': {
          const result = await service.sendChatMessage(team.adminPhone, userPhone, {
            chatId: params.chat_id || null,
            chatName: params.chat_name || null,
            text: params.message,
            fromName: message?.name || null,
          });
          if (result.error) return failure(context, 'team_chat_send_failed', result.error);
          return ok(context, `Posted in *${result.chat.name || `chat #${result.chat.id}`}*. Your team sees it on the dashboard, and Ari nudges anyone who has not read it.`, result);
        }

        default:
          return failure(context, 'unsupported_team_comms_action',
            'I can show broadcasts and who read them, manage 1:1s and onboarding, save member details, share the invite link, and post in a team chat.');
      }
    } catch (error) {
      logger.error(`[TeamComms] ${action} failed: ${error.message}`);
      const retryable = ['40001', '40P01', '55P03', '08006', 'ETIMEDOUT', 'ECONNRESET'].includes(error.code);
      return failure(context, error.code || 'team_comms_execution_failed',
        `Couldn't complete that team request: ${String(error.message || 'unknown error').slice(0, 300)}`, retryable);
    }
  };
}

const teamCommsHandler = createTeamCommsHandler();
registry.register('team_comms', teamCommsHandler);

module.exports = { createTeamCommsHandler };
