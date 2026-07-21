/**
 * File analysis — reads the CONTENT of a user's saved attachment by sending
 * it to a provider that can parse files server-side. This closes the "Ari
 * saved your file but can't see inside it" gap without shipping any
 * format-specific parsers: the agent loop calls the analyze_file tool, gets
 * the extracted content back as a tool result, and acts on it with the
 * normal CRM/task/reminder tools.
 *
 * Backends, tried in order until one succeeds:
 *   1. PDFs: OpenRouter Responses with the file-parser plugin. The parsed
 *      document is supplied to the model in the same request.
 *   2. OpenAI Responses API direct file input (xlsx/csv/pdf/docx parsed
 *      server-side; spreadsheets up to ~1,000 rows per sheet).
 *   3. Anthropic code execution (Files API upload + container_upload; the
 *      sandbox has pandas/openpyxl, so any spreadsheet parses).
 * Gemini (our primary chat LLM) rejects xlsx uploads outright, so it is
 * deliberately not a backend here. Uploaded files are deleted from the
 * provider immediately after the analysis call.
 *
 * Env:
 *   OPENROUTER_API_KEY                 - enables PDF file-parser analysis
 *   OPENROUTER_PDF_ENGINE              - cloudflare-ai, mistral-ocr, or native
 *   OPENAI_API_KEY / ANTHROPIC_API_KEY — optional non-PDF/PDF fallbacks
 *   FILE_ANALYSIS_PROVIDER             — optional forced order, e.g. "openrouter"
 *   OPENAI_FILE_ANALYSIS_MODEL         — default 'gpt-4.1-mini'
 *   ANTHROPIC_FILE_ANALYSIS_MODEL      — default 'claude-sonnet-4-6'
 *                                        (code execution needs Sonnet/Opus 4.5+)
 */

'use strict';

const axios = require('axios');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const database = require('../config/database');
const logger = require('../utils/logger');
const { currentChatSession, conversationStateKey } = require('./chat-session-context');
const { phoneCandidates } = require('./contact-group.service');
const { fileArtifactService } = require('./file-artifact.service');

const HTTP_TIMEOUT = 30000;
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
// The agent loop bounds tool-result serialization (~4KB) — keep our answer
// inside that so nothing is silently cut mid-row.
const MAX_RESULT_CHARS = 3600;
const ANTHROPIC_FILES_BETA = 'files-api-2025-04-14';

function buildInstruction(question) {
  return [
    'You are the file-reading step of a CRM assistant. Answer ONLY from the attached file.',
    `Task: ${String(question || 'Summarize the file contents.').trim()}`,
    'For spreadsheets: name every sheet/tab, then list its rows compactly as "Name | Email | Company" style lines (cap ~40 rows per tab, note when truncated).',
    `Keep the whole answer under ${MAX_RESULT_CHARS} characters — compact lines, no prose padding.`,
  ].join('\n');
}

function extractFileAnnotations(value) {
  const found = new Map();
  const seen = new Set();
  function visit(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 12 || seen.has(node)) return;
    seen.add(node);
    if (node.type === 'file' && typeof node.file?.hash === 'string') {
      found.set(node.file.hash, node);
      return;
    }
    for (const child of Array.isArray(node) ? node : Object.values(node)) visit(child, depth + 1);
  }
  visit(value);
  return [...found.values()];
}

function withoutEmbeddedPdf(state, hasReusableAnnotations) {
  if (!hasReusableAnnotations || !state || !Array.isArray(state.messages)) return state;
  const copy = JSON.parse(JSON.stringify(state));
  copy.messages = copy.messages.map((item) => {
    if (!Array.isArray(item?.content)) return item;
    return { ...item, content: item.content.filter((part) => part?.type !== 'input_file') };
  });
  return copy;
}

