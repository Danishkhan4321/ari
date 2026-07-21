'use strict';

const http = require('node:http');
const { randomBytes, randomUUID } = require('node:crypto');
const llm = require('./llm-provider');
const BoundedMap = require('../utils/bounded-map');

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    return part?.text || part?.input_text || part?.output_text || '';
  }).filter(Boolean).join('\n');
}

function messagesFromResponses(request, options = {}) {
  const messages = [];
  let pendingToolCalls = [];
  const flushToolCalls = () => {
    if (pendingToolCalls.length === 0) return;
    messages.push({ role: 'assistant', content: null, tool_calls: pendingToolCalls });
    pendingToolCalls = [];
  };
  if (request.instructions) messages.push({ role: 'system', content: String(request.instructions) });
  for (const item of Array.isArray(request.input) ? request.input : []) {
    if (item?.type === 'message') {
      flushToolCalls();
      const role = item.role === 'developer' ? 'system' : (item.role || 'user');
      const content = contentText(item.content);
      if (content) messages.push({ role, content });
      continue;
    }
    if (item?.type === 'function_call') {
      const callId = item.call_id || item.id;
      const extraContent = options.toolMetadata?.get(callId);
      pendingToolCalls.push({
          id: callId,
          type: 'function',
          function: { name: item.name, arguments: String(item.arguments || '{}') },
          ...(extraContent ? { extra_content: extraContent } : {}),
      });
      continue;
    }
    if (item?.type === 'function_call_output') {
      flushToolCalls();
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? null),
      });
    }
  }
  flushToolCalls();
  return messages;
}

function chatToolChoice(choice) {
  if (!choice || typeof choice === 'string') return choice || 'auto';
  if (choice.type === 'function' && choice.name) {
    return { type: 'function', function: { name: choice.name } };
  }
  return 'auto';
}

function toolsFromResponses(request) {
  return (Array.isArray(request.tools) ? request.tools : [])
    .filter((tool) => tool?.type === 'function' && tool.name)
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.parameters || { type: 'object', properties: {} },
      },
    }));
}

function normalizeUsage(usage = {}) {
  const inputTokens = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const outputTokens = Number(usage.completion_tokens || usage.output_tokens || 0);
  const cachedTokens = Number(usage.prompt_tokens_details?.cached_tokens || usage.input_tokens_details?.cached_tokens || 0);
  const reasoningTokens = Number(usage.completion_tokens_details?.reasoning_tokens || usage.output_tokens_details?.reasoning_tokens || 0);
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: cachedTokens },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: reasoningTokens },
    total_tokens: Number(usage.total_tokens || inputTokens + outputTokens),
  };
}

