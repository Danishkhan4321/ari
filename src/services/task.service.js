const { query } = require('../config/database');
const logger = require('../utils/logger');

class TaskService {

  constructor() {
    this.tablesCreated = false;
  }

  // ========== ENSURE TABLES ==========
  async ensureTables() {
    if (this.tablesCreated) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS teams (
          id SERIAL PRIMARY KEY,
          admin_phone VARCHAR(20) NOT NULL,
          team_name VARCHAR(100) NOT NULL DEFAULT 'default',
          member_phone VARCHAR(20) NOT NULL,
          member_name VARCHAR(100) NOT NULL,
          role VARCHAR(50) DEFAULT 'member',
          created_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(admin_phone, team_name, member_phone)
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_teams_admin ON teams(admin_phone)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_teams_member ON teams(member_phone)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_teams_name ON teams(admin_phone, team_name)`);
    } catch (e) {
      // Table may already exist — that's OK, run migrations below
      logger.info('Teams table exists, running migrations...');
    }

    // Migrate existing tables: add team_name column if missing
    // Run each migration independently so one failure doesn't block others
    try {
      await query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS team_name VARCHAR(100) DEFAULT 'default'`);
    } catch (e) { logger.warn('teams migration (add team_name):', e.message); }

    try {
      await query(`UPDATE teams SET team_name = 'default' WHERE team_name IS NULL OR team_name = ''`);
    } catch (e) { logger.warn('teams migration (set defaults):', e.message); }

    try {
      // Set NOT NULL after ensuring all rows have a value
      await query(`ALTER TABLE teams ALTER COLUMN team_name SET NOT NULL`);
    } catch (e) { /* already NOT NULL or column doesn't exist yet */ }

    try {
      await query(`ALTER TABLE teams DROP CONSTRAINT IF EXISTS teams_admin_phone_member_phone_key`);
    } catch (e) { /* constraint may not exist */ }

    try {
      await query(`
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.table_constraints
            WHERE constraint_name = 'teams_admin_team_member_unique'
          ) THEN
            ALTER TABLE teams ADD CONSTRAINT teams_admin_team_member_unique
              UNIQUE (admin_phone, team_name, member_phone);
          END IF;
        END $$
      `);
    } catch (e) { logger.warn('teams migration (unique constraint):', e.message); }

    try {
      await query(`
        CREATE TABLE IF NOT EXISTS tasks (
          id SERIAL PRIMARY KEY,
          user_phone VARCHAR(20) NOT NULL,
          assigned_to VARCHAR(20),
          assigned_by VARCHAR(20),
          description TEXT NOT NULL,
          priority VARCHAR(10) DEFAULT 'medium',
          status VARCHAR(20) DEFAULT 'pending',
          due_date TIMESTAMP,
          created_at TIMESTAMP DEFAULT NOW(),
          completed_at TIMESTAMP
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_phone)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to)`);
    } catch (e) {
      logger.warn('tasks table creation:', e.message);
    }

