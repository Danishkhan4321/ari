const { query } = require('../config/database');
const logger = require('../utils/logger');
const axios = require('axios');
const llm = require('./llm-provider');

const apiKey = llm.apiKey();
const apiUrl = llm.chatUrl();
const model = llm.fastModel();

class MemoryService {

  constructor() {
    this.notesTableCreated = false;
  }

  // ==================== NOTES TABLE ====================
  async ensureNotesTable() {
    if (this.notesTableCreated) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS notes (
          id SERIAL PRIMARY KEY,
          user_phone VARCHAR(20) NOT NULL,
          topic VARCHAR(100) NOT NULL,
          content TEXT NOT NULL,
          source VARCHAR(50) DEFAULT 'manual',
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_notes_user ON notes(user_phone)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_notes_topic ON notes(user_phone, topic)`);
      this.notesTableCreated = true;
    } catch (error) {
      logger.error('Error creating notes table:', error.message);
    }
  }

  // ==================== AI-POWERED MEMORY EXTRACTION ====================

  async extractMemoriesWithAI(message) {
    try {
      const prompt = `You are a memory extractor. Analyze if the user is sharing any information that should be remembered.

User message: "${message}"

Extract ANY memorable information - about themselves, other people, things, facts, etc.

Respond ONLY in this JSON format (no other text):
{
  "should_save": true/false,
  "memories": [
    {
      "category": "personal/work/family/friends/finance/health/preferences/general",
      "subject": "who/what this is about (e.g., 'user', 'John', 'boss', 'wifi', 'meeting')",
      "key": "what type of info (e.g., 'name', 'birthday', 'phone', 'password', 'time')",
      "value": "the actual value to remember"
    }
  ]
}

Examples:

"I'm Danish" → {"should_save": true, "memories": [{"category": "personal", "subject": "user", "key": "name", "value": "Danish"}]}

"My boss's name is Rahul" → {"should_save": true, "memories": [{"category": "work", "subject": "boss", "key": "name", "value": "Rahul"}]}

"John's birthday is March 15" → {"should_save": true, "memories": [{"category": "friends", "subject": "John", "key": "birthday", "value": "March 15"}]}

"Remember the wifi password is abc123" → {"should_save": true, "memories": [{"category": "general", "subject": "wifi", "key": "password", "value": "abc123"}]}

"Emily likes chocolate" → {"should_save": true, "memories": [{"category": "friends", "subject": "Emily", "key": "likes", "value": "chocolate"}]}

"Meeting tomorrow at 3pm with Amit" → {"should_save": true, "memories": [{"category": "work", "subject": "meeting with Amit", "key": "time", "value": "tomorrow at 3pm"}]}

"My car number is MH01AB1234" → {"should_save": true, "memories": [{"category": "personal", "subject": "user", "key": "car number", "value": "MH01AB1234"}]}

"How are you?" → {"should_save": false, "memories": []}

"What's the weather?" → {"should_save": false, "memories": []}

Rules:
- Only extract if there's actual information to remember
- Casual chat like "hi", "thanks", "how are you" → should_save: false
- Questions asking for info → should_save: false
- If user says "I" or "my", subject is "user"
- If about someone else, use their name as subject`;

      // Route via modelFor('mem0_extract') — falls back to default model if env unset.
      const taskModel = llm.modelFor('mem0_extract') || model;
      const response = await llm.chatCompletion({
        model: taskModel,
        messages: [
          { role: 'system', content: 'You are a JSON-only memory extractor. Output ONLY valid JSON.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        max_tokens: 500,
      }, { task: 'mem0_extract', timeout: 15000 });

      try {
        const tracker = require('./model-usage-tracker.service');
        tracker.log({ task: 'mem0_extract', model: taskModel, usage: response?.data?.usage });
      } catch (_) {}

      const aiResponse = response.data.choices[0].message.content.trim();

      // Parse JSON from AI response
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { should_save: false, memories: [] };
      }

      const parsed = JSON.parse(jsonMatch[0]);
      return parsed;

    } catch (error) {
      logger.error('AI memory extraction error:', error.message);
      return { should_save: false, memories: [] };
    }
  }

  // ==================== AI-POWERED MEMORY RECALL ====================

  async searchWithAI(userPhone, message) {
    try {
      // The relational current-value projection is authoritative. Mem0 can be
      // enabled only as a legacy compatibility path because its vector index
      // may briefly return a fact that has since been superseded.
      const mem0Service = require('./mem0-memory.service');
      if (process.env.MEM0_RECALL_LEGACY === 'true' && mem0Service.isAvailable()) {
        try {
          const mem0Results = await mem0Service.search(message, userPhone, 20);
          if (mem0Results && mem0Results.length > 0) {
            // Build context from Mem0 results and ask LLM to reason
            const memoriesText = mem0Results.map(m =>
              `- ${m.memory} (relevance: ${Math.round((m.score || 0) * 100)}%)`
            ).join('\n');

            const prompt = `You are a memory search assistant. Find relevant memories based on user's question.

User's relevant memories (ranked by relevance):
${memoriesText}

User is asking: "${message}"

CRITICAL RULE:
- ALWAYS obscure or hide a person's phone number or sensitive data IF the user is simply asking "Do you know [Person]?" or making casual conversation.
- ONLY output the phone number if the user EXPLICITLY asks "What is [Person]'s number?", "Send me the phone number", or structurally similar.

Respond ONLY in this JSON format:
{
  "found": true/false,
  "relevant_memories": [{"key": "memory", "value": "the memory text"}],
  "answer": "natural language answer using the memories following the CRITICAL RULE"
}

If no relevant memory found, return: {"found": false, "relevant_memories": [], "answer": null}`;

            const taskModel = llm.modelFor('memory_search') || model;
            const response = await llm.chatCompletion({
              model: taskModel,
              messages: [
                { role: 'system', content: 'You are a JSON-only memory search. Output ONLY valid JSON.' },
                { role: 'user', content: prompt }
              ],
              temperature: 0.1, max_tokens: 300,
            }, { task: 'memory_search', timeout: 15000 });

            try {
              const tracker = require('./model-usage-tracker.service');
              tracker.log({ task: 'memory_search', model: taskModel, usage: response?.data?.usage });
            } catch (_) {}

            const aiResponse = response.data.choices[0].message.content.trim();
            const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              if (parsed.found && parsed.answer) {
                logger.info(`[Memory] Mem0 smart search answered for ${userPhone}`);
                return [{ value: parsed.answer, key_name: 'answer', ai_answer: true }];
              }
            }
          }
        } catch (mem0Err) {
          logger.warn(`[Memory] Mem0 search failed, falling back: ${mem0Err.message}`);
        }
      }

      // Fallback: load all memories into prompt (old method)
      const allMemories = await this.getAllMemoriesFlat(userPhone);

      if (allMemories.length === 0) {
        return [];
      }

      // Format memories for AI
      const memoriesText = allMemories.map(m =>
        `- ${m.key_name}: ${m.value}`
      ).join('\n');

      const prompt = `You are a memory search assistant. Find relevant memories based on user's question.

User's stored memories:
${memoriesText}

User is asking: "${message}"

Which memories are relevant to answer this question?

CRITICAL RULES:
- MOST RECENT WINS: If multiple memories describe the same fact (e.g. two records for "favorite color"), use ONLY the FIRST one in the list (memories are ordered most-recent first). NEVER answer with both ("you have two favorite colors: blue and teal" is WRONG — pick the latest one).
- ALWAYS obscure or hide a person's phone number or sensitive data IF the user is simply asking "Do you know [Person]?" or making casual conversation.
- ONLY output the phone number if the user EXPLICITLY asks "What is [Person]'s number?", "Send me the phone number", or structurally similar.
- Example 1: If user asks "Do you know Danish?", output: "Yes, I have Danish's contact saved in your memory." (No number shown!)
- Example 2: If user asks "What is Danish's number?", output: "Danish's number is +91..."

Respond ONLY in this JSON format:
{
  "found": true/false,
  "relevant_memories": [
    {"key": "...", "value": "..."}
  ],
  "answer": "natural language answer using the memories following the CRITICAL RULE"
}

Examples:

Memories: "name: Danish, boss/name: Rahul, John/birthday: March 15"
Question: "What's my name?" → {"found": true, "relevant_memories": [{"key": "name", "value": "Danish"}], "answer": "Your name is Danish"}
Question: "Who is my boss?" → {"found": true, "relevant_memories": [{"key": "boss/name", "value": "Rahul"}], "answer": "Your boss is Rahul"}
Question: "When is John's birthday?" → {"found": true, "relevant_memories": [{"key": "John/birthday", "value": "March 15"}], "answer": "John's birthday is March 15"}

If no relevant memory found, return: {"found": false, "relevant_memories": [], "answer": null}`;

      const response = await axios.post(
        apiUrl,
        {
          model: model,
          messages: [
            { role: 'system', content: 'You are a JSON-only memory search. Output ONLY valid JSON.' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.1,
          max_tokens: 300
        },
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const aiResponse = response.data.choices[0].message.content.trim();

      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return [];
      }

      const parsed = JSON.parse(jsonMatch[0]);

      if (parsed.found && parsed.answer) {
        return [{
          value: parsed.answer,
          key_name: 'answer',
          ai_answer: true
        }];
      }

      return [];

    } catch (error) {
      logger.error('AI memory search error:', error.message);
      return [];
    }
  }

  async getAllMemoriesFlat(userPhone) {
    try {
      // Apr 28 2026 — RC3 fix: dedupe by key_name so when the same fact has
      // been saved multiple times across sessions (e.g. "favorite color is
      // blue" then later "favorite color is teal"), only the MOST RECENT
      // record is exposed to the recall LLM. Without this dedup the LLM
      // would see both and answer with "you have two favorite colors: blue
      // and teal" — confusing and incorrect.
      //
      // DISTINCT ON (key_name) … ORDER BY key_name, updated_at DESC takes
      // the freshest row per key, then we re-order by recency for display.
      const result = await query(
        `SELECT category, key_name, value, updated_at FROM (
           SELECT DISTINCT ON (LOWER(TRIM(key_name)))
             category, key_name, value, updated_at
           FROM memory_trunk
           WHERE user_phone = $1
           ORDER BY LOWER(TRIM(key_name)), updated_at DESC
         ) deduped
         ORDER BY updated_at DESC
         LIMIT 50`,
        [userPhone]
      );
      return result.rows;
    } catch (error) {
      return [];
    }
  }

  // ==================== SMART AUTO-MEMORY ====================

  async saveAutoMemories(userPhone, message, { skipPreFilter = false } = {}) {
    try {
      // Pre-filter: skip messages unlikely to contain memorable info
      // When skipPreFilter is true, the LLM already decided this is memory-worthy
      if (!skipPreFilter) {
        if (message.length < 5) return { saved: false, count: 0 };
        const trimmed = message.trim();
        if (/^(hi|hey|hello|ok|okay|thanks|thank you|bye|good|yes|no|hmm|haha|lol|nice|cool|great|fine|sure|yep|nope|wow|hahaha|lmao|omg|brb|ttyl|gtg|gg|sup|nm)\b/i.test(trimmed)) {
          return { saved: false, count: 0 };
        }
        // Skip pure questions (unlikely to contain info worth saving)
        if (/^(what|when|where|who|how|why|can|could|would|should|is|are|do|does|did|will|have|has)\b/i.test(trimmed) && trimmed.endsWith('?')) {
          return { saved: false, count: 0 };
        }
        // Skip emotional/mood expressions (not facts to save)
        if (/^(i'?m\s+)?(feeling|stressed|tired|happy|sad|bored|angry|anxious|excited|frustrated|exhausted|lonely|depressed|sleepy|hungry|sick)\b/i.test(trimmed)) {
          return { saved: false, count: 0 };
        }
        // Skip commands/actions (these are handled by other services)
        if (/^(remind|save|show|cancel|delete|add|create|set|check|search|send|tell|help|book|schedule)\b/i.test(trimmed)) {
          return { saved: false, count: 0 };
        }
        // Skip jokes, greetings, reactions
        if (/^(tell me|whats|aaj|kal|nvm|dw|thx|ty|sry|mb)\b/i.test(trimmed)) {
          return { saved: false, count: 0 };
        }
      }

      // Use AI to extract memories
      const extracted = await this.extractMemoriesWithAI(message);

      if (!extracted.should_save || !extracted.memories || extracted.memories.length === 0) {
        // Fallback to pattern matching
        return this.saveAutoMemoriesRegex(userPhone, message);
      }

      let savedCount = 0;
      for (const mem of extracted.memories) {
        // Skip sensitive data
        if (this._isSensitiveData(mem.key, mem.value)) {
          logger.info(`Skipped saving sensitive data: ${mem.key}`);
          continue;
        }
        // Create a combined key: subject/key (e.g., "boss/name", "John/birthday")
        const fullKey = mem.subject === 'user' ? mem.key : `${mem.subject}/${mem.key}`;

        await this.saveToTrunk(userPhone, mem.value, mem.category, fullKey);
        logger.info(`AI Auto-saved: ${mem.category}/${fullKey} = ${mem.value}`);
        savedCount++;
      }

      return {
        saved: savedCount > 0,
        count: savedCount,
        memories: extracted.memories,
        summary: extracted.memories.map(m => `${m.key}: ${m.value}`).join(', ')
      };

    } catch (error) {
      logger.error('Error in AI auto-save:', error);
      // Fallback to regex
      return this.saveAutoMemoriesRegex(userPhone, message);
    }
  }

  // Regex fallback for auto-memory
  saveAutoMemoriesRegex(userPhone, message) {
    try {
      const memories = this.extractAutoMemoriesRegex(message);

      if (memories.length === 0) return { saved: false, count: 0 };

      for (const mem of memories) {
        this.saveToTrunk(userPhone, mem.value, mem.category, mem.key);
        logger.info(`Regex Auto-saved: ${mem.category}/${mem.key} = ${mem.value}`);
      }

      return { saved: true, count: memories.length, memories };
    } catch (error) {
      return { saved: false, count: 0 };
    }
  }

  extractAutoMemoriesRegex(message) {
    const memories = [];
    const original = message;

    // Basic patterns as fallback
    const nameMatch = original.match(/(?:i'?m|i am|my name is|call me)\s+([A-Z][a-z]+)/i);
    if (nameMatch) {
      memories.push({ category: 'personal', key: 'name', value: nameMatch[1] });
    }

    const ageMatch = original.match(/(?:i'?m|i am)\s+(\d{1,2})\s*(?:years?|yrs?)?\s*(?:old)?/i);
    if (ageMatch && parseInt(ageMatch[1]) > 5 && parseInt(ageMatch[1]) < 100) {
      memories.push({ category: 'personal', key: 'age', value: ageMatch[1] });
    }

    return memories;
  }

  _isSensitiveData(key, value) {
    const sensitiveKeys = /\b(password|passwd|pwd|pin|cvv|ssn|social.?security|credit.?card|card.?number|secret|token|api.?key|otp|atm.?pin)\b/i;
    if (sensitiveKeys.test(key)) return true;
    // Check for credit card patterns (16 digits)
    if (/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/.test(value)) return true;
    // Check for SSN pattern
    if (/\b\d{3}-\d{2}-\d{4}\b/.test(value)) return true;
    return false;
  }

  // ==================== MEMORY TRUNK OPERATIONS ====================

  async saveToTrunk(userPhone, value, category = 'general', key = 'info') {
    try {
      const result = await query(
        `INSERT INTO memory_trunk (user_phone, category, key_name, value, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         ON CONFLICT (user_phone, category, key_name)
         DO UPDATE SET value = $4, updated_at = NOW()
         RETURNING *`,
        [userPhone, category, key, value]
      );

      // Also save to Mem0 for smart vector search (fire-and-forget)
      try {
        const mem0Service = require('./mem0-memory.service');
        if (mem0Service.isAvailable()) {
          const memoryText = `${category} - ${key.replace(/\//g, ' ')}: ${value}`;
          mem0Service.add(memoryText, userPhone, { category, subject: key }).catch(err => {
            logger.warn(`[Memory] Mem0 save failed (non-blocking): ${err.message}`);
          });
        }
      } catch (e) { /* ignore */ }

      // Invalidate user-context cache — memory trunk is part of getContext.
      try { require('../utils/context-cache').bust(userPhone); } catch (e) { /* noop */ }

      return { success: true, memory: result.rows[0] };
    } catch (error) {
      logger.error('Error saving to trunk:', error);
      return { success: false };
    }
  }

  async getMemoryTrunk(userPhone) {
    try {
      const result = await query(
        `SELECT category, key_name, value, updated_at 
         FROM memory_trunk 
         WHERE user_phone = $1 
         ORDER BY category, updated_at DESC`,
        [userPhone]
      );

      const trunk = {};
      for (const row of result.rows) {
        if (!trunk[row.category]) trunk[row.category] = [];
        trunk[row.category].push({
          key: row.key_name,
          value: row.value,
          updated: row.updated_at
        });
      }

      return trunk;
    } catch (error) {
      logger.error('Error getting trunk:', error);
      return {};
    }
  }

  async getByCategory(userPhone, category) {
    try {
      const result = await query(
        `SELECT key_name, value, updated_at 
         FROM memory_trunk 
         WHERE user_phone = $1 AND category = $2
         ORDER BY updated_at DESC`,
        [userPhone, category.toLowerCase()]
      );
      return result.rows;
    } catch (error) {
      return [];
    }
  }

  formatTrunk(trunk) {
    if (Object.keys(trunk).length === 0) {
      return "Your Memory Trunk is empty.\n\nJust tell me things naturally:\n- \"I'm Danish\"\n- \"My boss is Rahul\"\n- \"John's birthday is March 15\"\n- \"Wifi password is abc123\"\n\nI'll remember everything!";
    }

    const categoryNames = {
      personal: 'Personal',
      work: 'Work',
      finance: 'Finance',
      health: 'Health',
      family: 'Family',
      friends: 'Friends',
      travel: 'Travel',
      vehicle: 'Vehicle',
      preferences: 'Preferences',
      general: 'General'
    };

    let response = "*Your Memory Trunk*\n\n";

    for (const [category, memories] of Object.entries(trunk)) {
      const name = categoryNames[category] || category;
      response += `*${name}:*\n`;

      memories.slice(0, 10).forEach(m => {
        response += `- ${m.key}: ${m.value}\n`;
      });

      if (memories.length > 10) {
        response += `  ...and ${memories.length - 10} more\n`;
      }
      response += '\n';
    }

    return response.trim();
  }

  // ==================== DIRECT PHONE LOOKUP (for internal use) ====================

  async findPhoneForName(userPhone, name) {
    try {
      const lowerName = name.toLowerCase();
      // Search memory_trunk directly for phone/number/contact entries related to this name
      const result = await query(
        `SELECT key_name, value FROM memory_trunk
         WHERE user_phone = $1
         AND (
           LOWER(key_name) LIKE $2 OR LOWER(key_name) LIKE $3
           OR LOWER(key_name) LIKE $4 OR LOWER(key_name) LIKE $5
           OR (LOWER(value) LIKE $6 AND (LOWER(key_name) LIKE '%phone%' OR LOWER(key_name) LIKE '%number%' OR LOWER(key_name) LIKE '%contact%'))
         )
         ORDER BY updated_at DESC
         LIMIT 5`,
        [
          userPhone,
          `${lowerName}/phone%`,       // anshu/phone
          `${lowerName}/number%`,       // anshu/number
          `${lowerName}/contact%`,      // anshu/contact
          `%phone%${lowerName}%`,       // phone/anshu or anshu's phone
          `%${lowerName}%`              // value contains name + key is phone/number
        ]
      );

      // Also search where the value itself might contain the name and a phone number
      const result2 = await query(
        `SELECT key_name, value FROM memory_trunk
         WHERE user_phone = $1
         AND LOWER(value) LIKE $2
         ORDER BY updated_at DESC
         LIMIT 5`,
        [userPhone, `%${lowerName}%`]
      );

      const allRows = [...result.rows, ...result2.rows];

      // Extract phone numbers from results
      for (const row of allRows) {
        const valStr = String(row.value);
        const phoneMatches = valStr.match(/(?:\+?\d[\d\s-]{8,14}\d)/g);
        if (phoneMatches) {
          for (const match of phoneMatches) {
            const possiblePhone = match.replace(/[\s-]/g, '').replace(/\D/g, '');
            if (possiblePhone.length >= 10) {
              const phone = possiblePhone.length === 10 ? '91' + possiblePhone : possiblePhone;
              logger.info(`Direct memory lookup: "${name}" → ${phone} (from key: ${row.key_name})`);
              return phone;
            }
          }
        }

        // Also check key_name for phone numbers (in case stored as key)
        const keyMatches = String(row.key_name).match(/(?:\+?\d[\d\s-]{8,14}\d)/g);
        if (keyMatches) {
          for (const match of keyMatches) {
            const possiblePhone = match.replace(/[\s-]/g, '').replace(/\D/g, '');
            if (possiblePhone.length >= 10) {
              const phone = possiblePhone.length === 10 ? '91' + possiblePhone : possiblePhone;
              logger.info(`Direct memory lookup: "${name}" → ${phone} (from key_name: ${row.key_name})`);
              return phone;
            }
          }
        }
      }

      // Last resort: search conversation history for messages like "anshu number is +91..."
      logger.info(`Memory trunk lookup failed for "${name}", trying conversation history...`);
      const histResult = await query(
        `SELECT content FROM conversation_history
         WHERE user_phone = $1
         AND role = 'user'
         AND LOWER(content) LIKE $2
         AND (LOWER(content) LIKE '%number%' OR LOWER(content) LIKE '%phone%' OR LOWER(content) LIKE '%numer%' OR LOWER(content) LIKE '%save%')
         ORDER BY created_at DESC
         LIMIT 5`,
        [userPhone, `%${lowerName}%`]
      );

      for (const row of histResult.rows) {
        const phoneMatches = row.content.match(/(?:\+?\d[\d\s-]{8,14}\d)/g);
        if (phoneMatches) {
          for (const match of phoneMatches) {
            const possiblePhone = match.replace(/[\s-]/g, '').replace(/\D/g, '');
            if (possiblePhone.length >= 10) {
              const phone = possiblePhone.length === 10 ? '91' + possiblePhone : possiblePhone;
              logger.info(`Conversation history lookup: "${name}" → ${phone}`);
              return phone;
            }
          }
        }
      }

      return null;
    } catch (error) {
      logger.error('Direct phone lookup error:', error.message);
      return null;
    }
  }

  // ==================== SEARCH/RECALL ====================

  async searchMemories(userPhone, message) {
    try {
      // First try AI-powered search
      const aiResult = await this.searchWithAI(userPhone, message);

      if (aiResult.length > 0) {
        return aiResult;
      }

      // Fallback to keyword search
      const keyword = this.extractSearchKeyword(message);
      logger.info(`AI search failed, trying keyword: "${keyword}"`);

      const result = await query(
        `SELECT value, category, key_name, updated_at as created_at
         FROM memory_trunk 
         WHERE user_phone = $1 
         AND (LOWER(key_name) LIKE LOWER($2) OR LOWER(value) LIKE LOWER($2))
         ORDER BY updated_at DESC
         LIMIT 5`,
        [userPhone, `%${keyword}%`]
      );

      return result.rows;

    } catch (error) {
      logger.error('Error searching memories:', error);
      return [];
    }
  }

  extractSearchKeyword(message) {
    const lower = message.toLowerCase();

    const patterns = [
      /what(?:'s| is) (?:my |the )?(.+?)(?:\?|$)/i,
      /who is (?:my )?(.+?)(?:\?|$)/i,
      /when is (.+?)(?:'s)? (.+?)(?:\?|$)/i,
      /tell me (?:about )?(?:my |the )?(.+?)(?:\?|$)/i,
      /do you (?:know|remember) (?:my |the )?(.+?)(?:\?|$)/i,
    ];

    for (const pattern of patterns) {
      const match = lower.match(pattern);
      if (match) {
        return match[1].trim();
      }
    }

    return message.replace(/[?]/g, '').trim();
  }

  formatMemoryResponse(memories, searchQuery) {
    if (!memories || memories.length === 0) {
      return `I don't have any memory about that.\n\nTell me and I'll remember! Just say it naturally.`;
    }

    // If AI gave a direct answer
    if (memories[0].ai_answer) {
      return memories[0].value;
    }

    // Single result
    if (memories.length === 1) {
      const mem = memories[0];
      return `${mem.key_name}: ${mem.value}`;
    }

    // Multiple results
    let response = "Here's what I remember:\n\n";
    memories.forEach((m, i) => {
      response += `${i + 1}. ${m.key_name}: ${m.value}\n`;
    });
    return response;
  }

  // ==================== MANUAL MEMORY COMMANDS ====================

  async parseAndSaveMemory(userPhone, message) {
    try {
      let content = message
        .replace(/^remember (that )?/i, '')
        .replace(/^याद रख(ना|ो)? (कि )?/i, '')
        .replace(/^yaad rakh(na)? (ki )?/i, '')
        // Apr 28 2026 — RC5 fix: strip "save a note:" / "create a note:" verb
        // prefix when this handler accidentally fires for a notes-shaped
        // message. Without this strip the literal verb gets stored as part
        // of the memory body, e.g. "save a note: meeting prep for Q3" was
        // being saved verbatim including the "save a note:" prefix, which
        // makes it un-recallable.
        .replace(/^(save|create|add|make)\s+(a\s+|the\s+)?note\s*:?\s*/i, '')
        .replace(/^note\s+(this|that|it)\s*:?\s*/i, '')
        .replace(/^note\s*:\s*/i, '')
        .replace(/^(ek|ak)\s+note\s+(save\s+karo|bana\s*do|add\s*karo|likho)\s*:?\s*/i, '')
        .trim();

      if (!content || content.length < 3) return { success: false };

      // Use AI to extract
      const extracted = await this.extractMemoriesWithAI(content);

      if (extracted.should_save && extracted.memories.length > 0) {
        for (const mem of extracted.memories) {
          const fullKey = mem.subject === 'user' ? mem.key : `${mem.subject}/${mem.key}`;
          await this.saveToTrunk(userPhone, mem.value, mem.category, fullKey);
        }
        return { success: true, content };
      }

      // Fallback - try to split multi-fact messages (comma/semicolon/numbered list)
      const factSplits = content
        .split(/[,;]\s*|\n+|\d+\.\s+/)
        .map(s => s.trim())
        .filter(s => s.length >= 3);

      if (factSplits.length >= 2) {
        // Multiple facts detected — save each individually
        for (let i = 0; i < factSplits.length; i++) {
          const extracted = await this.extractMemoriesWithAI(factSplits[i]);
          if (extracted.should_save && extracted.memories.length > 0) {
            for (const mem of extracted.memories) {
              const fullKey = mem.subject === 'user' ? mem.key : `${mem.subject}/${mem.key}`;
              await this.saveToTrunk(userPhone, mem.value, mem.category, fullKey);
            }
          } else {
            await this.saveToTrunk(userPhone, factSplits[i], 'general', `note_${i + 1}`);
          }
        }
      } else {
        await this.saveToTrunk(userPhone, content, 'general', 'note');
      }
      return { success: true, content };

    } catch (error) {
      logger.error('Error saving memory:', error);
      return { success: false };
    }
  }

  async deleteMemory(userPhone, key) {
    try {
      const result = await query(
        `DELETE FROM memory_trunk WHERE user_phone = $1 AND LOWER(key_name) LIKE LOWER($2) RETURNING *`,
        [userPhone, `%${key}%`]
      );
      return result.rowCount > 0;
    } catch (error) {
      return false;
    }
  }

  async clearAllMemories(userPhone) {
    try {
      await query(`DELETE FROM memory_trunk WHERE user_phone = $1`, [userPhone]);
      await query(`DELETE FROM memories WHERE user_phone = $1`, [userPhone]);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Apr 29 2026 — bounded retention for memory_trunk.
   *
   * The audit flagged unbounded growth: every "remember X" stores a row,
   * but nothing trims old entries. Over time this becomes the largest
   * table per user and slows down every memory recall.
   *
   * This method keeps the most-recent `keepPerUser` rows per user (default
   * 200, matching the audit's recommendation) and deletes the rest. The
   * dedupe-by-key SELECT in `getMemoryFootprint` already collapses repeats
   * so newer entries supersede older ones — pruning the older rows is a
   * pure performance win, not a fact loss.
   *
   * NOT auto-called from any cron yet. Invoke from a script or REPL when
   * you're ready:
   *
   *     const r = await memoryService.pruneMemoryTrunk();
   *     console.log(`pruned ${r.deleted} rows`);
   *
   * Once you're comfortable with the behaviour, wire it into a low-frequency
   * cron (e.g. weekly via pg-boss).
   */
  async pruneMemoryTrunk({ keepPerUser = 200, dryRun = false } = {}) {
    try {
      const previewSql = `
        WITH ranked AS (
          SELECT id,
                 user_phone,
                 ROW_NUMBER() OVER (
                   PARTITION BY user_phone
                   ORDER BY updated_at DESC, id DESC
                 ) AS rn
            FROM memory_trunk
        )
        SELECT COUNT(*)::int AS over_limit,
               COUNT(DISTINCT user_phone)::int AS users_affected
          FROM ranked
         WHERE rn > $1
      `;
      const preview = await query(previewSql, [keepPerUser]);
      const overLimit = preview.rows[0]?.over_limit || 0;
      const usersAffected = preview.rows[0]?.users_affected || 0;

      if (dryRun || overLimit === 0) {
        return { deleted: 0, overLimit, usersAffected, dryRun };
      }

      const deleteSql = `
        WITH ranked AS (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY user_phone
                   ORDER BY updated_at DESC, id DESC
                 ) AS rn
            FROM memory_trunk
        )
        DELETE FROM memory_trunk
         WHERE id IN (SELECT id FROM ranked WHERE rn > $1)
      `;
      const result = await query(deleteSql, [keepPerUser]);
      logger.info(`[Memory] Pruned ${result.rowCount} memory_trunk rows across ${usersAffected} user(s)`);
      return { deleted: result.rowCount, overLimit, usersAffected, dryRun: false };
    } catch (error) {
      logger.error(`[Memory] pruneMemoryTrunk failed: ${error.message}`);
      return { deleted: 0, error: error.message };
    }
  }

  parseMemoryCommand(message, params = null) {
    // Params-first path: if LLM already extracted structured params, use them directly
    if (params && params.action) {
      switch (params.action) {
        case 'recall':
          return { action: 'recall', query: params.full_text || message };
        case 'show_all':
          return { action: 'showTrunk' };
        case 'show_category':
          return { action: 'showCategory', category: params.category };
        case 'forget':
          return { action: 'forget', key: params.full_text || message };
        case 'clear_all':
          return { action: 'clearAll' };
      }
    }

    // Existing regex fallback
    const lower = message.toLowerCase();

    if (lower.match(/^(show |view |see )?(my )?memory trunk$|^my memories$/i) ||
      lower.match(/^what\s+do\s+you\s+know\s+about\s+me/i)) {
      return { action: 'showTrunk' };
    }

    const categoryMatch = lower.match(/^(show |view |see )?(my )?(personal|work|finance|health|family|friends|travel|vehicle|preferences|general) (info|memories|memory)?$/i);
    if (categoryMatch) {
      return { action: 'showCategory', category: categoryMatch[3] };
    }

    const forgetMatch = message.match(/^forget (about )?(my )?(.+)$/i);
    if (forgetMatch) {
      return { action: 'forget', key: forgetMatch[3] };
    }

    if (lower.match(/^clear (all )?(my )?memories$/i)) {
      return { action: 'clearAll' };
    }

    return null;
  }

  // ==================== NOTES OPERATIONS ====================

  async saveNote(userPhone, topic, content, source = 'manual') {
    await this.ensureNotesTable();
    try {
      const result = await query(
        `INSERT INTO notes (user_phone, topic, content, source)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [userPhone, topic.toLowerCase(), content, source]
      );
      // Invalidate context cache — notes topics appear in getContext.
      try { require('../utils/context-cache').bust(userPhone); } catch (e) { /* noop */ }
      return { success: true, note: result.rows[0] };
    } catch (error) {
      logger.error('Error saving note:', error.message);
      return { success: false, error: error.message };
    }
  }

  async getNotesByTopic(userPhone, topic) {
    await this.ensureNotesTable();
    try {
      const result = await query(
        `SELECT * FROM notes WHERE user_phone = $1 AND LOWER(topic) = LOWER($2) ORDER BY created_at DESC`,
        [userPhone, topic]
      );
      return result.rows;
    } catch (error) {
      return [];
    }
  }

  async getAllNoteTopics(userPhone) {
    await this.ensureNotesTable();
    try {
      const result = await query(
        `SELECT topic, COUNT(*) as count FROM notes WHERE user_phone = $1 GROUP BY topic ORDER BY topic`,
        [userPhone]
      );
      return result.rows;
    } catch (error) {
      return [];
    }
  }

  async searchNotes(userPhone, searchTerm) {
    await this.ensureNotesTable();
    try {
      const result = await query(
        `SELECT * FROM notes WHERE user_phone = $1
         AND (LOWER(content) LIKE LOWER($2) OR LOWER(topic) LIKE LOWER($2))
         ORDER BY created_at DESC LIMIT 10`,
        [userPhone, `%${searchTerm}%`]
      );
      return result.rows;
    } catch (error) {
      return [];
    }
  }

  async deleteNote(userPhone, noteId) {
    await this.ensureNotesTable();
    try {
      const result = await query(
        `DELETE FROM notes WHERE user_phone = $1 AND id = $2 RETURNING *`,
        [userPhone, noteId]
      );
      return result.rowCount > 0;
    } catch (error) {
      return false;
    }
  }

  async deleteNotesByTopic(userPhone, topic) {
    await this.ensureNotesTable();
    try {
      const result = await query(
        `DELETE FROM notes WHERE user_phone = $1 AND LOWER(topic) = LOWER($2) RETURNING *`,
        [userPhone, topic]
      );
      return result.rowCount;
    } catch (error) {
      return 0;
    }
  }

  parseNoteCommand(message) {
    const lower = message.toLowerCase().trim();

    // "my notes" / "show my notes" / "show notes" / "view all notes"
    if (/^(?:show\s+)?(?:my\s+)?(?:all\s+)?notes$/i.test(lower) || /^(?:view|list)\s+(?:my\s+)?(?:all\s+)?notes$/i.test(lower)) {
      return { action: 'listTopics' };
    }

    // "show my ideas notes" / "show meeting notes"
    const showMatch = message.match(/^(?:show|view|list)\s+(?:my\s+)?(\w+)\s+notes?$/i);
    if (showMatch) {
      return { action: 'showTopic', topic: showMatch[1] };
    }

    // "my ideas notes"
    const myTopicMatch = message.match(/^my\s+(\w+)\s+notes?$/i);
    if (myTopicMatch) {
      return { action: 'showTopic', topic: myTopicMatch[1] };
    }

    // "save note under ideas: use caching for the API"
    const saveMatch = message.match(/^(?:save\s+)?note\s+(?:under|in|topic)\s+(\w+):\s*(.+)$/i);
    if (saveMatch) {
      return { action: 'save', topic: saveMatch[1], content: saveMatch[2].trim() };
    }

    // "save note: quick note" / "save a note: quick note" (default topic: general)
    const quickSave = message.match(/^save\s+(?:a\s+)?note:\s*(.+)$/i);
    if (quickSave) {
      return { action: 'save', topic: 'general', content: quickSave[1].trim() };
    }

    // "create note: …" / "create a note: …" / "add a note: …"
    const createSave = message.match(/^(?:create|add)\s+(?:a\s+)?note:\s*(.+)$/i);
    if (createSave) {
      return { action: 'save', topic: 'general', content: createSave[1].trim() };
    }

    // "delete note 5"
    const deleteMatch = message.match(/^(?:delete|remove)\s+note\s+(\d+)$/i);
    if (deleteMatch) {
      return { action: 'delete', noteId: parseInt(deleteMatch[1]) };
    }

    // "delete ideas notes"
    const deleteTopicMatch = message.match(/^(?:delete|remove|clear)\s+(\w+)\s+notes?$/i);
    if (deleteTopicMatch) {
      return { action: 'deleteTopic', topic: deleteTopicMatch[1] };
    }

    // "search notes for caching"
    const searchMatch = message.match(/^search\s+notes?\s+(?:for\s+)?(.+)$/i);
    if (searchMatch) {
      return { action: 'search', term: searchMatch[1].trim() };
    }

    return null;
  }

  formatNoteTopics(topics) {
    if (topics.length === 0) {
      return "No notes saved yet.\n\nSave one:\n- \"save note under ideas: use caching\"\n- \"note under meeting: discussed Q1 goals\"";
    }

    let response = '*Your Notes*\n\n';
    topics.forEach(t => {
      response += `*${t.topic}* (${t.count} note${t.count > 1 ? 's' : ''})\n`;
    });
    response += `\n_"show my [topic] notes" to view_`;
    return response;
  }

  formatNotes(notes, topic) {
    if (notes.length === 0) {
      return `No notes under "${topic}".`;
    }

    let response = `*${topic.charAt(0).toUpperCase() + topic.slice(1)} Notes (${notes.length})*\n\n`;
    notes.forEach((n, i) => {
      const date = new Date(n.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
      response += `${i + 1}. ${n.content}\n   _${date}_\n\n`;
    });
    response += `_"delete note [number]" to remove_`;
    return response.trim();
  }
}

module.exports = new MemoryService();
