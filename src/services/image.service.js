const { query } = require('../config/database');
const logger = require('../utils/logger');
const axios = require('axios');
const crypto = require('crypto');
const llm = require('./llm-provider');

// Initialize Supabase inline
let supabase = null;
let BUCKET_NAME = 'user-images';

try {
  const { createClient } = require('@supabase/supabase-js');
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
  BUCKET_NAME = process.env.SUPABASE_BUCKET || 'user-images';

  if (SUPABASE_URL && SUPABASE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    logger.info('Supabase storage initialized');
  }
} catch (e) {
  logger.warn('Supabase not available, images will use original URLs');
}

const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB max image size

// Valid image categories
const CATEGORIES = [
  'Restaurant Receipt', 'Travel Ticket', 'Event Ticket', 'Invoice',
  'Bill', 'ID Document', 'Screenshot', 'Photo', 'Document', 'Other'
];

class ImageService {

  constructor() {
    this.apiKey = llm.apiKey();
    this.apiUrl = llm.chatUrl();
    // Vision uses the same active provider (Gemini Flash supports vision via OpenAI-compat).
    this.visionApiKey = llm.apiKey();
    this.model = llm.fastModel();
    this.schemaReady = false;
  }

  // ========== ENSURE SCHEMA ==========
  async ensureImagesSchema() {
    if (this.schemaReady) return true;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS user_images (
          id SERIAL PRIMARY KEY,
          user_phone VARCHAR(20) NOT NULL,
          image_url TEXT NOT NULL,
          title VARCHAR(255),
          category VARCHAR(50),
          description TEXT,
          context TEXT,
          extracted_text TEXT,
          key_details TEXT,
          document_type VARCHAR(50),
          document_name VARCHAR(255),
          keywords TEXT[],
          saved_at_local VARCHAR(50),
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Add columns if they don't exist (for existing tables)
      await query(`ALTER TABLE user_images ADD COLUMN IF NOT EXISTS title VARCHAR(255)`);
      await query(`ALTER TABLE user_images ADD COLUMN IF NOT EXISTS category VARCHAR(50)`);
      await query(`ALTER TABLE user_images ADD COLUMN IF NOT EXISTS key_details TEXT`);
      await query(`ALTER TABLE user_images ADD COLUMN IF NOT EXISTS saved_at_local VARCHAR(50)`);
      await query(`ALTER TABLE user_images ADD COLUMN IF NOT EXISTS context TEXT`);
      await query(`ALTER TABLE user_images ADD COLUMN IF NOT EXISTS extracted_text TEXT`);
      await query(`ALTER TABLE user_images ADD COLUMN IF NOT EXISTS document_type VARCHAR(50)`);
      await query(`ALTER TABLE user_images ADD COLUMN IF NOT EXISTS document_name VARCHAR(255)`);
      await query(`ALTER TABLE user_images ADD COLUMN IF NOT EXISTS keywords TEXT[]`);

      await query(`CREATE INDEX IF NOT EXISTS idx_user_images_phone ON user_images(user_phone)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_user_images_category ON user_images(category)`);

      this.schemaReady = true;
      return true;
    } catch (error) {
      logger.error('Schema error:', error.message);
      return false;
    }
  }

