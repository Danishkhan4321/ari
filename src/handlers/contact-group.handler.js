/**
 * Contact-group handler for the dashboard CRM. Large workbooks take one
 * checkpointed server-side action; manual name assignment remains deliberately
 * exact so a short name can never select an unrelated person.
 */

'use strict';

const registry = require('./handler-registry');
const { contactGroupService: defaultContactGroupService } = require('../services/contact-group.service');
const logger = require('../utils/logger');

const DASHBOARD_HINT = 'You can see it in the dashboard under Contacts → Groups.';
let cachedBulkService = null;

function defaultBulkService() {
  if (cachedBulkService) return cachedBulkService;
  const { createContactGroupBulkService } = require('../services/contact-group-bulk.service');
  const { createContactGroupBulkRepository } = require('../services/contact-group-bulk.repository');
  const { fileAnalysisService } = require('../services/file-analysis.service');
  const repository = createContactGroupBulkRepository();
  cachedBulkService = createContactGroupBulkService({
    loadDocument: (userPhone, input) => fileAnalysisService.loadRecentDocument(
      userPhone,
      input.fileName || null,
    ),
    syncGroup: repository.syncGroup,
    checkpointStore: repository.checkpointStore,
    groupExists: repository.groupExists,
  });
  return cachedBulkService;
}

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

function formatAddOutcome(result) {
  if (result.error) return result.error;
  const added = Array.isArray(result.added) ? result.added : [];
  const existing = Array.isArray(result.existing) ? result.existing : [];
  const notFound = Array.isArray(result.notFound) ? result.notFound : [];
  const ambiguous = Array.isArray(result.ambiguous) ? result.ambiguous : [];
  const rejected = Array.isArray(result.rejected) ? result.rejected : [];
  const parts = [];
  if (added.length > 0) {
    parts.push(`Added ${added.map((name) => `*${name}*`).join(', ')} to *${result.group.name}*.`);
  }
  if (existing.length > 0) {
    parts.push(`${existing.map((name) => `*${name}*`).join(', ')} already belonged to *${result.group.name}*.`);
  }
  if (notFound.length > 0) {
    parts.push(`No exact CRM match for ${notFound.join(', ')}. Save/import them with email or phone first.`);
  }
  if (ambiguous.length > 0) {
    parts.push(`Skipped ambiguous names: ${ambiguous.join(', ')}. Use a unique email or phone so Ari cannot choose the wrong person.`);
  }
  if (rejected.length > 0) {
    parts.push(`Skipped ${rejected.length} name${rejected.length === 1 ? '' : 's'} beyond the 100-name manual limit. Use sync_from_file for bulk membership.`);
  }
  return parts.join('\n') || `No changes were needed in *${result.group.name}*.`;
}

function memberToolResult(result, summary = formatAddOutcome(result)) {
  const added = result.added || [];
  const existing = result.existing || [];
  const failures = [
    ...(result.notFound || []),
    ...(result.ambiguous || []),
    ...(result.rejected || []),
  ];
  const verified = added.length + existing.length;
  const status = failures.length === 0 ? 'success' : (verified > 0 ? 'partial' : 'failure');
  return {
    status,
    user_summary: summary,
    data: result,
    error: status === 'success' ? undefined : {
      code: status === 'partial' ? 'contact_group_members_partial' : 'contact_group_members_failed',
      category: 'business_rule',
      retryable: false,
      message: summary,
    },
  };
}

function bulkSummary(result) {
  if (result.status === 'success') {
    const replay = result.replayedGroups > 0 ? ` ${result.replayedGroups} completed checkpoint(s) were safely reused.` : '';
    return `Synchronized all ${result.totalGroups} CRM groups and ${result.totalRecords} unique people from ${result.sourceName}.${replay}`;
  }
  if (result.status === 'partial') {
    return `Synchronized ${result.completedGroups} of ${result.totalGroups} CRM groups from ${result.sourceName}; ${result.failedGroups} failed. A retry will resume only unfinished groups.`;
  }
  return `Could not synchronize the CRM workbook ${result.sourceName || ''}. No completed group will be repeated on retry.`.trim();
}

function bulkToolResult(result) {
  const status = result.status === 'success' ? 'success'
    : result.status === 'partial' ? 'partial' : 'failure';
  const summary = bulkSummary(result);
  return {
    status,
    user_summary: summary,
    data: result,
    error: status === 'success' ? undefined : {
      code: status === 'partial' ? 'crm_bulk_partial' : 'crm_bulk_failed',
      category: 'bulk_operation',
      retryable: (result.errors || []).some((error) => error.retryable === true),
      message: summary,
    },
  };
}

