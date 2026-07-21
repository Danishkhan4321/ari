import {
  OpenRouter,
  createInitialState,
  fromChatMessages,
  maxCost,
  maxTokensUsed,
  stepCountIs,
  tool,
} from '@openrouter/agent';
import { z } from 'zod';

function modelSelection(models) {
  const cleaned = [...new Set((models || []).map((model) => String(model || '').trim()).filter(Boolean))];
  if (cleaned.length === 0) throw new Error('At least one OpenRouter model must be configured.');
  return cleaned.length === 1 ? { model: cleaned[0] } : { models: cleaned };
}

function objectSchema(jsonSchema) {
  const schema = z.fromJSONSchema(jsonSchema || {
    type: 'object',
    properties: {},
    additionalProperties: false,
  });
  if (!(schema instanceof z.ZodObject)) {
    throw new Error('Ari tool input schemas must describe JSON objects.');
  }
  return schema;
}

function makeTools(toolSpecs, executeTool, signal) {
  return toolSpecs.map((spec) => tool({
    name: spec.name,
    description: spec.description,
    inputSchema: objectSchema(spec.inputSchema),
    execute: async (args, context) => executeTool(spec.name, args, {
      callId: context?.toolCall?.callId || context?.toolCall?.id || null,
      turn: context?.numberOfTurns || 0,
      signal,
    }),
  }));
}

function abortError(message, code = 'agent_timeout') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function guardedStateAccessor(accessor) {
  let closed = false;
  let saveTail = Promise.resolve();
  return {
    accessor: {
      load: () => accessor.load(),
      save(state) {
        if (closed) return Promise.resolve();
        const pending = Promise.resolve().then(() => accessor.save(state));
        saveTail = pending.catch(() => {});
        return pending;
      },
    },
    async close() {
      closed = true;
      await saveTail;
    },
  };
}

async function consumeWithDeadline(result, timeoutMs, controller, closeState) {
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(abortError(`OpenRouter agent exceeded ${timeoutMs}ms.`));
      reject(abortError(`OpenRouter agent exceeded ${timeoutMs}ms.`));
    }, timeoutMs);
  });

  const operations = [result.getText(), result.getResponse(), result.getState()];
  const completion = Promise.all(operations);
  const settled = Promise.allSettled(operations);
  try {
    return await Promise.race([completion, deadline]);
  } catch (error) {
    await result.cancel().catch(() => {});
    // Cancellation can reject one getter while the pinned SDK is still
    // pairing tool outputs and saving state in another. Drain all getters for
    // a bounded window, then close the accessor: saves already started finish;
    // truly late saves become no-ops and cannot touch a released pg client.
    await Promise.race([
      settled,
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await closeState();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createClient(options) {
  return new OpenRouter({
    apiKey: options.apiKey,
    httpReferer: options.httpReferer,
    appTitle: options.appTitle || 'Ari',
    serverURL: options.serverURL,
    timeoutMs: options.requestTimeoutMs,
  });
}

export function createSeedState(id, chatMessages = []) {
  const state = createInitialState(id);
  state.messages = fromChatMessages(chatMessages);
  return state;
}

export function validateToolArguments(jsonSchema, value) {
  return objectSchema(jsonSchema).safeParse(value);
}

export async function executeAgentTurn(options) {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(options.signal?.reason || abortError('Agent turn cancelled.', 'agent_cancelled'));
  if (options.signal) {
    if (options.signal.aborted) onExternalAbort();
    else options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const agentTools = makeTools(options.toolSpecs, options.executeTool, controller.signal);
  const durableState = guardedStateAccessor(options.stateAccessor);
  const request = {
    ...modelSelection(options.models),
    input: options.input,
    instructions: options.instructions,
    tools: agentTools,
    state: durableState.accessor,
    sessionId: options.conversationId,
    promptCacheKey: options.conversationId,
    safetyIdentifier: options.safetyIdentifier,
    parallelToolCalls: options.parallelToolCalls === true,
    maxToolCalls: options.maxToolCalls,
    maxOutputTokens: options.maxOutputTokens,
    provider: options.provider,
    plugins: [
      // Ari's durable state is the memory contract. Middle-out compression can
      // silently remove CRM evidence, approvals, and tool observations.
      { id: 'context-compression', enabled: false },
    ],
    stopWhen: [
      stepCountIs(options.maxSteps),
      maxTokensUsed(options.maxTokens),
      maxCost(options.maxCostUsd),
    ],
    metadata: options.metadata,
    onTurnStart: options.onTurnStart,
    onTurnEnd: options.onTurnEnd,
  };
  if (options.reasoningEffort) request.reasoning = { effort: options.reasoningEffort };

  const result = options.client.callModel(request, {
    timeoutMs: options.requestTimeoutMs,
    signal: controller.signal,
  });

  try {
    const [text, response, state] = await consumeWithDeadline(
      result,
      options.overallTimeoutMs,
      controller,
      () => durableState.close()
    );
    await durableState.close();
    return { text: String(text || '').trim(), response, state };
  } finally {
    if (options.signal) options.signal.removeEventListener('abort', onExternalAbort);
  }
}

export async function analyzePdf(options) {
  let durableState = options.state || null;
  const stateAccessor = {
    async load() { return durableState; },
    async save(state) { durableState = state; },
  };
  const hasParsedState = Boolean(durableState && Array.isArray(durableState.messages));
  const result = options.client.callModel({
    ...modelSelection(options.models),
    input: hasParsedState ? options.instruction : [{
        role: 'user',
        content: [
          { type: 'input_text', text: options.instruction },
          {
            type: 'input_file',
            filename: options.filename,
            fileData: `data:${options.mimeType || 'application/pdf'};base64,${options.buffer.toString('base64')}`,
          },
        ],
      }],
    state: stateAccessor,
    maxOutputTokens: options.maxOutputTokens,
    provider: options.provider,
    plugins: hasParsedState
      ? [{ id: 'context-compression', enabled: false }]
      : [
          { id: 'context-compression', enabled: false },
          { id: 'file-parser', pdf: { engine: options.pdfEngine || 'cloudflare-ai' } },
        ],
  }, { timeoutMs: options.timeoutMs });

  const [text, response, state] = await Promise.all([
    result.getText(), result.getResponse(), result.getState(),
  ]);
  return {
    text: String(text || '').trim(),
    response,
    // Persistable Responses items include the parser annotations. A caller may
    // retain these for a later follow-up without uploading/parsing the PDF again.
    responseItems: response?.output || [],
    state: state || durableState,
  };
}