  // ========== ANALYZE IMAGE — STRUCTURED OUTPUT ==========
  async analyzeImage(imageUrl, userCaption = '') {
    try {
      if (!this.visionApiKey) {
        logger.warn('No LLM API key set, using basic analysis');
        return this.basicAnalysis(userCaption);
      }

      const taskModel = llm.modelFor('image_analyze') || llm.fastModel();
      const response = await llm.chatCompletion(
        {
          model: taskModel,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `Analyze this image and extract structured information.

Return ONLY a JSON object:
{
  "category": one of: "Restaurant Receipt", "Travel Ticket", "Event Ticket", "Invoice", "Bill", "ID Document", "Screenshot", "Photo", "Document", "Other",
  "auto_title": "a short, descriptive title (e.g. 'Dominos Pizza Receipt', 'Delhi-Mumbai Rajdhani Ticket', 'Airtel Broadband Bill')",
  "description": "1-2 sentence summary of what the image shows",
  "key_details": {
    // Include ONLY fields that are actually visible/applicable:
    "merchant": "name if visible",
    "event": "event name if applicable",
    "route": "origin-destination if travel",
    "date": "date shown on document if any",
    "time": "time shown if any",
    "amount": "total amount if visible",
    "currency": "INR/USD/etc if visible",
    "reference": "PNR/booking ID/invoice number/order ID if visible",
    "passenger": "passenger/customer name if visible",
    "seat": "seat number if applicable",
    "venue": "venue/location if applicable",
    "operator": "airline/railway/bus operator if applicable",
    "items": "key items listed (brief) if applicable"
  },
  "tags": ["tag1", "tag2", ...],  // 8-12 searchable tags: merchant, city, type, amounts, reference numbers, names, dates
  "extracted_text": "important text verbatim from the image (numbers, IDs, names, amounts)",
  "needs_clarification": null or "a short question if critical info is missing for correct categorization"
}

Rules:
- Only include key_details fields that are actually present in the image
- Tags should include: merchant/event name, city/location, category keywords, amounts, reference numbers, dates
- Be thorough with reference numbers, PNR, booking IDs — these are critical for later recall
- If the user provided a caption, use it for additional context
${userCaption ? `\nUser caption: "${userCaption}"` : ''}`
                },
                {
                  type: 'image_url',
                  image_url: { url: imageUrl }
                }
              ]
            }
          ],
          max_tokens: 1000,
        },
        { task: 'image_analyze', timeout: 20000 }
      );
      try { require('./model-usage-tracker.service').log({ task: 'image_analyze', model: taskModel, usage: response?.data?.usage }); } catch (_) {}

      const content = response.data.choices[0].message.content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        // Normalize category
        if (parsed.category && !CATEGORIES.includes(parsed.category)) {
          parsed.category = this.mapCategory(parsed.category);
        }
        return parsed;
      }

      return this.basicAnalysis(userCaption);

    } catch (error) {
      logger.error('Vision API error:', error.message);
      return this.basicAnalysis(userCaption);
    }
  }

  mapCategory(raw) {
    const lower = (raw || '').toLowerCase();
    if (lower.includes('receipt') || lower.includes('restaurant')) return 'Restaurant Receipt';
    if (lower.includes('travel') || lower.includes('train') || lower.includes('flight') || lower.includes('bus') || lower.includes('boarding')) return 'Travel Ticket';
    if (lower.includes('ticket') || lower.includes('event') || lower.includes('concert') || lower.includes('movie')) return 'Event Ticket';
    if (lower.includes('invoice')) return 'Invoice';
    if (lower.includes('bill')) return 'Bill';
    if (lower.includes('id') || lower.includes('aadhaar') || lower.includes('passport') || lower.includes('license')) return 'ID Document';
    if (lower.includes('screenshot')) return 'Screenshot';
    if (lower.includes('document') || lower.includes('pdf')) return 'Document';
    if (lower.includes('photo')) return 'Photo';
    return 'Other';
  }

  basicAnalysis(userCaption) {
    return {
      category: 'Other',
      auto_title: userCaption || 'Untitled Image',
      description: userCaption || 'Image uploaded',
      key_details: {},
      tags: this.extractKeywords(userCaption),
      extracted_text: '',
      needs_clarification: null
    };
  }

  extractKeywords(text) {
    if (!text) return [];
    const words = text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);
    const stopWords = ['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'was', 'one', 'has', 'have', 'been', 'this', 'that', 'with', 'from', 'they', 'will', 'would', 'there', 'their', 'what', 'about', 'which', 'when', 'make', 'like', 'just', 'over', 'into', 'other', 'than', 'then', 'some', 'could', 'them', 'these', 'also', 'image', 'photo', 'picture', 'save', 'show', 'send'];
    const filtered = words.filter(w => !stopWords.includes(w));
    return [...new Set(filtered)].slice(0, 15);
  }

  // ========== PROCESS IMAGE FROM WHATSAPP (analyze only, don't save) ==========
  async processImage(mediaId, caption = '') {
    try {
      const messagingService = require('./messaging.service');

      // Download image from platform
      const mediaUrl = await messagingService.getMediaUrl('wa_temp', mediaId);
      const imageBuffer = await messagingService.downloadMedia('wa_temp', mediaUrl);

      // Validate file size
      if (imageBuffer.length > MAX_IMAGE_SIZE) {
        return { success: false, error: `Image too large (${Math.round(imageBuffer.length / 1024 / 1024)}MB). Max ${MAX_IMAGE_SIZE / 1024 / 1024}MB.` };
      }

      // Upload to Supabase for permanent URL
      let permanentUrl = null;
      if (supabase) {
        const fileName = `temp/${Date.now()}_${crypto.randomBytes(4).toString('hex')}.jpg`;
        const { error } = await supabase.storage
          .from(BUCKET_NAME)
          .upload(fileName, imageBuffer, { contentType: 'image/jpeg' });

        if (!error) {
          const { data: urlData } = supabase.storage.from(BUCKET_NAME).getPublicUrl(fileName);
          permanentUrl = urlData.publicUrl;
        }
      }

      if (!permanentUrl) {
        return { success: false, error: 'Could not upload image' };
      }

      // Analyze with Vision API — structured output
      const analysis = await this.analyzeImage(permanentUrl, caption);

      // Build user-facing message with structured summary
      let message = '';
      if (analysis.category && analysis.category !== 'Other') {
        message += `*${analysis.category}*\n`;
      }
      if (analysis.auto_title) {
        message += `${analysis.auto_title}\n\n`;
      }
      if (analysis.description) {
        message += `${analysis.description}\n`;
      }

      // Show key details (only non-empty ones)
      const details = analysis.key_details || {};
      const detailLines = [];
      if (details.merchant) detailLines.push(`Merchant: ${details.merchant}`);
      if (details.event) detailLines.push(`Event: ${details.event}`);
      if (details.operator) detailLines.push(`Operator: ${details.operator}`);
      if (details.route) detailLines.push(`Route: ${details.route}`);
      if (details.date) detailLines.push(`Date: ${details.date}`);
      if (details.amount) detailLines.push(`Amount: ${details.currency || ''} ${details.amount}`.trim());
      if (details.reference) detailLines.push(`Ref: ${details.reference}`);
      if (details.passenger) detailLines.push(`Passenger: ${details.passenger}`);
      if (details.seat) detailLines.push(`Seat: ${details.seat}`);
      if (details.venue) detailLines.push(`Venue: ${details.venue}`);

      if (detailLines.length > 0) {
        message += '\n' + detailLines.join('\n');
      }

      message += '\n\nReply *"save"* to keep this image.';

      return {
        success: true,
        analysis,
        imageUrl: permanentUrl,
        message,
        // For the follow-up context
        title: caption || analysis.auto_title || null,
        category: analysis.category || 'Other',
        tags: (analysis.tags || []).join(', '),
        keyDetails: analysis.key_details || {},
        needsClarification: analysis.needs_clarification || null
      };

    } catch (error) {
      logger.error('processImage error:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ========== SAVE IMAGE — STRUCTURED RECORD ==========
  async saveStructuredImage(userPhone, imageUrl, record, userTimezone = 'Asia/Kolkata') {
    try {
      await this.ensureImagesSchema();

      const now = new Date();
      const savedAtLocal = now.toLocaleString('en-IN', {
        timeZone: userTimezone,
        day: 'numeric', month: 'short', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true
      });

      const keyDetailsStr = record.keyDetails
        ? JSON.stringify(record.keyDetails)
        : null;

      const tags = record.tags || [];

      const result = await query(
        `INSERT INTO user_images (
          user_phone, image_url, title, category, description, context,
          extracted_text, key_details, document_type, document_name,
          keywords, saved_at_local, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
        RETURNING *`,
        [
          userPhone,
          imageUrl,
          record.title || record.autoTitle || 'Untitled',
          record.category || 'Other',
          record.description || '',
          record.context || record.description || '',
          record.extractedText || '',
          keyDetailsStr,
          record.category || 'Other',
          record.title || record.autoTitle || null,
          tags,
          savedAtLocal
        ]
      );

      logger.info(`Image saved: ID=${result.rows[0].id}, category=${record.category}`);

      return {
        success: true,
        imageId: result.rows[0].id,
        title: record.title || record.autoTitle,
        category: record.category,
        savedAt: savedAtLocal
      };

    } catch (error) {
      logger.error('Error saving structured image:', error);
      return { success: false };
    }
  }

  // ========== LEGACY saveImage (for backward compat) ==========
  async saveImage(userPhone, imageUrl, userMessage = '') {
    const analysis = typeof userMessage === 'object'
      ? userMessage
      : await this.analyzeImage(imageUrl, userMessage);

    return this.saveStructuredImage(userPhone, imageUrl, {
      title: analysis.title || analysis.auto_title || analysis.document_name,
      category: analysis.category || analysis.document_type || 'Other',
      description: analysis.description || analysis.full || '',
      extractedText: analysis.extracted_text || '',
      keyDetails: analysis.key_details || {},
      tags: analysis.tags || analysis.keywords || [],
      autoTitle: analysis.auto_title
    });
  }

  // ========== FORMAT IMAGES LIST (Title + Date + Category) ==========
  formatImagesList(images) {
    if (!images || images.length === 0) return 'No saved images found.';

    let response = `*Saved Images (${images.length})*\n\n`;
    images.forEach((img, i) => {
      const title = img.title || img.document_name || 'Untitled';
      const category = img.category || img.document_type || '';
      const date = img.saved_at_local || new Date(img.created_at).toLocaleDateString('en-IN', {
        day: 'numeric', month: 'short'
      });
      response += `${i + 1}. *${title}*`;
      if (category) response += ` [${category}]`;
      response += `\n   ${date}\n\n`;
    });
    response += `_Reply with a number to view_`;
    return response;
  }

  // ========== FORMAT SINGLE IMAGE SUMMARY ==========
  formatImageSummary(img) {
    const title = img.title || img.document_name || 'Untitled';
    const category = img.category || img.document_type || '';
    const date = img.saved_at_local || new Date(img.created_at).toLocaleDateString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric'
    });

    let summary = `*${title}*`;
    if (category) summary += ` [${category}]`;
    summary += `\nSaved: ${date}`;

    // Parse and show key details if available
    if (img.key_details) {
      try {
        const details = typeof img.key_details === 'string'
          ? JSON.parse(img.key_details)
          : img.key_details;
        const lines = [];
        if (details.merchant) lines.push(`Merchant: ${details.merchant}`);
        if (details.amount) lines.push(`Amount: ${details.currency || ''} ${details.amount}`.trim());
        if (details.reference) lines.push(`Ref: ${details.reference}`);
        if (details.route) lines.push(`Route: ${details.route}`);
        if (details.date) lines.push(`Date: ${details.date}`);
        if (details.operator) lines.push(`Operator: ${details.operator}`);
        if (lines.length > 0) summary += '\n' + lines.join('\n');
      } catch (e) {}
    }

    return summary;
  }

  // ========== SMART SEARCH FOR IMAGES ==========
  async searchImages(userPhone, searchQuery) {
    try {
      await this.ensureImagesSchema();

      logger.info(`Searching images for "${searchQuery}"`);

      const searchIntent = await this.parseSearchIntent(searchQuery);
      const searchTerms = this.buildSearchTerms(searchQuery, searchIntent);

      logger.info(`Search terms: ${JSON.stringify(searchTerms)}`);

      // If all search terms are generic noise (e.g., "share the saved image again"),
      // return the most recent saved images instead of searching by keyword
      if (searchTerms.allNoise && !searchIntent.category && !searchIntent.document_type) {
        logger.info('Generic image request — returning most recent images');
        const recentResult = await query(
          `SELECT * FROM user_images WHERE user_phone = $1 ORDER BY created_at DESC LIMIT 5`,
          [userPhone]
        );
        return recentResult.rows;
      }

      const result = await query(
        `SELECT *,
          (
            CASE WHEN title ILIKE $2 THEN 100 ELSE 0 END +
            CASE WHEN category ILIKE $3 THEN 50 ELSE 0 END +
            CASE WHEN document_name ILIKE $2 THEN 80 ELSE 0 END +
            CASE WHEN description ILIKE $2 THEN 30 ELSE 0 END +
            CASE WHEN key_details ILIKE $2 THEN 40 ELSE 0 END +
            CASE WHEN extracted_text ILIKE $2 THEN 40 ELSE 0 END +
            CASE WHEN $4 = ANY(keywords) THEN 60 ELSE 0 END
          ) as relevance_score
        FROM user_images
        WHERE user_phone = $1
        AND (
          title ILIKE $2
          OR document_name ILIKE $2
          OR category ILIKE $3
          OR description ILIKE $2
          OR key_details ILIKE $2
          OR extracted_text ILIKE $2
          OR $4 = ANY(keywords)
          OR $5 = ANY(keywords)
          OR $6 = ANY(keywords)
        )
        ORDER BY relevance_score DESC, created_at DESC
        LIMIT 10`,
        [
          userPhone,
          `%${searchTerms.primary}%`,
          `%${searchIntent.document_type || searchIntent.category || ''}%`,
          searchTerms.keywords[0] || '',
          searchTerms.keywords[1] || '',
          searchTerms.keywords[2] || ''
        ]
      );

      if (result.rows.length === 0) {
        // Broader fallback: try category-only or return recent images
        const broadResult = await query(
          `SELECT * FROM user_images
           WHERE user_phone = $1
           AND (
             title ILIKE $2 OR description ILIKE $2
             OR extracted_text ILIKE $2 OR category ILIKE $3
           )
           ORDER BY created_at DESC
           LIMIT 10`,
          [
            userPhone,
            `%${searchTerms.primary}%`,
            `%${searchIntent.document_type || searchIntent.category || searchTerms.primary}%`
          ]
        );

        // If still nothing and we have some search terms, return recent as last resort
        if (broadResult.rows.length === 0) {
          logger.info('No keyword matches — falling back to most recent images');
          const recentFallback = await query(
            `SELECT * FROM user_images WHERE user_phone = $1 ORDER BY created_at DESC LIMIT 5`,
            [userPhone]
          );
          return recentFallback.rows;
        }

        return broadResult.rows;
      }

      return result.rows;

    } catch (error) {
      logger.error('Error searching images:', error);
      return [];
    }
  }

  async parseSearchIntent(searchQuery) {
    try {
      const response = await axios.post(
        this.apiUrl,
        {
          model: this.model,
          messages: [
            { role: 'system', content: 'Extract search intent. Output ONLY valid JSON.' },
            {
              role: 'user',
              content: `User wants to find a saved image: "${searchQuery}"

Return JSON:
{
  "category": one of "Restaurant Receipt" | "Travel Ticket" | "Event Ticket" | "Invoice" | "Bill" | "ID Document" | "Screenshot" | "Photo" | "Document" | null,
  "document_type": same as category (for backward compat),
  "looking_for": "what they want in plain words",
  "keywords": ["keyword1", "keyword2", "keyword3"]
}`
            }
          ],
          temperature: 0.1,
          max_tokens: 200
        },
        {
          headers: llm.headers(),
          timeout: 5000
        }
      );

      const content = response.data.choices[0].message.content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch (error) {
      logger.error('Search intent error:', error.message);
    }

    return {
      category: null,
      document_type: null,
      looking_for: searchQuery,
      keywords: searchQuery.toLowerCase().split(/\s+/).filter(w => w.length > 2)
    };
  }

  buildSearchTerms(searchQuery, intent) {
    const keywords = [
      ...(intent.keywords || []),
      ...searchQuery.toLowerCase().split(/\s+/).filter(w => w.length > 2)
    ];

    const noise = ['the', 'that', 'this', 'you', 'sent', 'show', 'give', 'remember', 'earlier', 'ago', 'days', 'image', 'photo', 'picture', 'can', 'share', 'send', 'again', 'saved', 'find', 'open', 'where', 'from', 'last', 'week', 'about', 'please', 'resend', 'forward', 'back', 'need', 'want', 'get', 'fetch', 'retrieve', 'shared', 'stored', 'uploaded'];
    const uniqueKeywords = [...new Set(keywords)].filter(k => !noise.includes(k));

    return {
      primary: intent.looking_for || searchQuery,
      keywords: uniqueKeywords.slice(0, 5),
      allNoise: uniqueKeywords.length === 0 // Flag when all terms are noise (generic request)
    };
  }

  // ========== HELPER METHODS ==========

  async getUserImages(userPhone, limit = 10) {
    try {
      await this.ensureImagesSchema();
      const result = await query(
        `SELECT * FROM user_images WHERE user_phone = $1 ORDER BY created_at DESC LIMIT $2`,
        [userPhone, limit]
      );
      return result.rows;
    } catch (error) {
      return [];
    }
  }

  async getImagesByCategory(userPhone, category) {
    try {
      const result = await query(
        `SELECT * FROM user_images WHERE user_phone = $1 AND category ILIKE $2 ORDER BY created_at DESC LIMIT 10`,
        [userPhone, `%${category}%`]
      );
      return result.rows;
    } catch (error) {
      return [];
    }
  }

  async getImagesByType(userPhone, documentType) {
    return this.getImagesByCategory(userPhone, documentType);
  }

  async deleteImage(userPhone, imageId) {
    try {
      const result = await query(
        `DELETE FROM user_images WHERE id = $1 AND user_phone = $2 RETURNING *`,
        [imageId, userPhone]
      );
      return result.rows.length > 0;
    } catch (error) {
      return false;
    }
  }

  async deleteImageBySearch(userPhone, searchText) {
    try {
      const matches = await this.searchImages(userPhone, searchText);
      if (matches.length === 1) {
        await this.deleteImage(userPhone, matches[0].id);
        return { success: true, deleted: matches[0] };
      }
      if (matches.length > 1) {
        return { success: false, multiple: true, matches };
      }
      return { success: false, notFound: true };
    } catch (error) {
      return { success: false };
    }
  }

  async findImageByDescription(userPhone, description) {
    const images = await this.searchImages(userPhone, description);
    return images.length > 0 ? images[0] : null;
  }
}

module.exports = new ImageService();
