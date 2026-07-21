'use strict';

// Multimodal model calls for the native runtime, via @ai-sdk/google-vertex.
//
// WHY THIS EXISTS: the native loop talks to Vertex's OpenAI-COMPATIBILITY
// endpoint, which has no general file part — so attachment turns could not run
// natively and were routed to the Python Agno sidecar (slow, and it never
// emitted the live status/reasoning events). This adapter speaks Vertex's
// NATIVE API, where file parts live, using the same service-account
// credentials Ari already holds.
//
// TWO DESIGN RULES, both load-bearing:
//
//  1. Tools are declared WITHOUT an `execute` function. The AI SDK then
//     returns tool calls and STOPS instead of running them itself. That keeps
//     Ari's executor authoritative — idempotency journal, confirmation gate,
//     effect-partitioned (read-parallel / write-serial) execution, and abort
//     semantics all stay exactly as they are. The SDK's own tool runner would
//     execute every call with an unconditional Promise.all, which would
//     silently break the write-serial guarantee.
//
//  2. The return value is shaped like an OpenAI chat completion
//     ({ data: { choices: [{ message }], usage } }) so runModelRounds needs no
//     branching — this is a drop-in `chatCompletion` replacement.

const logger = require('../utils/logger');

let cachedProvider = null;
let cachedKey = '';

function vertexProjectFromEnv(env) {
  return String(
    env.GOOGLE_VERTEX_PROJECT
    || env.GOOGLE_CLOUD_PROJECT
    || env.GCLOUD_PROJECT
    || env.GCP_PROJECT
    || env.VERTEX_PROJECT_ID
    || '',
  ).trim();
}

/**
 * Ari stores the service account as base64-encoded JSON (or raw JSON) in
 * GOOGLE_VERTEX_CREDENTIALS; GOOGLE_APPLICATION_CREDENTIALS (a file path) is
 * also supported and handled by ADC when we pass no explicit credentials.
 */
function serviceAccountFromEnv(env) {
  const raw = String(env.GOOGLE_VERTEX_CREDENTIALS || '').trim();
  if (!raw) return null;
  let text = raw;
  if (!text.startsWith('{')) {
    try { text = Buffer.from(raw, 'base64').toString('utf8'); } catch (_) { return null; }
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed?.client_email || !parsed?.private_key) return null;
    return { client_email: parsed.client_email, private_key: parsed.private_key };
  } catch (_) {
    return null;
  }
}

/**
 * Claude/Gemini on Vertex are region-bound; `global` is valid for Gemini but
 * the SDK provider expects a concrete location for the native endpoint.
 */
function vertexLocation(env) {
  const configured = String(env.ARI_VERTEX_MULTIMODAL_LOCATION || env.GOOGLE_VERTEX_LOCATION || '').trim();
  if (!configured || configured.toLowerCase() === 'global') return 'us-central1';
  return configured;
}

function isConfigured(env = process.env) {
  if (!vertexProjectFromEnv(env)) return false;
  return Boolean(serviceAccountFromEnv(env) || String(env.GOOGLE_APPLICATION_CREDENTIALS || '').trim());
}

function getProvider(env = process.env) {
  const project = vertexProjectFromEnv(env);
  const location = vertexLocation(env);
  const key = `${project}:${location}`;
  if (cachedProvider && cachedKey === key) return cachedProvider;
  const { createVertex } = require('@ai-sdk/google-vertex');
  const credentials = serviceAccountFromEnv(env);
  cachedProvider = createVertex({
    project,
    location,
    // Omitting googleAuthOptions falls back to ADC via
    // GOOGLE_APPLICATION_CREDENTIALS, which is the other supported setup.
    ...(credentials ? { googleAuthOptions: { credentials } } : {}),
  });
  cachedKey = key;
  return cachedProvider;
}

/**
 * Convert the loop's OpenAI-style messages into AI SDK ModelMessages, adding
 * validated file parts to the LAST user message (the current turn).
 */
