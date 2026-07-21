const { google } = require('googleapis');
const googleAuthService = require('./google-auth.service');
const logger = require('../utils/logger');

/**
 * Google Tasks API wrapper.
 *
 * Lets Ari sync local tasks with the user's Google Tasks default list.
 * All methods return { success, ... } objects and never throw.
 *
 * Note: the Google Tasks API only supports task lists the authenticated user
 * owns. We always target the default list unless a taskListId is supplied.
 */
class GoogleTasksService {
  async _getClient(userPhone) {
    const authClient = await googleAuthService.getAuthClient(userPhone);
    if (!authClient) {
      return { ok: false, error: 'Google not connected. Say "connect google" first.' };
    }
    return { ok: true, tasks: google.tasks({ version: 'v1', auth: authClient }) };
  }

  /**
   * Return the default task list for the user (typically "My Tasks").
   * Returns: { success, taskListId, title } or { success: false, error }
   */
  async getDefaultTaskList(userPhone) {
    const client = await this._getClient(userPhone);
    if (!client.ok) return { success: false, error: client.error };

    try {
      const result = await client.tasks.tasklists.list({ maxResults: 10 });
      const lists = result.data.items || [];
      if (lists.length === 0) {
        return { success: false, error: 'No Google Tasks lists found.' };
      }
      // First list is the default
      return { success: true, taskListId: lists[0].id, title: lists[0].title };
    } catch (error) {
      const tokenResult = await googleAuthService.handleTokenError(userPhone, error);
      if (tokenResult && tokenResult.cleared) return { success: false, error: tokenResult.message };
      logger.error('Google Tasks getDefaultTaskList error:', error.message);
      return { success: false, error: 'Failed to fetch Google Tasks lists.' };
    }
  }

  /**
   * List tasks in a task list (defaults to the user's default list).
   * Returns: { success, tasks: [{ id, title, notes, due, status }] }
   */
  async listTasks(userPhone, taskListId = null) {
    const client = await this._getClient(userPhone);
    if (!client.ok) return { success: false, error: client.error };

    try {
      let listId = taskListId;
      if (!listId) {
        const def = await this.getDefaultTaskList(userPhone);
        if (!def.success) return def;
        listId = def.taskListId;
      }

      const result = await client.tasks.tasks.list({
        tasklist: listId,
        showCompleted: false,
        maxResults: 100
      });

      const tasks = (result.data.items || []).map(t => ({
        id: t.id,
        title: t.title || '(untitled)',
        notes: t.notes || null,
        due: t.due || null,
        status: t.status || 'needsAction',
        taskListId: listId
      }));

      return { success: true, tasks, taskListId: listId };
    } catch (error) {
      const tokenResult = await googleAuthService.handleTokenError(userPhone, error);
      if (tokenResult && tokenResult.cleared) return { success: false, error: tokenResult.message };
      logger.error('Google Tasks list error:', error.message);
      return { success: false, error: 'Failed to list Google Tasks.' };
    }
  }

  /**
   * Create a new task.
   * Params: { title, notes, due (ISO string), taskListId (optional) }
   * Returns: { success, taskId, taskListId }
   */
  async createTask(userPhone, { title, notes, due, taskListId } = {}) {
    if (!title || !String(title).trim()) {
      return { success: false, error: 'Task title is required.' };
    }

    const client = await this._getClient(userPhone);
    if (!client.ok) return { success: false, error: client.error };

    try {
      let listId = taskListId;
      if (!listId) {
        const def = await this.getDefaultTaskList(userPhone);
        if (!def.success) return def;
        listId = def.taskListId;
      }

      const resource = { title: String(title).trim() };
      if (notes) resource.notes = String(notes);
      if (due) resource.due = this._toRfc3339(due);

      const result = await client.tasks.tasks.insert({
        tasklist: listId,
        resource
      });

      return {
        success: true,
        taskId: result.data.id,
        taskListId: listId,
        title: result.data.title
      };
    } catch (error) {
      const tokenResult = await googleAuthService.handleTokenError(userPhone, error);
      if (tokenResult && tokenResult.cleared) return { success: false, error: tokenResult.message };
      logger.error('Google Tasks create error:', error.message);
      return { success: false, error: 'Failed to create Google Task.' };
    }
  }

  /**
   * Mark a task as completed.
   */
  async completeTask(userPhone, taskId, taskListId = null) {
    if (!taskId) return { success: false, error: 'Task ID is required.' };

    const client = await this._getClient(userPhone);
    if (!client.ok) return { success: false, error: client.error };

    try {
      let listId = taskListId;
      if (!listId) {
        const def = await this.getDefaultTaskList(userPhone);
        if (!def.success) return def;
        listId = def.taskListId;
      }

      await client.tasks.tasks.patch({
        tasklist: listId,
        task: taskId,
        resource: { status: 'completed' }
      });

      return { success: true };
    } catch (error) {
      const tokenResult = await googleAuthService.handleTokenError(userPhone, error);
      if (tokenResult && tokenResult.cleared) return { success: false, error: tokenResult.message };
      logger.error('Google Tasks complete error:', error.message);
      return { success: false, error: 'Failed to complete Google Task.' };
    }
  }

  /**
   * Delete a task.
   */
  async deleteTask(userPhone, taskId, taskListId = null) {
    if (!taskId) return { success: false, error: 'Task ID is required.' };

    const client = await this._getClient(userPhone);
    if (!client.ok) return { success: false, error: client.error };

    try {
      let listId = taskListId;
      if (!listId) {
        const def = await this.getDefaultTaskList(userPhone);
        if (!def.success) return def;
        listId = def.taskListId;
      }

      await client.tasks.tasks.delete({
        tasklist: listId,
        task: taskId
      });

      return { success: true };
    } catch (error) {
      const tokenResult = await googleAuthService.handleTokenError(userPhone, error);
      if (tokenResult && tokenResult.cleared) return { success: false, error: tokenResult.message };
      logger.error('Google Tasks delete error:', error.message);
      return { success: false, error: 'Failed to delete Google Task.' };
    }
  }

  /**
   * Convert a Date or ISO string to RFC 3339 (Google Tasks accepts ISO).
   */
  _toRfc3339(input) {
    if (!input) return null;
    if (typeof input === 'string') return input;
    if (input instanceof Date) return input.toISOString();
    return null;
  }
}

module.exports = new GoogleTasksService();