function outputItems(message = {}) {
  const items = [];
  const text = contentText(message.content);
  if (text) {
    items.push({
      id: `msg_${randomUUID().replace(/-/g, '')}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', annotations: [], text }],
    });
  }
  for (const toolCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    items.push({
      id: `fc_${randomUUID().replace(/-/g, '')}`,
      type: 'function_call',
      status: 'completed',
      call_id: toolCall.id || `call_${randomUUID().replace(/-/g, '')}`,
      name: toolCall.function?.name || toolCall.name,
      arguments: String(toolCall.function?.arguments || toolCall.arguments || '{}'),
    });
  }
  return items;
}

function responseEnvelope(request, message, usage) {
  const id = `resp_${randomUUID().replace(/-/g, '')}`;
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: request.instructions || null,
    max_output_tokens: request.max_output_tokens || null,
    model: request.model,
    output: outputItems(message),
    parallel_tool_calls: request.parallel_tool_calls !== false,
    previous_response_id: request.previous_response_id || null,
    store: false,
    temperature: request.temperature ?? null,
    tool_choice: request.tool_choice || 'auto',
    tools: request.tools || [],
    top_p: request.top_p ?? null,
    truncation: request.truncation || 'disabled',
    usage: normalizeUsage(usage),
  };
}

function sseEvents(response) {
  let sequenceNumber = 0;
  const events = [];
  const add = (type, payload) => events.push({ type, sequence_number: sequenceNumber++, ...payload });
  add('response.created', { response: { ...response, status: 'in_progress', output: [] } });
  response.output.forEach((item, outputIndex) => {
    add('response.output_item.added', { output_index: outputIndex, item: { ...item, status: 'in_progress' } });
    if (item.type === 'message' && item.content[0]) {
      const part = item.content[0];
      add('response.content_part.added', { item_id: item.id, output_index: outputIndex, content_index: 0, part: { ...part, text: '' } });
      add('response.output_text.delta', { item_id: item.id, output_index: outputIndex, content_index: 0, delta: part.text, logprobs: [] });
      add('response.output_text.done', { item_id: item.id, output_index: outputIndex, content_index: 0, text: part.text, logprobs: [] });
      add('response.content_part.done', { item_id: item.id, output_index: outputIndex, content_index: 0, part });
    }
    if (item.type === 'function_call') {
      add('response.function_call_arguments.delta', { item_id: item.id, output_index: outputIndex, delta: item.arguments });
      add('response.function_call_arguments.done', { item_id: item.id, output_index: outputIndex, arguments: item.arguments });
    }
    add('response.output_item.done', { output_index: outputIndex, item });
  });
  add('response.completed', { response });
  return events;
}

class AriResponsesGateway {
  constructor(options = {}) {
    this.host = options.host || '127.0.0.1';
    this.port = Number(options.port || 0);
    this.token = options.token || randomBytes(32).toString('hex');
    this.llm = options.llm || llm;
    this.toolMetadata = options.toolMetadata || new BoundedMap(2048, 30 * 60 * 1000);
    this.server = null;
    this.starting = null;
  }

  async start() {
    if (this.server?.listening) return this.connection();
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      const server = http.createServer((request, response) => void this._handle(request, response));
      server.once('error', reject);
      server.listen(this.port, this.host, () => {
        this.server = server;
        resolve(this.connection());
      });
    }).finally(() => { this.starting = null; });
    return this.starting;
  }

  connection() {
    const address = this.server?.address();
    const port = typeof address === 'object' && address ? address.port : this.port;
    return { baseUrl: `http://${this.host}:${port}/v1`, token: this.token };
  }

  async _handle(request, response) {
    if (request.method !== 'POST' || request.url !== '/v1/responses') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Not found.' } }));
      return;
    }
    if (request.headers.authorization !== `Bearer ${this.token}`) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Unauthorized.' } }));
      return;
    }
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) throw new Error('Request is too large.');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const tools = toolsFromResponses(body);
      const complex = body.reasoning?.effort === 'high'
        || body.reasoning?.effort === 'xhigh'
        || body.model === this.llm.complexModel?.();
      const upstream = await this.llm.chatCompletion({
        model: body.model || this.llm.defaultModel(),
        messages: messagesFromResponses(body, { toolMetadata: this.toolMetadata }),
        ...(tools.length > 0 ? { tools, tool_choice: chatToolChoice(body.tool_choice) } : {}),
        temperature: body.temperature ?? 0,
        max_tokens: body.max_output_tokens || 2500,
        ...(this.llm.defaultBodyExtras?.(complex ? 'complex' : 'agent') || {}),
      }, { task: 'agent_primary', timeout: 60_000, enablePromptCache: true });
      const data = upstream?.data || upstream || {};
      const message = data.choices?.[0]?.message || {};
      for (const toolCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        if (toolCall?.id && toolCall.extra_content) {
          this.toolMetadata.set(toolCall.id, toolCall.extra_content);
        }
      }
      const envelope = responseEnvelope(body, message, data.usage || {});
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      for (const event of sseEvents(envelope)) {
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      response.end();
    } catch (error) {
      if (response.headersSent) return response.end();
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: String(error.message || error).slice(0, 300) } }));
    }
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise((resolve) => server.close(resolve));
    this.toolMetadata?.clear?.();
  }
}

module.exports = {
  AriResponsesGateway,
  chatToolChoice,
  messagesFromResponses,
  normalizeUsage,
  outputItems,
  responseEnvelope,
  sseEvents,
  toolsFromResponses,
};