function toModelMessages(messages, files) {
  const converted = [];
  for (const message of messages) {
    const role = message.role;
    if (role === 'system') {
      converted.push({ role: 'system', content: String(message.content || '') });
      continue;
    }
    if (role === 'tool') {
      // Tool results carry the tool_call_id the assistant turn referenced.
      converted.push({
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: String(message.tool_call_id || ''),
          toolName: String(message.name || 'tool'),
          output: { type: 'text', value: String(message.content || '') },
        }],
      });
      continue;
    }
    if (role === 'assistant') {
      const parts = [];
      const text = String(message.content || '').trim();
      if (text) parts.push({ type: 'text', text });
      for (const call of message.tool_calls || []) {
        let input = {};
        try { input = JSON.parse(call.function?.arguments || '{}'); } catch (_) { input = {}; }
        parts.push({
          type: 'tool-call',
          toolCallId: String(call.id || ''),
          toolName: String(call.function?.name || call.name || ''),
          input,
        });
      }
      converted.push({ role: 'assistant', content: parts.length ? parts : [{ type: 'text', text: '' }] });
      continue;
    }
    converted.push({ role: 'user', content: [{ type: 'text', text: String(message.content || '') }] });
  }

  if (Array.isArray(files) && files.length > 0) {
    for (let index = converted.length - 1; index >= 0; index--) {
      if (converted[index].role !== 'user') continue;
      const content = Array.isArray(converted[index].content)
        ? converted[index].content
        : [{ type: 'text', text: String(converted[index].content || '') }];
      converted[index] = {
        role: 'user',
        content: [...content, ...files.map((file) => ({
          type: 'file',
          data: file.data,
          mediaType: file.mediaType,
          filename: file.name,
        }))],
      };
      break;
    }
  }
  return converted;
}

/** Declare tools with NO execute — the SDK reports calls, Ari runs them. */
function toSdkTools(tools, jsonSchema, tool) {
  const declared = {};
  for (const entry of tools || []) {
    const fn = entry.function || entry;
    if (!fn?.name) continue;
    declared[fn.name] = tool({
      description: String(fn.description || ''),
      inputSchema: jsonSchema(fn.parameters || { type: 'object', properties: {} }),
    });
  }
  return declared;
}

/**
 * Drop-in replacement for llm.chatCompletion for multimodal turns.
 *
 * @param {object} body   OpenAI-shaped body ({ model, messages, tools, ... })
 * @param {object} opts   { signal, timeout, files, onDelta }
 * @returns {Promise<{data:{choices:Array,usage:object}}>}
 */
async function chatCompletionWithFiles(body, opts = {}) {
  const env = opts.env || process.env;
  const { generateText, jsonSchema, tool, stepCountIs } = await import('ai');
  const provider = getProvider(env);
  const model = provider(String(body.model || 'gemini-2.5-flash'));

  const result = await generateText({
    model,
    messages: toModelMessages(body.messages || [], opts.files),
    tools: toSdkTools(body.tools, jsonSchema, tool),
    // Exactly one model step: report tool calls, never execute them here.
    stopWhen: stepCountIs(1),
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    maxOutputTokens: body.max_tokens,
    abortSignal: opts.signal,
  });

  const toolCalls = (result.toolCalls || []).map((call, index) => ({
    id: String(call.toolCallId || `call_${index}`),
    type: 'function',
    function: {
      name: String(call.toolName || ''),
      arguments: JSON.stringify(call.input ?? {}),
    },
  }));
  const message = { role: 'assistant', content: String(result.text || '') };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  const usage = result.usage || {};
  return {
    data: {
      choices: [{ message, finish_reason: result.finishReason || null }],
      usage: {
        prompt_tokens: usage.inputTokens ?? null,
        completion_tokens: usage.outputTokens ?? null,
        total_tokens: usage.totalTokens ?? null,
      },
    },
  };
}

/**
 * Read validated attachments into memory as AI SDK file parts. Only types the
 * model can actually interpret are sent; anything else stays out of the prompt
 * and remains reachable through the analyze_file tool.
 */
function readModelFiles(validatedFiles, { maxBytes = 20 * 1024 * 1024 } = {}) {
  const fs = require('node:fs');
  const parts = [];
  let total = 0;
  for (const file of validatedFiles || []) {
    const mediaType = String(file.mimeType || '').toLowerCase();
    const modelReadable = mediaType === 'application/pdf'
      || mediaType.startsWith('image/')
      || mediaType.startsWith('audio/')
      || mediaType.startsWith('video/')
      || mediaType.startsWith('text/')
      || mediaType === 'application/json';
    if (!modelReadable) continue;
    if (total + file.size > maxBytes) {
      logger.warn({ name: file.name }, 'attachment skipped: model payload budget reached');
      continue;
    }
    try {
      parts.push({ data: fs.readFileSync(file.path), mediaType, name: file.name });
      total += file.size;
    } catch (error) {
      logger.warn({ err: error.message }, 'attachment could not be read for the model');
    }
  }
  return parts;
}

module.exports = {
  chatCompletionWithFiles,
  readModelFiles,
  isConfigured,
  _internals: { toModelMessages, toSdkTools, serviceAccountFromEnv, vertexLocation },
};
