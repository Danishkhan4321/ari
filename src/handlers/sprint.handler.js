const registry = require('./handler-registry');
const sprintService = require('../services/sprint.service');
const { query } = require('../config/database');
const logger = require('../utils/logger');

registry.register('sprint_manage', async (message, context) => {
  const { text } = message;
  const { userPhone, intentParams } = context;
  const lower = text.toLowerCase().trim();

  try {
    // Resolve team admin phone for sprint scoping
    const adminPhone = await _resolveAdminPhone(userPhone);
    if (!adminPhone) {
      return '\u26a0\ufe0f You need to be part of a team to use sprint management.\nAsk your admin to add you with "add team member [name] [phone]"';
    }

    // ── LLM Params-First Routing ────────────────────────────────────────
    if (intentParams?.action) {
      switch (intentParams.action) {
        case 'create': {
          if (intentParams.sprint_name) {
            const result = await sprintService.createSprint(adminPhone, intentParams.sprint_name, null, intentParams.sprint_goal || null);
            if (!result.success) return `\u26a0\ufe0f ${result.error}`;
            const sprint = result.sprint;
            let response = `\ud83c\udfc3 Sprint Created!\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
            response += `\ud83d\udccc Name: ${sprint.name}\n`;
            if (intentParams.sprint_goal) response += `\ud83c\udfaf Goal: ${intentParams.sprint_goal}\n`;
            response += `\ud83d\udcc5 Started: ${new Date(sprint.start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}\n`;
            response += `\nAdd items with "add to sprint: task name - 3 points"`;
            return response;
          }
          break;
        }
        case 'add_item': {
          if (intentParams.item_title) {
            const sprint = await sprintService.getActiveSprint(adminPhone);
            if (!sprint) return '\u26a0\ufe0f No active sprint. Create one with "create sprint: Sprint Name"';
            const points = intentParams.story_points ? parseInt(intentParams.story_points) : 1;
            let assignedTo = null;
            let assigneeName = intentParams.assignee_name || null;
            if (assigneeName) {
              const resolved = await _resolveTeamMember(adminPhone, assigneeName);
              if (resolved) { assignedTo = resolved.phone; assigneeName = resolved.name; }
            }
            const item = await sprintService.addItem(sprint.id, intentParams.item_title, assignedTo, assigneeName, points);
            if (!item) return '\u274c Failed to add item to sprint. Please try again.';
            let response = `\u2705 Added to Sprint: ${sprint.name}\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
            response += `\ud83d\udccc [#${item.id}] ${item.title}\n`;
            response += `\ud83d\udcca Points: ${item.story_points}\n`;
            if (assigneeName) response += `\ud83d\udc64 Assigned: ${assigneeName}\n`;
            return response.trim();
          }
          break;
        }
        case 'status': {
          const status = await sprintService.getSprintStatus(adminPhone);
          if (!status) return '\ud83c\udfc3 No active sprint.\n\nCreate one with "create sprint: Sprint Name"';
          return _formatSprintStatus(status);
        }
        case 'end': {
          const result = await sprintService.endSprint(adminPhone);
          if (!result.success) return `\u26a0\ufe0f ${result.error}`;
          const s = result.summary;
          let response = `\ud83c\udfc1 Sprint Completed: ${s.name}\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
          response += `\ud83d\udcca Completed: ${s.completedPoints}/${s.totalPoints} pts (${s.progressPercent}%)\n`;
          response += `\u2705 Items Done: ${s.completedItems}/${s.totalItems}\n`;
          response += `\ud83d\udd25 Velocity: ${s.velocity} pts\n`;
          if (s.incompleteItems && s.incompleteItems.length > 0) {
            response += `\n\u26a0\ufe0f Incomplete Items (${s.incompleteItems.length}):\n`;
            s.incompleteItems.forEach(item => { response += `  \u2022 [#${item.id}] ${item.title} (${item.story_points}pts)\n`; });
          }
          return response.trim();
        }
        case 'history': {
          const history = await sprintService.getSprintHistory(adminPhone);
          if (history.length === 0) return '\ud83d\udccb No completed sprints yet.';
          let response = `\ud83d\udccb Sprint History\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
          history.forEach((s, i) => {
            const pct = s.totalPoints > 0 ? Math.round((s.completedPoints / s.totalPoints) * 100) : 0;
            response += `\n${i + 1}. *${s.name}*\n`;
            response += `   \ud83d\udcca ${s.completedPoints}/${s.totalPoints} pts (${pct}%)\n`;
            response += `   \u2705 ${s.completedItems}/${s.totalItems} items\n`;
            if (s.goal) response += `   \ud83c\udfaf ${s.goal}\n`;
          });
          return response.trim();
        }
        case 'velocity': {
          const velocity = await sprintService.getVelocity(adminPhone);
          if (velocity.sprints.length === 0) return '\ud83d\udcca No completed sprints to calculate velocity.\nComplete a sprint first with "end sprint"';
          let response = `\ud83d\udcca Team Velocity\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
          response += `\ud83d\udd25 Average: ${velocity.avgVelocity} pts/sprint\n\n`;
          response += `Recent Sprints:\n`;
          velocity.sprints.forEach(s => { response += `  \u2022 ${s.name}: ${s.points} pts\n`; });
          return response.trim();
        }
        case 'complete_item': {
          if (intentParams.item_id) {
            const itemId = parseInt(intentParams.item_id);
            const item = await sprintService.updateItemStatus(itemId, 'done', userPhone);
            if (!item) return `\u26a0\ufe0f Sprint item #${itemId} not found.`;
            return `\u2705 Sprint item #${itemId} marked as done!\n\ud83c\udf89 "${item.title}" completed (${item.story_points}pts)`;
          }
          break;
        }
      }
    }

    // ── Regex Fallback ──────────────────────────────────────────────────

    // ── Create Sprint ───────────────────────────────────────────────────
    const createMatch = text.match(/^(?:create|new|start|begin|kick\s*off)\s+(?:a\s+)?(?:new\s+)?sprint[:\s]+(.+)$/i);
    if (createMatch) {
      const raw = createMatch[1].trim();
      let name = raw;
      let goal = null;

      // Support "Sprint Name - Goal description"
      const goalSplit = raw.match(/^(.+?)\s*-\s+(.+)$/);
      if (goalSplit) {
        name = goalSplit[1].trim();
        goal = goalSplit[2].trim();
      }

      const result = await sprintService.createSprint(adminPhone, name, null, goal);

      if (!result.success) {
        return `\u26a0\ufe0f ${result.error}`;
      }

      const sprint = result.sprint;
      let response = `\ud83c\udfc3 Sprint Created!\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
      response += `\ud83d\udccc Name: ${sprint.name}\n`;
      if (goal) {
        response += `\ud83c\udfaf Goal: ${goal}\n`;
      }
      response += `\ud83d\udcc5 Started: ${new Date(sprint.start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}\n`;
      response += `\nAdd items with "add to sprint: task name - 3 points"`;
      return response;
    }

    // ── Add Item to Sprint ──────────────────────────────────────────────
    const addMatch = text.match(/^(?:add\s+to\s+sprint|sprint\s+item)[:\s]+(.+)$/i);
    if (addMatch) {
      const sprint = await sprintService.getActiveSprint(adminPhone);
      if (!sprint) {
        return '\u26a0\ufe0f No active sprint. Create one with "create sprint: Sprint Name"';
      }

      const raw = addMatch[1].trim();
      const { title, points, assigneeName, assignedTo } = await _parseSprintItem(raw, adminPhone);

      const item = await sprintService.addItem(sprint.id, title, assignedTo, assigneeName, points);

      if (!item) {
        return '\u274c Failed to add item to sprint. Please try again.';
      }

      let response = `\u2705 Added to Sprint: ${sprint.name}\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
      response += `\ud83d\udccc [#${item.id}] ${item.title}\n`;
      response += `\ud83d\udcca Points: ${item.story_points}\n`;
      if (assigneeName) {
        response += `\ud83d\udc64 Assigned: ${assigneeName}\n`;
      }
      return response.trim();
    }

    // ── Sprint Status ───────────────────────────────────────────────────
    if (/^(?:sprint\s+status|show\s+sprint|current\s+sprint|active\s+sprint)$/i.test(lower)) {
      const status = await sprintService.getSprintStatus(adminPhone);

      if (!status) {
        return '\ud83c\udfc3 No active sprint.\n\nCreate one with "create sprint: Sprint Name"';
      }

      return _formatSprintStatus(status);
    }

    // ── End Sprint ──────────────────────────────────────────────────────
    if (/^(?:end|close|finish|complete)\s+sprint$/i.test(lower)) {
      const result = await sprintService.endSprint(adminPhone);

      if (!result.success) {
        return `\u26a0\ufe0f ${result.error}`;
      }

      const s = result.summary;
      let response = `\ud83c\udfc1 Sprint Completed: ${s.name}\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
      response += `\ud83d\udcca Completed: ${s.completedPoints}/${s.totalPoints} pts (${s.progressPercent}%)\n`;
      response += `\u2705 Items Done: ${s.completedItems}/${s.totalItems}\n`;
      response += `\ud83d\udd25 Velocity: ${s.velocity} pts\n`;

      if (s.incompleteItems && s.incompleteItems.length > 0) {
        response += `\n\u26a0\ufe0f Incomplete Items (${s.incompleteItems.length}):\n`;
        s.incompleteItems.forEach(item => {
          response += `  \u2022 [#${item.id}] ${item.title} (${item.story_points}pts)\n`;
        });
      }

      return response.trim();
    }

    // ── Sprint History ──────────────────────────────────────────────────
    if (/^(?:sprint\s+history|past\s+sprints?|previous\s+sprints?|completed\s+sprints?)$/i.test(lower)) {
      const history = await sprintService.getSprintHistory(adminPhone);

      if (history.length === 0) {
        return '\ud83d\udccb No completed sprints yet.';
      }

      let response = `\ud83d\udccb Sprint History\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
      history.forEach((s, i) => {
        const pct = s.totalPoints > 0 ? Math.round((s.completedPoints / s.totalPoints) * 100) : 0;
        response += `\n${i + 1}. *${s.name}*\n`;
        response += `   \ud83d\udcca ${s.completedPoints}/${s.totalPoints} pts (${pct}%)\n`;
        response += `   \u2705 ${s.completedItems}/${s.totalItems} items\n`;
        if (s.goal) {
          response += `   \ud83c\udfaf ${s.goal}\n`;
        }
      });
      return response.trim();
    }

    // ── Sprint Velocity ─────────────────────────────────────────────────
    if (/^(?:sprint\s+velocity|team\s+velocity|velocity)$/i.test(lower)) {
      const velocity = await sprintService.getVelocity(adminPhone);

      if (velocity.sprints.length === 0) {
        return '\ud83d\udcca No completed sprints to calculate velocity.\nComplete a sprint first with "end sprint"';
      }

      let response = `\ud83d\udcca Team Velocity\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
      response += `\ud83d\udd25 Average: ${velocity.avgVelocity} pts/sprint\n\n`;
      response += `Recent Sprints:\n`;
      velocity.sprints.forEach(s => {
        response += `  \u2022 ${s.name}: ${s.points} pts\n`;
      });
      return response.trim();
    }

    // ── Complete Sprint Item ────────────────────────────────────────────
    const completeMatch = lower.match(/^(?:complete|done|finish)\s+(?:sprint\s+)?item\s+#?(\d+)$/);
    if (completeMatch) {
      const itemId = parseInt(completeMatch[1]);
      const item = await sprintService.updateItemStatus(itemId, 'done', userPhone);

      if (!item) {
        return `\u26a0\ufe0f Sprint item #${itemId} not found.`;
      }

      return `\u2705 Sprint item #${itemId} marked as done!\n\ud83c\udf89 "${item.title}" completed (${item.story_points}pts)`;
    }

    // ── Fallback ────────────────────────────────────────────────────────
    return '\ud83c\udfc3 *Sprint Commands:*\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u2022 "create sprint: Sprint Name"\n\u2022 "add to sprint: task name - 3 points"\n\u2022 "sprint status"\n\u2022 "complete item #3"\n\u2022 "end sprint"\n\u2022 "sprint history"\n\u2022 "sprint velocity"';

  } catch (error) {
    logger.error('Sprint handler error:', error.message);
    return '\u274c Something went wrong with sprint management. Please try again.';
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

async function _parseSprintItem(raw, adminPhone) {
  let title = raw;
  let points = 1;
  let assigneeName = null;
  let assignedTo = null;

  // Extract assignee: "@Rahul" at end
  const assignMatch = title.match(/\s+@(\S+)\s*$/i);
  if (assignMatch) {
    const nameInput = assignMatch[1].trim();
    title = title.replace(assignMatch[0], '').trim();
    const resolved = await _resolveTeamMember(adminPhone, nameInput);
    if (resolved) {
      assignedTo = resolved.phone;
      assigneeName = resolved.name;
    } else {
      assigneeName = nameInput;
    }
  }

  // Extract points: "3 points", "3pts", "3 pts", "- 3 points"
  const pointsMatch = title.match(/\s*[-\u2013\u2014]?\s*(\d+)\s*(?:pts?|points?)\s*$/i);
  if (pointsMatch) {
    points = parseInt(pointsMatch[1]);
    title = title.replace(pointsMatch[0], '').trim();
  }

  // Clean up trailing dash/separator
  title = title.replace(/\s*[-\u2013\u2014]\s*$/, '').trim();

  return { title, points, assigneeName, assignedTo };
}

function _formatSprintStatus(status) {
  const { sprint, items, stats } = status;

  const todo = items.filter(i => i.status === 'todo');
  const inProgress = items.filter(i => i.status === 'in_progress');
  const done = items.filter(i => i.status === 'done');

  let response = `\ud83c\udfc3 Sprint: ${sprint.name}\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
  response += `\ud83d\udcca Progress: ${stats.progressPercent}% (${stats.completedPoints}/${stats.totalPoints} pts)\n`;
  response += `\ud83d\udd25 Velocity: ${stats.velocity} pts\n`;
  if (sprint.end_date) {
    response += `\ud83d\udcc5 Ends: ${new Date(sprint.end_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}\n`;
  }
  if (sprint.goal) {
    response += `\ud83c\udfaf Goal: ${sprint.goal}\n`;
  }

  if (todo.length > 0) {
    response += `\n\ud83d\udcdd Todo (${todo.length}):\n`;
    todo.forEach(t => {
      const assignee = t.assigned_to_name ? ` - ${t.assigned_to_name}` : '';
      response += `  [#${t.id}] ${t.title} (${t.story_points}pts)${assignee}\n`;
    });
  }

  if (inProgress.length > 0) {
    response += `\n\ud83d\udd04 In Progress (${inProgress.length}):\n`;
    inProgress.forEach(t => {
      const assignee = t.assigned_to_name ? ` - ${t.assigned_to_name}` : '';
      response += `  [#${t.id}] ${t.title} (${t.story_points}pts)${assignee}\n`;
    });
  }

  if (done.length > 0) {
    response += `\n\u2705 Done (${done.length}):\n`;
    done.forEach(t => {
      const assignee = t.assigned_to_name ? ` - ${t.assigned_to_name}` : '';
      response += `  [#${t.id}] ${t.title} (${t.story_points}pts)${assignee}\n`;
    });
  }

  if (items.length === 0) {
    response += '\nNo items yet. Add one with "add to sprint: task name - 3 points"';
  }

  return response.trim();
}
