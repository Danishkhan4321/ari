const registry = require('./handler-registry');
const sharedBoardService = require('../services/shared-board.service');
const { query } = require('../config/database');
const logger = require('../utils/logger');

const PRIORITY_ICONS = {
  high: '\u26A1',
  normal: '',
  low: '\u{1F53D}'
};

registry.register('shared_board', async (message, context) => {
  const { text } = message;
  const { userPhone, intentParams } = context;
  const lower = text.toLowerCase().trim();

  try {
    // Resolve team admin phone for board scoping
    const adminPhone = await _resolveAdminPhone(userPhone);
    if (!adminPhone) {
      return '\u26A0\uFE0F You need to be part of a team to use shared boards.\nAsk your admin to add you with "add team member [name] [phone]"';
    }

    // ── LLM Params-First Routing ────────────────────────────────────────
    if (intentParams?.action) {
      switch (intentParams.action) {
        case 'create_board': {
          if (intentParams.board_name) {
            const result = await sharedBoardService.createBoard(adminPhone, intentParams.board_name, intentParams.board_description || null, userPhone);
            if (!result.success) return `\u26A0\uFE0F ${result.error}`;
            let response = `\u2705 Board Created!\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
            response += `\uD83D\uDCCB Name: ${result.board.name}\n`;
            if (intentParams.board_description) {
              response += `\uD83D\uDCDD Description: ${intentParams.board_description}\n`;
            }
            response += `\nAdd tasks with "add task to ${result.board.name}: [task title]"`;
            return response;
          }
          break;
        }
        case 'add_task': {
          if (intentParams.board_name && intentParams.task_title) {
            const board = await sharedBoardService.getBoard(adminPhone, intentParams.board_name);
            if (!board) return `\u26A0\uFE0F Board "${intentParams.board_name}" not found. Create it with "create board: ${intentParams.board_name}"`;
            const priority = intentParams.priority || 'normal';
            let assignedTo = null;
            let assignedToName = intentParams.assignee_name || null;
            if (assignedToName) {
              const resolved = await _resolveTeamMember(adminPhone, assignedToName);
              if (resolved) { assignedTo = resolved.phone; assignedToName = resolved.name; }
            }
            const result = await sharedBoardService.addTask(board.id, intentParams.task_title, assignedTo, assignedToName, priority, null, userPhone);
            if (!result.success) return `\u26A0\uFE0F ${result.error}`;
            const task = result.task;
            let response = `\u2705 Task Added to ${board.name}\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
            response += `\uD83D\uDCCC [#${task.id}] ${task.title}\n`;
            if (assignedToName) response += `\uD83D\uDC64 Assigned: ${assignedToName}\n`;
            if (priority !== 'normal') response += `${PRIORITY_ICONS[priority] || ''} Priority: ${_capitalise(priority)}\n`;
            return response;
          }
          break;
        }
        case 'status': {
          if (intentParams.board_name) {
            const data = await sharedBoardService.getBoardStatus(adminPhone, intentParams.board_name);
            if (!data) return `\u26A0\uFE0F Board "${intentParams.board_name}" not found.`;
            return _formatBoardStatus(data);
          }
          // No board name — show all boards
          return await _formatBoardsList(adminPhone);
        }
        case 'assign': {
          if (intentParams.task_id && intentParams.assignee_name) {
            const taskId = parseInt(intentParams.task_id);
            const resolved = await _resolveTeamMember(adminPhone, intentParams.assignee_name);
            if (!resolved) return `\u26A0\uFE0F Could not find team member "${intentParams.assignee_name}".`;
            const result = await sharedBoardService.assignTask(taskId, resolved.phone, resolved.name, userPhone);
            if (!result.success) return `\u26A0\uFE0F ${result.error}`;
            return `\u2705 Task #${taskId} assigned to ${resolved.name}.`;
          }
          break;
        }
        case 'complete': {
          if (intentParams.task_id) {
            const taskId = parseInt(intentParams.task_id);
            const result = await sharedBoardService.updateTaskStatus(taskId, 'done', userPhone);
            if (!result.success) return `\u26A0\uFE0F ${result.error}`;
            return `\u2705 Task #${taskId} marked as done!\n\uD83C\uDF89 "${result.task.title}" completed.`;
          }
          break;
        }
        case 'move': {
          if (intentParams.task_id && intentParams.target_column) {
            const taskId = parseInt(intentParams.task_id);
            const status = _normaliseStatus(intentParams.target_column);
            const result = await sharedBoardService.updateTaskStatus(taskId, status, userPhone);
            if (!result.success) return `\u26A0\uFE0F ${result.error}`;
            const statusLabel = _formatStatusLabel(status);
            return `\u2705 Task #${taskId} moved to ${statusLabel}.`;
          }
          break;
        }
        case 'start': {
          if (intentParams.task_id) {
            const taskId = parseInt(intentParams.task_id);
            const result = await sharedBoardService.updateTaskStatus(taskId, 'in_progress', userPhone);
            if (!result.success) return `\u26A0\uFE0F ${result.error}`;
            return `\uD83D\uDD04 Task #${taskId} is now in progress.\n\uD83D\uDCAA Working on: "${result.task.title}"`;
          }
          break;
        }
        case 'list_boards': {
          return await _formatBoardsList(adminPhone);
        }
        case 'delete_board': {
          if (intentParams.board_name) {
            if (adminPhone !== userPhone) return '\u26A0\uFE0F Only the team admin can delete boards.';
            const result = await sharedBoardService.deleteBoard(adminPhone, intentParams.board_name);
            if (!result.success) return `\u26A0\uFE0F ${result.error}`;
            return `\uD83D\uDDD1\uFE0F Board "${result.board.name}" and all its tasks have been deleted.`;
          }
          break;
        }
        case 'delete_task': {
          if (intentParams.task_id) {
            const taskId = parseInt(intentParams.task_id);
            const result = await sharedBoardService.deleteTask(taskId, userPhone);
            if (!result.success) return `\u26A0\uFE0F ${result.error}`;
            return `\uD83D\uDDD1\uFE0F Task #${taskId} "${result.task.title}" deleted.`;
          }
          break;
        }
      }
    }

    // ── Regex Fallback ──────────────────────────────────────────────────

    // ── Create Board ────────────────────────────────────────────────────
    const createMatch = text.match(/^(?:create|new|make|setup|set\s+up|start)\s+(?:a\s+)?(?:new\s+)?(?:project\s+)?board[:\s]+(.+)$/i)
      || text.match(/^(?:create|new|make)\s+(?:a\s+)?(?:new\s+)?board\s+(?:called|named|for)\s+(.+)$/i);
    if (createMatch) {
      const rawName = createMatch[1].trim();
      // Support "create board: Name - description" or just "create board: Name"
      let name = rawName;
      let description = null;
      const descSplit = rawName.match(/^(.+?)\s*[-\u2014\u2013]\s*(.+)$/);
      if (descSplit) {
        name = descSplit[1].trim();
        description = descSplit[2].trim();
      }

      const result = await sharedBoardService.createBoard(adminPhone, name, description, userPhone);
      if (!result.success) {
        return `\u26A0\uFE0F ${result.error}`;
      }

      let response = `\u2705 Board Created!\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
      response += `\uD83D\uDCCB Name: ${result.board.name}\n`;
      if (description) {
        response += `\uD83D\uDCDD Description: ${description}\n`;
      }
      response += `\nAdd tasks with "add task to ${result.board.name}: [task title]"`;
      return response;
    }

    // ── Add Task to Board ───────────────────────────────────────────────
    const addTaskMatch = text.match(/^(?:add\s+(?:a\s+)?task\s+(?:to|on|in)(?:\s+board)?|board\s+task(?:\s+to)?|new\s+task\s+(?:on|in|for)(?:\s+board)?)\s+([^:]+):\s*(.+)$/i);
    if (addTaskMatch) {
      const boardName = addTaskMatch[1].trim();
      const taskTitle = addTaskMatch[2].trim();

      const board = await sharedBoardService.getBoard(adminPhone, boardName);
      if (!board) {
        return `\u26A0\uFE0F Board "${boardName}" not found. Create it with "create board: ${boardName}"`;
      }

      // Parse optional priority and assignment from title
      const { cleanTitle, priority, assigneeName } = _parseTaskDetails(taskTitle);

      let assignedTo = null;
      let assignedToName = assigneeName;

      if (assigneeName) {
        const resolved = await _resolveTeamMember(adminPhone, assigneeName);
        if (resolved) {
          assignedTo = resolved.phone;
          assignedToName = resolved.name;
        }
      }

      const result = await sharedBoardService.addTask(
        board.id, cleanTitle, assignedTo, assignedToName, priority, null, userPhone
      );

      if (!result.success) {
        return `\u26A0\uFE0F ${result.error}`;
      }

      const task = result.task;
      let response = `\u2705 Task Added to ${board.name}\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
      response += `\uD83D\uDCCC [#${task.id}] ${task.title}\n`;
      if (assignedToName) {
        response += `\uD83D\uDC64 Assigned: ${assignedToName}\n`;
      }
      if (priority !== 'normal') {
        response += `${PRIORITY_ICONS[priority] || ''} Priority: ${_capitalise(priority)}\n`;
      }
      return response;
    }

    // ── Board Status / Show Board ───────────────────────────────────────
    const statusMatch = text.match(/^(?:board\s+status|show\s+(?:me\s+)?(?:the\s+)?board|board\s+tasks?|what'?s?\s+on\s+(?:the\s+)?board|how'?s?\s+(?:the\s+)?board)\s*(?:of\s+|for\s+)?(.+)?$/i);
    if (statusMatch) {
      const boardName = statusMatch[1] ? statusMatch[1].trim() : null;

      if (!boardName) {
        // Show all boards if no name specified
        return await _formatBoardsList(adminPhone);
      }

      const data = await sharedBoardService.getBoardStatus(adminPhone, boardName);
      if (!data) {
        return `\u26A0\uFE0F Board "${boardName}" not found.`;
      }

      return _formatBoardStatus(data);
    }

    // ── Assign Task ─────────────────────────────────────────────────────
    const assignMatch = text.match(/^assign\s+task\s+#?(\d+)\s+to\s+(.+)$/i);
    if (assignMatch) {
      const taskId = parseInt(assignMatch[1]);
      const assigneeName = assignMatch[2].trim();

      const resolved = await _resolveTeamMember(adminPhone, assigneeName);
      if (!resolved) {
        return `\u26A0\uFE0F Could not find team member "${assigneeName}".`;
      }

      const result = await sharedBoardService.assignTask(taskId, resolved.phone, resolved.name, userPhone);
      if (!result.success) {
        return `\u26A0\uFE0F ${result.error}`;
      }

      return `\u2705 Task #${taskId} assigned to ${resolved.name}.`;
    }

    // ── Complete Task ───────────────────────────────────────────────────
    const completeMatch = lower.match(/^(?:complete|done|finish|mark\s+done)\s+task\s+#?(\d+)$/);
    if (completeMatch) {
      const taskId = parseInt(completeMatch[1]);
      const result = await sharedBoardService.updateTaskStatus(taskId, 'done', userPhone);
      if (!result.success) {
        return `\u26A0\uFE0F ${result.error}`;
      }
      return `\u2705 Task #${taskId} marked as done!\n\uD83C\uDF89 "${result.task.title}" completed.`;
    }

    // ── Move Task to Done ───────────────────────────────────────────────
    const moveDoneMatch = lower.match(/^move\s+task\s+#?(\d+)\s+to\s+(todo|done|in.?progress)$/);
    if (moveDoneMatch) {
      const taskId = parseInt(moveDoneMatch[1]);
      const rawStatus = moveDoneMatch[2];
      const status = _normaliseStatus(rawStatus);
      const result = await sharedBoardService.updateTaskStatus(taskId, status, userPhone);
      if (!result.success) {
        return `\u26A0\uFE0F ${result.error}`;
      }
      const statusLabel = _formatStatusLabel(status);
      return `\u2705 Task #${taskId} moved to ${statusLabel}.`;
    }

    // ── Start Task / Working On ─────────────────────────────────────────
    const startMatch = lower.match(/^(?:start|working\s+on|begin)\s+task\s+#?(\d+)$/);
    if (startMatch) {
      const taskId = parseInt(startMatch[1]);
      const result = await sharedBoardService.updateTaskStatus(taskId, 'in_progress', userPhone);
      if (!result.success) {
        return `\u26A0\uFE0F ${result.error}`;
      }
      return `\uD83D\uDD04 Task #${taskId} is now in progress.\n\uD83D\uDCAA Working on: "${result.task.title}"`;
    }

    // ── My Boards / Show Boards ─────────────────────────────────────────
    if (/^(?:my |show |list |view )?boards$/i.test(lower)) {
      return await _formatBoardsList(adminPhone);
    }

    // ── Delete Board ────────────────────────────────────────────────────
    const deleteBoardMatch = text.match(/^delete\s+board\s+(.+)$/i);
    if (deleteBoardMatch) {
      if (adminPhone !== userPhone) {
        return '\u26A0\uFE0F Only the team admin can delete boards.';
      }
      const boardName = deleteBoardMatch[1].trim();
      const result = await sharedBoardService.deleteBoard(adminPhone, boardName);
      if (!result.success) {
        return `\u26A0\uFE0F ${result.error}`;
      }
      return `\uD83D\uDDD1\uFE0F Board "${result.board.name}" and all its tasks have been deleted.`;
    }

    // ── Delete Task ─────────────────────────────────────────────────────
    const deleteTaskMatch = lower.match(/^delete\s+task\s+#?(\d+)$/);
    if (deleteTaskMatch) {
      const taskId = parseInt(deleteTaskMatch[1]);
      const result = await sharedBoardService.deleteTask(taskId, userPhone);
      if (!result.success) {
        return `\u26A0\uFE0F ${result.error}`;
      }
      return `\uD83D\uDDD1\uFE0F Task #${taskId} "${result.task.title}" deleted.`;
    }

    // ── Fallback ────────────────────────────────────────────────────────
    return `\uD83D\uDCCB *Shared Board Commands:*\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u2022 "create board: Project Alpha"\n\u2022 "add task to Project Alpha: design mockups"\n\u2022 "board status Project Alpha"\n\u2022 "assign task #3 to Rahul"\n\u2022 "start task #3"\n\u2022 "done task #3"\n\u2022 "my boards"\n\u2022 "delete board Project Alpha"`;

  } catch (error) {
    logger.error('Shared board handler error:', error.message);
    return '\u274C Something went wrong with the shared board. Please try again.';
  }
});

// ── Helper Functions ──────────────────────────────────────────────────────

async function _resolveAdminPhone(userPhone) {
  try {
    // Check if user is an admin
    const adminCheck = await query(
      `SELECT admin_phone FROM teams WHERE admin_phone = $1 LIMIT 1`,
      [userPhone]
    );
    if (adminCheck.rows.length > 0) {
      return userPhone;
    }

    // Check if user is a member
    const memberCheck = await query(
      `SELECT admin_phone FROM teams WHERE member_phone = $1 LIMIT 1`,
      [userPhone]
    );
    if (memberCheck.rows.length > 0) {
      return memberCheck.rows[0].admin_phone;
    }

    return null;
  } catch (error) {
    logger.error('Error resolving admin phone:', error.message);
    return null;
  }
}

async function _resolveTeamMember(adminPhone, nameOrPhone) {
  try {
    const lower = nameOrPhone.toLowerCase().trim();

    const result = await query(
      `SELECT member_phone, member_name FROM teams WHERE admin_phone = $1 ORDER BY member_name`,
      [adminPhone]
    );

    const members = result.rows;

    // Exact name match
    let match = members.find(m => m.member_name.toLowerCase() === lower);
    if (match) return { phone: match.member_phone, name: match.member_name };

    // Partial name match
    match = members.find(m => m.member_name.toLowerCase().includes(lower));
    if (match) return { phone: match.member_phone, name: match.member_name };

    // Phone match
    const phone = nameOrPhone.replace(/\D/g, '');
    if (phone.length >= 10) {
      match = members.find(m => m.member_phone.includes(phone));
      if (match) return { phone: match.member_phone, name: match.member_name };
    }

    return null;
  } catch (error) {
    return null;
  }
}

function _parseTaskDetails(taskTitle) {
  let cleanTitle = taskTitle;
  let priority = 'normal';
  let assigneeName = null;

  // Extract priority: "fix bug !high" or "fix bug (high)"
  const priorityMatch = cleanTitle.match(/\s*[!\(](high|low|normal)\)?$/i);
  if (priorityMatch) {
    priority = priorityMatch[1].toLowerCase();
    cleanTitle = cleanTitle.replace(priorityMatch[0], '').trim();
  }

  // Extract assignment: "fix bug @Rahul"
  const assignMatch = cleanTitle.match(/\s*@(\S+)$/i);
  if (assignMatch) {
    assigneeName = assignMatch[1].trim();
    cleanTitle = cleanTitle.replace(assignMatch[0], '').trim();
  }

  return { cleanTitle, priority, assigneeName };
}

function _normaliseStatus(raw) {
  const lower = raw.toLowerCase().replace(/[\s_-]+/g, '');
  if (lower === 'inprogress' || lower === 'wip' || lower === 'doing') return 'in_progress';
  if (lower === 'done' || lower === 'completed') return 'done';
  return 'todo';
}

function _formatStatusLabel(status) {
  switch (status) {
    case 'in_progress': return '\uD83D\uDD04 In Progress';
    case 'done': return '\u2705 Done';
    default: return '\uD83D\uDCDD To Do';
  }
}

function _capitalise(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function _formatBoardStatus(data) {
  const { board, todo, inProgress, done, stats } = data;

  let response = `\uD83D\uDCCB Board: ${board.name}\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
  response += `\uD83D\uDCCA Progress: ${stats.completionRate}% (${stats.doneCount}/${stats.total} done)\n`;

  if (todo.length > 0) {
    response += `\n\uD83D\uDCDD To Do:\n`;
    todo.forEach(t => {
      const assignee = t.assigned_to_name ? ` (${t.assigned_to_name})` : '';
      const pri = PRIORITY_ICONS[t.priority] || '';
      response += `  \u2022 [#${t.id}] ${t.title}${assignee}${pri ? ' ' + pri : ''}\n`;
    });
  }

  if (inProgress.length > 0) {
    response += `\n\uD83D\uDD04 In Progress:\n`;
    inProgress.forEach(t => {
      const assignee = t.assigned_to_name ? ` (${t.assigned_to_name})` : '';
      const pri = PRIORITY_ICONS[t.priority] || '';
      response += `  \u2022 [#${t.id}] ${t.title}${assignee}${pri ? ' ' + pri : ''}\n`;
    });
  }

  if (done.length > 0) {
    response += `\n\u2705 Done:\n`;
    done.forEach(t => {
      const assignee = t.assigned_to_name ? ` (${t.assigned_to_name})` : '';
      response += `  \u2022 [#${t.id}] ${t.title}${assignee}\n`;
    });
  }

  if (stats.total === 0) {
    response += `\nNo tasks yet. Add one with "add task to ${board.name}: [task]"`;
  }

  return response.trim();
}

async function _formatBoardsList(adminPhone) {
  const boards = await sharedBoardService.getBoards(adminPhone);

  if (boards.length === 0) {
    return '\uD83D\uDCCB No shared boards yet.\n\nCreate one with "create board: Project Alpha"';
  }

  let response = `\uD83D\uDCCB *Your Shared Boards (${boards.length})*\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;

  boards.forEach((b, i) => {
    const total = parseInt(b.total_tasks) || 0;
    const doneCount = parseInt(b.done_count) || 0;
    const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;
    response += `\n${i + 1}. *${b.name}*`;
    if (b.description) {
      response += ` \u2014 ${b.description}`;
    }
    response += `\n   \uD83D\uDCDD ${b.todo_count} \u2022 \uD83D\uDD04 ${b.in_progress_count} \u2022 \u2705 ${b.done_count} (${pct}%)\n`;
  });

  response += `\n_"board status [name]" to view details_`;
  return response.trim();
}