function createFileAnalysisService(options = {}) {
  const queryFn = options.queryFn || database.query;
  const readFileFn = options.readFileFn || fs.readFile;
  const localFileRoot = options.localFileRoot || process.env.ARI_SESSION_ATTACHMENT_DIR || null;
  const artifactService = options.artifactService || fileArtifactService;
  const httpGet = options.httpGet || ((url) => axios.get(url, {
    responseType: 'arraybuffer',
    timeout: HTTP_TIMEOUT,
    maxContentLength: MAX_DOWNLOAD_BYTES,
  }));
  const openrouterFactory = options.openrouterFactory !== undefined ? options.openrouterFactory : (() => {
    if (!process.env.OPENROUTER_API_KEY) return null;
    return require('./openrouter-agent.service');
  });
  const openaiFactory = options.openaiFactory !== undefined ? options.openaiFactory : (() => {
    if (!process.env.OPENAI_API_KEY) return null;
    const OpenAI = require('openai');
    return new OpenAI({ timeout: 120000 });
  });
  const anthropicFactory = options.anthropicFactory !== undefined ? options.anthropicFactory : (() => {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    const Anthropic = require('@anthropic-ai/sdk');
    return new Anthropic({ timeout: 180000 });
  });

  async function loadParsedPdfState(scopeKey, fileHash) {
    try {
      const result = await queryFn(
        `SELECT state, annotations
           FROM ari_file_analysis_cache
          WHERE scope_key = $1 AND file_hash = $2
          LIMIT 1`,
        [scopeKey, fileHash]
      );
      return result.rows?.[0]?.state || null;
    } catch (error) {
      if (error?.code === '42P01') return null;
      throw error;
    }
  }

  async function saveParsedPdfState({ scopeKey, fileHash, userPhone, sessionId, fileName, state, annotations }) {
    if (!state) return;
    try {
      await queryFn(
        `INSERT INTO ari_file_analysis_cache
           (scope_key, file_hash, user_phone, session_id, file_name, provider, annotations, state, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'openrouter', $6::jsonb, $7::jsonb, NOW(), NOW())
         ON CONFLICT (scope_key, file_hash) DO UPDATE
           SET annotations = EXCLUDED.annotations,
               state = EXCLUDED.state,
               file_name = EXCLUDED.file_name,
               updated_at = NOW()`,
        [scopeKey, fileHash, String(userPhone), sessionId || null, fileName,
          JSON.stringify(annotations || []), JSON.stringify(state)]
      );
    } catch (error) {
      if (error?.code !== '42P01') throw error;
    }
  }

  async function findRecentDocument(userPhone, fileNameHint = null) {
    const candidates = phoneCandidates(userPhone);
    const chatSession = currentChatSession();
    if (chatSession?.sessionId) {
      const params = [candidates, chatSession.sessionId];
      let nameFilter = '';
      if (fileNameHint && String(fileNameHint).trim()) {
        params.push(`%${String(fileNameHint).trim()}%`);
        nameFilter = 'AND file_name ILIKE $3';
      }
      const local = await queryFn(
        `SELECT id, local_path, file_name, mime_type, size_bytes, created_at,
                'session'::text AS artifact_scope
           FROM ari_chat_attachments
          WHERE user_phone = ANY($1) AND session_id = $2 ${nameFilter}
          ORDER BY created_at DESC
          LIMIT 1`,
        params
      );
      if (local.rows[0]) return local.rows[0];
    }
    const params = [candidates];
    let nameFilter = '';
    if (fileNameHint && String(fileNameHint).trim()) {
      params.push(`%${String(fileNameHint).trim()}%`);
      nameFilter = `AND (file_name ILIKE $2 OR document_name ILIKE $2)`;
    }
    const r = await queryFn(
      `SELECT id, file_url, file_name, document_name, mime_type, local_path,
              size_bytes, content_sha256, created_at,
              'user_file'::text AS artifact_scope
         FROM user_files
        WHERE user_phone = ANY($1) AND file_type <> 'image' ${nameFilter}
        ORDER BY created_at DESC
        LIMIT 1`,
      params
    );
    return r.rows[0] || null;
  }

  async function readDocumentBuffer(doc) {
    if (doc.local_path) {
      if (!localFileRoot) throw new Error('local attachment root is not configured');
      const root = path.resolve(localFileRoot);
      const localPath = path.resolve(String(doc.local_path));
      const relative = path.relative(root, localPath);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('local attachment path is outside the session directory');
      }
      return Buffer.from(await readFileFn(localPath));
    }
    const download = await httpGet(doc.file_url);
    return Buffer.from(download.data);
  }

  /**
   * Load the most recent document available to the active chat session.
   * Local attachments pass through readDocumentBuffer's root confinement;
   * callers receive bytes and storage-neutral metadata, never a local path.
   */
  async function loadRecentDocument(userPhone, fileNameHint = null) {
    const doc = await findRecentDocument(userPhone, fileNameHint);
    if (!doc) {
      return {
        error: 'no_document',
        message: fileNameHint
          ? `No saved file matching "${fileNameHint}" found. Attach the file first.`
          : 'No saved file found. Attach the file first.',
      };
    }

    if (doc.artifact_scope) {
      const artifactId = `${doc.artifact_scope}:${String(doc.id)}`;
      const loaded = await artifactService.loadOwnedArtifact(userPhone, artifactId);
      return {
        id: doc.id,
        artifactId: loaded.artifactId,
        buffer: loaded.buffer,
        fileName: loaded.fileName,
        mimeType: loaded.mimeType,
        createdAt: loaded.createdAt,
      };
    }

    return {
      id: doc.id,
      buffer: await readDocumentBuffer(doc),
      fileName: doc.file_name || doc.document_name || 'document',
      mimeType: doc.mime_type || 'application/octet-stream',
      createdAt: doc.created_at,
    };
  }

  async function analyzeViaOpenAI(client, buffer, displayName, mimeType, instruction) {
    let uploadedId = null;
    try {
      const uploaded = await client.files.create({
        file: new File([buffer], displayName, { type: mimeType || 'application/octet-stream' }),
        purpose: 'user_data',
      });
      uploadedId = uploaded.id;
      const response = await client.responses.create({
        model: process.env.OPENAI_FILE_ANALYSIS_MODEL || 'gpt-4.1-mini',
        input: [{
          role: 'user',
          content: [
            { type: 'input_file', file_id: uploadedId },
            { type: 'input_text', text: instruction },
          ],
        }],
      });
      return String(response.output_text || '').trim();
    } finally {
      if (uploadedId) client.files.delete(uploadedId).catch(() => {});
    }
  }

  async function analyzeViaAnthropic(client, buffer, displayName, mimeType, instruction) {
    let uploadedId = null;
    try {
      const uploaded = await client.beta.files.upload({
        file: new File([buffer], displayName, { type: mimeType || 'application/octet-stream' }),
        betas: [ANTHROPIC_FILES_BETA],
      });
      uploadedId = uploaded.id;

      const params = {
        model: process.env.ANTHROPIC_FILE_ANALYSIS_MODEL || 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [
            { type: 'container_upload', file_id: uploadedId },
            { type: 'text', text: instruction },
          ],
        }],
        tools: [{ type: 'code_execution_20260120', name: 'code_execution' }],
      };
      const requestOptions = { headers: { 'anthropic-beta': ANTHROPIC_FILES_BETA } };

      let response = await client.messages.create(params, requestOptions);
      // Server-side tool loops can pause; resume by echoing the assistant turn.
      for (let hop = 0; hop < 4 && response.stop_reason === 'pause_turn'; hop++) {
        params.messages = [...params.messages, { role: 'assistant', content: response.content }];
        response = await client.messages.create(params, requestOptions);
      }

      return response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();
    } finally {
      if (uploadedId) {
        client.beta.files.delete(uploadedId, { betas: [ANTHROPIC_FILES_BETA] }).catch(() => {});
      }
    }
  }

  /**
   * Analyze the user's most recent saved document (or one matched by name).
   * Returns { text, fileName, provider } or { error, message }.
   */
  async function analyzeDocument(userPhone, question, fileNameHint = null, loadedArtifact = null) {
    const forced = String(process.env.FILE_ANALYSIS_PROVIDER || '').toLowerCase();
    const openrouter = openrouterFactory && openrouterFactory();
    const openai = openaiFactory && openaiFactory();
    const anthropic = anthropicFactory && anthropicFactory();

    const doc = loadedArtifact ? {
      id: loadedArtifact.artifactId || null,
      file_name: loadedArtifact.fileName,
      mime_type: loadedArtifact.mimeType,
      created_at: loadedArtifact.createdAt || null,
      artifact_buffer: loadedArtifact.buffer,
      artifact_id: loadedArtifact.artifactId || null,
    } : await findRecentDocument(userPhone, fileNameHint);
    if (!doc) {
      return { error: 'no_document', message: fileNameHint
        ? `No saved file matching "${fileNameHint}" found. Attach the file first.`
        : 'No saved file found. Attach the file first.' };
    }

    const displayName = doc.file_name || doc.document_name || 'document';
    const isPdf = /\.pdf$/i.test(displayName)
      || String(doc.mime_type || '').toLowerCase() === 'application/pdf';
    const available = [];
    if (isPdf && openrouter) available.push(['openrouter', openrouter]);
    if (openai) available.push(['openai', openai]);
    if (anthropic) available.push(['anthropic', anthropic]);
    const backends = forced
      ? [...available.filter(([name]) => name === forced), ...available.filter(([name]) => name !== forced)]
      : available;
    if (backends.length === 0) {
      return {
        error: 'not_configured',
        message: 'File analysis is not configured on this server (no compatible OpenRouter, OpenAI, or Anthropic key).',
      };
    }

    let buffer;
    let resolvedArtifactId = doc.artifact_id || null;
    try {
      if (Buffer.isBuffer(doc.artifact_buffer)) {
        buffer = doc.artifact_buffer;
      } else if (doc.artifact_scope) {
        const loaded = await artifactService.loadOwnedArtifact(
          userPhone,
          `${doc.artifact_scope}:${String(doc.id)}`,
        );
        buffer = loaded.buffer;
        resolvedArtifactId = loaded.artifactId;
      } else {
        buffer = await readDocumentBuffer(doc);
      }
    } catch (error) {
      logger.error(`[FileAnalysis] download of ${displayName} failed: ${error.message}`);
      return { error: 'download_failed', message: `I couldn't retrieve ${displayName} from storage. Try re-attaching it.` };
    }

    const instruction = buildInstruction(question);
    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');
    const chatSession = currentChatSession();
    const scopeKey = String(conversationStateKey(userPhone));
    let lastError = null;
    for (const [provider, client] of backends) {
      try {
        let text;
        if (provider === 'openrouter') {
          const cachedState = await loadParsedPdfState(scopeKey, fileHash);
          const analysis = await client.analyzePdfWithOpenRouter({
            buffer,
            filename: displayName,
            mimeType: doc.mime_type || 'application/pdf',
            instruction,
            state: cachedState,
          });
          text = analysis.text;
          const annotations = extractFileAnnotations([analysis.state, analysis.responseItems]);
          const state = withoutEmbeddedPdf(analysis.state, annotations.length > 0);
          await saveParsedPdfState({
            scopeKey,
            fileHash,
            userPhone,
            sessionId: chatSession?.sessionId || null,
            fileName: displayName,
            state,
            annotations,
          });
        } else if (provider === 'openai') {
          text = await analyzeViaOpenAI(client, buffer, displayName, doc.mime_type, instruction);
        } else {
          text = await analyzeViaAnthropic(client, buffer, displayName, doc.mime_type, instruction);
        }
        if (!text) throw new Error('empty analysis');
        const truncated = text.length > MAX_RESULT_CHARS;
        const bounded = truncated ? `${text.slice(0, MAX_RESULT_CHARS)}\n…[truncated]` : text;
        return {
          text: bounded,
          fileName: displayName,
          mimeType: doc.mime_type || 'application/octet-stream',
          provider,
          artifactId: resolvedArtifactId || (doc.id
            ? `${doc.local_path ? 'session' : 'user_file'}:${String(doc.id)}`
            : null),
          complete: !truncated,
          truncated,
        };
      } catch (error) {
        lastError = error;
        logger.warn(`[FileAnalysis] ${provider} failed for ${displayName}: ${error.status || ''} ${error.message}`);
      }
    }

    logger.error(`[FileAnalysis] all providers failed for ${displayName}: ${lastError?.message}`);
    return { error: 'analysis_failed', message: `I couldn't read ${displayName} (${lastError?.status || lastError?.code || 'error'}). Try re-attaching it, or a CSV/PDF version.` };
  }

  function failureEntry(artifactId, error) {
    const code = String(error?.code || 'analysis_failed');
    const safeMessage = code === 'artifact_not_found'
      ? 'The requested artifact is unavailable.'
      : String(error?.message || 'The artifact could not be analyzed.').slice(0, 500);
    return {
      artifact_id: String(artifactId || ''),
      status: 'failure',
      complete: false,
      error: { code, message: safeMessage },
    };
  }

  /** Analyze stable, tenant-owned artifact IDs in the caller's exact order. */
  async function analyzeArtifacts(userPhone, requestedIds, question, runOptions = {}) {
    const mode = ['summarize', 'extract', 'compare'].includes(runOptions.mode)
      ? runOptions.mode : 'summarize';
    let artifactIds = Array.isArray(requestedIds)
      ? requestedIds.map((id) => String(id || '').trim()).filter(Boolean)
      : [];
    if (artifactIds.length === 0) {
      const current = await artifactService.listCurrentTurnArtifacts(userPhone);
      artifactIds = current.map((artifact) => artifact.artifact_id);
    }

    // WhatsApp and migrated conversations may have a recent user_file but no
    // session artifact. Preserve that behavior and expose honest coverage.
    if (artifactIds.length === 0) {
      const legacy = await analyzeDocument(userPhone, question, runOptions.fileNameHint || null);
      if (legacy.error) {
        return {
          mode,
          files: [failureEntry('', { code: legacy.error, message: legacy.message })],
          coverage: { requested: 1, analyzed: 0, failed: 1 },
          complete: false,
          evidence: [],
        };
      }
      const entry = {
        artifact_id: legacy.artifactId,
        file_name: legacy.fileName,
        mime_type: legacy.mimeType,
        status: 'success',
        provider: legacy.provider,
        text: legacy.text,
        complete: legacy.complete === true,
        truncated: legacy.truncated === true,
      };
      return {
        mode,
        files: [entry],
        coverage: { requested: 1, analyzed: 1, failed: 0 },
        complete: entry.complete,
        evidence: [{
          artifact_id: entry.artifact_id,
          file_name: entry.file_name,
          provider: entry.provider,
          complete: entry.complete,
        }],
      };
    }

    const files = [];
    for (const artifactId of artifactIds) {
      try {
        const loaded = await artifactService.loadOwnedArtifact(userPhone, artifactId);
        if (!loaded?.buffer) {
          throw Object.assign(new Error('The requested artifact is unavailable.'), {
            code: 'artifact_not_found',
          });
        }
        const analyzed = await analyzeDocument(userPhone, question, null, loaded);
        if (analyzed.error) {
          files.push(failureEntry(artifactId, {
            code: analyzed.error,
            message: analyzed.message,
          }));
          continue;
        }
        files.push({
          artifact_id: loaded.artifactId || artifactId,
          file_name: analyzed.fileName,
          mime_type: analyzed.mimeType,
          status: 'success',
          provider: analyzed.provider,
          text: analyzed.text,
          complete: analyzed.complete === true,
          truncated: analyzed.truncated === true,
        });
      } catch (error) {
        files.push(failureEntry(artifactId, error));
      }
    }

    const successful = files.filter((file) => file.status === 'success');
    const failed = files.length - successful.length;
    return {
      mode,
      files,
      coverage: { requested: artifactIds.length, analyzed: successful.length, failed },
      complete: failed === 0 && successful.length === artifactIds.length
        && successful.every((file) => file.complete === true),
      evidence: successful.map((file) => ({
        artifact_id: file.artifact_id,
        file_name: file.file_name,
        provider: file.provider,
        complete: file.complete,
      })),
    };
  }

  return { analyzeDocument, analyzeArtifacts, findRecentDocument, loadRecentDocument };
}

module.exports = {
  createFileAnalysisService,
  fileAnalysisService: createFileAnalysisService(),
};
