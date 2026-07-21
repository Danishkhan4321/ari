const { query } = require('../config/database');
const logger = require('../utils/logger');

class SharedBoardService {

  constructor() {
    this.schemaReady = false;
  }

  async ensureSchema() {
    if (this.schemaReady) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS shared_boards (
          id SERIAL PRIMARY KEY,
          team_admin_phone VARCHAR(50) NOT NULL,
          name VARCHAR(255) NOT NULL,
          description TEXT,
          created_by VARCHAR(50) NOT NULL,
          created_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(team_admin_phone, name)
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS board_tasks (
          id SERIAL PRIMARY KEY,
          board_id INTEGER REFERENCES shared_boards(id) ON DELETE CASCADE,
          title VARCHAR(500) NOT NULL,
          description TEXT,
          assigned_to VARCHAR(50),
          assigned_to_name VARCHAR(255),
          status VARCHAR(20) DEFAULT 'todo',
          priority VARCHAR(10) DEFAULT 'normal',
          due_date TIMESTAMP,
          created_by VARCHAR(50) NOT NULL,
          created_at TIMESTAMP DEFAULT NOW(),
          completed_at TIMESTAMP
        )
      `);

      await query(`CREATE INDEX IF NOT EXISTS idx_board_tasks_board ON board_tasks(board_id)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_board_tasks_assigned ON board_tasks(assigned_to)`);

      this.schemaReady = true;
    } catch (error) {
      logger.error('Error creating shared board tables:', error.message);
    }
  }

  async createBoard(adminPhone, name, description, createdBy) {
    await this.ensureSchema();
    try {
      const result = await query(
        `INSERT INTO shared_boards (team_admin_phone, name, description, created_by)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [adminPhone, name, description || null, createdBy]
      );
      return { success: true, board: result.rows[0] };
    } catch (error) {
      if (error.message.includes('unique') || error.message.includes('duplicate')) {
        return { success: false, error: `A board named "${name}" already exists.` };
      }
      logger.error('Error creating shared board:', error.message);
      return { success: false, error: error.message };
    }
  }

  async getBoards(adminPhone) {
    await this.ensureSchema();
    try {
      const result = await query(
        `SELECT sb.*,
           COALESCE(SUM(CASE WHEN bt.status = 'todo' THEN 1 ELSE 0 END), 0) AS todo_count,
           COALESCE(SUM(CASE WHEN bt.status = 'in_progress' THEN 1 ELSE 0 END), 0) AS in_progress_count,
           COALESCE(SUM(CASE WHEN bt.status = 'done' THEN 1 ELSE 0 END), 0) AS done_count,
           COUNT(bt.id) AS total_tasks
         FROM shared_boards sb
         LEFT JOIN board_tasks bt ON bt.board_id = sb.id
         WHERE sb.team_admin_phone = $1
         GROUP BY sb.id
         ORDER BY sb.created_at DESC`,
        [adminPhone]
      );
      return result.rows;
    } catch (error) {
      logger.error('Error getting boards:', error.message);
      return [];
    }
  }

  async getBoard(adminPhone, boardName) {
    await this.ensureSchema();
    try {
      const boardResult = await query(
        `SELECT * FROM shared_boards
         WHERE team_admin_phone = $1 AND LOWER(name) = LOWER($2)`,
        [adminPhone, boardName]
      );

      if (boardResult.rows.length === 0) return null;

      const board = boardResult.rows[0];
      const tasksResult = await query(
        `SELECT * FROM board_tasks
         WHERE board_id = $1
         ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END, created_at ASC`,
        [board.id]
      );

      board.tasks = tasksResult.rows;
      return board;
    } catch (error) {
      logger.error('Error getting board:', error.message);
      return null;
    }
  }

  async addTask(boardId, title, assignedTo, assignedToName, priority, dueDate, createdBy) {
    await this.ensureSchema();
    try {
      const result = await query(
        `INSERT INTO board_tasks (board_id, title, assigned_to, assigned_to_name, priority, due_date, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [boardId, title, assignedTo || null, assignedToName || null, priority || 'normal', dueDate || null, createdBy]
      );
      return { success: true, task: result.rows[0] };
    } catch (error) {
      logger.error('Error adding board task:', error.message);
      return { success: false, error: error.message };
    }
  }

  async updateTaskStatus(taskId, status, userPhone) {
    await this.ensureSchema();
    try {
      // Verify permission: assigned_to or board admin can update
      const taskResult = await query(
        `SELECT bt.*, sb.team_admin_phone
         FROM board_tasks bt
         JOIN shared_boards sb ON sb.id = bt.board_id
         WHERE bt.id = $1`,
        [taskId]
      );

      if (taskResult.rows.length === 0) {
        return { success: false, error: 'Task not found.' };
      }

      const task = taskResult.rows[0];
      if (task.assigned_to !== userPhone && task.team_admin_phone !== userPhone && task.created_by !== userPhone) {
        return { success: false, error: 'You do not have permission to update this task.' };
      }

      const completedAt = status === 'done' ? 'NOW()' : 'NULL';
      const result = await query(
        `UPDATE board_tasks
         SET status = $1, completed_at = ${completedAt}
         WHERE id = $2
         RETURNING *`,
        [status, taskId]
      );

      return { success: true, task: result.rows[0] };
    } catch (error) {
      logger.error('Error updating task status:', error.message);
      return { success: false, error: error.message };
    }
  }

  async getBoardStatus(adminPhone, boardName) {
    await this.ensureSchema();
    try {
      const board = await this.getBoard(adminPhone, boardName);
      if (!board) return null;

      const tasks = board.tasks || [];
      const todo = tasks.filter(t => t.status === 'todo');
      const inProgress = tasks.filter(t => t.status === 'in_progress');
      const done = tasks.filter(t => t.status === 'done');

      const total = tasks.length;
      const stats = {
        total,
        todoCount: todo.length,
        inProgressCount: inProgress.length,
        doneCount: done.length,
        completionRate: total > 0 ? Math.round((done.length / total) * 100) : 0
      };

      return { board, todo, inProgress, done, stats };
    } catch (error) {
      logger.error('Error getting board status:', error.message);
      return null;
    }
  }

  async assignTask(taskId, assignedTo, assignedToName, callerPhone = null) {
    await this.ensureSchema();
    try {
      // Batch H (May 20 2026): IDOR fix — assignTask used to be a bare
      // UPDATE-by-id. Any user who knew a taskId could reassign that
      // task. Matches the updateTaskStatus pattern above: caller must
      // be the board admin or the task creator. If callerPhone wasn't
      // passed (legacy call), we still allow but log loudly so the
      // unscoped pattern gets noticed.
      if (callerPhone) {
        const permCheck = await query(
          `SELECT bt.id, sb.team_admin_phone, bt.created_by
             FROM board_tasks bt
             JOIN shared_boards sb ON sb.id = bt.board_id
            WHERE bt.id = $1`,
          [taskId]
        );
        if (permCheck.rows.length === 0) {
          return { success: false, error: 'Task not found.' };
        }
        const t = permCheck.rows[0];
        if (t.team_admin_phone !== callerPhone && t.created_by !== callerPhone) {
          logger.security('shared_board_assign_idor_attempt', { caller: callerPhone, taskId });
          return { success: false, error: 'You do not have permission to assign this task.' };
        }
      } else {
        logger.warn(`[SharedBoard] assignTask called without callerPhone for taskId=${taskId} — legacy unscoped path`);
      }
      const result = await query(
        `UPDATE board_tasks
         SET assigned_to = $1, assigned_to_name = $2
         WHERE id = $3
         RETURNING *`,
        [assignedTo, assignedToName, taskId]
      );

      if (result.rows.length === 0) {
        return { success: false, error: 'Task not found.' };
      }

      return { success: true, task: result.rows[0] };
    } catch (error) {
      logger.error('Error assigning task:', error.message);
      return { success: false, error: error.message };
    }
  }

  async deleteTask(taskId, userPhone) {
    await this.ensureSchema();
    try {
      // Only admin or creator can delete
      const taskResult = await query(
        `SELECT bt.*, sb.team_admin_phone
         FROM board_tasks bt
         JOIN shared_boards sb ON sb.id = bt.board_id
         WHERE bt.id = $1`,
        [taskId]
      );

      if (taskResult.rows.length === 0) {
        return { success: false, error: 'Task not found.' };
      }

      const task = taskResult.rows[0];
      if (task.team_admin_phone !== userPhone && task.created_by !== userPhone) {
        return { success: false, error: 'Only the board admin or task creator can delete tasks.' };
      }

      await query(`DELETE FROM board_tasks WHERE id = $1`, [taskId]);
      return { success: true, task };
    } catch (error) {
      logger.error('Error deleting task:', error.message);
      return { success: false, error: error.message };
    }
  }

  async deleteBoard(adminPhone, boardName) {
    await this.ensureSchema();
    try {
      const result = await query(
        `DELETE FROM shared_boards
         WHERE team_admin_phone = $1 AND LOWER(name) = LOWER($2)
         RETURNING *`,
        [adminPhone, boardName]
      );

      if (result.rows.length === 0) {
        return { success: false, error: `Board "${boardName}" not found.` };
      }

      return { success: true, board: result.rows[0] };
    } catch (error) {
      logger.error('Error deleting board:', error.message);
      return { success: false, error: error.message };
    }
  }
}

module.exports = new SharedBoardService();
