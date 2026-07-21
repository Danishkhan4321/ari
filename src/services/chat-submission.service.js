const { query } = require('../config/database');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class ChatSubmissionService {
  constructor(queryFn = query) {
    this.query = queryFn;
  }

  async claim({ userPhone, sessionId, clientMessageId, runId }) {
    if (!userPhone || !UUID_PATTERN.test(sessionId || '') || !UUID_PATTERN.test(clientMessageId || '')) {
      return { ok: false, reason: 'invalid' };
    }

    const owned = await this.query(
      `SELECT 1 FROM ari_chat_sessions WHERE id = $1::uuid AND user_phone = $2 LIMIT 1`,
      [sessionId, userPhone]
    );
    if (owned.rowCount === 0) return { ok: false, reason: 'not_found' };

    const inserted = await this.query(
      `INSERT INTO ari_chat_submissions
         (user_phone, session_id, client_message_id, run_id, status, created_at, updated_at)
       VALUES ($1, $2::uuid, $3::uuid, $4, 'claimed', NOW(), NOW())
       ON CONFLICT (user_phone, session_id, client_message_id) DO NOTHING
       RETURNING client_message_id`,
      [userPhone, sessionId, clientMessageId, runId || null]
    );
    return { ok: true, claimed: inserted.rowCount > 0 };
  }

  async markStatus({ userPhone, sessionId, clientMessageId, status }) {
    await this.query(
      `UPDATE ari_chat_submissions
          SET status = $4, updated_at = NOW()
        WHERE user_phone = $1 AND session_id = $2::uuid AND client_message_id = $3::uuid`,
      [userPhone, sessionId, clientMessageId, status]
    );
  }
}

module.exports = new ChatSubmissionService();
module.exports.ChatSubmissionService = ChatSubmissionService;
module.exports.UUID_PATTERN = UUID_PATTERN;