function createContactGroupHandler(options = {}) {
  const contactGroupService = options.contactGroupService || defaultContactGroupService;
  const getBulkService = options.bulkService
    ? () => options.bulkService
    : (options.getBulkService || defaultBulkService);

  return async function contactGroupHandler(message, context = {}) {
    const { userPhone, intentParams } = context;
    const params = intentParams || {};
    const action = params.action || 'create';

    try {
      switch (action) {
        case 'create': {
          const name = String(params.group_name || '').trim();
          if (!name) {
            return reply(context, {
              status: 'waiting_input',
              user_summary: 'What should the group be called?',
              data: { required: ['group_name'] },
            }, 'What should the group be called? Say: create group [name]');
          }
          const result = await contactGroupService.createGroup(userPhone, name, params.emoji || null);
          if (result.error) return failure(context, 'contact_group_create_failed', `Couldn't create the group: ${result.error}`);
          const header = result.existed
            ? `You already have a group named *${result.group.name}* — using that one.`
            : `Group *${result.group.name}* created. ${DASHBOARD_HINT}`;
          const memberNames = Array.isArray(params.member_names) ? params.member_names.filter(Boolean) : [];
          if (memberNames.length === 0) {
            return reply(context, {
              status: 'success', user_summary: header, data: { group: result.group, existed: result.existed },
            }, header);
          }
          const addResult = await contactGroupService.addMembersByNames(userPhone, result.group.name, memberNames);
          const summary = `${header}\n${formatAddOutcome(addResult)}`;
          return reply(context, memberToolResult(addResult, summary), summary);
        }

        case 'add_members': {
          const groupName = String(params.group_name || '').trim();
          const memberNames = Array.isArray(params.member_names) ? params.member_names.filter(Boolean) : [];
          if (!groupName) {
            return reply(context, {
              status: 'waiting_input', user_summary: 'Which group should I update?', data: { required: ['group_name'] },
            }, 'Which group? Say: add [names] to group [group name]');
          }
          if (memberNames.length === 0) {
            return reply(context, {
              status: 'waiting_input',
              user_summary: `Who should I add to ${groupName}? Give me exact CRM names.`,
              data: { required: ['member_names'] },
            }, `Who should I add to *${groupName}*? Give me exact contact or lead names.`);
          }
          const result = await contactGroupService.addMembersByNames(userPhone, groupName, memberNames);
          if (result.error) return failure(context, 'contact_group_not_found', `${result.error}. Say "show my groups" to see what exists.`);
          const summary = formatAddOutcome(result);
          return reply(context, memberToolResult(result, summary), summary);
        }

        case 'sync_from_file': {
          const result = await getBulkService().syncFromFile(userPhone, {
            fileName: params.file_name || null,
            retryFailed: params.retry_failed !== false,
          });
          const typed = bulkToolResult(result);
          return reply(context, typed, typed.user_summary);
        }

        case 'list': {
          const groups = await contactGroupService.listGroups(userPhone);
          if (groups.length === 0) {
            const text = 'No groups yet. Say: create group [name] — or build one in the dashboard under Contacts → Groups.';
            return reply(context, { status: 'success', user_summary: text, data: { groups: [] } }, text);
          }
          const lines = groups.map((group) => `- ${group.emoji ? `${group.emoji} ` : ''}*${group.name}* (${group.member_count} member${group.member_count === 1 ? '' : 's'})`);
          const text = `Your contact groups:\n${lines.join('\n')}`;
          return reply(context, { status: 'success', user_summary: text, data: { groups } }, text);
        }

        case 'remove_members': {
          const groupName = String(params.group_name || '').trim();
          const memberNames = Array.isArray(params.member_names) ? params.member_names.filter(Boolean) : [];
          if (!groupName || memberNames.length === 0) {
            return reply(context, {
              status: 'waiting_input',
              user_summary: 'Which group, and who should I remove from it?',
              data: { required: ['group_name', 'member_names'] },
            }, 'Which group, and who should I remove? Say: remove [names] from group [group name]');
          }
          const result = await contactGroupService.removeMembersByNames(userPhone, groupName, memberNames);
          if (result.error) return failure(context, 'contact_group_not_found', `${result.error}. Say "show my groups" to see what exists.`);
          const parts = [];
          if (result.removed.length > 0) {
            parts.push(`Removed ${result.removed.length} member${result.removed.length === 1 ? '' : 's'} from *${result.group.name}*: ${result.removed.join(', ')}. The contacts themselves were kept.`);
          }
          if (result.ambiguous.length > 0) parts.push(`Ambiguous (more than one match): ${result.ambiguous.join(', ')}.`);
          if (result.notFound.length > 0) parts.push(`Not in that group: ${result.notFound.join(', ')}.`);
          const summary = parts.join('\n') || `Nothing changed in *${result.group.name}*.`;
          return reply(context, {
            status: result.removed.length > 0 ? 'success' : 'failure',
            user_summary: summary,
            data: { removed: result.removed, notFound: result.notFound, ambiguous: result.ambiguous },
            error: result.removed.length > 0 ? undefined : {
              code: 'contact_group_members_not_removed',
              category: 'execution',
              retryable: true,
              message: 'No named member was in that group.',
            },
          }, summary);
        }

        case 'rename': {
          const groupName = String(params.group_name || '').trim();
          const newName = String(params.new_name || '').trim();
          if (!groupName || !newName) {
            return reply(context, {
              status: 'waiting_input',
              user_summary: 'Which group should I rename, and to what?',
              data: { required: ['group_name', 'new_name'] },
            }, 'Which group should I rename, and to what? Say: rename group [old] to [new]');
          }
          const result = await contactGroupService.updateGroup(userPhone, groupName, { newName });
          if (result.error) return failure(context, 'contact_group_update_failed', result.error);
          const text = `Group *${result.previousName}* renamed to *${result.group.name}*.`;
          return reply(context, { status: 'success', user_summary: text, data: { group: result.group } }, text);
        }

        case 'set_emoji': {
          const groupName = String(params.group_name || '').trim();
          if (!groupName) {
            return reply(context, {
              status: 'waiting_input', user_summary: 'Which group should get the emoji?', data: { required: ['group_name'] },
            }, 'Which group? Say: set [emoji] for group [name]');
          }
          const result = await contactGroupService.updateGroup(userPhone, groupName, { emoji: params.emoji || null });
          if (result.error) return failure(context, 'contact_group_update_failed', result.error);
          const text = params.emoji
            ? `Group *${result.group.name}* now uses ${params.emoji}.`
            : `Removed the emoji from *${result.group.name}*.`;
          return reply(context, { status: 'success', user_summary: text, data: { group: result.group } }, text);
        }

        case 'archive':
        case 'restore': {
          const groupName = String(params.group_name || '').trim();
          if (!groupName) {
            return reply(context, {
              status: 'waiting_input', user_summary: `Which group should I ${action}?`, data: { required: ['group_name'] },
            }, `Which group should I ${action}?`);
          }
          const result = await contactGroupService.updateGroup(userPhone, groupName, { archived: action === 'archive' });
          if (result.error) return failure(context, 'contact_group_update_failed', result.error);
          const text = action === 'archive'
            ? `Group *${result.group.name}* archived. It stays in the dashboard's Archived filter and can be restored anytime.`
            : `Group *${result.group.name}* restored to your active groups.`;
          return reply(context, { status: 'success', user_summary: text, data: { group: result.group } }, text);
        }

        case 'delete': {
          const groupName = String(params.group_name || '').trim();
          const deleteAll = params.delete_all === true || /^all(\s+groups?)?$/i.test(groupName);
          if (deleteAll) {
            const groups = await contactGroupService.listGroups(userPhone);
            if (groups.length === 0) {
              const text = 'There are no CRM groups to delete.';
              return reply(context, { status: 'success', user_summary: text, data: { deletedCount: 0, deleted: [] } }, text);
            }
            if (params.confirm !== true) {
              // Bulk deletion is irreversible; require an explicit user
              // confirmation before the model may re-call with confirm=true.
              const names = groups.map((group) => group.name).join(', ');
              return reply(context, {
                status: 'waiting_input',
                user_summary: `This permanently deletes all ${groups.length} CRM group(s): ${names}. The contacts/leads inside them are kept. Should I go ahead?`,
                data: { requires: { confirm: true }, groups: groups.map((group) => group.name) },
              }, `Delete all ${groups.length} groups (${names})? Reply "yes, delete all groups" to confirm. The contacts inside them are kept.`);
            }
            const result = await contactGroupService.deleteAllGroups(userPhone);
            const text = result.deletedCount > 0
              ? `Deleted ${result.deletedCount} CRM group(s): ${result.deleted.join(', ')}. The contacts/leads themselves were kept.`
              : 'No CRM groups were deleted.';
            return reply(context, {
              status: result.deletedCount > 0 ? 'success' : 'failure',
              user_summary: text,
              data: result,
              error: result.deletedCount > 0 ? undefined : {
                code: 'contact_group_delete_unverified',
                category: 'execution',
                retryable: true,
                message: 'The delete removed no rows; the groups may already be gone.',
              },
            }, text);
          }
          if (!groupName) {
            return reply(context, {
              status: 'waiting_input',
              user_summary: 'Which group should I delete? Or say all groups.',
              data: { required: ['group_name'] },
            }, 'Which group should I delete? Say: delete group [name]');
          }
          const result = await contactGroupService.deleteGroup(userPhone, groupName);
          if (result.error) return failure(context, 'contact_group_not_found', `${result.error}. Say "show my groups" to see what exists.`);
          const text = `Deleted group *${result.deleted.name}*. The contacts/leads in it were kept.`;
          return reply(context, { status: 'success', user_summary: text, data: result }, text);
        }

        default:
          return failure(context, 'unsupported_contact_group_action', 'I can create groups, add exact CRM members, list groups, delete a group (or all groups), or sync a workbook.');
      }
    } catch (error) {
      logger.error(`[ContactGroup] ${action} failed: ${error.message}`);
      const code = error.code || 'contact_group_execution_failed';
      const retryable = ['40001', '40P01', '55P03', '08006', 'ETIMEDOUT', 'ECONNRESET'].includes(code);
      return failure(
        context,
        code,
        `Couldn't update your contact groups: ${String(error.message || 'unknown error').slice(0, 300)}`,
        retryable,
      );
    }
  };
}

const contactGroupHandler = createContactGroupHandler();
registry.register('contact_group_manage', contactGroupHandler);

module.exports = {
  bulkToolResult,
  createContactGroupHandler,
  formatAddOutcome,
  memberToolResult,
};
