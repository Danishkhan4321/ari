const { query } = require('../config/database');
const logger = require('../utils/logger');
const axios = require('axios');
const crypto = require('crypto');
const { localFileStorage } = require('./local-file-storage.service');

// Initialize Supabase inline
let supabase = null;
let BUCKET_NAME = 'user-files';

try {
  const { createClient } = require('@supabase/supabase-js');
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
  BUCKET_NAME = process.env.SUPABASE_BUCKET || 'user-files';

  if (SUPABASE_URL && SUPABASE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    logger.info('Supabase storage initialized for files');
  }
} catch (e) {
  logger.warn('Supabase not available for file storage');
}

const llm = require('./llm-provider');

class FileService {

  constructor(options = {}) {
    this.apiKey = llm.apiKey();
    this.apiUrl = llm.chatUrl();
    // Kept for callers that still need to hit the raw OpenAI audio/transcription
    // endpoint, which has no Gemini-compat equivalent.
    this.openaiApiKey = process.env.OPENAI_API_KEY;
    this.model = llm.fastModel();
    this.queryFn = options.queryFn || query;
    this.supabase = options.supabase === undefined ? supabase : options.supabase;
    this.localFileStorage = options.localFileStorage || localFileStorage;
  }

  // ========== ENSURE SCHEMA ==========
  async ensureFilesSchema() {
    try {
      await this.queryFn(`
        CREATE TABLE IF NOT EXISTS user_files (
          id SERIAL PRIMARY KEY,
          user_phone VARCHAR(20) NOT NULL,
          file_url TEXT NOT NULL,
          file_type VARCHAR(20) NOT NULL,
          mime_type VARCHAR(100),
          file_name VARCHAR(255),
          description TEXT,
          context TEXT,
          extracted_text TEXT,
          document_type VARCHAR(50),
          document_name VARCHAR(255),
          keywords TEXT[],
          local_path TEXT,
          size_bytes BIGINT,
          content_sha256 CHAR(64),
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Rolling-deploy compatibility for databases created before migration
      // 30. The migration remains the source of truth; IF NOT EXISTS keeps
      // this safe while old and new app instances overlap.
      await this.queryFn(`
        ALTER TABLE user_files
          ADD COLUMN IF NOT EXISTS local_path TEXT,
          ADD COLUMN IF NOT EXISTS size_bytes BIGINT,
          ADD COLUMN IF NOT EXISTS content_sha256 CHAR(64)
      `);
      await this.queryFn(`CREATE INDEX IF NOT EXISTS idx_user_files_phone ON user_files(user_phone)`);
      await this.queryFn(`CREATE INDEX IF NOT EXISTS idx_user_files_type ON user_files(file_type)`);
      
      return true;
    } catch (error) {
      logger.error('Schema error:', error.message);
      return false;
    }
  }

  // ========== DETECT FILE TYPE ==========
  detectFileType(mimeType, url = '') {
    if (!mimeType) {
      // Try to detect from URL
      const ext = url.split('.').pop()?.toLowerCase();
      if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return 'image';
      if (ext === 'pdf') return 'pdf';
      if (['doc', 'docx'].includes(ext)) return 'document';
      if (['xls', 'xlsx'].includes(ext)) return 'spreadsheet';
      return 'other';
    }

    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType === 'application/pdf') return 'pdf';
    if (mimeType.includes('word') || mimeType.includes('document')) return 'document';
    if (mimeType.includes('sheet') || mimeType.includes('excel')) return 'spreadsheet';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.startsWith('video/')) return 'video';
    return 'other';
  }

  // ========== ANALYZE IMAGE WITH VISION API ==========
  async analyzeImage(imageUrl, userMessage = '') {
    try {
      if (!this.openaiApiKey) {
        logger.warn('OpenAI API key not set');
        return this.basicAnalysis(userMessage, 'image');
      }

      logger.info('Analyzing image with GPT-4 Vision...');

      // FIX: was referencing undeclared `OPENAI_API_URL` — used `this.apiUrl`
      // which is initialized from `llm.chatUrl()` in the constructor.
      // This call path was throwing ReferenceError before this fix.
      const response = await axios.post(
        this.apiUrl,
        {
          model: process.env.OPENAI_FAST_MODEL || 'gpt-4.1-mini',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `Analyze this image thoroughly and extract ALL relevant information.

Return a JSON object:
{
  "document_type": "bill" | "ticket" | "receipt" | "id_card" | "screenshot" | "photo" | "menu" | "certificate" | "other",
  "document_name": "specific name (e.g., 'Dominos Pizza Bill', 'Indian Railways Ticket to Mumbai')",
  "description": "detailed description",
  "extracted_text": "ALL visible text - names, numbers, dates, amounts, addresses",
  "context": "what this is and its purpose",
  "keywords": ["keyword1", "keyword2", ...] // 10-15 searchable keywords
}

Extract everything: restaurant names, ticket numbers, dates, amounts, destinations, company names, etc.
User said: "${userMessage || 'uploaded this image'}"`
                },
                {
                  type: 'image_url',
                  image_url: { url: imageUrl }
                }
              ]
            }
          ],
          max_tokens: 1500
        },
        {
          headers: {
            'Authorization': `Bearer ${this.openaiApiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      const content = response.data.choices[0].message.content;
      logger.info('Image analysis received');

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        logger.info(`Parsed: type=${parsed.document_type}, name=${parsed.document_name}`);
        return parsed;
      }

      return this.basicAnalysis(content, 'image');

    } catch (error) {
      logger.error('Vision API error:', error.response?.data || error.message);
      return this.basicAnalysis(userMessage, 'image');
    }
  }

  // ========== ANALYZE PDF ==========
  async analyzePdf(pdfUrl, userMessage = '') {
    try {
      // For PDFs, we'll extract what we can from the filename and user context
      // Full PDF text extraction would require additional libraries
      
      const fileName = pdfUrl.split('/').pop() || 'document.pdf';
      
      // Try to use AI to understand from filename and context
      const response = await axios.post(
        this.apiUrl,
        {
          model: this.model,
          messages: [
            {
              role: 'system',
              content: 'Analyze the PDF filename and context to understand what this document might be. Output JSON only.'
            },
            {
              role: 'user',
              content: `PDF filename: "${fileName}"
User context: "${userMessage || 'uploaded a PDF'}"

Return JSON:
{
  "document_type": "invoice" | "receipt" | "ticket" | "report" | "form" | "certificate" | "contract" | "other",
  "document_name": "best guess of document name",
  "description": "what this PDF likely contains",
  "context": "likely purpose",
  "keywords": ["keyword1", "keyword2", ...]
}`
            }
          ],
          temperature: 0.1,
          max_tokens: 300
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const content = response.data.choices[0].message.content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }

      return this.basicAnalysis(userMessage, 'pdf');

    } catch (error) {
      logger.error('PDF analysis error:', error.message);
      return this.basicAnalysis(userMessage, 'pdf');
    }
  }

  basicAnalysis(userMessage, fileType) {
    const keywords = this.extractKeywords(userMessage);
    return {
      document_type: fileType,
      document_name: null,
      description: userMessage || `${fileType} uploaded`,
      extracted_text: '',
      context: userMessage,
      keywords
    };
  }

  extractKeywords(text) {
    if (!text) return [];
    
    const words = text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);
    
    const stopWords = ['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'was', 'one', 'has', 'have', 'this', 'that', 'with', 'from', 'will', 'would', 'there', 'their', 'what', 'about', 'which', 'when', 'make', 'like', 'just'];
    
    return [...new Set(words.filter(w => !stopWords.includes(w)))].slice(0, 15);
  }

  // ========== SAVE FILE (Image, PDF, etc) ==========
  async saveFile(userPhone, fileUrl, mimeType, userMessage = '') {
    try {
      await this.ensureFilesSchema();

      const fileType = this.detectFileType(mimeType, fileUrl);
      logger.info(`Saving ${fileType} for ${userPhone}`);

      // Analyze based on file type
      let analysis;
      if (fileType === 'image') {
        analysis = await this.analyzeImage(fileUrl, userMessage);
      } else if (fileType === 'pdf') {
        analysis = await this.analyzePdf(fileUrl, userMessage);
      } else {
        analysis = this.basicAnalysis(userMessage, fileType);
      }

      logger.info(`Analysis complete: ${analysis.document_type} - ${analysis.document_name || 'unnamed'}`);

      // Upload to Supabase for permanent storage
      let permanentUrl = fileUrl;

      if (supabase) {
        try {
          // SSRF protection: validate URL before downloading
          const { isSafeUrl } = require('../utils/security');
          if (!isSafeUrl(fileUrl)) {
            logger.warn(`Blocked unsafe file URL: ${fileUrl}`);
            return { success: false, error: 'URL not allowed' };
          }

          const response = await axios.get(fileUrl, {
            responseType: 'arraybuffer',
            timeout: 30000,
            maxContentLength: 25 * 1024 * 1024
          });
          
          const buffer = Buffer.from(response.data);
          const ext = fileType === 'pdf' ? 'pdf' : 'jpg';
          const fileName = `${userPhone}/${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;

          const { error } = await supabase.storage
            .from(BUCKET_NAME)
            .upload(fileName, buffer, { 
              contentType: mimeType || (fileType === 'pdf' ? 'application/pdf' : 'image/jpeg')
            });

          if (!error) {
            const { data: urlData } = supabase.storage.from(BUCKET_NAME).getPublicUrl(fileName);
            permanentUrl = urlData.publicUrl;
            logger.info('File uploaded to Supabase');
          } else {
            logger.error('Supabase upload error:', error.message);
          }
        } catch (uploadError) {
          logger.error('Upload error:', uploadError.message);
        }
      }

      // Save to database
      const result = await query(
        `INSERT INTO user_files (
          user_phone, file_url, file_type, mime_type, file_name,
          description, context, extracted_text, document_type, document_name, keywords, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
        RETURNING *`,
        [
          userPhone,
          permanentUrl,
          fileType,
          mimeType,
          analysis.document_name,
          analysis.description,
          analysis.context,
          analysis.extracted_text || '',
          analysis.document_type,
          analysis.document_name,
          analysis.keywords || []
        ]
      );

      logger.info(`File saved: ID=${result.rows[0].id}`);

      return {
        success: true,
        fileId: result.rows[0].id,
        fileType,
        analysis
      };

    } catch (error) {
      logger.error('Error saving file:', error);
      return { success: false, error: error.message };
    }
  }

  // Save a file that we already downloaded (e.g., WhatsApp media that requires auth)
  async saveUploadedBuffer(userPhone, buffer, mimeType, originalFileName = '', userMessage = '') {
    let localStored = null;
    let storagePath = null;
    try {
      // Validate file size (25MB max)
      const MAX_FILE_SIZE = 25 * 1024 * 1024;
      if (buffer.length > MAX_FILE_SIZE) {
        return { success: false, error: `File too large (${Math.round(buffer.length / 1024 / 1024)}MB). Max 25MB.` };
      }

      await this.ensureFilesSchema();

      const fileType = this.detectFileType(mimeType, originalFileName);
      logger.info(`Saving uploaded buffer (${fileType}, ${Math.round(buffer.length / 1024)}KB) for ${userPhone}`);

      // Upload buffer to Supabase for permanent storage (preferred)
      let permanentUrl = null;

      if (this.supabase) {
        try {
          const safeExt =
            (mimeType === 'application/pdf' ? 'pdf' :
              (originalFileName.split('.').pop()?.toLowerCase() || 'bin'));
          const fileName = `${userPhone}/${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${safeExt}`;
          const bucket = this.supabase.storage.from(BUCKET_NAME);
          const { error } = await bucket.upload(
            fileName,
            buffer,
            { contentType: mimeType || 'application/octet-stream' },
          );

          if (error) {
            logger.error('Supabase upload error:', error.message);
          } else {
            const { data: urlData } = bucket.getPublicUrl(fileName);
            if (urlData?.publicUrl) {
              storagePath = fileName;
              permanentUrl = urlData.publicUrl;
              logger.info('File uploaded to Supabase');
            }
          }
        } catch (error) {
          // Storage is an optimization, not a durability requirement. A
          // transient SDK/network failure must still reach the confined local
          // fallback below.
          logger.error('Supabase upload error:', error.message);
        }
      }

      // Never leave a fake `buffer:local` pointer behind. When object storage
      // is unavailable, persist the bytes under the shared, confined Ari
      // attachment root so user_file:<id> remains analyzable after a restart.
      if (!permanentUrl) {
        localStored = await this.localFileStorage.store({
          userPhone,
          buffer,
          fileName: originalFileName,
        });
      }

      // Analyze (PDF text extraction supported; image buffer analysis not implemented here)
      let analysis;
      if (fileType === 'pdf') {
        analysis = await this.analyzePdfBuffer(buffer, originalFileName, userMessage);
      } else {
        analysis = this.basicAnalysis(userMessage, fileType);
        analysis.document_name = originalFileName || analysis.document_name;
      }

      const result = await this.queryFn(
        `INSERT INTO user_files (
          user_phone, file_url, file_type, mime_type, file_name,
          description, context, extracted_text, document_type, document_name, keywords,
          local_path, size_bytes, content_sha256, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
        RETURNING *`,
        [
          userPhone,
          permanentUrl || 'ari-local://stored',
          fileType,
          mimeType,
          originalFileName || analysis.document_name,
          analysis.description,
          analysis.context,
          analysis.extracted_text || '',
          analysis.document_type,
          analysis.document_name || originalFileName || null,
          analysis.keywords || [],
          localStored?.localPath || null,
          localStored?.sizeBytes || buffer.length,
          localStored?.sha256 || crypto.createHash('sha256').update(buffer).digest('hex')
        ]
      );

      return {
        success: true,
        fileId: result.rows[0].id,
        artifactId: `user_file:${result.rows[0].id}`,
        fileType,
        analysis,
      };
    } catch (error) {
      if (localStored?.localPath) {
        await this.localFileStorage.remove(localStored.localPath).catch(() => {});
      }
      if (storagePath && this.supabase) {
        await this.supabase.storage
          .from(BUCKET_NAME)
          .remove([storagePath])
          .catch(() => {});
      }
      logger.error('Error saving uploaded buffer:', error);
      return { success: false, error: error.message };
    }
  }

  async analyzePdfBuffer(buffer, fileName = 'document.pdf', userMessage = '') {
    // Try real text extraction if pdf-parse is available; otherwise fall back.
    let extractedText = '';
    try {
      // eslint-disable-next-line global-require
      const pdfParse = require('pdf-parse');
      const parsed = await pdfParse(buffer);
      extractedText = (parsed.text || '').trim();
      logger.info(`PDF text extracted (${Math.round(extractedText.length / 1000)}k chars)`);
    } catch (e) {
      logger.warn(`PDF text extraction unavailable: ${e.message}`);
    }

    // Scanned-PDF fallback: if pdf-parse returned near-nothing, try Marker OCR.
    // This catches photographed utility bills, receipts, scanned contracts, etc.
    // Marker preserves table structure, which matters for due-date/amount extraction.
    try {
      const ocrService = require('./ocr.service');
      if (ocrService.shouldFallback(extractedText)) {
        logger.info(`PDF appears to be scanned (${extractedText.length} chars) — attempting Marker OCR`);
        const ocrText = await ocrService.extractFromPdf(buffer, fileName);
        if (ocrText && ocrText.length > extractedText.length) {
          extractedText = ocrText;
          logger.info(`OCR: recovered ${Math.round(ocrText.length / 1000)}k chars of text via Marker`);
        }
      }
    } catch (e) {
      // Never let OCR break the existing flow — the LLM step runs either way.
      logger.warn(`OCR fallback error (non-fatal): ${e.message}`);
    }

    // Use Groq to summarize + name using extracted text (if any) + user context + filename
    try {
      const taskModel = llm.modelFor('pdf_analyze') || this.model;
      const response = await llm.chatCompletion(
        {
          model: taskModel,
          messages: [
            { role: 'system', content: 'You analyze documents and output ONLY JSON.' },
            {
              role: 'user',
              content: `Filename: "${fileName}"
User context: "${userMessage || ''}"
Extracted text (may be empty):
${extractedText.slice(0, 6000)}

Return JSON:
{
  "document_type": "invoice" | "receipt" | "ticket" | "report" | "form" | "certificate" | "contract" | "other",
  "document_name": "short human name",
  "description": "1-2 line description",
  "context": "what this is for",
  "extracted_text": "short key text if relevant (optional)",
  "keywords": ["up to 12 keywords"]
}`
            }
          ],
          temperature: 0.1,
          max_tokens: 350,
        },
        { task: 'pdf_analyze', timeout: 20000 }
      );
      try { require('./model-usage-tracker.service').log({ task: 'pdf_analyze', model: taskModel, usage: response?.data?.usage }); } catch (_) {}

      const content = response.data.choices[0].message.content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          document_type: parsed.document_type || 'pdf',
          document_name: parsed.document_name || fileName,
          description: parsed.description || userMessage || fileName,
          context: parsed.context || userMessage,
          extracted_text: extractedText,
          keywords: parsed.keywords || []
        };
      }
    } catch (error) {
      logger.error('PDF buffer analysis error:', error.message);
    }

    // Fallback
    const basic = this.basicAnalysis(userMessage, 'pdf');
    basic.document_name = fileName;
    basic.extracted_text = extractedText;
    return basic;
  }

  // ========== SEARCH FILES ==========
  async searchFiles(userPhone, searchQuery, fileType = null) {
    try {
      await this.ensureFilesSchema();

      logger.info(`Searching files: "${searchQuery}" (type: ${fileType || 'all'})`);

      const searchIntent = await this.parseSearchIntent(searchQuery);
      const searchTerms = this.buildSearchTerms(searchQuery, searchIntent);

      let queryText = `
        SELECT *, 
          (
            CASE WHEN document_name ILIKE $2 THEN 100 ELSE 0 END +
            CASE WHEN document_type ILIKE $3 THEN 50 ELSE 0 END +
            CASE WHEN description ILIKE $2 THEN 30 ELSE 0 END +
            CASE WHEN context ILIKE $2 THEN 20 ELSE 0 END +
            CASE WHEN extracted_text ILIKE $2 THEN 40 ELSE 0 END +
            CASE WHEN $4 = ANY(keywords) THEN 60 ELSE 0 END +
            CASE WHEN $5 = ANY(keywords) THEN 60 ELSE 0 END
          ) as relevance_score
        FROM user_files 
        WHERE user_phone = $1
        AND (
          document_name ILIKE $2
          OR document_type ILIKE $3
          OR description ILIKE $2
          OR context ILIKE $2
          OR extracted_text ILIKE $2
          OR $4 = ANY(keywords)
          OR $5 = ANY(keywords)
        )`;

      const params = [
        userPhone,
        `%${searchTerms.primary}%`,
        `%${searchIntent.document_type || searchTerms.primary}%`,
        searchTerms.keywords[0] || '',
        searchTerms.keywords[1] || ''
      ];

      if (fileType) {
        queryText += ` AND file_type = $6`;
        params.push(fileType);
      }

      queryText += ` ORDER BY relevance_score DESC, created_at DESC LIMIT 10`;

      const result = await query(queryText, params);

      if (result.rows.length === 0) {
        // Broader search
        const broadResult = await query(
          `SELECT * FROM user_files 
           WHERE user_phone = $1
           AND (description ILIKE $2 OR context ILIKE $2 OR document_type ILIKE $2)
           ${fileType ? 'AND file_type = $3' : ''}
           ORDER BY created_at DESC LIMIT 10`,
          fileType ? [userPhone, `%${searchTerms.primary}%`, fileType] : [userPhone, `%${searchTerms.primary}%`]
        );
        return broadResult.rows;
      }

      return result.rows;

    } catch (error) {
      logger.error('Search error:', error);
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
            {
              role: 'system',
              content: 'Extract search intent. Output ONLY JSON.'
            },
            {
              role: 'user',
              content: `User searching for a file: "${searchQuery}"

Return JSON:
{
  "document_type": "bill" | "ticket" | "receipt" | "pdf" | "photo" | "screenshot" | null,
  "looking_for": "what they want",
  "keywords": ["keyword1", "keyword2", "keyword3"]
}`
            }
          ],
          temperature: 0.1,
          max_tokens: 200
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const content = response.data.choices[0].message.content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch (error) {
      logger.error('Intent parse error:', error.message);
    }

    return {
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

    const filtered = [...new Set(keywords)]
      .filter(k => !['the', 'that', 'this', 'you', 'sent', 'show', 'give', 'remember', 'earlier', 'ago', 'days', 'image', 'photo', 'file', 'can', 'please'].includes(k));

    return {
      primary: intent.looking_for || searchQuery,
      keywords: filtered.slice(0, 5)
    };
  }

  // ========== HELPER METHODS ==========
  async findFileByDescription(userPhone, description) {
    const files = await this.searchFiles(userPhone, description);
    return files.length > 0 ? files[0] : null;
  }

  async getUserFiles(userPhone, limit = 10, fileType = null) {
    try {
      let queryText = `SELECT * FROM user_files WHERE user_phone = $1`;
      const params = [userPhone];

      if (fileType) {
        queryText += ` AND file_type = $2`;
        params.push(fileType);
      }

      const limitIdx = params.length + 1;
      queryText += ` ORDER BY created_at DESC LIMIT $${limitIdx}`;
      params.push(parseInt(limit, 10) || 10);

      const result = await query(queryText, params);
      return result.rows;
    } catch (error) {
      return [];
    }
  }

  async getFilesByType(userPhone, documentType) {
    try {
      const result = await query(
        `SELECT * FROM user_files WHERE user_phone = $1 AND document_type = $2 ORDER BY created_at DESC LIMIT 10`,
        [userPhone, documentType]
      );
      return result.rows;
    } catch (error) {
      return [];
    }
  }

  async deleteFile(userPhone, fileId) {
    try {
      const result = await this.queryFn(
        `DELETE FROM user_files WHERE id = $1 AND user_phone = $2 RETURNING *`,
        [fileId, userPhone]
      );
      if (result.rows[0]?.local_path) {
        await this.localFileStorage.remove(result.rows[0].local_path).catch((error) => {
          logger.warn(`Could not remove local file ${fileId}: ${error.message}`);
        });
      }
      return result.rows.length > 0;
    } catch (error) {
      return false;
    }
  }

  // For backward compatibility with image.service.js calls
  async saveImage(userPhone, imageUrl, userMessage = '') {
    return this.saveFile(userPhone, imageUrl, 'image/jpeg', userMessage);
  }

  async searchImages(userPhone, searchQuery) {
    return this.searchFiles(userPhone, searchQuery, 'image');
  }

  async findImageByDescription(userPhone, description) {
    return this.findFileByDescription(userPhone, description);
  }

  async getUserImages(userPhone, limit = 10) {
    return this.getUserFiles(userPhone, limit, 'image');
  }
}

module.exports = new FileService();
module.exports.FileService = FileService;
