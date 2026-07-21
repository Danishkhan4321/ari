const { query } = require('../config/database');
const logger = require('../utils/logger');
const llm = require('./llm-provider');

class MeetingMinutesService {

  constructor() {
    this.schemaReady = false;
  }

  async ensureSchema() {
    if (this.schemaReady) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS meeting_minutes (
          id SERIAL PRIMARY KEY,
          user_phone VARCHAR(50) NOT NULL,
          team_admin_phone VARCHAR(50),
          title VARCHAR(500),
          date TIMESTAMP DEFAULT NOW(),
          attendees TEXT,
          summary TEXT,
          action_items TEXT,
          decisions TEXT,
          raw_notes TEXT,
          created_by VARCHAR(50) NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_meeting_minutes_user ON meeting_minutes(user_phone)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_meeting_minutes_team ON meeting_minutes(team_admin_phone)`);

      this.schemaReady = true;
    } catch (error) {
      logger.error('Error creating meeting_minutes table:', error.message);
    }
  }

  async createMinutes(userPhone, title, rawNotes, teamAdminPhone) {
    await this.ensureSchema();
    try {
      // Generate structured minutes using AI
      const structured = await this.generateStructuredMinutes(rawNotes, title);

      const result = await query(
        `INSERT INTO meeting_minutes (user_phone, team_admin_phone, title, raw_notes, summary, action_items, decisions, attendees, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $1)
         RETURNING *`,
        [
          userPhone,
          teamAdminPhone || null,
          title || 'Untitled Meeting',
          rawNotes,
          structured.summary || null,
          JSON.stringify(structured.actionItems || []),
          JSON.stringify(structured.decisions || []),
          JSON.stringify(structured.attendees || [])
        ]
      );

      // Auto-link to the team knowledge base so the minutes are
      // searchable alongside other team docs. Before May 19 2026 minutes
      // were siloed in their own table — users had to remember the exact
      // command "show me minutes from X" to recall them. Now searching the
      // knowledge base also surfaces meeting notes. Failure here is
      // non-fatal — the minutes still exist in their own table.
      if (result.rows[0]?.id) {
        try {
          const summary = structured.summary || (rawNotes ? rawNotes.slice(0, 500) : '');
          const actionLines = Array.isArray(structured.actionItems)
            ? structured.actionItems.map(a => `- ${typeof a === 'string' ? a : (a.text || a.action || '')}`).join('\n')
            : '';
          const decisionLines = Array.isArray(structured.decisions)
            ? structured.decisions.map(d => `- ${typeof d === 'string' ? d : (d.text || d.decision || '')}`).join('\n')
            : '';
          const content = [
            summary,
            actionLines ? `\n*Action items*\n${actionLines}` : '',
            decisionLines ? `\n*Decisions*\n${decisionLines}` : ''
          ].filter(Boolean).join('\n');
          if (content.trim()) {
            await query(
              `INSERT INTO knowledge_base (team_admin_phone, title, content, category, tags, created_by, created_by_name)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT DO NOTHING`,
              [
                teamAdminPhone || userPhone,
                `Meeting: ${title || 'Untitled'}`,
                content,
                'meeting_minutes',
                'meeting,minutes,auto',
                userPhone,
                null
              ]
            );
          }
        } catch (kbErr) {
          logger.warn(`[MeetingMinutes] KB auto-link failed (non-fatal): ${kbErr.message}`);
        }
      }

      return { success: true, minutes: result.rows[0], structured };
    } catch (error) {
      logger.error('Error creating meeting minutes:', error.message);
      return { success: false, error: error.message };
    }
  }

  async generateStructuredMinutes(rawNotes, title) {
    try {
      const apiKey = llm.apiKey();
      if (!apiKey) {
        logger.error('No AI API key configured for meeting minutes generation');
        return { summary: rawNotes, actionItems: [], decisions: [], keyTopics: [], attendees: [] };
      }

      const apiUrl = llm.chatUrl();
      const model = llm.defaultModel();

      const axios = require('axios');

      const response = await axios.post(apiUrl, {
        model,
        messages: [
          {
            role: 'system',
            content: `You are a meeting minutes assistant. Parse the raw meeting notes into a structured format.

Output ONLY valid JSON with this structure:
{
  "summary": "A concise 2-3 sentence summary of the meeting",
  "actionItems": [
    {"item": "Description of action item", "assignee": "Person responsible or null", "deadline": "Deadline mentioned or null"}
  ],
  "decisions": ["Decision 1", "Decision 2"],
  "keyTopics": ["Topic 1", "Topic 2"],
  "attendees": ["Name 1", "Name 2"]
}

Rules:
- Extract action items with assignees and deadlines if mentioned
- Identify key decisions made during the meeting
- List main topics discussed
- Extract attendee names if mentioned in the notes
- Keep the summary concise and factual
- If information is not available, use empty arrays
- Output ONLY the JSON, nothing else`
          },
          {
            role: 'user',
            content: `Meeting title: ${title || 'Untitled Meeting'}\n\nRaw notes:\n${rawNotes}`
          }
        ],
        temperature: 0.3,
        max_tokens: 1000
      }, {
        headers: llm.headers(),
        timeout: 30000
      });

      const content = response.data.choices[0].message.content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.error('Could not parse AI response for meeting minutes');
        return { summary: rawNotes, actionItems: [], decisions: [], keyTopics: [], attendees: [] };
      }

      return JSON.parse(jsonMatch[0]);
    } catch (error) {
      logger.error('Error generating structured minutes:', error.message);
      return { summary: rawNotes, actionItems: [], decisions: [], keyTopics: [], attendees: [] };
    }
  }

  async getMinutes(userPhone, minutesId) {
    await this.ensureSchema();
    try {
      const result = await query(
        `SELECT * FROM meeting_minutes WHERE user_phone = $1 AND id = $2`,
        [userPhone, minutesId]
      );
      return result.rows[0] || null;
    } catch (error) {
      logger.error('Error getting meeting minutes:', error.message);
      return null;
    }
  }

  async getRecentMinutes(userPhone, limit) {
    await this.ensureSchema();
    try {
      const maxResults = limit || 10;
      const result = await query(
        `SELECT * FROM meeting_minutes WHERE user_phone = $1 ORDER BY created_at DESC LIMIT $2`,
        [userPhone, maxResults]
      );
      return result.rows;
    } catch (error) {
      logger.error('Error getting recent meeting minutes:', error.message);
      return [];
    }
  }

  async searchMinutes(userPhone, searchTerm) {
    await this.ensureSchema();
    try {
      const pattern = `%${searchTerm}%`;
      const result = await query(
        `SELECT * FROM meeting_minutes
         WHERE user_phone = $1
           AND (title ILIKE $2 OR summary ILIKE $2 OR action_items ILIKE $2 OR raw_notes ILIKE $2)
         ORDER BY created_at DESC`,
        [userPhone, pattern]
      );
      return result.rows;
    } catch (error) {
      logger.error('Error searching meeting minutes:', error.message);
      return [];
    }
  }

  async getActionItems(userPhone) {
    await this.ensureSchema();
    try {
      const result = await query(
        `SELECT id, title, date, action_items FROM meeting_minutes
         WHERE user_phone = $1 AND action_items IS NOT NULL AND action_items != '[]'
         ORDER BY created_at DESC
         LIMIT 20`,
        [userPhone]
      );

      const allActionItems = [];
      for (const row of result.rows) {
        try {
          const items = typeof row.action_items === 'string'
            ? JSON.parse(row.action_items)
            : row.action_items;

          if (Array.isArray(items)) {
            for (const item of items) {
              allActionItems.push({
                meetingId: row.id,
                meetingTitle: row.title,
                meetingDate: row.date,
                item: item.text || item.item || item,
                assignee: item.assignee || null,
                deadline: item.deadline || null
              });
            }
          }
        } catch (parseErr) {
          // If action_items is plain text, treat it as a single item
          allActionItems.push({
            meetingId: row.id,
            meetingTitle: row.title,
            meetingDate: row.date,
            item: row.action_items,
            assignee: null,
            deadline: null
          });
        }
      }

      return allActionItems;
    } catch (error) {
      logger.error('Error getting action items:', error.message);
      return [];
    }
  }
}

module.exports = new MeetingMinutesService();
