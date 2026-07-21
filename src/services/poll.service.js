const { query } = require('../config/database');
const logger = require('../utils/logger');

class PollService {

  constructor() {
    this.tablesCreated = false;
  }

  async ensureTables() {
    if (this.tablesCreated) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS polls (
          id SERIAL PRIMARY KEY,
          creator_phone VARCHAR(20) NOT NULL,
          question TEXT NOT NULL,
          options JSONB NOT NULL DEFAULT '[]',
          recipients JSONB NOT NULL DEFAULT '[]',
          is_anonymous BOOLEAN DEFAULT FALSE,
          status VARCHAR(20) DEFAULT 'active',
          created_at TIMESTAMP DEFAULT NOW(),
          closed_at TIMESTAMP
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_polls_creator ON polls(creator_phone)`);

      await query(`
        CREATE TABLE IF NOT EXISTS poll_votes (
          id SERIAL PRIMARY KEY,
          poll_id INTEGER REFERENCES polls(id) ON DELETE CASCADE,
          voter_phone VARCHAR(20) NOT NULL,
          selected_option INTEGER NOT NULL,
          created_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(poll_id, voter_phone)
        )
      `);

      // Add new columns if they don't exist
      await query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS deadline TIMESTAMP`);
      await query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS anonymous BOOLEAN DEFAULT false`);
      await query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS multi_select BOOLEAN DEFAULT false`);
      // poll_type: 'poll' (numbered choice) | 'checkin' (yes/no/maybe)
      await query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS poll_type VARCHAR(20) DEFAULT 'poll'`);
      // team_name: when poll was sent to an entire named team
      await query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS team_name VARCHAR(100)`);
      // Backfill poll_type for rows created before this column existed
      await query(`UPDATE polls SET poll_type = 'poll' WHERE poll_type IS NULL`);

      this.tablesCreated = true;
    } catch (error) {
      logger.error('Error creating poll tables:', error.message);
    }
  }

  async createPoll(creatorPhone, question, options, recipients, isAnonymous = false) {
    await this.ensureTables();
    try {
      const result = await query(
        `INSERT INTO polls (creator_phone, question, options, recipients, is_anonymous)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [creatorPhone, question, JSON.stringify(options), JSON.stringify(recipients), isAnonymous]
      );
      return { success: true, poll: result.rows[0] };
    } catch (error) {
      logger.error('Error creating poll:', error.message);
      return { success: false, error: error.message };
    }
  }

  async recordVote(pollId, voterPhone, selectedOption) {
    await this.ensureTables();
    try {
      // Restrict to creator OR recipients at the DB layer — anyone with a
      // poll id used to be able to vote even if they weren't on the
      // recipient list.
      const poll = await this.getPollById(pollId, voterPhone);
      if (!poll) return { success: false, error: 'Poll not found.' };
      if (poll.status !== 'active') return { success: false, error: 'Poll is closed.' };

      const options = poll.options;
      if (selectedOption < 0 || selectedOption >= options.length) {
        return { success: false, error: `Invalid option. Choose 1-${options.length}.` };
      }

      await query(
        `INSERT INTO poll_votes (poll_id, voter_phone, selected_option)
         VALUES ($1, $2, $3)
         ON CONFLICT (poll_id, voter_phone)
         DO UPDATE SET selected_option = $3`,
        [pollId, voterPhone, selectedOption]
      );

      // Check if everyone has voted — trigger full-response notification
      const recipients = Array.isArray(poll.recipients) ? poll.recipients : [];
      const totalRecipients = recipients.length;
      let allVoted = false;
      let creatorPhone = null;
      if (totalRecipients > 0) {
        const voteCountResult = await query(
          `SELECT COUNT(DISTINCT voter_phone) AS cnt FROM poll_votes WHERE poll_id = $1`,
          [pollId]
        );
        const voteCount = parseInt(voteCountResult.rows[0]?.cnt || 0);
        if (voteCount >= totalRecipients) {
          allVoted = true;
          creatorPhone = poll.creator_phone;
        }
      }

      return { success: true, option: options[selectedOption], allVoted, creatorPhone, pollId };
    } catch (error) {
      logger.error('Error recording vote:', error.message);
      return { success: false, error: 'Could not record vote.' };
    }
  }

  /**
   * Fetch a single poll record.
   *
   * Apr 29 2026 — IDOR hardening. Callers should pass `requesterPhone` so the
   * row is filtered at the DB layer (the requester must be either the
   * creator OR a recipient). Legacy callers that don't pass it (e.g. cron
   * jobs that need to operate on every active poll) get the unfiltered
   * legacy behaviour — those call sites are documented in the audit and
   * should be migrated to a dedicated `getPollByIdInternal` over time.
   */
  async getPollById(pollId, requesterPhone = null) {
    try {
      if (requesterPhone) {
        const result = await query(
          `SELECT * FROM polls
            WHERE id = $1
              AND (creator_phone = $2 OR $2 = ANY(recipients))`,
          [pollId, requesterPhone]
        );
        return result.rows[0] || null;
      }
      const result = await query(`SELECT * FROM polls WHERE id = $1`, [pollId]);
      return result.rows[0] || null;
    } catch (error) {
      return null;
    }
  }

  async getPollResults(pollId) {
    await this.ensureTables();
    try {
      const poll = await this.getPollById(pollId);
      if (!poll) return null;

      const votes = await query(
        `SELECT selected_option, COUNT(*) as count, ARRAY_AGG(voter_phone) as voters
         FROM poll_votes WHERE poll_id = $1
         GROUP BY selected_option ORDER BY selected_option`,
        [pollId]
      );

      const totalVotes = votes.rows.reduce((sum, r) => sum + parseInt(r.count), 0);
      const options = poll.options;

      const isAnonymous = poll.is_anonymous || poll.anonymous;
      const results = options.map((opt, i) => {
        const voteRow = votes.rows.find(r => r.selected_option === i);
        const count = voteRow ? parseInt(voteRow.count) : 0;
        const voters = (voteRow && !isAnonymous) ? voteRow.voters : [];
        const percentage = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
        return { option: opt, count, percentage, voters };
      });

      return { poll, results, totalVotes, totalRecipients: poll.recipients.length };
    } catch (error) {
      logger.error('Error getting poll results:', error.message);
      return null;
    }
  }

  async closePoll(pollId, requesterPhone) {
    await this.ensureTables();
    try {
      // Filter at the DB layer + check creator after — defense-in-depth.
      const poll = await this.getPollById(pollId, requesterPhone);
      if (!poll) return { success: false, error: 'Poll not found.' };
      if (poll.creator_phone !== requesterPhone) return { success: false, error: 'Only the creator can close this poll.' };

      await query(
        `UPDATE polls SET status = 'closed', closed_at = NOW() WHERE id = $1`,
        [pollId]
      );

      return { success: true };
    } catch (error) {
      return { success: false, error: 'Could not close poll.' };
    }
  }

  /**
   * Atomically closes a poll ONLY if all recipients have voted AND it is still active.
   * Returns the closed poll row ({ id, creator_phone }) or null if nothing was closed.
   * Using a single UPDATE with a subquery prevents the race condition where concurrent
   * votes all detect "all voted" and each try to close + notify the creator.
   */
  async closeIfAllVoted(pollId) {
    try {
      const result = await query(
        `UPDATE polls SET status = 'closed', closed_at = NOW()
         WHERE id = $1
           AND status = 'active'
           AND (SELECT COUNT(*) FROM poll_votes WHERE poll_id = $1)
               >= jsonb_array_length(recipients)
         RETURNING id, creator_phone`,
        [pollId]
      );
      return result.rows[0] || null; // null = not all voted yet, or already closed by a concurrent call
    } catch (e) {
      logger.error('closeIfAllVoted error:', e.message);
      return null;
    }
  }

  async getActivePollsForUser(userPhone) {
    await this.ensureTables();
    try {
      const result = await query(
        `SELECT * FROM polls WHERE creator_phone = $1 AND status = 'active' ORDER BY created_at DESC`,
        [userPhone]
      );
      return result.rows;
    } catch (error) {
      return [];
    }
  }

  async getActivePollForVoter(voterPhone) {
    await this.ensureTables();
    try {
      // Find active polls where this person is a recipient and hasn't voted yet
      const result = await query(
        `SELECT p.* FROM polls p
         WHERE p.status = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM poll_votes pv WHERE pv.poll_id = p.id AND pv.voter_phone = $1
         )
         ORDER BY p.created_at DESC`,
        [voterPhone]
      );

      // Filter to polls where voterPhone is in recipients
      for (const poll of result.rows) {
        const recipients = poll.recipients;
        if (recipients.some(r => r.phone === voterPhone || r === voterPhone)) {
          return poll;
        }
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  // ========== TEXT-VOTE SUPPORT (checkins + text-matched votes) ==========

  /**
   * Try to match a text reply to a poll option.
   * For checkins: matches yes/no/maybe in many languages.
   * For polls: tries option text or number matching.
   * Returns the 0-based option index, or -1 if no match.
   */
  parseTextVote(reply, poll) {
    const lower = reply.toLowerCase().trim();
    const options = poll.options || [];
    const type = poll.poll_type || 'poll';

    if (type === 'checkin') {
      if (/^(yes|yeah|yep|haan|ha|y|1|sure|ok|okay|available|confirm)$/i.test(lower)) return 0;
      if (/^(no|nope|nahi|na|n|2|not|busy|cant|can't)$/i.test(lower)) return 1;
      if (/^(maybe|possibly|perhaps|3|might|shayad|not sure)$/i.test(lower)) return 2;
      return -1;
    }

    // Number reply
    const numMatch = lower.match(/^(\d+)$/);
    if (numMatch) {
      const idx = parseInt(numMatch[1]) - 1;
      return (idx >= 0 && idx < options.length) ? idx : -1;
    }

    // Text match against options (exact then partial)
    for (let i = 0; i < options.length; i++) {
      if (lower === options[i].toLowerCase()) return i;
    }
    for (let i = 0; i < options.length; i++) {
      if (options[i].toLowerCase().includes(lower) || lower.includes(options[i].toLowerCase())) return i;
    }
    return -1;
  }

  /**
   * Record a vote using text matching — used by handlePollVote for non-numeric replies.
   */
  async recordTextVote(pollId, voterPhone, replyText) {
    await this.ensureTables();
    try {
      const poll = await this.getPollById(pollId);
      if (!poll) return { success: false, error: 'Poll not found.' };
      if (poll.status !== 'active') return { success: false, error: 'Poll is closed.' };

      const optionIndex = this.parseTextVote(replyText, poll);
      if (optionIndex === -1) return { success: false, noMatch: true };

      await query(
        `INSERT INTO poll_votes (poll_id, voter_phone, selected_option)
         VALUES ($1, $2, $3)
         ON CONFLICT (poll_id, voter_phone)
         DO UPDATE SET selected_option = $3`,
        [pollId, voterPhone, optionIndex]
      );
      // All-voted check
      const recipients = Array.isArray(poll.recipients) ? poll.recipients : [];
      let allVoted = false;
      let creatorPhone = null;
      if (recipients.length > 0) {
        const vc = await query(
          `SELECT COUNT(DISTINCT voter_phone) AS cnt FROM poll_votes WHERE poll_id = $1`,
          [pollId]
        );
        if (parseInt(vc.rows[0]?.cnt || 0) >= recipients.length) {
          allVoted = true;
          creatorPhone = poll.creator_phone;
        }
      }
      return { success: true, option: poll.options[optionIndex], allVoted, creatorPhone, pollId };
    } catch (error) {
      logger.error('Error recording text vote:', error.message);
      return { success: false, error: 'Could not record vote.' };
    }
  }

  /**
   * Create a poll with team_name recorded (used for team polls / check-ins).
   */
  async createTeamPoll(creatorPhone, teamName, question, options, pollType = 'poll', recipients = []) {
    await this.ensureTables();
    try {
      const result = await query(
        `INSERT INTO polls (creator_phone, team_name, question, options, recipients, poll_type, is_anonymous)
         VALUES ($1, $2, $3, $4, $5, $6, false)
         RETURNING *`,
        [creatorPhone, teamName || null, question, JSON.stringify(options), JSON.stringify(recipients), pollType]
      );
      return { success: true, poll: result.rows[0] };
    } catch (error) {
      logger.error('createTeamPoll error:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get the latest active poll/checkin for a team (for showing results).
   */
  async getLatestTeamPoll(creatorPhone, teamName = null) {
    await this.ensureTables();
    try {
      const result = teamName
        ? await query(
            `SELECT * FROM polls WHERE creator_phone = $1 AND LOWER(team_name) = LOWER($2) AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
            [creatorPhone, teamName]
          )
        : await query(
            `SELECT * FROM polls WHERE creator_phone = $1 AND team_name IS NOT NULL AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
            [creatorPhone]
          );
      return result.rows[0] || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Format poll results. Optionally pass a phoneToName map to show voter names.
   * Voter names are only shown for non-anonymous polls; anonymous stays hidden.
   */
  formatPollResults(data, phoneToName = null) {
    if (!data) return 'No poll results found.';

    const { poll, results, totalVotes, totalRecipients } = data;
    const isCheckin = poll.poll_type === 'checkin';
    const isAnonymous = poll.is_anonymous || poll.anonymous;
    let response = `*${isCheckin ? 'Check-in' : 'Poll'} Results*\n\n`;
    response += `*${poll.question}*\n`;
    response += `${totalVotes}/${totalRecipients} responded`;
    if (isAnonymous) response += ` _(anonymous)_`;
    response += `\n\n`;

    const nameFor = (phone) => {
      if (!phone) return 'Unknown';
      if (phoneToName && phoneToName[phone]) return phoneToName[phone];
      // Fall back to masked phone for privacy
      const digits = String(phone).replace(/\D/g, '');
      if (digits.length >= 4) return `+${digits.slice(0, 2)} ***${digits.slice(-4)}`;
      return phone;
    };

    for (const r of results) {
      const barLen = Math.max(1, Math.round(r.percentage / 10));
      const bar = '█'.repeat(barLen) + '░'.repeat(10 - barLen);
      response += `${r.option}: ${r.count} (${r.percentage}%)\n${bar}\n`;
      // Show voter names for non-anonymous polls
      if (!isAnonymous && Array.isArray(r.voters) && r.voters.length > 0) {
        const names = r.voters.map(nameFor).join(', ');
        response += `   _${names}_\n`;
      }
      response += `\n`;
    }

    response += poll.status === 'active'
      ? `_"close poll" to end_`
      : `_Closed_`;

    return response.trim();
  }

  /**
   * Format an outgoing poll. If senderName is provided, show who sent it.
   */
  formatPollMessage(poll, senderName = null) {
    const options = poll.options;
    const isCheckin = poll.poll_type === 'checkin';
    const header = senderName ? `*Poll from ${senderName}*` : `*Poll*`;
    const checkinHeader = senderName ? `*Check-in from ${senderName}*` : `*Check-in*`;

    if (isCheckin) {
      return `${checkinHeader}\n\n*${poll.question}*\n\nReply: *yes*, *no*, or *maybe*`;
    }

    let message = `${header}\n\n*${poll.question}*\n\n`;
    options.forEach((opt, i) => { message += `${i + 1}. ${opt}\n`; });
    message += `\nReply with the number of your choice.`;
    return message;
  }

  parsePollCommand(message) {
    const lower = message.toLowerCase().trim();

    // Helper: extract question and options from a string
    // Accepts: "question? options: a, b, c" | "X or Y or Z" | "question a/b/c"
    const extractQuestionOptions = (text) => {
      let question = text.trim();
      let options = [];
      const optsMatch = question.match(/^(.+?)\s*(?:options?|choices?)\s*[:\-]\s*(.+)$/i);
      if (optsMatch) {
        question = optsMatch[1].trim().replace(/[?:]+$/, '') + '?';
        options = optsMatch[2].split(/[,;]|\s+or\s+/i).map(o => o.trim()).filter(Boolean);
      } else if (/\bor\b/i.test(question)) {
        const parts = question.split(/\bor\b/i).map(p => p.trim()).filter(Boolean);
        if (parts.length >= 2) {
          question = question.replace(/\?$/, '').trim() + '?';
          options = parts;
        }
      }
      // FIX #8 (Apr 27 2026 — Bucket J06): strip leading filler words from
      // the FIRST option. When user wrote "lunch options pizza or sushi or
      // salad" and there was no colon after "options", the regex above did
      // NOT trigger the optsMatch branch, so the split by "or" produced
      // ["lunch options pizza", "sushi", "salad"] with the word "options"
      // embedded in option #1. Strip the leading filler now.
      if (options.length > 0) {
        options = options.map(o =>
          o.replace(/^(?:options?|choices?|lunch options?|dinner options?|menu)\s+/i, '').trim()
        ).filter(Boolean);
      }
      if (options.length < 2) options = ['Yes', 'No'];
      return { question, options };
    };

    // "poll results" / "show poll results"
    if (/^(show |view )?(poll )?results$/i.test(lower)) {
      return { action: 'results' };
    }

    // "close poll"
    if (/^close\s+poll$/i.test(lower)) {
      return { action: 'close' };
    }

    // "my polls"
    if (/^(my |show |active )?polls$/i.test(lower)) {
      return { action: 'list' };
    }

    // NEW: "create [anonymous] poll: <question> [options: a, b, c]"
    //      "[anonymous] poll: <question> ..."
    //      "create poll to my team: ..." / "poll team: ..."
    //      "poll to design team: ..." / "create poll for legal team: ..."
    // Detect anonymous flag
    const isAnonymous = /\banonymous\b/i.test(lower);

    // Named team variant: capture team name explicitly
    //   "poll to <name> team: ..."  |  "create poll for <name> team: ..."
    const namedTeamMatch = message.match(/^(?:create\s+)?(?:an?\s+)?(?:anonymous\s+)?poll\s+(?:to|for|in)\s+(?:the\s+|my\s+)?([\w\s-]+?)\s+team\s*[:\-]\s*(.+)$/i);
    if (namedTeamMatch) {
      const teamName = namedTeamMatch[1].trim();
      const body = namedTeamMatch[2].trim();
      const { question, options } = extractQuestionOptions(body);
      return { action: 'create', recipientNames: [], toTeam: true, teamName, isAnonymous, question, options };
    }

    // Default-team / generic variant
    const createMatch = message.match(/^(?:create\s+)?(?:an?\s+)?(?:anonymous\s+)?poll\s*(?:to\s+(?:my\s+|the\s+)?team|for\s+(?:my\s+|the\s+)?team|team)?\s*[:\-]\s*(.+)$/i);
    if (createMatch) {
      const body = createMatch[1].trim();
      const { question, options } = extractQuestionOptions(body);
      return { action: 'create', recipientNames: [], toTeam: true, teamName: null, isAnonymous, question, options };
    }

    // "poll to Emily, Rahul: lunch at 12 or 1?"
    const pollMatch = message.match(/^poll\s+(?:to\s+)?([^:]+):\s*(.+)$/i);
    if (pollMatch) {
      const recipientsPart = pollMatch[1].trim();
      const questionAndOptions = pollMatch[2].trim();

      // Parse recipients (comma-separated names)
      const recipientNames = recipientsPart.split(/[,&]/).map(n => n.trim()).filter(n => n);

      // Parse question and options (split by "or" or by "options:" or numbered)
      let question = questionAndOptions;
      let options = [];

      // Try "X or Y or Z" format
      if (/\bor\b/i.test(questionAndOptions)) {
        const parts = questionAndOptions.split(/\bor\b/i).map(p => p.trim());
        if (parts.length >= 2) {
          // Question might be embedded: "lunch at 12 or 1?" -> question: "lunch at?", options: ["12", "1"]
          // Better to keep whole thing as question and extract options
          question = questionAndOptions.replace(/\?$/, '').trim() + '?';
          options = parts;
        }
      }

      // If no options found by "or", try "options: a, b, c" format
      if (options.length === 0) {
        const optionsMatch = questionAndOptions.match(/^(.+?)\s*(?:options?|choices?):\s*(.+)$/i);
        if (optionsMatch) {
          question = optionsMatch[1].trim();
          options = optionsMatch[2].split(/[,;]/).map(o => o.trim()).filter(o => o);
        }
      }

      // Default: if still no options, create Yes/No
      if (options.length < 2) {
        options = ['Yes', 'No'];
      }

      return { action: 'create', recipientNames, question, options };
    }

    return null;
  }

  /**
   * Find polls that have passed their deadline and should be auto-closed.
   * For use in a cron job to automatically close expired polls.
   * @returns {Promise<Array>} Active polls whose deadline has passed
   */
  async getExpiredPolls() {
    await this.ensureTables();
    try {
      const result = await query(
        `SELECT * FROM polls
         WHERE status = 'active'
           AND deadline IS NOT NULL
           AND deadline <= NOW()
         ORDER BY deadline`
      );
      return result.rows;
    } catch (error) {
      logger.error('Error getting expired polls:', error.message);
      return [];
    }
  }

  /**
   * Close an expired poll (no creator auth check - for cron/system use).
   * Sets status to 'closed' and returns the final results.
   * @param {number} pollId - The poll ID to close
   * @returns {Promise<{success: boolean, results?: object, error?: string}>}
   */
  async closeExpiredPoll(pollId) {
    await this.ensureTables();
    try {
      const poll = await this.getPollById(pollId);
      if (!poll) return { success: false, error: 'Poll not found.' };
      if (poll.status === 'closed') return { success: false, error: 'Poll is already closed.' };

      await query(
        `UPDATE polls SET status = 'closed', closed_at = NOW() WHERE id = $1`,
        [pollId]
      );

      const results = await this.getPollResults(pollId);
      return { success: true, results };
    } catch (error) {
      logger.error('Error closing expired poll:', error.message);
      return { success: false, error: 'Could not close poll.' };
    }
  }

  /**
   * Compare poll votes against a team member list and return who hasn't voted.
   * @param {number} pollId - The poll ID
   * @param {Array<{phone: string, name: string}>} teamMembers - List of team members to check
   * @returns {Promise<Array<{phone: string, name: string}>>} Members who haven't voted
   */
  async getNonVoters(pollId, teamMembers) {
    await this.ensureTables();
    try {
      const poll = await this.getPollById(pollId);
      if (!poll) return [];

      const result = await query(
        `SELECT voter_phone FROM poll_votes WHERE poll_id = $1`,
        [pollId]
      );

      const voterPhones = new Set(result.rows.map(r => r.voter_phone));

      return teamMembers
        .filter(m => !voterPhones.has(m.phone))
        .map(m => ({ phone: m.phone, name: m.name }));
    } catch (error) {
      logger.error('Error getting non-voters:', error.message);
      return [];
    }
  }

  /**
   * Generate a text-based bar chart visualization of poll results.
   * Uses block characters for the bar (10 blocks total).
   * @param {number} pollId - The poll ID
   * @returns {Promise<string|null>} Formatted text visualization or null if poll not found
   */
  async getResultsVisualization(pollId) {
    await this.ensureTables();
    try {
      const data = await this.getPollResults(pollId);
      if (!data) return null;

      const { poll, results, totalVotes } = data;

      // Find the longest option name for alignment
      const maxOptionLen = Math.max(...results.map(r => r.option.length), 1);

      let viz = `Poll Results: ${poll.question}\n`;
      viz += '\u2501'.repeat(Math.min(maxOptionLen + 25, 40)) + '\n';

      for (const r of results) {
        const filledBlocks = totalVotes > 0 ? Math.round((r.count / totalVotes) * 10) : 0;
        const emptyBlocks = 10 - filledBlocks;
        const bar = '\u2588'.repeat(filledBlocks) + '\u2591'.repeat(emptyBlocks);
        const paddedOption = r.option.padEnd(maxOptionLen, ' ');
        const voteLabel = r.count === 1 ? 'vote ' : 'votes';
        viz += `${paddedOption} ${bar} ${r.count} ${voteLabel} (${r.percentage}%)\n`;
      }

      viz += `Total: ${totalVotes} vote${totalVotes !== 1 ? 's' : ''}`;

      return viz;
    } catch (error) {
      logger.error('Error generating results visualization:', error.message);
      return null;
    }
  }
}

module.exports = new PollService();
