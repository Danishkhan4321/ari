const registry = require('./handler-registry');
const selfStandupService = require('../services/self-standup.service');
const logger = require('../utils/logger');

registry.register('self_standup', async (message, context) => {
  const { text } = message;
  const { userPhone, intentParams } = context;

  try {
    // ── LLM Params-First Routing ──────────────────────────────────────
    if (intentParams?.action) {
      switch (intentParams.action) {
        case 'log': {
          if (intentParams.yesterday_done || intentParams.today_plan) {
            const result = await selfStandupService.logStandup(
              userPhone,
              intentParams.yesterday_done || null,
              intentParams.today_plan || null,
              intentParams.blockers || null,
              intentParams.mood || null,
              null // energyLevel
            );
            if (!result.success) return `${result.error}`;

            const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            let response = `Standup Logged! (${date})\n━━━━━━━━━━━━\n`;
            if (intentParams.yesterday_done) response += `Done: ${intentParams.yesterday_done}\n`;
            if (intentParams.today_plan) response += `Plan: ${intentParams.today_plan}\n`;
            response += `Blockers: ${intentParams.blockers || 'none'}\n`;
            if (intentParams.mood) response += `Mood: ${intentParams.mood}`;
            return response.trim();
          }
          break;
        }
        case 'history': {
          const entries = await selfStandupService.getHistory(userPhone);

          if (!entries || entries.length === 0) {
            return 'Standup History\n━━━━━━━━━━━━\nNo standups logged yet.\n\nStart with "log standup: Done: finished API, Plan: start UI"!';
          }

          let response = `Standup History (Last ${entries.length} days)\n━━━━━━━━━━━━\n`;

          for (const entry of entries) {
            const date = new Date(entry.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            response += `\n${date}`;
            if (entry.yesterday_done) response += `\nDone: ${entry.yesterday_done}`;
            if (entry.today_plan) response += `\nPlan: ${entry.today_plan}`;
            if (entry.blockers && entry.blockers.toLowerCase() !== 'none') {
              response += `\nBlockers: ${entry.blockers}`;
            }
          }

          return response;
        }
        case 'today': {
          const standup = await selfStandupService.getToday(userPhone);

          if (!standup) {
            return 'No standup logged today yet.\n\nLog one with:\n"standup: Done: finished API, Plan: start UI, Blockers: none"';
          }

          const date = new Date(standup.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

          let response = `Today's Standup (${date})\n━━━━━━━━━━━━\n`;
          if (standup.yesterday_done) response += `Done: ${standup.yesterday_done}\n`;
          if (standup.today_plan) response += `Plan: ${standup.today_plan}\n`;
          if (standup.blockers) response += `Blockers: ${standup.blockers}\n`;
          if (standup.mood) response += `Mood: ${standup.mood}`;
          return response.trim();
        }
        case 'weekly_reflection': {
          const result = await selfStandupService.getWeeklyReflection(userPhone);

          if (!result.standups || result.standups.length === 0) {
            return 'Weekly Reflection\n━━━━━━━━━━━━\nNo standups logged this week.\n\nStart with "log standup" to track your daily progress!';
          }

          let response = `Weekly Reflection\n━━━━━━━━━━━━\n`;
          response += `Completion: ${result.completionRate}%\n`;
          response += `Standups: ${result.standups.length} logged\n`;

          if (result.topBlockers.length > 0) {
            response += `\nBlockers this week:`;
            for (const b of result.topBlockers) {
              response += `\n• ${b}`;
            }
          }

          if (result.moodTrend.length > 0) {
            response += `\n\nMood trend:`;
            for (const m of result.moodTrend) {
              const date = new Date(m.date).toLocaleDateString('en-US', { weekday: 'short' });
              response += `\n• ${date}: ${m.mood}`;
            }
          }

          response += `\n\nAccomplished:`;
          for (const s of result.standups) {
            if (s.yesterday_done) {
              const date = new Date(s.date).toLocaleDateString('en-US', { weekday: 'short' });
              response += `\n• ${date}: ${s.yesterday_done}`;
            }
          }

          return response;
        }
      }
    }

    // ── Regex Fallback (existing code, unchanged) ─────────────────────
    const lower = text.toLowerCase().trim();

    // ── Weekly Reflection ─────────────────────────────────────────────
    if (/\b(?:weekly\s*reflection|week\s*review|week\s*recap|reflect\s*(?:on\s*)?(?:my\s*)?week)\b/i.test(lower)) {
      const result = await selfStandupService.getWeeklyReflection(userPhone);

      if (!result.standups || result.standups.length === 0) {
        return 'Weekly Reflection\n━━━━━━━━━━━━\nNo standups logged this week.\n\nStart with "log standup" to track your daily progress!';
      }

      let response = `Weekly Reflection\n━━━━━━━━━━━━\n`;
      response += `Completion: ${result.completionRate}%\n`;
      response += `Standups: ${result.standups.length} logged\n`;

      if (result.topBlockers.length > 0) {
        response += `\nBlockers this week:`;
        for (const b of result.topBlockers) {
          response += `\n• ${b}`;
        }
      }

      if (result.moodTrend.length > 0) {
        response += `\n\nMood trend:`;
        for (const m of result.moodTrend) {
          const date = new Date(m.date).toLocaleDateString('en-US', { weekday: 'short' });
          response += `\n• ${date}: ${m.mood}`;
        }
      }

      // Show summary of what was done
      response += `\n\nAccomplished:`;
      for (const s of result.standups) {
        if (s.yesterday_done) {
          const date = new Date(s.date).toLocaleDateString('en-US', { weekday: 'short' });
          response += `\n• ${date}: ${s.yesterday_done}`;
        }
      }

      return response;
    }

    // ── Standup History ───────────────────────────────────────────────
    if (/\b(?:standup\s*history|standup\s*(?:this|last)\s*week|past\s*standups?|previous\s*standups?)\b/i.test(lower)) {
      const entries = await selfStandupService.getHistory(userPhone);

      if (!entries || entries.length === 0) {
        return 'Standup History\n━━━━━━━━━━━━\nNo standups logged yet.\n\nStart with "log standup: Done: finished API, Plan: start UI"!';
      }

      let response = `Standup History (Last ${entries.length} days)\n━━━━━━━━━━━━\n`;

      for (const entry of entries) {
        const date = new Date(entry.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        response += `\n${date}`;
        if (entry.yesterday_done) response += `\nDone: ${entry.yesterday_done}`;
        if (entry.today_plan) response += `\nPlan: ${entry.today_plan}`;
        if (entry.blockers && entry.blockers.toLowerCase() !== 'none') {
          response += `\nBlockers: ${entry.blockers}`;
        }
      }

      return response;
    }

    // ── Today's Standup ───────────────────────────────────────────────
    if (/\b(?:today'?s?\s*standup|show\s*(?:my\s*)?standup|current\s*standup|get\s*standup)\b/i.test(lower)) {
      const standup = await selfStandupService.getToday(userPhone);

      if (!standup) {
        return 'No standup logged today yet.\n\nLog one with:\n"standup: Done: finished API, Plan: start UI, Blockers: none"';
      }

      const date = new Date(standup.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

      let response = `Today's Standup (${date})\n━━━━━━━━━━━━\n`;
      if (standup.yesterday_done) response += `Done: ${standup.yesterday_done}\n`;
      if (standup.today_plan) response += `Plan: ${standup.today_plan}\n`;
      if (standup.blockers) response += `Blockers: ${standup.blockers}\n`;
      if (standup.mood) response += `Mood: ${standup.mood}`;
      return response.trim();
    }

    // ── Log Standup (default) ─────────────────────────────────────────
    const parsed = _parseStandupFromText(text);

    if (parsed && (parsed.done || parsed.plan)) {
      const result = await selfStandupService.logStandup(
        userPhone,
        parsed.done,
        parsed.plan,
        parsed.blockers || null,
        parsed.mood || null,
        null // energyLevel
      );

      if (!result.success) {
        return `${result.error}`;
      }

      const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      let response = `Standup Logged! (${date})\n━━━━━━━━━━━━\n`;
      if (parsed.done) response += `Done: ${parsed.done}\n`;
      if (parsed.plan) response += `Plan: ${parsed.plan}\n`;
      response += `Blockers: ${parsed.blockers || 'none'}\n`;
      if (parsed.mood) response += `Mood: ${parsed.mood}`;
      return response.trim();
    }

    // ── Prompt for structured input ───────────────────────────────────
    return 'Personal Standup\n━━━━━━━━━━━━\nPlease share your standup in this format:\n\nDone: what you completed\nPlan: what you\'ll work on\nBlockers: any blockers (or \'none\')\n\nExample: "Done: finished API, Plan: start UI, Blockers: waiting for design"';

  } catch (error) {
    logger.error('Self standup handler error:', error.message);
    return 'Something went wrong with standup tracking. Please try again.';
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────

function _parseStandupFromText(text) {
  const result = {
    done: null,
    plan: null,
    blockers: null,
    mood: null,
  };

  // Try structured format: "Done: X, Plan: Y, Blockers: Z"
  const doneMatch = text.match(/\b(?:done|completed|finished|yesterday|did)[:\s]+(.+?)(?=\s*,?\s*(?:plan|todo|today|blocker|mood|$))/i);
  if (doneMatch) {
    result.done = doneMatch[1].replace(/,\s*$/, '').trim();
  }

  const planMatch = text.match(/\b(?:plan|todo|today|next|will do|going to)[:\s]+(.+?)(?=\s*,?\s*(?:blocker|mood|$))/i);
  if (planMatch) {
    result.plan = planMatch[1].replace(/,\s*$/, '').trim();
  }

  const blockerMatch = text.match(/\b(?:blockers?|blocked|stuck|issues?)[:\s]+(.+?)(?=\s*,?\s*(?:mood|$))/i);
  if (blockerMatch) {
    result.blockers = blockerMatch[1].replace(/,\s*$/, '').trim();
  }

  const moodMatch = text.match(/\b(?:mood|feeling)[:\s]+(.+?)(?=\s*$)/i);
  if (moodMatch) {
    result.mood = moodMatch[1].replace(/,\s*$/, '').trim();
  }

  // Try inline format: "standup: did X, planning Y"
  if (!result.done && !result.plan) {
    const inlineMatch = text.match(/\bstandup[:\s]+(.+)/i);
    if (inlineMatch) {
      const content = inlineMatch[1].trim();
      const parts = content.split(/\s*,\s*/);
      if (parts.length >= 2) {
        result.done = parts[0].replace(/^(?:done|did|finished)[:\s]*/i, '').trim();
        result.plan = parts[1].replace(/^(?:plan|will|next|today)[:\s]*/i, '').trim();
        if (parts[2]) {
          result.blockers = parts[2].replace(/^(?:blockers?|blocked|stuck)[:\s]*/i, '').trim();
        }
      }
    }
  }

  // Try simple format: "my standup" with context or just "standup: X"
  if (!result.done && !result.plan) {
    return null;
  }

  return result;
}