    // Migration: add last_reminder_sent column for 24h assignee reminders
    try {
      await query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS last_reminder_sent TIMESTAMP`);
    } catch (e) {
      // Column may already exist
    }

    // Align tasks schema with migrations/1_baseline_schema.js (title + description)
    try {
      await query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS title TEXT`);
      await query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS description TEXT`);
      await query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS team_admin_phone TEXT`);
      await query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS team_name TEXT`);
      await query(`UPDATE tasks SET title = description WHERE (title IS NULL OR title = '') AND description IS NOT NULL`);
      await query(`UPDATE tasks SET description = title WHERE (description IS NULL OR description = '') AND title IS NOT NULL`);
      await query(`CREATE INDEX IF NOT EXISTS idx_tasks_team_status ON tasks(team_admin_phone, LOWER(team_name), status, due_date)`);
    } catch (e) {
      logger.warn('tasks schema migration:', e.message);
    }

    this.tablesCreated = true;
  }

  _taskText(task) {
    return String(task?.description || task?.title || '').trim() || 'Untitled';
  }

  // ========== TASK COMPLETION BY ID (for button replies) ==========

  async completeTaskById(taskId) {
    await this.ensureTables();
    try {
      const result = await query(
        `UPDATE tasks SET status = 'completed', completed_at = NOW()
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [taskId]
      );
      if (result.rows.length === 0) {
        return { success: false, error: 'Task not found or already completed.' };
      }
      return { success: true, task: result.rows[0] };
    } catch (error) {
      logger.error('Error completing task by ID:', error.message);
      return { success: false, error: 'Could not complete task.' };
    }
  }

  /** Reopen a completed task the caller owns or is assigned. */
  async reopenTaskByIdForUser(userPhone, taskId) {
    await this.ensureTables();
    try {
      const result = await query(
        `UPDATE tasks SET status = 'pending', completed_at = NULL
         WHERE id = $1
           AND status = 'completed'
           AND (user_phone = $2 OR assigned_to = $2)
         RETURNING *`,
        [taskId, userPhone]
      );
      if (!result.rows?.length) {
        return { success: false, error: 'Task not found, not accessible, or not completed.' };
      }
      return { success: true, task: result.rows[0] };
    } catch (error) {
      logger.error('Error reopening task by ID:', error.message);
      return { success: false, error: 'Could not reopen task.' };
    }
  }

  /** Reopen the most recently completed task matching a title fragment. */
  async reopenTaskByTitleForUser(userPhone, titleQuery) {
    await this.ensureTables();
    try {
      const result = await query(
        `UPDATE tasks SET status = 'pending', completed_at = NULL
         WHERE id = (
           SELECT id FROM tasks
            WHERE (user_phone = $1 OR assigned_to = $1)
              AND status = 'completed'
              AND LOWER(COALESCE(description, title, '')) LIKE $2
            ORDER BY completed_at DESC NULLS LAST, id DESC
            LIMIT 1)
         RETURNING *`,
        [userPhone, `%${String(titleQuery).toLowerCase()}%`]
      );
      if (!result.rows?.length) {
        return { success: false, error: `No completed task matching "${titleQuery}" found.` };
      }
      return { success: true, task: result.rows[0] };
    } catch (error) {
      logger.error('Error reopening task by title:', error.message);
      return { success: false, error: 'Could not reopen task.' };
    }
  }

  /** Edit description/priority/due date of a task the caller owns or is assigned. */
  async editTaskByIdForUser(userPhone, taskId, { description, priority, dueDate } = {}) {
    await this.ensureTables();
    const sets = [];
    const values = [];
    let index = 1;
    if (description !== undefined && String(description).trim()) {
      // title and description are kept in sync at create time — stay in sync.
      sets.push(`title = $${index}`, `description = $${index}`);
      values.push(String(description).trim());
      index++;
    }
    if (priority !== undefined && priority) {
      sets.push(`priority = $${index++}`);
      values.push(priority === 'normal' ? 'medium' : priority);
    }
    if (dueDate !== undefined) {
      sets.push(`due_date = $${index++}`);
      values.push(dueDate);
    }
    if (sets.length === 0) return { success: false, error: 'Nothing to change on that task.' };
    values.push(taskId, userPhone);
    try {
      const result = await query(
        `UPDATE tasks SET ${sets.join(', ')}
         WHERE id = $${index} AND (user_phone = $${index + 1} OR assigned_to = $${index + 1})
         RETURNING *`,
        values
      );
      if (!result.rows?.length) {
        return { success: false, error: 'Task not found or not accessible.' };
      }
      return { success: true, task: result.rows[0] };
    } catch (error) {
      logger.error('Error editing task by ID:', error.message);
      return { success: false, error: 'Could not edit task.' };
    }
  }

  /** Complete a stable task ID only when the caller owns or is assigned it. */
  async completeTaskByIdForUser(userPhone, taskId) {
    await this.ensureTables();
    try {
      const result = await query(
        `UPDATE tasks SET status = 'completed', completed_at = NOW()
         WHERE id = $1
           AND status = 'pending'
           AND (user_phone = $2 OR assigned_to = $2)
         RETURNING *`,
        [taskId, userPhone]
      );
      if (!result.rows?.length) {
        return { success: false, error: 'Task not found, not accessible, or already completed.' };
      }
      return { success: true, task: result.rows[0] };
    } catch (error) {
      logger.error('Error completing owned task by ID:', error.message);
      return { success: false, error: 'Could not complete task.' };
    }
  }

  // ========== ASSIGNEE FOLLOW-UPS (flexible cadence, Phase 3) ==========

  /**
   * Set or replace the follow-up cadence for an assigned task.
   * @param {number} taskId
   * @param {{cadenceMinutes: number|null, nextAt: Date, summary: string}} parsed
   *   from webhook controller's _parseFollowUpDirective().
   *   cadenceMinutes=null → one-time follow-up (clears after firing)
   *   cadenceMinutes>0    → recurring (advances next_at by cadence each fire)
   */
  async setTaskFollowUp(taskId, parsed, actorPhone = null) {
    if (!parsed || !parsed.nextAt) return false;
    try {
      const result = await query(
        `UPDATE tasks
            SET followup_cadence_minutes = $2,
                next_followup_at = $3
          WHERE id = $1
            AND ($4::text IS NULL OR assigned_by = $4)
          RETURNING id`,
        [taskId, parsed.cadenceMinutes || null, parsed.nextAt, actorPhone]
      );
      return Boolean(result.rows?.length || result.rowCount > 0);
    } catch (error) {
      logger.error('Error setting task follow-up:', error.message);
      return false;
    }
  }

  /** Tasks due for a follow-up notification (next_followup_at <= now). */
  async getAssignedTasksDueFollowUp() {
    await this.ensureTables();
    try {
      const result = await query(
        `SELECT * FROM tasks
         WHERE assigned_to IS NOT NULL
           AND assigned_by != assigned_to
           AND status = 'pending'
           AND next_followup_at IS NOT NULL
           AND next_followup_at <= NOW()
         ORDER BY next_followup_at ASC
         LIMIT 50`
      );
      return result.rows;
    } catch (error) {
      logger.error('Error fetching tasks due for follow-up:', error.message);
      return [];
    }
  }

  /**
   * Mark a follow-up as fired and advance to the next occurrence (if recurring)
   * or clear it (if one-time).
   */
  async advanceFollowUp(taskId, cadenceMinutes) {
    try {
      if (cadenceMinutes && cadenceMinutes > 0) {
        // Recurring — push next_followup_at by the cadence
        await query(
          `UPDATE tasks
              SET next_followup_at = NOW() + ($2 || ' minutes')::interval,
                  last_reminder_sent = NOW()
            WHERE id = $1`,
          [taskId, String(cadenceMinutes)]
        );
      } else {
        // One-time — clear next_followup_at so it doesn't fire again
        await query(
          `UPDATE tasks
              SET next_followup_at = NULL,
                  last_reminder_sent = NOW()
            WHERE id = $1`,
          [taskId]
        );
      }
    } catch (error) {
      logger.error('Error advancing follow-up:', error.message);
    }
  }

  // ========== 24-HOUR ASSIGNEE REMINDERS (legacy — kept for back-compat) ==========

  async getAssignedTasksDueReminder() {
    await this.ensureTables();
    try {
      const result = await query(
        `SELECT * FROM tasks
         WHERE assigned_to IS NOT NULL
           AND assigned_by != assigned_to
           AND status = 'pending'
           AND created_at < NOW() - INTERVAL '23 hours 30 minutes'
           AND (last_reminder_sent IS NULL OR last_reminder_sent < NOW() - INTERVAL '23 hours 30 minutes')
           AND next_followup_at IS NULL  -- skip tasks with explicit follow-up cadence (handled by Phase 3 cron)
         ORDER BY created_at ASC
         LIMIT 50`
      );
      return result.rows;
    } catch (error) {
      logger.error('Error fetching tasks due for reminder:', error.message);
      return [];
    }
  }

  async updateTaskReminderSent(taskId) {
    try {
      await query(`UPDATE tasks SET last_reminder_sent = NOW() WHERE id = $1`, [taskId]);
    } catch (error) {
      logger.error('Error updating reminder sent:', error.message);
    }
  }

  // ========== TEAM MANAGEMENT ==========

  async createTeam(adminPhone, teamName) {
    await this.ensureTables();
    try {
      const tn = String(teamName || '').toLowerCase().trim();
      if (!tn) return { success: false, error: 'team name required' };
      const existing = await query(
        `SELECT 1 FROM teams WHERE admin_phone = $1 AND team_name = $2 LIMIT 1`,
        [adminPhone, tn]
      );
      if (existing.rows.length > 0) {
        return { success: false, already: true, error: `team "${tn}" already exists` };
      }
      // Same convention as the dashboard create route: the creator is the
      // team's first row, as admin, so "team exists" means the same thing on
      // every surface.
      let ownerName = 'Team Admin';
      try {
        const tokenRow = await query(
          `SELECT google_email FROM google_tokens WHERE user_phone = $1 LIMIT 1`,
          [adminPhone]
        );
        const email = tokenRow.rows[0]?.google_email;
        if (email) {
          const local = String(email).split('@')[0];
          ownerName = local.charAt(0).toUpperCase() + local.slice(1);
        }
      } catch (_) { /* keep fallback name */ }
      const result = await query(
        `INSERT INTO teams (admin_phone, team_name, member_phone, member_name, role)
         VALUES ($1, $2, $1, $3, 'admin')
         RETURNING *`,
        [adminPhone, tn, ownerName]
      );
      return { success: result.rowCount > 0, member: result.rows[0] };
    } catch (error) {
      logger.error('Error creating team:', error.message);
      return { success: false, error: error.message };
    }
  }

  async addTeamMember(adminPhone, memberPhone, memberName, role = 'member', teamName = 'default') {
    await this.ensureTables();
    try {
      const tn = (teamName || 'default').toLowerCase().trim();
      const result = await query(
        `INSERT INTO teams (admin_phone, team_name, member_phone, member_name, role)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (admin_phone, team_name, member_phone)
         DO UPDATE SET member_name = $4, role = $5
         RETURNING *`,
        [adminPhone, tn, memberPhone, memberName, role]
      );
      return { success: true, member: result.rows[0] };
    } catch (error) {
      logger.error('Error adding team member:', error.message);
      return { success: false, error: error.message };
    }
  }

  async removeTeamMember(adminPhone, memberIdentifier, teamName = null) {
    await this.ensureTables();
    try {
      const teamFilter = teamName ? `AND LOWER(team_name) = LOWER($3)` : '';
      let result = await query(
        `DELETE FROM teams WHERE admin_phone = $1 AND LOWER(member_name) = LOWER($2) ${teamFilter} RETURNING *`,
        teamName ? [adminPhone, memberIdentifier, teamName] : [adminPhone, memberIdentifier]
      );
      if (result.rowCount === 0) {
        const phone = memberIdentifier.replace(/\D/g, '');
        result = await query(
          `DELETE FROM teams WHERE admin_phone = $1 AND member_phone = $2 ${teamFilter} RETURNING *`,
          teamName ? [adminPhone, phone, teamName] : [adminPhone, phone]
        );
      }
      if (result.rowCount > 0) {
        return { success: true, removed: result.rows[0] };
      }
      return { success: false, error: 'Member not found' };
    } catch (error) {
      logger.error('Error removing team member:', error.message);
      return { success: false, error: error.message };
    }
  }

  async getTeamMembers(adminPhone, teamName = null) {
    await this.ensureTables();
    try {
      const result = teamName
        ? await query(
            `SELECT * FROM teams WHERE admin_phone = $1 AND LOWER(team_name) = LOWER($2) ORDER BY member_name`,
            [adminPhone, teamName]
          )
        : await query(
            `SELECT * FROM teams WHERE admin_phone = $1 ORDER BY team_name, member_name`,
            [adminPhone]
          );
      return result.rows;
    } catch (error) {
      return [];
    }
  }

  async getTeamNames(adminPhone) {
    await this.ensureTables();
    try {
      const result = await query(
        `SELECT team_name, COUNT(*) AS member_count FROM teams
         WHERE admin_phone = $1 GROUP BY team_name ORDER BY team_name`,
        [adminPhone]
      );
      return result.rows;
    } catch (error) {
      return [];
    }
  }

  async deleteTeam(adminPhone, teamName) {
    await this.ensureTables();
    try {
      const result = await query(
        `DELETE FROM teams WHERE admin_phone = $1 AND LOWER(team_name) = LOWER($2) RETURNING *`,
        [adminPhone, teamName]
      );
      return { success: result.rowCount > 0, count: result.rowCount };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async getMyManagers(memberPhone) {
    await this.ensureTables();
    try {
      const result = await query(
        `SELECT DISTINCT admin_phone FROM teams WHERE member_phone = $1`,
        [memberPhone]
      );
      return result.rows.map(r => r.admin_phone);
    } catch (error) {
      return [];
    }
  }

  async getTeamMembersForUser(userPhone) {
    await this.ensureTables();
    try {
      const result = await query(
        `SELECT * FROM teams WHERE admin_phone = $1 ORDER BY team_name, member_name`,
        [userPhone]
      );
      return result.rows;
    } catch (error) {
      return [];
    }
  }

  resolveTeamNameFromText(text) {
    // Extracts team name from messages like:
    // "send reminder to stitch boat team" → "stitch boat"
    // "remind the design team" → "design"
    // "stitch boat team ko remind karo" → "stitch boat"
    // "the team" / "team" → null
    const patterns = [
      /\bsend\s+(?:a\s+)?(?:reminder|message)\s+to\s+(?:the\s+)?([a-zA-Z][a-zA-Z\s]+?)\s+team\b/i,
      /\bremind\s+(?:the\s+)?([a-zA-Z][a-zA-Z\s]+?)\s+team\b/i,
      /\b(?:to|for)\s+(?:the\s+)?([a-zA-Z][a-zA-Z\s]+?)\s+team\b/i,
      /\b([a-zA-Z][a-zA-Z\s]+?)\s+team\s+ko\b/i,
      /\b([a-zA-Z][a-zA-Z\s]+?)\s+team\b/i,
    ];
    const stopWords = new Set([
      'the', 'my', 'our', 'this', 'that', 'a', 'an', 'all', 'entire', 'whole',
      'your', 'their', 'its', 'any', 'some', 'every', 'great', 'good', 'new'
    ]);
    for (let i = 0; i < patterns.length; i++) {
      const match = text.match(patterns[i]);
      if (match) {
        const name = match[1].trim().toLowerCase();
        // Guard: >4 words = likely a sentence fragment, not a team name (e.g. "I work in a marketing")
        if (name.split(/\s+/).length > 4) continue;
        if (!stopWords.has(name)) return name;
      }
    }
    return null;
  }

  async resolveTeamMemberPhone(adminPhone, nameOrPhone) {
    const members = await this.getTeamMembers(adminPhone);
    const lower = nameOrPhone.toLowerCase().trim();

    // Try exact name match
    let match = members.find(m => m.member_name.toLowerCase() === lower);
    if (match) return { found: true, phone: match.member_phone, name: match.member_name };

    // Try partial name match
    match = members.find(m => m.member_name.toLowerCase().includes(lower));
    if (match) return { found: true, phone: match.member_phone, name: match.member_name };

    // Try phone match
    const phone = nameOrPhone.replace(/\D/g, '');
    if (phone.length >= 10) {
      match = members.find(m => m.member_phone.includes(phone));
      if (match) return { found: true, phone: match.member_phone, name: match.member_name };
    }

    return { found: false };
  }

  // ========== PERSONAL & ASSIGNED TASK MANAGEMENT ==========

  async createPersonalTask(userPhone, description, priority = 'medium', dueDate = null) {
    await this.ensureTables();
    try {
      const result = await query(
        `INSERT INTO tasks (user_phone, title, description, priority, due_date, status)
         VALUES ($1, $2, $2, $3, $4, 'pending')
         RETURNING *`,
        [userPhone, description, priority, dueDate]
      );
      return { success: true, task: result.rows[0] };
    } catch (error) {
      logger.error('Error creating personal task:', error.message);
      return { success: false, error: error.message };
    }
  }

  async assignTask(assignerPhone, assigneePhone, description, priority = 'medium', dueDate = null) {
    await this.ensureTables();
    try {
      const result = await query(
        `INSERT INTO tasks (user_phone, assigned_to, assigned_by, title, description, priority, due_date, status)
         VALUES ($1, $2, $3, $4, $4, $5, $6, 'pending')
         RETURNING *`,
        [assignerPhone, assigneePhone, assignerPhone, description, priority, dueDate]
      );
      return { success: true, task: result.rows[0] };
    } catch (error) {
      logger.error('Error assigning task:', error.message);
      return { success: false, error: error.message };
    }
  }

  async getPersonalTasks(userPhone) {
    await this.ensureTables();
    try {
      const result = await query(
        `SELECT * FROM tasks
         WHERE user_phone = $1 AND (assigned_to IS NULL OR assigned_to = $1) AND status = 'pending'
         ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END, created_at DESC`,
        [userPhone]
      );
      return result.rows;
    } catch (error) {
      return [];
    }
  }

  async getAssignedToMeTasks(userPhone) {
    await this.ensureTables();
    try {
      const result = await query(
        `SELECT * FROM tasks
         WHERE assigned_to = $1 AND assigned_by != $1 AND status = 'pending'
         ORDER BY created_at DESC`,
        [userPhone]
      );
      return result.rows;
    } catch (error) {
      return [];
    }
  }

  async getAssignedByMeTasks(userPhone) {
    await this.ensureTables();
    try {
      const result = await query(
        `SELECT * FROM tasks
         WHERE assigned_by = $1 AND assigned_to != $1 AND status = 'pending'
         ORDER BY created_at DESC`,
        [userPhone]
      );
      return result.rows;
    } catch (error) {
      return [];
    }
  }

  async getAllMyTasks(userPhone) {
    await this.ensureTables();
    const [personal, assignedToMe, assignedByMe] = await Promise.all([
      this.getPersonalTasks(userPhone),
      this.getAssignedToMeTasks(userPhone),
      this.getAssignedByMeTasks(userPhone)
    ]);
    return { personal, assignedToMe, assignedByMe };
  }

  async completeTaskByTitle(userPhone, titleQuery) {
    await this.ensureTables();
    try {
      const q = String(titleQuery || '').trim().toLowerCase();
      if (!q) return { success: false, error: 'Which task should I mark done?' };

      const { personal, assignedToMe } = await this.getAllMyTasks(userPhone);
      const allTasks = [...personal, ...assignedToMe];
      const task = allTasks.find(t => this._taskText(t).toLowerCase().includes(q));
      if (!task) {
        return { success: false, error: `No pending task matching "${titleQuery}".` };
      }

      await query(
        `UPDATE tasks SET status = 'completed', completed_at = NOW() WHERE id = $1`,
        [task.id]
      );
      return { success: true, task };
    } catch (error) {
      logger.error('Error completing task by title:', error.message);
      return { success: false, error: 'Could not complete task.' };
    }
  }

  async completeTaskByIndex(userPhone, index) {
    await this.ensureTables();
    try {
      // Get all tasks for the user in display order
      const { personal, assignedToMe } = await this.getAllMyTasks(userPhone);
      const allTasks = [...personal, ...assignedToMe];

      if (index < 1 || index > allTasks.length) {
        return { success: false, error: `Invalid task number. You have ${allTasks.length} tasks.` };
      }

      const task = allTasks[index - 1];
      await query(
        `UPDATE tasks SET status = 'completed', completed_at = NOW() WHERE id = $1`,
        [task.id]
      );

      return { success: true, task };
    } catch (error) {
      logger.error('Error completing task:', error.message);
      return { success: false, error: 'Could not complete task.' };
    }
  }

  async deleteTask(userPhone, { index = null, titleQuery = null } = {}) {
    await this.ensureTables();
    try {
      const { personal, assignedToMe } = await this.getAllMyTasks(userPhone);
      const allTasks = [...personal, ...assignedToMe];
      let task = null;
      if (index) {
        if (index < 1 || index > allTasks.length) {
          return { success: false, error: `Invalid task number. You have ${allTasks.length} tasks.` };
        }
        task = allTasks[index - 1];
      } else if (titleQuery) {
        const q = String(titleQuery).trim().toLowerCase();
        task = allTasks.find(t => this._taskText(t).toLowerCase().includes(q));
        if (!task) return { success: false, error: `No pending task matching "${titleQuery}".` };
      } else {
        return { success: false, error: 'Which task should I delete? Give its number or name.' };
      }
      // Same rule as the dashboard: an assignee cannot delete a task someone
      // else assigned to them — completing it is the correct exit.
      if (task.assigned_by && task.assigned_by !== userPhone) {
        return { success: false, error: 'Only the person who assigned this task can delete it. You can mark it done instead.' };
      }
      const result = await query(
        `DELETE FROM tasks WHERE id = $1 RETURNING id`,
        [task.id]
      );
      if (result.rowCount === 0) {
        return { success: false, error: 'The task could not be deleted — it may already be gone.' };
      }
      return { success: true, task };
    } catch (error) {
      logger.error('Error deleting task:', error.message);
      return { success: false, error: 'Could not delete task.' };
    }
  }

  /** Delete a stable task ID without interpreting it as a list position. */
  async deleteTaskById(userPhone, taskId) {
    await this.ensureTables();
    try {
      const result = await query(
        `DELETE FROM tasks
          WHERE id = $1
            AND user_phone = $2
            AND (assigned_by IS NULL OR assigned_by = $2)
          RETURNING *`,
        [taskId, userPhone]
      );
      if (!result.rows?.length) {
        return { success: false, error: 'Task not found or you do not have permission to delete it.' };
      }
      return { success: true, task: result.rows[0] };
    } catch (error) {
      logger.error('Error deleting task by ID:', error.message);
      return { success: false, error: 'Could not delete task.' };
    }
  }

  async getTaskDigest(userPhone) {
    const { personal, assignedToMe, assignedByMe } = await this.getAllMyTasks(userPhone);
    const total = personal.length + assignedToMe.length + assignedByMe.length;
    if (total === 0) return null;

    let digest = '';
    if (personal.length > 0) {
      digest += `${personal.length} personal task${personal.length > 1 ? 's' : ''}`;
    }
    if (assignedToMe.length > 0) {
      digest += `${digest ? ', ' : ''}${assignedToMe.length} assigned to you`;
    }
    if (assignedByMe.length > 0) {
      digest += `${digest ? ', ' : ''}${assignedByMe.length} delegated`;
    }
    return digest;
  }

  async formatTasksList(tasks, userPhone) {
    const { personal, assignedToMe, assignedByMe } = tasks;
    const total = personal.length + assignedToMe.length + assignedByMe.length;

    if (total === 0) {
      return "No pending tasks!\n\nAdd one:\n- \"add task: finish report\"\n- \"assign task to Emily: review PR\"";
    }

    // RC #2 fix: batch-resolve all referenced phones to contact names
    // before rendering. Avoids per-row sequential DB queries (single
    // round-trip via formatManyPhones helper) and keeps the render fast.
    const { formatManyPhones } = require('../utils/format-phone');
    const phonesToResolve = [
      ...assignedToMe.map(t => t.assigned_by),
      ...assignedByMe.map(t => t.assigned_to),
    ].filter(Boolean);
    const phoneMap = await formatManyPhones(phonesToResolve, userPhone);

    let response = `*Your Tasks (${total})*\n\n`;
    let idx = 1;

    if (personal.length > 0) {
      response += `*Personal:*\n`;
      personal.forEach(t => {
        const pri = t.priority === 'high' ? '[HIGH]' : t.priority === 'low' ? '[LOW]' : '[MED]';
        const due = t.due_date ? ` (due: ${new Date(t.due_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })})` : '';
        response += `${idx}. ${pri} ${this._taskText(t)}${due}\n`;
        idx++;
      });
      response += '\n';
    }

    if (assignedToMe.length > 0) {
      response += `*Assigned to you:*\n`;
      assignedToMe.forEach(t => {
        const pri = t.priority === 'high' ? '[HIGH]' : t.priority === 'low' ? '[LOW]' : '[MED]';
        const fromName = phoneMap.get(t.assigned_by) || `+${t.assigned_by}`;
        response += `${idx}. ${pri} ${this._taskText(t)} (from: ${fromName})\n`;
        idx++;
      });
      response += '\n';
    }

    if (assignedByMe.length > 0) {
      response += `*Delegated by you:*\n`;
      assignedByMe.forEach(t => {
        const toName = phoneMap.get(t.assigned_to) || `+${t.assigned_to}`;
        response += `- ${this._taskText(t)} → ${toName}\n`;
      });
      response += '\n';
    }

    response += `_"done task [number]" to complete_`;
    return response;
  }

  // ========== COMMAND PARSING ==========

  parseEnhancedTaskCommand(message) {
    const lower = message.toLowerCase().trim();

    // "my tasks" / "show my tasks" / "show tasks"
    if (/^(?:show\s+)?(?:my\s+)?(?:all\s+)?tasks$/i.test(lower) || /^(?:view|list)\s+(?:my\s+)?(?:all\s+)?tasks$/i.test(lower)) {
      return { action: 'list' };
    }

    // "mark finish report as done"
    const markDoneMatch = message.match(/^mark\s+(.+?)\s+as\s+done$/i);
    if (markDoneMatch) {
      return { action: 'complete', titleQuery: markDoneMatch[1].trim() };
    }

    // "done task 3" / "complete task 1"
    const doneMatch = lower.match(/^(done|complete|finish|mark done)\s+task\s+(\d+)$/i);
    if (doneMatch) {
      return { action: 'complete', index: parseInt(doneMatch[2]) };
    }

    // "assign task to Emily: review the PR"
    const assignMatch = message.match(/^assign\s+task\s+to\s+([^:]+):\s*(.+)$/i);
    if (assignMatch) {
      return { action: 'assign', target: assignMatch[1].trim(), description: assignMatch[2].trim() };
    }

    // "add task: finish report" / "task: do something"
    const addMatch = message.match(/^(?:add\s+)?task:\s*(.+)$/i);
    if (addMatch) {
      return { action: 'add', description: addMatch[1].trim() };
    }

    // "add task finish report by Friday"
    const addMatch2 = message.match(/^add\s+task\s+(.+)$/i);
    if (addMatch2) {
      return { action: 'add', description: addMatch2[1].trim() };
    }

    return null;
  }

  parseTeamCommand(message) {
    const lower = message.toLowerCase().trim();

    // "my teams" / "list teams" / "show all teams"
    if (/^(my|show|list|view)\s+teams?$/i.test(lower) || /^teams$/i.test(lower)) {
      return { action: 'list_teams' };
    }

    // "my team" / "show team" / "team members" → list all (no specific name)
    if (/^(my |show |view |list )?(team|team members)$/i.test(lower)) {
      return { action: 'list', teamName: null };
    }

    // "my [name] team" / "show [name] team members"
    const listNamedMatch = message.match(/^(?:my|show|view|list)\s+(.+?)\s+team(?:\s+members)?$/i);
    if (listNamedMatch) {
      return { action: 'list', teamName: listNamedMatch[1].trim().toLowerCase() };
    }

    // "create [name] team" / "new [name] team" / "make [name] team"
    const createMatch = message.match(/^(?:create|new|make)\s+(.+?)\s+team$/i);
    if (createMatch) {
      return { action: 'create', teamName: createMatch[1].trim().toLowerCase() };
    }

    // "delete [name] team" / "remove [name] team"
    const deleteTeamMatch = message.match(/^(?:delete|disband|remove)\s+(.+?)\s+team$/i);
    if (deleteTeamMatch) {
      return { action: 'delete_team', teamName: deleteTeamMatch[1].trim().toLowerCase() };
    }

    // "add [name] [phone] to [team name] team"
    const addToTeamMatch = message.match(/^add\s+([a-zA-Z][a-zA-Z\s]*?)\s+\+?(\d[\d\s-]{9,17})\s+to\s+(?:the\s+)?(.+?)\s+team$/i);
    if (addToTeamMatch) {
      let phone = addToTeamMatch[2].replace(/\D/g, '');
      if (phone.length === 10) phone = '91' + phone;
      return { action: 'add', name: addToTeamMatch[1].trim(), phone, teamName: addToTeamMatch[3].trim().toLowerCase() };
    }

    // "add team member [name] [phone]" → default team
    const addDefaultMatch = message.match(/^add\s+team\s+member\s+([a-zA-Z][a-zA-Z\s]*?)\s+\+?(\d[\d\s-]{9,17})$/i);
    if (addDefaultMatch) {
      let phone = addDefaultMatch[2].replace(/\D/g, '');
      if (phone.length === 10) phone = '91' + phone;
      return { action: 'add', name: addDefaultMatch[1].trim(), phone, teamName: 'default' };
    }

    // "add [name(s)] to [team name] team" — names only, no phone (will lookup contacts)
    // Supports: "add Rahul to design team", "add Rahul and Priya to design team"
    const addNameOnlyMatch = message.match(/^add\s+([a-zA-Z][a-zA-Z\s,&]+?)\s+(?:to|in)\s+(?:the\s+)?(.+?)\s+team$/i);
    if (addNameOnlyMatch) {
      const rawNames = addNameOnlyMatch[1].trim();
      const teamName = addNameOnlyMatch[2].trim().toLowerCase();
      // Split by "and", "&", ","
      const names = rawNames.split(/\s*(?:,|\band\b|&)\s*/i).map(n => n.trim()).filter(n => n.length > 0);
      if (names.length === 1) {
        return { action: 'add_by_name', names, teamName };
      }
      return { action: 'add_by_name', names, teamName };
    }

    // "remove [name] from [team name] team"
    const removeFromMatch = message.match(/^remove\s+(.+?)\s+from\s+(?:the\s+)?(.+?)\s+team$/i);
    if (removeFromMatch) {
      return { action: 'remove', identifier: removeFromMatch[1].trim(), teamName: removeFromMatch[2].trim().toLowerCase() };
    }

    // "remove team member [name]"
    const removeMatch = message.match(/^remove\s+team\s+member\s+(.+)$/i);
    if (removeMatch) {
      return { action: 'remove', identifier: removeMatch[1].trim(), teamName: null };
    }

    return null;
  }

  // ========== LEGACY DELEGATED TASK METHODS ==========

  parseTaskFromMessage(message) {
    const result = {
      phone: null,
      taskDescription: null,
      followUpMinutes: null,
      reminderTime: null
    };

    const phoneMatch = message.match(/(\d{10,})/);
    if (phoneMatch) {
      result.phone = phoneMatch[1];
    }

    const remindAtMatch = message.match(/,?\s*(?:remind|follow.?up|check)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
    if (remindAtMatch) {
      let hours = parseInt(remindAtMatch[1]);
      const minutes = remindAtMatch[2] ? parseInt(remindAtMatch[2]) : 0;
      const ampm = remindAtMatch[3].toLowerCase();
      if (ampm === 'pm' && hours !== 12) hours += 12;
      if (ampm === 'am' && hours === 12) hours = 0;
      const now = new Date();
      const reminderDate = new Date();
      reminderDate.setHours(hours, minutes, 0, 0);
      if (reminderDate <= now) {
        reminderDate.setDate(reminderDate.getDate() + 1);
      }
      result.reminderTime = reminderDate;
    }

    const remindInMatch = message.match(/,?\s*(?:remind|follow.?up|check)\s+(?:in|after)\s+(\d+)\s*(min|minute|minutes|hour|hours|hr|hrs)/i);
    if (remindInMatch) {
      const amount = parseInt(remindInMatch[1]);
      const unit = remindInMatch[2].toLowerCase();
      if (unit.startsWith('h')) {
        result.followUpMinutes = amount * 60;
      } else {
        result.followUpMinutes = amount;
      }
    }

    const remindTomorrowMatch = message.match(/,?\s*(?:remind|follow.?up|check)\s+tomorrow/i);
    if (remindTomorrowMatch) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(9, 0, 0, 0);
      result.reminderTime = tomorrow;
    }

    let taskDescription = message;
    taskDescription = taskDescription.replace(/(\d{10,})/g, '');
    taskDescription = taskDescription.replace(/,?\s*(?:remind|follow.?up|check)\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)/gi, '');
    taskDescription = taskDescription.replace(/,?\s*(?:remind|follow.?up|check)\s+(?:in|after)\s+\d+\s*(?:min|minute|minutes|hour|hours|hr|hrs)/gi, '');
    taskDescription = taskDescription.replace(/,?\s*(?:remind|follow.?up|check)\s+tomorrow/gi, '');
    taskDescription = taskDescription.replace(/^(tell|remind|message|send|bolo|batao|ask|ko|को)\s+/i, '');
    taskDescription = taskDescription.replace(/^\s*to\s+/i, '');
    taskDescription = taskDescription.replace(/\s+/g, ' ').trim();
    taskDescription = taskDescription.replace(/^,\s*/, '').replace(/,\s*$/, '');
    taskDescription = taskDescription.replace(/^\+?\d+\s*/g, '');
    taskDescription = taskDescription.replace(/^ko\s+/i, '');
    taskDescription = taskDescription.replace(/^reminder bhejna\s*/i, '');
    result.taskDescription = taskDescription.trim();

    return result;
  }

  async createDelegatedTask(ownerPhone, recipientPhone, taskDescription, followUpMinutes = null, reminderTime = null) {
    try {
      let followUpAt = null;
      if (reminderTime) {
        followUpAt = reminderTime;
      } else if (followUpMinutes) {
        followUpAt = new Date(Date.now() + followUpMinutes * 60 * 1000);
      }

      const result = await query(
        `INSERT INTO delegated_tasks
         (owner_phone, recipient_phone, task_description, status, follow_up_at, created_at)
         VALUES ($1, $2, $3, 'pending', $4, NOW())
         RETURNING *`,
        [ownerPhone, recipientPhone, taskDescription, followUpAt]
      );

      return result.rows[0];
    } catch (error) {
      logger.error('Error creating delegated task:', error);
      return null;
    }
  }

  async findPendingTaskForRecipient(recipientPhone) {
    try {
      const result = await query(
        `SELECT * FROM delegated_tasks
         WHERE recipient_phone = $1 AND status = 'pending'
         ORDER BY created_at DESC LIMIT 1`,
        [recipientPhone]
      );
      return result.rows[0] || null;
    } catch (error) {
      logger.error('Error finding task:', error);
      return null;
    }
  }

  async getPendingTasksByOwner(ownerPhone) {
    try {
      const result = await query(
        `SELECT * FROM delegated_tasks
         WHERE owner_phone = $1 AND status = 'pending'
         ORDER BY created_at DESC`,
        [ownerPhone]
      );
      return result.rows;
    } catch (error) {
      logger.error('Error getting tasks:', error);
      return [];
    }
  }

  async getTasksPendingFollowUp() {
    try {
      const result = await query(
        `SELECT * FROM delegated_tasks
         WHERE status = 'pending'
         AND follow_up_at IS NOT NULL
         AND follow_up_at <= NOW()
         AND (last_follow_up IS NULL OR last_follow_up < NOW() - INTERVAL '1 hour')
         ORDER BY follow_up_at ASC`
      );
      return result.rows;
    } catch (error) {
      logger.error('Error getting tasks for follow-up:', error);
      return [];
    }
  }

  async markTaskCompleted(taskId) {
    try {
      await query(
        `UPDATE delegated_tasks SET status = 'completed', completed_at = NOW() WHERE id = $1`,
        [taskId]
      );
      return true;
    } catch (error) {
      logger.error('Error marking task completed:', error);
      return false;
    }
  }

  async updateLastFollowUp(taskId) {
    try {
      await query(
        `UPDATE delegated_tasks SET last_follow_up = NOW(), follow_up_count = COALESCE(follow_up_count, 0) + 1 WHERE id = $1`,
        [taskId]
      );
    } catch (error) {
      logger.error('Error updating follow-up:', error);
    }
  }

  async getRecentTaskByOwner(ownerPhone) {
    try {
      const result = await query(
        `SELECT * FROM delegated_tasks
         WHERE owner_phone = $1
         ORDER BY created_at DESC LIMIT 1`,
        [ownerPhone]
      );
      return result.rows[0] || null;
    } catch (error) {
      return null;
    }
  }

  formatTaskTime(date) {
    if (!date) return 'No follow-up scheduled';
    return new Date(date).toLocaleString('en-IN', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  }
}

module.exports = new TaskService();
