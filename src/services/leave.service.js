const { query } = require('../config/database');
const logger = require('../utils/logger');

class LeaveService {

  constructor() {
    this.tablesCreated = false;
    this.leaveTypes = ['casual', 'sick', 'earned', 'personal'];
    this.defaultBalances = { casual: 12, sick: 12, earned: 15, personal: 5 };
  }

  async ensureTables() {
    if (this.tablesCreated) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS leave_requests (
          id SERIAL PRIMARY KEY,
          employee_phone VARCHAR(20) NOT NULL,
          manager_phone VARCHAR(20),
          leave_type VARCHAR(20) DEFAULT 'casual',
          start_date DATE NOT NULL,
          end_date DATE NOT NULL,
          reason TEXT,
          status VARCHAR(20) DEFAULT 'pending',
          responded_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_leave_employee ON leave_requests(employee_phone)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_leave_manager ON leave_requests(manager_phone)`);

      await query(`
        CREATE TABLE IF NOT EXISTS leave_balances (
          id SERIAL PRIMARY KEY,
          user_phone VARCHAR(20) NOT NULL,
          leave_type VARCHAR(20) NOT NULL,
          total_days INTEGER DEFAULT 12,
          used_days INTEGER DEFAULT 0,
          year INTEGER NOT NULL,
          UNIQUE(user_phone, leave_type, year)
        )
      `);

      // Add new columns if they don't exist
      await query(`ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS half_day BOOLEAN DEFAULT false`);
      await query(`ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS half_day_period VARCHAR(20)`);
      await query(`ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS auto_delegate_to VARCHAR(50)`);

      this.tablesCreated = true;
    } catch (error) {
      logger.error('Error creating leave tables:', error.message);
    }
  }

  async initializeBalance(userPhone, year = null) {
    await this.ensureTables();
    const currentYear = year || new Date().getFullYear();
    try {
      for (const [type, total] of Object.entries(this.defaultBalances)) {
        await query(
          `INSERT INTO leave_balances (user_phone, leave_type, total_days, used_days, year)
           VALUES ($1, $2, $3, 0, $4)
           ON CONFLICT (user_phone, leave_type, year) DO NOTHING`,
          [userPhone, type, total, currentYear]
        );
      }
    } catch (error) {
      logger.error('Error initializing balance:', error.message);
    }
  }

  /**
   * Check if an employee already has approved leave overlapping the given date range.
   * @param {string} employeePhone
   * @param {string|Date} startDate
   * @param {string|Date} endDate
   * @returns {Promise<{conflict: boolean, existing?: object}>}
   */
  async checkLeaveConflict(employeePhone, startDate, endDate) {
    await this.ensureTables();
    try {
      const result = await query(
        `SELECT * FROM leave_requests
         WHERE employee_phone = $1 AND status = 'approved'
         AND start_date <= $3 AND end_date >= $2
         LIMIT 1`,
        [employeePhone, startDate, endDate]
      );
      if (result.rows.length > 0) {
        return { conflict: true, existing: result.rows[0] };
      }
      return { conflict: false };
    } catch (error) {
      logger.error('Error checking leave conflict:', error.message);
      return { conflict: false };
    }
  }

  /**
   * Get team members who are on approved leave today.
   * @param {string[]} phoneArray - Array of member phone numbers
   * @returns {Promise<string[]>} - Array of phone numbers on leave today
   */
  async getMembersOnLeaveToday(phoneArray) {
    await this.ensureTables();
    if (!phoneArray || phoneArray.length === 0) return [];
    try {
      const result = await query(
        `SELECT DISTINCT employee_phone FROM leave_requests
         WHERE status = 'approved'
         AND employee_phone = ANY($1)
         AND start_date <= CURRENT_DATE
         AND end_date >= CURRENT_DATE`,
        [phoneArray]
      );
      return result.rows.map(r => r.employee_phone);
    } catch (error) {
      logger.error('Error getting members on leave today:', error.message);
      return [];
    }
  }

  async applyForLeave(employeePhone, managerPhone, leaveType, startDate, endDate, reason) {
    await this.ensureTables();
    try {
      // Calculate days
      const start = new Date(startDate);
      const end = new Date(endDate);
      const days = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;

      // Check for overlapping approved leave
      const conflictCheck = await this.checkLeaveConflict(employeePhone, startDate, endDate);
      if (conflictCheck.conflict) {
        const existing = conflictCheck.existing;
        const existStart = new Date(existing.start_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
        const existEnd = new Date(existing.end_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
        return {
          success: false,
          error: `You already have approved leave from ${existStart} to ${existEnd} overlapping these dates.`
        };
      }

      // Check balance
      await this.initializeBalance(employeePhone);
      const balance = await this.getLeaveBalance(employeePhone, leaveType);
      const remaining = balance ? balance.total_days - balance.used_days : 0;

      if (remaining < days) {
        return {
          success: false,
          error: `Insufficient ${leaveType} leave balance. You have ${remaining} days remaining, need ${days}.`
        };
      }

      const result = await query(
        `INSERT INTO leave_requests (employee_phone, manager_phone, leave_type, start_date, end_date, reason, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending')
         RETURNING *`,
        [employeePhone, managerPhone, leaveType, startDate, endDate, reason]
      );

      return { success: true, request: result.rows[0], days };
    } catch (error) {
      logger.error('Error applying for leave:', error.message);
      return { success: false, error: 'Could not submit leave request.' };
    }
  }

  async approveLeave(leaveId, managerPhone) {
    await this.ensureTables();
    try {
      // Filter at the DB layer when we know who's asking (the manager). This
      // prevents IDOR: an unauthorized caller can no longer read the row
      // even if they know the leave id. The post-fetch manager_phone check
      // below remains as defense-in-depth.
      const leave = await this.getLeaveById(leaveId, managerPhone || null);
      if (!leave) return { success: false, error: 'Leave request not found.' };
      if (managerPhone && leave.manager_phone !== managerPhone) return { success: false, error: 'Access denied — not the assigned manager.' };
      if (leave.status !== 'pending') return { success: false, error: 'Leave request already processed.' };

      const days = Math.ceil((new Date(leave.end_date) - new Date(leave.start_date)) / (1000 * 60 * 60 * 24)) + 1;

      // Update status — also verify manager_phone in WHERE for defense-in-depth
      await query(
        `UPDATE leave_requests SET status = 'approved', responded_at = NOW() WHERE id = $1 AND manager_phone = $2`,
        [leaveId, leave.manager_phone]
      );

      // Update balance
      const year = new Date(leave.start_date).getFullYear();
      await this.initializeBalance(leave.employee_phone, year);
      await query(
        `UPDATE leave_balances SET used_days = used_days + $1
         WHERE user_phone = $2 AND leave_type = $3 AND year = $4`,
        [days, leave.employee_phone, leave.leave_type, year]
      );

      return { success: true, leave, days };
    } catch (error) {
      logger.error('Error approving leave:', error.message);
      return { success: false, error: 'Could not approve leave.' };
    }
  }

  async rejectLeave(leaveId, reason = null, managerPhone = null) {
    await this.ensureTables();
    try {
      // Filter at the DB layer when we know who's asking. Defense-in-depth:
      // the post-fetch manager_phone check + the parameterised UPDATE WHERE
      // both still run, but we no longer leak the row to an unauthorized
      // caller in the first place.
      const leave = await this.getLeaveById(leaveId, managerPhone);
      if (!leave) return { success: false, error: 'Leave request not found.' };
      if (managerPhone && leave.manager_phone !== managerPhone) return { success: false, error: 'Access denied — not the assigned manager.' };
      if (leave.status !== 'pending') return { success: false, error: 'Leave request already processed.' };

      // Also verify manager_phone in WHERE for defense-in-depth
      await query(
        `UPDATE leave_requests SET status = 'rejected', responded_at = NOW() WHERE id = $1 AND manager_phone = $2`,
        [leaveId, leave.manager_phone]
      );

      return { success: true, leave };
    } catch (error) {
      logger.error('Error rejecting leave:', error.message);
      return { success: false, error: 'Could not reject leave.' };
    }
  }

  /**
   * Fetch a single leave request.
   *
   * Apr 29 2026 — IDOR hardening. Callers should pass `requesterPhone` so the
   * row is filtered at the DB layer (the requester must be either the
   * employee who filed the leave OR the manager assigned to it). The
   * downstream UPDATE callers also verify in their WHERE clause for
   * defense-in-depth, but the SELECT shouldn't leak the row in the first
   * place.
   *
   * If `requesterPhone` is not passed (legacy callers, internal jobs), the
   * unfiltered legacy behaviour is preserved — those call sites should be
   * audited and migrated over time.
   */
  async getLeaveById(leaveId, requesterPhone = null) {
    try {
      if (requesterPhone) {
        const result = await query(
          `SELECT * FROM leave_requests
            WHERE id = $1
              AND (employee_phone = $2 OR manager_phone = $2)`,
          [leaveId, requesterPhone]
        );
        return result.rows[0] || null;
      }
      const result = await query(`SELECT * FROM leave_requests WHERE id = $1`, [leaveId]);
      return result.rows[0] || null;
    } catch (error) {
      return null;
    }
  }

  async getLeaveBalance(userPhone, leaveType = null) {
    await this.ensureTables();
    await this.initializeBalance(userPhone);
    try {
      if (leaveType) {
        const result = await query(
          `SELECT * FROM leave_balances WHERE user_phone = $1 AND leave_type = $2 AND year = $3`,
          [userPhone, leaveType, new Date().getFullYear()]
        );
        return result.rows[0] || null;
      }
      const result = await query(
        `SELECT * FROM leave_balances WHERE user_phone = $1 AND year = $2 ORDER BY leave_type`,
        [userPhone, new Date().getFullYear()]
      );
      return result.rows;
    } catch (error) {
      return leaveType ? null : [];
    }
  }

  async getPendingRequestsForManager(managerPhone) {
    await this.ensureTables();
    try {
      const result = await query(
        `SELECT * FROM leave_requests
         WHERE manager_phone = $1 AND status = 'pending'
         ORDER BY created_at DESC`,
        [managerPhone]
      );
      return result.rows;
    } catch (error) {
      return [];
    }
  }

  async getMyLeaveRequests(userPhone) {
    await this.ensureTables();
    try {
      const result = await query(
        `SELECT * FROM leave_requests
         WHERE employee_phone = $1
         ORDER BY created_at DESC LIMIT 10`,
        [userPhone]
      );
      return result.rows;
    } catch (error) {
      return [];
    }
  }

  async getTeamLeaveStatus(adminPhone) {
    await this.ensureTables();
    try {
      const result = await query(
        `SELECT lr.*, t.member_name
         FROM leave_requests lr
         JOIN teams t ON lr.employee_phone = t.member_phone AND t.admin_phone = $1
         WHERE lr.status = 'approved'
         AND lr.end_date >= CURRENT_DATE
         ORDER BY lr.start_date`,
        [adminPhone]
      );
      return result.rows;
    } catch (error) {
      return [];
    }
  }

  async getUpcomingApprovedLeaves(userPhone) {
    await this.ensureTables();
    try {
      const result = await query(
        `SELECT * FROM leave_requests
         WHERE employee_phone = $1 AND status = 'approved'
         AND end_date >= CURRENT_DATE
         ORDER BY start_date LIMIT 5`,
        [userPhone]
      );
      return result.rows;
    } catch (error) {
      return [];
    }
  }

  formatLeaveBalance(balances) {
    if (!balances || balances.length === 0) return 'No leave balance data.';

    let response = `*Leave Balance (${new Date().getFullYear()})*\n\n`;
    for (const b of balances) {
      const remaining = b.total_days - b.used_days;
      const bar = '█'.repeat(Math.min(remaining, 15)) + '░'.repeat(Math.max(0, Math.min(b.total_days, 15) - remaining));
      response += `*${b.leave_type.charAt(0).toUpperCase() + b.leave_type.slice(1)}:* ${remaining}/${b.total_days} days\n${bar}\n\n`;
    }
    return response.trim();
  }

  parseLeaveCommand(message) {
    const lower = message.toLowerCase().trim();

    // "my leave balance" / "leave balance"
    if (/^(my |show |view )?(leave )?balance$/i.test(lower)) {
      return { action: 'balance' };
    }

    // "my leaves" / "leave status"
    if (/^(my |show )?(leave|leaves|leave status|leave requests)$/i.test(lower)) {
      return { action: 'status' };
    }

    // "team leave" / "who's on leave"
    if (/^(team leave|who'?s on leave|team leave status)$/i.test(lower)) {
      return { action: 'team_status' };
    }

    // "approve leave" / "approve" (when in context)
    if (/^approve(\s+leave)?$/i.test(lower)) {
      return { action: 'approve' };
    }

    // "reject leave" / "reject"
    if (/^reject(\s+leave)?$/i.test(lower)) {
      return { action: 'reject' };
    }

    // "apply for leave tomorrow" / "apply leave from X to Y for reason"
    const applyMatch = message.match(/^(?:apply|request|take)\s+(?:for\s+)?(?:a\s+)?(?:(casual|sick|earned|personal)\s+)?leave\s+(.+)$/i);
    if (applyMatch) {
      const leaveType = applyMatch[1] ? applyMatch[1].toLowerCase() : 'casual';
      const details = applyMatch[2];
      return { action: 'apply', leaveType, details };
    }

    // Simpler: "leave tomorrow for doctor visit"
    const simpleApply = message.match(/^leave\s+(.+)$/i);
    if (simpleApply && !lower.startsWith('leave balance') && !lower.startsWith('leave status')) {
      return { action: 'apply', leaveType: 'casual', details: simpleApply[1] };
    }

    return null;
  }

  parseLeaveDates(details) {
    const lower = details.toLowerCase();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let startDate = null;
    let endDate = null;
    let reason = details;

    // "tomorrow"
    if (/\btomorrow\b/i.test(lower)) {
      startDate = new Date(today);
      startDate.setDate(startDate.getDate() + 1);
      endDate = new Date(startDate);
      reason = details.replace(/\btomorrow\b/gi, '').trim();
    }

    // "today"
    if (!startDate && /\btoday\b/i.test(lower)) {
      startDate = new Date(today);
      endDate = new Date(today);
      reason = details.replace(/\btoday\b/gi, '').trim();
    }

    // "from X to Y" pattern (numeric dates)
    if (!startDate) {
      const fromToMatch = details.match(/from\s+(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)\s+to\s+(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/i);
      if (fromToMatch) {
        startDate = this.parseDate(fromToMatch[1]);
        endDate = this.parseDate(fromToMatch[2]);
        reason = details.replace(fromToMatch[0], '').trim();
      }
    }

    // "next week" - Mon to Fri
    if (!startDate && /\bnext\s+week\b/i.test(lower)) {
      const nextMon = new Date(today);
      nextMon.setDate(nextMon.getDate() + ((1 + 7 - nextMon.getDay()) % 7 || 7));
      startDate = nextMon;
      endDate = new Date(nextMon);
      endDate.setDate(endDate.getDate() + 4);
      reason = details.replace(/\bnext\s+week\b/gi, '').trim();
    }

    // Use chrono-node for natural language dates (e.g. "March 24 to March 26", "24th to 26th March")
    if (!startDate) {
      try {
        const chrono = require('chrono-node');
        const parsed = chrono.parse(details);
        if (parsed.length >= 1) {
          const first = parsed[0];
          startDate = first.start.date();
          startDate.setHours(0, 0, 0, 0);
          if (first.end) {
            endDate = first.end.date();
            endDate.setHours(0, 0, 0, 0);
          } else if (parsed.length >= 2) {
            // Two separate date mentions: "March 24 to March 26" may parse as two entries
            endDate = parsed[1].start.date();
            endDate.setHours(0, 0, 0, 0);
          } else {
            endDate = new Date(startDate);
          }
          // Remove the matched date text from reason
          reason = details;
          for (const p of parsed) {
            reason = reason.replace(p.text, '');
          }
          reason = reason.replace(/\s*(from|to|through|until|-|–|,)\s*/gi, ' ').trim();
          // Clean "reason:" prefix if present (user may include it)
          reason = reason.replace(/^reason\s*:\s*/i, '').trim();
        }
      } catch (e) {
        // chrono-node not available or parse failed, continue to default
      }
    }

    // Clean up reason
    reason = reason.replace(/^(for|because|due to|reason\s*:)\s+/i, '').trim();
    reason = reason.replace(/^,\s*/, '').trim();
    if (!reason) reason = 'Personal';

    // Default to tomorrow if no date found
    if (!startDate) {
      startDate = new Date(today);
      startDate.setDate(startDate.getDate() + 1);
      endDate = new Date(startDate);
    }

    return { startDate, endDate, reason };
  }

  parseDate(str) {
    const parts = str.split(/[\/\-]/);
    const day = parseInt(parts[0]);
    const month = parseInt(parts[1]) - 1;
    const year = parts[2] ? (parseInt(parts[2]) < 100 ? 2000 + parseInt(parts[2]) : parseInt(parts[2])) : new Date().getFullYear();
    return new Date(year, month, day);
  }

  /**
   * Apply for a half-day leave (first_half or second_half).
   * Uses the same validation as applyForLeave but marks the request as half_day.
   * @param {string} userPhone - Employee phone
   * @param {string} date - The date for half-day leave
   * @param {string} period - 'first_half' or 'second_half'
   * @param {string} leaveType - Type of leave (casual, sick, etc.)
   * @param {string} reason - Reason for leave
   * @returns {Promise<{success: boolean, request?: object, error?: string}>}
   */
  async applyHalfDayLeave(userPhone, date, period, leaveType = 'casual', reason = 'Personal') {
    await this.ensureTables();
    try {
      if (!['first_half', 'second_half'].includes(period)) {
        return { success: false, error: 'Period must be "first_half" or "second_half".' };
      }

      if (!this.leaveTypes.includes(leaveType)) {
        return { success: false, error: `Invalid leave type. Choose from: ${this.leaveTypes.join(', ')}` };
      }

      // Half day counts as 0.5 days
      const daysNeeded = 0.5;

      // Check balance
      await this.initializeBalance(userPhone);
      const balance = await this.getLeaveBalance(userPhone, leaveType);
      const remaining = balance ? balance.total_days - balance.used_days : 0;

      if (remaining < daysNeeded) {
        return {
          success: false,
          error: `Insufficient ${leaveType} leave balance. You have ${remaining} days remaining, need ${daysNeeded}.`
        };
      }

      const result = await query(
        `INSERT INTO leave_requests (employee_phone, leave_type, start_date, end_date, reason, status, half_day, half_day_period)
         VALUES ($1, $2, $3, $3, $4, 'pending', true, $5)
         RETURNING *`,
        [userPhone, leaveType, date, reason, period]
      );

      return { success: true, request: result.rows[0], days: daysNeeded };
    } catch (error) {
      logger.error('Error applying for half-day leave:', error.message);
      return { success: false, error: 'Could not submit half-day leave request.' };
    }
  }

  /**
   * Get all approved leaves starting today or tomorrow so admin can be notified.
   * Returns leaves with member names (joined from teams table).
   * @param {string} adminPhone - Admin phone number
   * @returns {Promise<Array>}
   */
  async getTeamLeaveNotifications(adminPhone) {
    await this.ensureTables();
    try {
      const result = await query(
        `SELECT lr.*, t.member_name
         FROM leave_requests lr
         JOIN teams t ON lr.employee_phone = t.member_phone AND t.admin_phone = $1
         WHERE lr.status = 'approved'
           AND lr.start_date >= CURRENT_DATE
           AND lr.start_date <= CURRENT_DATE + INTERVAL '1 day'
         ORDER BY lr.start_date, t.member_name`,
        [adminPhone]
      );
      return result.rows;
    } catch (error) {
      logger.error('Error getting team leave notifications:', error.message);
      return [];
    }
  }

  /**
   * Get leave balance summary for a user.
   * Returns total allowed, taken, remaining, and per-type breakdown.
   * Default total: 24 days per year across all types (configurable via leave_balances table).
   * @param {string} userPhone - User phone number
   * @returns {Promise<{totalAllowed: number, taken: number, remaining: number, breakdown: Array<{leaveType: string, taken: number}>}>}
   */
  async getLeaveBalanceSummary(userPhone) {
    await this.ensureTables();
    await this.initializeBalance(userPhone);
    try {
      const currentYear = new Date().getFullYear();
      const result = await query(
        `SELECT leave_type, total_days, used_days FROM leave_balances
         WHERE user_phone = $1 AND year = $2
         ORDER BY leave_type`,
        [userPhone, currentYear]
      );

      const rows = result.rows;
      let totalAllowed = 0;
      let taken = 0;
      const breakdown = [];

      for (const row of rows) {
        totalAllowed += row.total_days;
        taken += row.used_days;
        breakdown.push({
          leaveType: row.leave_type,
          allowed: row.total_days,
          taken: row.used_days,
          remaining: row.total_days - row.used_days
        });
      }

      return {
        totalAllowed,
        taken,
        remaining: totalAllowed - taken,
        breakdown
      };
    } catch (error) {
      logger.error('Error getting leave balance summary:', error.message);
      return { totalAllowed: 24, taken: 0, remaining: 24, breakdown: [] };
    }
  }
}

module.exports = new LeaveService();
