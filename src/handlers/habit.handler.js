const registry = require('./handler-registry');
const habitService = require('../services/habit.service');
const logger = require('../utils/logger');

registry.register('habit_manage', async (message, context) => {
  const { text } = message;
  const { userPhone, intentParams } = context;

  try {
    const resolvedParams = intentParams?.action ? intentParams : parseHabitCommand(text);
    // ── LLM Params-First Routing ──────────────────────────────────────
    if (resolvedParams?.action) {
      switch (resolvedParams.action) {
        case 'create': {
          if (resolvedParams.habit_name) {
            const frequency = resolvedParams.frequency || 'daily';
            const target = resolvedParams.target_count || 1;

            const result = await habitService.addHabit(userPhone, resolvedParams.habit_name, frequency, target);
            if (!result.success) return `${result.error}`;

            const habit = result.habit;
            let response = `Habit Created!\n━━━━━━━━━━━━\n`;
            response += `Habit: ${habit.name}\n`;
            response += `Frequency: ${_capitalise(habit.frequency)}\n`;
            response += `Target: ${habit.target_count}x per ${habit.frequency === 'weekly' ? 'week' : 'day'}`;
            response += `\n\nLog it anytime with "done ${habit.name}"!`;
            return response;
          }
          break;
        }
        case 'log': {
          if (resolvedParams.habit_name) {
            const notes = resolvedParams.notes || null;
            const result = await habitService.logHabit(userPhone, resolvedParams.habit_name, notes);
            if (!result.success) return `${result.error}`;

            const stats = await habitService.getHabitStats(userPhone, resolvedParams.habit_name);
            const streak = stats.success ? stats.streak : 0;

            let response = `Habit Logged!\n━━━━━━━━━━━━\n`;
            response += `${result.habit.name}\n`;
            if (streak > 0) {
              response += `Streak: ${streak} day${streak !== 1 ? 's' : ''}\n`;
            }
            if (notes) {
              response += `Notes: ${notes}\n`;
            }
            response += `\nKeep it up!`;
            return response;
          }
          break;
        }
        case 'delete': {
          if (resolvedParams.habit_name) {
            const result = await habitService.deleteHabit(userPhone, resolvedParams.habit_name);
            if (!result.success) return `${result.error}`;
            return `Habit Deleted\n━━━━━━━━━━━━\n"${result.habit.name}" has been removed from your habits.`;
          }
          break;
        }
        case 'list': {
          const habits = await habitService.getHabits(userPhone);

          if (habits.length === 0) {
            return 'No active habits found.\n\nStart tracking with "track habit: drink water" or "add habit: exercise"!';
          }

          let response = `Your Habits (${habits.length})\n━━━━━━━━━━━━\n`;
          for (let i = 0; i < habits.length; i++) {
            const h = habits[i];
            const freqLabel = h.frequency === 'weekly' ? 'weekly' : 'daily';
            response += `\n${i + 1}. ${h.name} (${freqLabel})`;
            if (h.target_count > 1) {
              response += ` — ${h.target_count}x`;
            }
          }

          const unlogged = await habitService.getUnloggedHabits(userPhone);
          if (unlogged.length > 0) {
            response += `\n\nPending today: ${unlogged.map(u => u.name).join(', ')}`;
          }

          return response;
        }
        case 'stats': {
          if (resolvedParams.habit_name) {
            const result = await habitService.getHabitStats(userPhone, resolvedParams.habit_name);
            if (!result.success) return `${result.error}`;

            let response = `Habit Stats: ${result.habit.name}\n━━━━━━━━━━━━\n`;
            response += `Streak: ${result.streak} day${result.streak !== 1 ? 's' : ''}\n`;
            response += `This week: ${result.thisWeekCount}\n`;
            response += `This month: ${result.thisMonthCount}\n`;
            response += `Total: ${result.totalCompletions}`;
            return response;
          }

          // Stats for all habits
          const stats = await habitService.getAllStats(userPhone);
          if (stats.length === 0) {
            return 'No habits tracked yet.\n\nStart with "track habit: exercise" or "add habit: reading"!';
          }

          let response = `Habit Stats (All)\n━━━━━━━━━━━━\n`;
          for (const s of stats) {
            const streakLabel = s.streak > 0 ? ` (streak: ${s.streak})` : '';
            response += `\n${s.name}${streakLabel}\n`;
            response += `   Week: ${s.thisWeekCount} | Month: ${s.thisMonthCount} | Total: ${s.totalCompletions}\n`;
          }
          return response.trim();
        }
      }
    }

    // ── Regex Fallback (existing code, unchanged) ─────────────────────
    const lower = text.toLowerCase().trim();

    // ── Delete Habit ──────────────────────────────────────────────────
    if (/\b(?:delete|remove|drop)\s+habit\b/i.test(lower)) {
      const habitName = _extractHabitName(text, /(?:delete|remove|drop)\s+habit[:\s]*(.+)/i);
      if (!habitName) {
        return 'Please specify which habit to delete.\nExample: "delete habit: exercise"';
      }

      const result = await habitService.deleteHabit(userPhone, habitName);
      if (!result.success) {
        return `${result.error}`;
      }

      return `Habit Deleted\n━━━━━━━━━━━━\n"${result.habit.name}" has been removed from your habits.`;
    }

    // ── Add / Track Habit ─────────────────────────────────────────────
    if (/\b(?:track|add|new|create|start)\s+habit\b/i.test(lower)) {
      const habitName = _extractHabitName(text, /(?:track|add|new|create|start)\s+habit[:\s]*(.+)/i);
      if (!habitName) {
        return 'Please specify a habit name.\nExample: "track habit: drink water"';
      }

      const frequency = _detectFrequency(lower);
      const target = _extractTarget(lower);

      const result = await habitService.addHabit(userPhone, habitName, frequency, target);
      if (!result.success) {
        return `${result.error}`;
      }

      const habit = result.habit;
      let response = `Habit Created!\n━━━━━━━━━━━━\n`;
      response += `Habit: ${habit.name}\n`;
      response += `Frequency: ${_capitalise(habit.frequency)}\n`;
      response += `Target: ${habit.target_count}x per ${habit.frequency === 'weekly' ? 'week' : 'day'}`;
      response += `\n\nLog it anytime with "done ${habit.name}"!`;
      return response;
    }

    // ── Log Habit ─────────────────────────────────────────────────────
    if ((/\b(?:log|done|completed|finished|did)\s+(?:habit[:\s]*)?/i.test(lower) ||
         /^mark\s+.+?\s+(?:as\s+)?done(?:\s+(?:for\s+)?today)?[.!]?$/i.test(lower)) &&
        !/\b(?:my|show|list|get|view)\b/i.test(lower)) {
      const habitName = _extractLogHabitName(text, lower);
      if (!habitName) {
        return 'Please specify which habit you completed.\nExample: "done exercise" or "log habit: reading"';
      }

      const notes = _extractNotes(text, habitName);
      const result = await habitService.logHabit(userPhone, habitName, notes);

      if (!result.success) {
        return `${result.error}`;
      }

      // Get streak info
      const stats = await habitService.getHabitStats(userPhone, habitName);
      const streak = stats.success ? stats.streak : 0;

      let response = `Habit Logged!\n━━━━━━━━━━━━\n`;
      response += `${result.habit.name}\n`;
      if (streak > 0) {
        response += `Streak: ${streak} day${streak !== 1 ? 's' : ''}\n`;
      }
      if (notes) {
        response += `Notes: ${notes}\n`;
      }
      response += `\nKeep it up!`;
      return response;
    }

    // ── Habit Stats ───────────────────────────────────────────────────
    if (/\b(?:habit\s*stat|streak|habit\s*report|habit\s*progress)/i.test(lower)) {
      const specificHabit = _extractStatsHabitName(text, lower);

      if (specificHabit) {
        // Stats for a specific habit
        const result = await habitService.getHabitStats(userPhone, specificHabit);
        if (!result.success) {
          return `${result.error}`;
        }

        let response = `Habit Stats: ${result.habit.name}\n━━━━━━━━━━━━\n`;
        response += `Streak: ${result.streak} day${result.streak !== 1 ? 's' : ''}\n`;
        response += `This week: ${result.thisWeekCount}\n`;
        response += `This month: ${result.thisMonthCount}\n`;
        response += `Total: ${result.totalCompletions}`;
        return response;
      }

      // Stats for all habits
      const stats = await habitService.getAllStats(userPhone);
      if (stats.length === 0) {
        return 'No habits tracked yet.\n\nStart with "track habit: exercise" or "add habit: reading"!';
      }

      let response = `Habit Stats (All)\n━━━━━━━━━━━━\n`;
      for (const s of stats) {
        const streakLabel = s.streak > 0 ? ` (streak: ${s.streak})` : '';
        response += `\n${s.name}${streakLabel}\n`;
        response += `   Week: ${s.thisWeekCount} | Month: ${s.thisMonthCount} | Total: ${s.totalCompletions}\n`;
      }
      return response.trim();
    }

    // ── List Habits ───────────────────────────────────────────────────
    if (/\b(?:my|show|list|view|get|all)\s*habit/i.test(lower) || /\bhabit\s*list\b/i.test(lower)) {
      const habits = await habitService.getHabits(userPhone);

      if (habits.length === 0) {
        return 'No active habits found.\n\nStart tracking with "track habit: drink water" or "add habit: exercise"!';
      }

      let response = `Your Habits (${habits.length})\n━━━━━━━━━━━━\n`;
      for (let i = 0; i < habits.length; i++) {
        const h = habits[i];
        const freqLabel = h.frequency === 'weekly' ? 'weekly' : 'daily';
        response += `\n${i + 1}. ${h.name} (${freqLabel})`;
        if (h.target_count > 1) {
          response += ` — ${h.target_count}x`;
        }
      }

      // Show today's unlogged habits
      const unlogged = await habitService.getUnloggedHabits(userPhone);
      if (unlogged.length > 0) {
        response += `\n\nPending today: ${unlogged.map(u => u.name).join(', ')}`;
      }

      return response;
    }

    // ── Fallback ──────────────────────────────────────────────────────
    return 'Habit Commands:\n━━━━━━━━━━━━\n• "track habit: exercise" — add a habit\n• "done exercise" — log completion\n• "my habits" — list all habits\n• "habit stats" — view stats & streaks\n• "delete habit: exercise" — remove a habit';

  } catch (error) {
    logger.error('Habit handler error:', error.message);
    return 'Something went wrong with habit tracking. Please try again.';
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────

function _extractHabitName(text, pattern) {
  const match = text.match(pattern);
  if (match && match[1]) {
    return match[1]
      .replace(/\b(?:daily|weekly|monthly)\b/gi, '')
      .replace(/\b\d+x?\s*(?:per|a|\/)\s*(?:day|week|month)\b/gi, '')
      .replace(/[:\-—]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return null;
}

function _extractLogHabitName(text, lower) {
  // "done exercise", "mark exercise done today", "log habit: meditation"
  const patterns = [
    /^mark\s+(.+?)\s+(?:as\s+)?done(?:\s+(?:for\s+)?today)?[.!]?$/i,
    /\blog\s+habit[:\s]+(.+)/i,
    /^\s*(?:done|completed|finished|did)\s+(?:my\s+)?(.+?)(?:\s+(?:for\s+)?today)?[.!]?$/i,
    /\blog\s+(.+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const name = match[1]
        .replace(/\bnotes?[:\s].*$/i, '')
        .replace(/[:\-—]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (name.length >= 2 && !/^(?:habit|it|this|that)$/i.test(name)) {
        return name;
      }
    }
  }
  return null;
}

function parseHabitCommand(text) {
  const original = String(text || '').trim();
  const lower = original.toLowerCase();
  if (!original) return null;

  const completedHabit = _extractLogHabitName(original, lower);
  if (
    completedHabit
    && (/^mark\s+/i.test(original) || /^\s*(?:done|completed|finished|did)\s+/i.test(original))
  ) {
    return { action: 'log', habit_name: completedHabit, full_text: original };
  }

  if (/\b(?:track|add|new|create|start)\s+habit\b/i.test(lower)) {
    const habitName = _extractHabitName(original, /(?:track|add|new|create|start)\s+habit[:\s]*(.+)/i);
    if (!habitName) return null;
    return {
      action: 'create',
      habit_name: habitName,
      frequency: _detectFrequency(lower),
      target_count: _extractTarget(lower),
      full_text: original,
    };
  }

  if (/\b(?:delete|remove|drop)\s+habit\b/i.test(lower)) {
    const habitName = _extractHabitName(original, /(?:delete|remove|drop)\s+habit[:\s]*(.+)/i);
    return habitName ? { action: 'delete', habit_name: habitName, full_text: original } : null;
  }

  if (/\b(?:habit\s*stat|streak|habit\s*report|habit\s*progress)/i.test(lower)) {
    return {
      action: 'stats',
      habit_name: _extractStatsHabitName(original, lower) || undefined,
      full_text: original,
    };
  }

  if (/\b(?:my|show|list|view|get|all)\s*habit/i.test(lower) || /\bhabit\s*list\b/i.test(lower)) {
    return { action: 'list', full_text: original };
  }

  return null;
}

function _extractStatsHabitName(text, lower) {
  // "habit stats exercise", "streak for reading", "habit stats: meditation"
  const patterns = [
    /\bhabit\s*stats?[:\s]+(.+)/i,
    /\bstreak\s+(?:for\s+)?(.+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const name = match[1].replace(/[:\-—]+/g, '').replace(/\s+/g, ' ').trim();
      if (name.length >= 2 && !/^(?:all|my|today|week|month)$/i.test(name)) {
        return name;
      }
    }
  }
  return null;
}

function _detectFrequency(lower) {
  if (/\bweekly\b/i.test(lower)) return 'weekly';
  return 'daily';
}

function _extractTarget(lower) {
  const match = lower.match(/(\d+)\s*(?:x|times)\s*(?:per|a|\/)\s*(?:day|week)/i);
  if (match) return parseInt(match[1]);
  return 1;
}

function _extractNotes(text, habitName) {
  const match = text.match(/\bnotes?[:\s]+(.+)/i);
  if (match) return match[1].trim();
  return null;
}

function _capitalise(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

module.exports = { parseHabitCommand };
