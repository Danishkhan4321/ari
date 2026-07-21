'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createOpenRouterAgentService,
  isConfigured,
  modelsFromEnv,
  repairUnpairedFunctionCalls,
  runOpenRouterAgentWithContinuation,
  runtimeConfig,
} = require('../src/services/openrouter-agent.service');
const { runWithChatSession } = require('../src/services/chat-session-context');
const { mergeCanonicalHistory } = require('../src/services/openrouter-agent-state.service');

const TASK_TOOL = {
  name: 'manage_tasks',
  description: 'Create and manage CRM tasks.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      priority: { type: 'string', enum: ['low', 'normal', 'high'] },
    },
    required: ['title'],
    additionalProperties: false,
  },
};

test('OpenRouter resumes a verified tool-cap checkpoint in durable conversation state', async () => {
  const inputs = [];
  const events = [];
  const segments = [
    {
      status: 'partial', text: 'Created the first batch.', steps: 5, latencyMs: 100,
      toolsUsed: ['manage_tasks'],
      toolResults: [
        { status: 'success', tool: 'manage_tasks', user_summary: 'Created task 1.' },
        { status: 'failure', tool: 'manage_tasks', error: { code: 'agent_tool_limit_reached' } },
      ],
    },
    {
      status: 'completed', text: 'Created all tasks.', steps: 2, latencyMs: 50,
      toolsUsed: ['manage_tasks'],
      toolResults: [{ status: 'success', tool: 'manage_tasks', user_summary: 'Created the rest.' }],
    },
  ];
  const result = await runOpenRouterAgentWithContinuation({
    runAgentLoop: async (options) => {
      inputs.push(options.userMessage);
      return segments.shift();
    },
  }, {
    userMessage: 'Create all tasks.',
    recentMessages: [{ role: 'user', content: 'Earlier context' }],
    onEvent: async (event) => events.push(event),
  });

  assert.equal(inputs.length, 2);
  assert.match(inputs[1], /do not repeat/i);
  assert.equal(result.status, 'completed');
  assert.equal(result.steps, 7);
  assert.equal(result.meta.continuationCount, 1);
  assert.ok(events.some((event) => event.type === 'run.continuing'));
});

function createHarness({
  toolResult,
  concurrentSecondCall = false,
  toolRequests = null,
  claimHandler = null,
  callbackToolName = 'manage_tasks',
  sdkFailure = null,
  modelText = null,
  confirmationGate = null,
  persistSdkTurn = false,
  sdkAssistantShape = 'response',
  providerErrorAfterTool = null,
  envOverrides = {},
} = {}) {
  const captured = {
    claims: [],
    clients: [],
    events: [],
    finishes: [],
    canonicalHistory: [],
    loadedStates: [],
    saves: [],
    toolExecutions: [],
  };

  const persistence = {
    async ensureTables() { captured.ensured = (captured.ensured || 0) + 1; },
    async withConversationLock(conversationKey, work) {
      captured.lockKey = conversationKey;
      return work(async () => ({ rows: [], rowCount: 0 }));
    },
    createStateAccessor(args) {
      captured.stateArgs = args;
      return {
        async load() {
          const baseState = captured.persistedState
            ? structuredClone(captured.persistedState)
            : structuredClone(args.initialState);
          const loaded = captured.canonicalHistory.length > 0
            ? mergeCanonicalHistory(baseState, captured.canonicalHistory)
            : baseState;
          captured.loadedStates.push(structuredClone(loaded));
          return loaded;
        },
        async save(state) {
          const snapshot = structuredClone(state);
          captured.saves.push(snapshot);
          captured.persistedState = snapshot;
        },
      };
    },
    async claimToolExecution(args) {
      captured.claims.push(args);
      if (claimHandler) return claimHandler(args, captured);
      return { claimed: true, argumentsHash: 'fake-arguments-hash' };
    },
    async finishToolExecution(args) { captured.finishes.push(args); },
  };

  const bridge = {
    createClient(config) {
      captured.clients.push(config);
      return { kind: 'fake-openrouter-client' };
    },
    createSeedState(id, messages) {
      captured.seed = { id, messages };
      return { id, messages: [...messages], previousResponseId: null };
    },
    validateToolArguments(schema, value) {
      captured.validation = { schema, value };
      if (!value || typeof value.title !== 'string') {
        return { success: false, error: { issues: [{ path: ['title'], message: 'Required' }] } };
      }
      return { success: true, data: { title: value.title.trim(), priority: value.priority || 'normal' } };
    },
    async executeAgentTurn(request) {
      captured.request = request;
      await request.onTurnStart({ numberOfTurns: 0 });
      const loadedState = await request.stateAccessor.load();
      if (sdkFailure) {
        const callId = sdkFailure.callId || 'or-sdk-rejected-1';
        const sdkState = {
          ...loadedState,
          messages: [
            ...(loadedState?.messages || []),
            {
              type: 'function_call', id: `fc-${callId}`, callId,
              name: sdkFailure.name || 'manage_tasks',
              arguments: sdkFailure.arguments || '{}',
            },
            {
              type: 'function_call_output', id: `output-${callId}`, callId,
              output: JSON.stringify({ error: sdkFailure.error }),
            },
          ],
        };
        await request.stateAccessor.save(sdkState);
        const response = {
          status: 'completed',
          model: 'openai/gpt-4.1-mini',
          usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        };
        await request.onTurnEnd({ numberOfTurns: 0 }, response);
        return { text: modelText || 'Done.', response, state: sdkState };
      }
      const requested = toolRequests || [{ title: '  Ship proposal  ' }];
      if (concurrentSecondCall) requested.push({ title: 'Must wait behind approval' });
      const calls = requested.map((args, index) => request.executeTool(
        callbackToolName,
        args,
        { callId: `or-tool-call-${index + 1}`, turn: 0, signal: request.signal }
      ));
      const observations = await Promise.all(calls);
      captured.observations = observations;
      [captured.observation, captured.concurrentObservation] = observations;
      if (providerErrorAfterTool) {
        const messages = [
          ...(loadedState?.messages || []),
          { role: 'user', content: request.input },
          { role: 'assistant', content: 'I am working on the CRM change now.' },
        ];
        requested.forEach((args, index) => {
          const callId = `or-tool-call-${index + 1}`;
          messages.push(
            {
              type: 'function_call', id: `fc-${callId}`, callId,
              name: callbackToolName, arguments: JSON.stringify(args),
            },
            {
              type: 'function_call_output', id: `output-${callId}`, callId,
              output: JSON.stringify(observations[index]),
            }
          );
        });
        await request.stateAccessor.save({
          ...loadedState,
          previousResponseId: 'provider-response-that-threw',
          messages,
        });
        const error = new Error(providerErrorAfterTool.message || 'provider failed after tool execution');
        error.code = providerErrorAfterTool.code || 'provider_after_tool_error';
        throw error;
      }
      const terminalModelText = modelText || (toolResult?.status === 'waiting_approval'
        ? 'Please approve this action.'
        : 'The CRM task was created.');
      let sdkState;
      if (persistSdkTurn) {
        const turnMessages = [
          ...(loadedState?.messages || []),
          { role: 'user', content: request.input },
        ];
        requested.forEach((args, index) => {
          const callId = `or-tool-call-${index + 1}`;
          turnMessages.push(
            {
              type: 'function_call', id: `fc-${callId}`, callId,
              name: callbackToolName, arguments: JSON.stringify(args),
            },
            {
              type: 'function_call_output', id: `output-${callId}`, callId,
              output: JSON.stringify(observations[index]),
            }
          );
        });
        turnMessages.push(sdkAssistantShape === 'easy'
          ? { role: 'assistant', content: terminalModelText }
          : {
              type: 'message', id: 'sdk-terminal-message', role: 'assistant', status: 'completed',
              content: [{ type: 'output_text', text: terminalModelText, annotations: [] }],
            });
        sdkState = {
          ...loadedState,
          status: 'complete',
          previousResponseId: 'sdk-response-with-false-prose',
          messages: turnMessages,
        };
      } else {
        sdkState = {
          id: request.conversationId,
          messages: [{ role: 'assistant', content: 'saved SDK state' }],
        };
      }
      await request.stateAccessor.save(sdkState);
      const response = {
        status: 'completed',
        model: 'openai/gpt-4.1-mini',
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      };
      await request.onTurnEnd({ numberOfTurns: 0 }, response);
      return {
        text: terminalModelText,
        response,
        state: sdkState,
      };
    },
  };

  const env = {
    OPENROUTER_API_KEY: 'test-openrouter-key',
    OPENROUTER_MODELS: 'openai/gpt-4.1-mini, google/gemini-2.5-flash',
    OPENROUTER_ALLOW_FALLBACKS: 'true',
    OPENROUTER_REQUIRE_PARAMETERS: 'true',
    OPENROUTER_DENY_DATA_COLLECTION: 'true',
    OPENROUTER_ZDR: 'true',
    ARI_AGENT_MAX_STEPS: '7',
    ARI_AGENT_MAX_TOKENS: '9000',
    ARI_AGENT_MAX_COST_USD: '0.25',
    ARI_AGENT_MAX_TOOL_CALLS: '5',
    ARI_AGENT_MAX_OUTPUT_TOKENS: '1024',
    ARI_AGENT_REQUEST_TIMEOUT_MS: '12000',
    ARI_AGENT_TIMEOUT_MS: '30000',
    ARI_TOOL_TIMEOUT_MS: '4000',
    ...envOverrides,
  };

  const service = createOpenRouterAgentService({
    env,
    persistence,
    bridgeLoader: async () => bridge,
    listTools: () => [TASK_TOOL, {
      name: 'web_search',
      description: 'Search the web.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    }],
    selectTools: async (message, options) => {
      captured.selection = { message, options };
      return [TASK_TOOL];
    },
    buildContext: async () => 'CRM snapshot: Acme is at proposal stage.',
    client: { kind: 'injected-client' },
    confirmationGate,
  });

  const executeFn = async (name, args, meta) => {
    captured.toolExecutions.push({ name, args, meta });
    if (typeof toolResult === 'function') return toolResult(name, args, meta, captured);
    return toolResult || {
      status: 'success',
      data: { task_id: 'task-42', title: args.title },
      user_summary: 'Created task task-42.',
      evidence: [{ type: 'crm_task', id: 'task-42' }],
    };
  };

  return { captured, env, executeFn, service };
}

test('OpenRouter config parses model lists and clamps runtime/privacy settings', () => {
  assert.deepEqual(modelsFromEnv({ OPENROUTER_MODELS: ' model/a, , model/b ' }), ['model/a', 'model/b']);
  assert.deepEqual(modelsFromEnv({}), ['openai/gpt-4.1-mini', 'google/gemini-2.5-flash']);
  assert.equal(isConfigured({ OPENROUTER_API_KEY: ' key ', ARI_AGENT_RUNTIME: 'openrouter' }), true);
  assert.equal(isConfigured({ OPENROUTER_API_KEY: ' key ' }), true,
    'direct OpenRouter remains the safe fallback when default Agno is unconfigured');
  assert.equal(isConfigured({ OPENROUTER_API_KEY: ' key ', ARI_AGENT_RUNTIME: 'agno' }), true,
    'direct OpenRouter remains the safe fallback when Agno fails before tool execution');
  assert.equal(isConfigured({ OPENROUTER_API_KEY: 'key', ARI_AGENT_RUNTIME: 'legacy' }), false);
  assert.equal(runtimeConfig({ OPENROUTER_API_KEY: 'key' }).overallTimeoutMs, 300_000,
    'each resumable OpenRouter segment gets the same five-minute long-task budget');
  assert.equal(runtimeConfig({ OPENROUTER_API_KEY: 'key' }).toolTimeoutMs, 300_000,
    'native bulk tools must be allowed to finish and checkpoint their transaction');

  const config = runtimeConfig({
    OPENROUTER_API_KEY: ' key ',
    OPENROUTER_MODEL: 'model/only',
    ARI_AGENT_MAX_STEPS: '999',
    ARI_AGENT_MAX_TOKENS: '10',
    ARI_AGENT_MAX_COST_USD: '0',
    ARI_AGENT_MAX_TOOL_CALLS: '0',
    ARI_AGENT_MAX_OUTPUT_TOKENS: '999999',
    OPENROUTER_ALLOW_FALLBACKS: 'false',
    OPENROUTER_REQUIRE_PARAMETERS: '0',
    OPENROUTER_DENY_DATA_COLLECTION: 'true',
    OPENROUTER_ZDR: 'yes',
  });

  assert.equal(config.apiKey, 'key');
  assert.deepEqual(config.models, ['model/only']);
  assert.equal(config.maxSteps, 30);
  assert.equal(config.maxTokens, 1000);
  assert.equal(config.maxCostUsd, 0.01);
  assert.equal(config.maxToolCalls, 1);
  assert.equal(config.maxOutputTokens, 32000);
  assert.deepEqual(config.provider, {
    allowFallbacks: false,
    requireParameters: false,
    dataCollection: 'deny',
    zdr: true,
  });
});

test('service sends fresh input, selected tools, explicit limits/privacy, and returns a typed tool outcome', async () => {
  const { captured, executeFn, service } = createHarness();
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const events = [];

  const outcome = await runWithChatSession({ sessionId, userPhone: '919000000001' }, () => service.runAgentLoop({
    runId: '22222222-2222-4222-8222-222222222222',
    userPhone: '919000000001',
    userMessage: 'Create the proposal task now',
    recentMessages: [
      { role: 'user', content: 'We discussed Acme yesterday.' },
      { role: 'assistant', content: 'Acme is at proposal stage.' },
    ],
    executeFn,
    onEvent: async (event) => events.push(event),
  }));

  assert.equal(captured.request.input, 'Create the proposal task now', 'history must not be concatenated into the fresh turn');
  assert.deepEqual(captured.seed.messages, [
    { role: 'user', content: 'We discussed Acme yesterday.' },
    { role: 'assistant', content: 'Acme is at proposal stage.' },
  ]);
  assert.match(captured.request.instructions, /CRM snapshot: Acme is at proposal stage/);
  assert.deepEqual(captured.request.toolSpecs.map((tool) => tool.name), [
    'manage_tasks',
    'discover_ari_tools',
    'invoke_ari_tool',
  ]);
  assert.equal(captured.selection.options.allTools.length, 2);

  assert.deepEqual(captured.request.models, ['openai/gpt-4.1-mini', 'google/gemini-2.5-flash']);
  assert.equal(captured.request.parallelToolCalls, false);
  assert.equal(captured.request.maxSteps, 7);
  assert.equal(captured.request.maxTokens, 9000);
  assert.equal(captured.request.maxCostUsd, 0.25);
  assert.equal(captured.request.maxToolCalls, 5);
  assert.equal(captured.request.maxOutputTokens, 1024);
  assert.equal(captured.request.requestTimeoutMs, 12000);
  assert.equal(captured.request.overallTimeoutMs, 30000);
  assert.deepEqual(captured.request.provider, {
    allowFallbacks: true,
    requireParameters: true,
    dataCollection: 'deny',
    zdr: true,
  });
  assert.equal(captured.request.metadata.ari_channel, 'dashboard');
  assert.doesNotMatch(captured.request.safetyIdentifier, /919000000001/);
  assert.equal(captured.stateArgs.sessionId, sessionId);
  assert.equal(captured.stateArgs.conversationKey, captured.request.conversationId);

  assert.deepEqual(captured.validation.value, { title: '  Ship proposal  ' });
  assert.equal(captured.toolExecutions.length, 1);
  assert.deepEqual(captured.toolExecutions[0].args, { title: 'Ship proposal', priority: 'normal' });
  assert.equal(captured.toolExecutions[0].meta.callId, 'or-tool-call-1');
  assert.equal(captured.claims[0].callId, 'or-tool-call-1');
  assert.equal(captured.finishes[0].status, 'completed');
  assert.equal(captured.observation.status, 'success');
  assert.equal(captured.observation.data.task_id, 'task-42');

  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.text, 'The CRM task was created.');
  assert.deepEqual(outcome.toolsUsed, ['manage_tasks']);
  assert.equal(outcome.toolResults[0].status, 'success');
  assert.equal(outcome.toolResults[0].meta.typed, true);
  assert.ok(events.some((event) => event.type === 'tool.succeeded'));
  assert.ok(events.some((event) => event.type === 'run.completed'));
});

test('service preserves waiting-approval semantics in its terminal outcome', async () => {
  const waiting = {
    status: 'waiting_approval',
    data: { approval_id: 'approval-7', pending: true },
    user_summary: 'Approve sending the proposal to Acme?',
  };
  const { captured, executeFn, service } = createHarness({
    toolResult: waiting,
    concurrentSecondCall: true,
  });

  const outcome = await service.runAgentLoop({
    userPhone: '919000000002',
    userMessage: 'Send the proposal',
    backgroundBlock: '',
    executeFn,
  });

  assert.equal(captured.observation.status, 'waiting_approval');
  assert.equal(captured.concurrentObservation.status, 'waiting_approval');
  assert.equal(captured.observation.ok, false);
  assert.equal(outcome.status, 'waiting_for_approval');
  assert.equal(outcome.toolResults[0].error, null);
  assert.match(outcome.text, /approve/i);

  const blockedFollowUp = await captured.request.executeTool(
    'manage_tasks',
    { title: 'Must not execute' },
    { callId: 'or-tool-call-after-approval', turn: 1 }
  );
  assert.equal(blockedFollowUp.status, 'waiting_approval');
  assert.equal(captured.toolExecutions.length, 1, 'no tool may run after an approval prompt in the same turn');
});

test('replayed waiting result fences every later tool in the same model batch', async () => {
  const waiting = {
    status: 'waiting_approval',
    data: { approval_id: 'approval-replayed', pending: true },
    user_summary: 'Approve the previously requested CRM write?',
  };
  const { captured, executeFn, service } = createHarness({
    toolRequests: [
      { title: 'Replay the pending write' },
      { title: 'Must remain behind the replayed approval' },
    ],
    claimHandler: async (args) => {
      if (args.callId === 'or-tool-call-1') {
        return {
          claimed: false,
          conflict: null,
          existing: { status: 'completed', result: waiting },
        };
      }
      return { claimed: true, argumentsHash: 'unexpected-second-claim' };
    },
  });

  const outcome = await service.runAgentLoop({
    userPhone: '9190000000021',
    userMessage: 'Resume the pending write, then create another task',
    backgroundBlock: '',
    executeFn,
  });

  assert.equal(captured.observations[0].status, 'waiting_approval');
  assert.equal(captured.observations[1].status, 'waiting_approval');
  assert.equal(captured.claims.length, 1, 'the later tool must not even claim a journal slot');
  assert.equal(captured.toolExecutions.length, 0, 'the later tool must not reach its executor');
  assert.equal(outcome.status, 'waiting_for_approval');
  assert.deepEqual(outcome.toolsUsed, ['manage_tasks']);
});

test('typed tool failure overrides a model that falsely says Done', async () => {
  const { executeFn, service } = createHarness({
    toolResult: 'Lead "Missing Co" not found.',
    modelText: 'Done.',
  });
  const outcome = await service.runAgentLoop({
    userPhone: '919000000003',
    userMessage: 'Move Missing Co to won',
    backgroundBlock: '',
    executeFn,
  });

  assert.equal(outcome.status, 'failed');
  assert.doesNotMatch(outcome.text, /^Done\.?$/i);
  assert.match(outcome.text, /not found/i);
});

test('authoritative failed and waiting outcomes replace durable false prose before history reconciliation', async (t) => {
  const scenarios = [
    {
      name: 'failed tool with Responses message content',
      userPhone: '9190000000031',
      userMessage: 'Move Missing Co to won',
      toolResult: 'Lead "Missing Co" not found.',
      sdkAssistantShape: 'response',
      expectedStatus: 'failed',
      expectedText: /not found/i,
    },
    {
      name: 'waiting approval with easy-input message content',
      userPhone: '9190000000032',
      userMessage: 'Send the proposal',
      toolResult: {
        status: 'waiting_approval',
        data: { approval_id: 'approval-durable-truth', pending: true },
        user_summary: 'Approve sending the proposal to Acme?',
      },
      sdkAssistantShape: 'easy',
      expectedStatus: 'waiting_for_approval',
      expectedText: /approve sending/i,
    },
  ];

  function stateItemText(item) {
    if (typeof item?.content === 'string') return item.content;
    if (!Array.isArray(item?.content)) return '';
    return item.content.map((part) => typeof part === 'string' ? part : part?.text || '').join('\n');
  }

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const { captured, executeFn, service } = createHarness({
        toolResult: scenario.toolResult,
        modelText: 'Done.',
        persistSdkTurn: true,
        sdkAssistantShape: scenario.sdkAssistantShape,
      });
      const outcome = await service.runAgentLoop({
        userPhone: scenario.userPhone,
        userMessage: scenario.userMessage,
        backgroundBlock: '',
        executeFn,
      });

      assert.equal(outcome.status, scenario.expectedStatus);
      assert.match(outcome.text, scenario.expectedText);
      const persisted = captured.saves.at(-1);
      assert.equal(persisted.previousResponseId, undefined,
        'rewriting provider output must invalidate its continuation hint');
      assert.doesNotMatch(JSON.stringify(persisted), /"Done\."/i);
      const terminalAssistant = [...persisted.messages].reverse()
        .find((item) => item?.role === 'assistant');
      assert.equal(stateItemText(terminalAssistant), outcome.text);

      const calls = persisted.messages.filter((item) => item?.type === 'function_call');
      const outputs = persisted.messages.filter((item) => item?.type === 'function_call_output');
      assert.equal(calls.length, 1);
      assert.equal(outputs.length, 1);
      assert.equal(outputs[0].callId, calls[0].callId,
        'terminal prose correction must not disturb the tool pair');

      // The controller writes this outward pair to canonical history after the
      // locked agent turn. A subsequent state load must find an exact overlap,
      // rather than appending the user again because durable prose said Done.
      const reconciled = mergeCanonicalHistory(persisted, [
        { id: 101, role: 'user', content: scenario.userMessage },
        { id: 102, role: 'assistant', content: outcome.text },
      ]);
      assert.equal(reconciled.messages.length, persisted.messages.length);
      assert.equal(reconciled.messages.filter((item) =>
        item?.role === 'user' && stateItemText(item) === scenario.userMessage).length, 1);
      assert.equal(stateItemText([...reconciled.messages].reverse()
        .find((item) => item?.role === 'assistant')), outcome.text);
      assert.doesNotMatch(JSON.stringify(reconciled), /"Done\."/i);

      captured.canonicalHistory = [
        { id: 101, role: 'user', content: scenario.userMessage },
        { id: 102, role: 'assistant', content: outcome.text },
      ];
      const followUpMessage = 'Tell me the verified status again';
      await service.runAgentLoop({
        userPhone: scenario.userPhone,
        userMessage: followUpMessage,
        backgroundBlock: '',
        executeFn,
      });

      const loadedForSecondTurn = captured.loadedStates.at(-1);
      assert.equal(loadedForSecondTurn.messages.length, persisted.messages.length,
        'canonical load must overlap the corrected pair instead of appending it');
      assert.equal(loadedForSecondTurn.messages.filter((item) =>
        item?.role === 'user' && stateItemText(item) === scenario.userMessage).length, 1);
      assert.equal(stateItemText([...loadedForSecondTurn.messages].reverse()
        .find((item) => item?.role === 'assistant')), outcome.text);
      assert.doesNotMatch(JSON.stringify(loadedForSecondTurn), /"Done\."/i);

      const afterSecondTurn = captured.saves.at(-1);
      assert.equal(afterSecondTurn.messages.filter((item) =>
        item?.role === 'user' && stateItemText(item) === scenario.userMessage).length, 1);
      assert.equal(afterSecondTurn.messages.filter((item) =>
        item?.role === 'user' && stateItemText(item) === followUpMessage).length, 1);
      assert.doesNotMatch(JSON.stringify(afterSecondTurn), /"Done\."/i);
    });
  }
});

test('provider failure after a persisted tool pair stores honest partial truth before lock release', async () => {
  const userMessage = 'Create the launch task';
  const { captured, executeFn, service } = createHarness({
    providerErrorAfterTool: { code: 'provider_stream_error', message: 'provider stream disconnected' },
  });

  const outcome = await service.runAgentLoop({
    userPhone: '9190000000033',
    userMessage,
    backgroundBlock: '',
    executeFn,
  });

  assert.equal(outcome.status, 'partial');
  assert.equal(outcome.errorCode, 'provider_stream_error');
  assert.match(outcome.text, /I completed:/i);
  const persisted = captured.saves.at(-1);
  assert.equal(persisted.previousResponseId, undefined);
  const itemText = (item) => {
    if (typeof item?.content === 'string') return item.content;
    return Array.isArray(item?.content)
      ? item.content.map((part) => typeof part === 'string' ? part : part?.text || '').join('\n')
      : '';
  };
  assert.equal(itemText(persisted.messages.at(-1)), outcome.text);
  assert.equal(persisted.messages.filter((item) => item?.type === 'function_call').length, 1);
  assert.equal(persisted.messages.filter((item) => item?.type === 'function_call_output').length, 1);

  const reconciled = mergeCanonicalHistory(persisted, [
    { id: 201, role: 'user', content: userMessage },
    { id: 202, role: 'assistant', content: outcome.text },
  ]);
  assert.equal(reconciled.messages.length, persisted.messages.length,
    'canonical history must overlap the corrected terminal pair');
  assert.equal(reconciled.messages.filter((item) =>
    item?.role === 'user' && itemText(item) === userMessage).length, 1);
  assert.equal(itemText(reconciled.messages.at(-1)), outcome.text);
  assert.notEqual(itemText(reconciled.messages.at(-1)), 'I am working on the CRM change now.');
});

test('legacy partial tool output overrides a model that falsely says Done', async () => {
  const { executeFn, service } = createHarness({
    toolResult: 'Task created, but I couldn\'t deliver the notification to Priya.',
    modelText: 'Done.',
  });
  const outcome = await service.runAgentLoop({
    userPhone: '919000000033',
    userMessage: 'Create and assign the task to Priya',
    backgroundBlock: '',
    executeFn,
  });

  assert.equal(outcome.status, 'partial');
  assert.doesNotMatch(outcome.text, /^Done\.?$/i);
  assert.match(outcome.text, /task created/i);
  assert.equal(outcome.toolResults[0].error.code, 'legacy_tool_partial');
});

test('callback-level unknown tools and invalid arguments are recorded as failed run truth', async (t) => {
  await t.test('unknown discovered tool', async () => {
    const { captured, executeFn, service } = createHarness({
      callbackToolName: 'invoke_ari_tool',
      toolRequests: [{ name: 'delete_the_internet', arguments: {} }],
      modelText: 'Done.',
    });
    const outcome = await service.runAgentLoop({
      userPhone: '919000000030',
      userMessage: 'Run the discovered tool',
      backgroundBlock: '',
      executeFn,
      onEvent: async (event) => captured.events.push(event),
    });

    assert.equal(captured.toolExecutions.length, 0);
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.toolResults[0].error.code, 'unknown_tool');
    assert.doesNotMatch(outcome.text, /^Done\.?$/i);
    assert.ok(captured.events.some((event) => event.type === 'tool.failed'
      && event.payload.code === 'unknown_tool'));
  });

  await t.test('invalid selected-tool arguments', async () => {
    const { captured, executeFn, service } = createHarness({
      toolRequests: [{ priority: 'high' }],
      modelText: 'Done.',
    });
    const outcome = await service.runAgentLoop({
      userPhone: '919000000031',
      userMessage: 'Create it',
      backgroundBlock: '',
      executeFn,
      onEvent: async (event) => captured.events.push(event),
    });

    assert.equal(captured.toolExecutions.length, 0);
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.toolResults[0].error.code, 'invalid_tool_arguments');
    assert.doesNotMatch(outcome.text, /^Done\.?$/i);
    assert.ok(captured.events.some((event) => event.type === 'tool.failed'
      && event.payload.code === 'invalid_tool_arguments'));
  });
});

test('SDK-intercepted validation, JSON parse, and execution errors override model Done claims', async (t) => {
  const cases = [
    {
      name: 'schema validation',
      error: '[{"origin":"string","code":"too_small","path":["title"],"message":"Too small"}]',
      code: 'invalid_tool_arguments',
    },
    {
      name: 'malformed JSON',
      error: 'Failed to parse tool call arguments for "manage_tasks": The model provided invalid JSON.',
      code: 'invalid_tool_arguments_json',
    },
    {
      name: 'SDK execution rejection',
      error: 'Agent SDK executor stopped unexpectedly.',
      code: 'sdk_tool_execution_error',
    },
  ];

  for (const [index, scenario] of cases.entries()) {
    await t.test(scenario.name, async () => {
      const { captured, executeFn, service } = createHarness({
        sdkFailure: { error: scenario.error },
        modelText: 'Done.',
      });
      const outcome = await service.runAgentLoop({
        userPhone: `91900000004${index}`,
        userMessage: 'Create the task',
        backgroundBlock: '',
        executeFn,
        onEvent: async (event) => captured.events.push(event),
      });

      assert.equal(captured.toolExecutions.length, 0, 'the SDK rejected before Ari execution');
      assert.equal(outcome.status, 'failed');
      assert.equal(outcome.toolResults[0].error.code, scenario.code);
      assert.equal(outcome.toolResults[0].meta.sdk_intercepted, true);
      assert.doesNotMatch(outcome.text, /^Done\.?$/i);
      assert.ok(captured.events.some((event) => event.type === 'tool.failed'
        && event.payload.source === 'openrouter-agent-sdk'
        && event.payload.code === scenario.code));
    });
  }
});

test('missing clarification is a canonical waiting-for-user run', async () => {
  const { executeFn, service } = createHarness({
    toolResult: {
      status: 'waiting_input',
      data: { pending: true },
      user_summary: 'Which lead did you mean?',
    },
  });
  const outcome = await service.runAgentLoop({
    userPhone: '919000000004',
    userMessage: 'Move the lead',
    backgroundBlock: '',
    executeFn,
  });

  assert.equal(outcome.status, 'waiting_for_user');
  assert.equal(outcome.text, 'Which lead did you mean?');
});

test('replacing an already-pending approval remains terminal waiting approval', async () => {
  const gate = {
    identity: 'old-pending',
    pendingIdentity() { return this.identity; },
    hasPending() { return true; },
  };
  const { captured, executeFn, service } = createHarness({
    confirmationGate: gate,
    toolResult: async () => {
      gate.identity = 'replacement-pending';
      return 'Approve sending the replacement message?';
    },
    concurrentSecondCall: true,
  });
  const outcome = await service.runAgentLoop({
    userPhone: '919000000005',
    userMessage: 'Send a different message',
    backgroundBlock: '',
    executeFn,
  });

  assert.equal(outcome.status, 'waiting_for_approval');
  assert.equal(captured.toolExecutions.length, 1);
  assert.equal(captured.concurrentObservation.status, 'waiting_approval');
});

test('application tool-call budget blocks an oversized same-response batch before mutation', async () => {
  const { captured, executeFn, service } = createHarness({
    toolRequests: [
      { title: 'One' },
      { title: 'Two' },
      { title: 'Three' },
    ],
    envOverrides: { ARI_AGENT_MAX_TOOL_CALLS: '1' },
  });
  const outcome = await service.runAgentLoop({
    userPhone: '919000000006',
    userMessage: 'Create three tasks',
    backgroundBlock: '',
    executeFn,
  });

  assert.equal(captured.toolExecutions.length, 1);
  assert.equal(captured.claims.length, 1);
  assert.equal(captured.observations[1].error.code, 'agent_tool_limit_reached');
  assert.equal(captured.observations[2].error.code, 'agent_tool_limit_reached');
  assert.equal(outcome.status, 'partial');
});

test('unknown timed-out outcome blocks every queued tool and settles its journal', async () => {
  const { captured, executeFn, service } = createHarness({
    toolRequests: [{ title: 'Slow write' }, { title: 'Must never start' }],
    envOverrides: { ARI_TOOL_TIMEOUT_MS: '1000' },
    toolResult: async (_name, args) => {
      if (args.title === 'Slow write') return new Promise(() => {});
      return { status: 'success', user_summary: 'This must not run.' };
    },
  });
  const outcome = await service.runAgentLoop({
    userPhone: '919000000007',
    userMessage: 'Do the slow write and then another',
    backgroundBlock: '',
    executeFn,
  });

  assert.equal(captured.toolExecutions.length, 1);
  assert.equal(captured.claims.length, 1);
  assert.equal(captured.finishes[0].status, 'unknown');
  assert.equal(captured.observations[0].error.code, 'tool_timeout_unknown_outcome');
  assert.equal(captured.observations[1].error.code, 'tool_timeout_unknown_outcome');
  assert.equal(outcome.status, 'failed');
});

test('external cancellation interrupts a hung tool and no queued tool starts', async () => {
  const controller = new AbortController();
  const { captured, executeFn, service } = createHarness({
    toolRequests: [{ title: 'Hung write' }, { title: 'Queued write' }],
    envOverrides: { ARI_TOOL_TIMEOUT_MS: '4000' },
    toolResult: async (_name, args) => {
      if (args.title === 'Hung write') return new Promise(() => {});
      return { status: 'success', user_summary: 'Queued write ran.' };
    },
  });
  const startedAt = Date.now();
  const run = service.runAgentLoop({
    userPhone: '919000000008',
    userMessage: 'Start two writes',
    backgroundBlock: '',
    executeFn,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(new Error('cancelled by test')), 25);
  const outcome = await run;

  assert.ok(Date.now() - startedAt < 1000, 'cancellation should not wait for the tool timeout');
  assert.equal(captured.toolExecutions.length, 1);
  assert.equal(captured.claims.length, 1);
  assert.equal(captured.finishes[0].status, 'unknown');
  assert.equal(captured.observations[0].error.code, 'tool_aborted_unknown_outcome');
  assert.equal(captured.observations[1].error.code, 'tool_aborted_unknown_outcome');
  assert.equal(outcome.status, 'failed');
});

test('repairs stop-limit state without executing its pending function call', () => {
  const state = {
    id: 'state-limit', status: 'complete', createdAt: 1, updatedAt: 2,
    messages: [
      { role: 'user', content: 'Create one more task' },
      { type: 'function_call', id: 'fc-item', callId: 'call-limit', name: 'manage_tasks', arguments: '{}' },
    ],
  };
  const repaired = repairUnpairedFunctionCalls(state);

  assert.equal(repaired.repaired.length, 1);
  assert.equal(repaired.state.messages.at(-1).type, 'function_call_output');
  assert.equal(repaired.state.messages.at(-1).callId, 'call-limit');
  assert.match(repaired.state.messages.at(-1).output, /agent_limit_reached/);
  assert.equal(state.messages.length, 2, 'repair must not mutate SDK-owned state');
});

test('ESM bridge matches the pinned OpenRouter Agent SDK request contract', async () => {
  const runtime = await import('../src/services/openrouter-agent-runtime.mjs');
  let captured = null;
  const client = {
    callModel(request, requestOptions) {
      captured = { request, requestOptions };
      return {
        async getText() { return 'Bridge response'; },
        async getResponse() { return { status: 'completed', model: 'test/model' }; },
        async getState() { return { id: 'bridge-state', messages: [] }; },
        async cancel() {},
      };
    },
  };

  const result = await runtime.executeAgentTurn({
    client,
    models: ['test/model'],
    input: 'Run the probe',
    instructions: 'Use the probe safely.',
    toolSpecs: [{
      name: 'probe',
      description: 'Probe the SDK tool contract.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
    }],
    executeTool: async () => ({ status: 'success' }),
    stateAccessor: { async load() { return null; }, async save() {} },
    conversationId: 'bridge-conversation',
    safetyIdentifier: 'bridge-user',
    parallelToolCalls: false,
    maxToolCalls: 2,
    maxOutputTokens: 64,
    provider: { dataCollection: 'deny', zdr: true },
    maxSteps: 3,
    maxTokens: 1000,
    maxCostUsd: 0.1,
    requestTimeoutMs: 5000,
    overallTimeoutMs: 5000,
    metadata: {},
  });

  assert.equal(result.text, 'Bridge response');
  assert.equal(captured.request.tools[0].type, 'function');
  assert.equal(captured.request.stopWhen.length, 3);
  assert.equal(captured.request.parallelToolCalls, false);
  assert.deepEqual(captured.request.plugins, [{ id: 'context-compression', enabled: false }]);
  assert.equal(captured.requestOptions.timeoutMs, 5000);
});

test('PDF bridge enables parsing only for the fresh file and reuses durable state on follow-up', async () => {
  const runtime = await import('../src/services/openrouter-agent-runtime.mjs');
  const requests = [];
  const priorState = {
    id: 'pdf-state', status: 'complete', createdAt: 1, updatedAt: 2,
    messages: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'parsed' }] }],
  };
  const client = {
    callModel(request) {
      requests.push(request);
      return {
        async getText() { return 'PDF answer'; },
        async getResponse() { return { status: 'completed', output: [] }; },
        async getState() { return priorState; },
      };
    },
  };
  const common = {
    client,
    models: ['test/model'],
    buffer: Buffer.from('%PDF test'),
    filename: 'test.pdf',
    mimeType: 'application/pdf',
    instruction: 'Read it',
    pdfEngine: 'cloudflare-ai',
    maxOutputTokens: 100,
    timeoutMs: 5000,
    provider: { dataCollection: 'deny', zdr: true },
  };

  await runtime.analyzePdf(common);
  await runtime.analyzePdf({ ...common, instruction: 'Follow up', state: priorState });

  assert.equal(Array.isArray(requests[0].input), true);
  assert.equal(requests[0].plugins.some((plugin) => plugin.id === 'file-parser'), true);
  assert.equal(requests[1].input, 'Follow up');
  assert.deepEqual(requests[1].plugins, [{ id: 'context-compression', enabled: false }]);
  assert.equal(await requests[1].state.load(), priorState);
});

test('bridge drains SDK continuation state saves before a cancelled lock can release', async () => {
  const runtime = await import('../src/services/openrouter-agent-runtime.mjs');
  const order = [];
  const external = new AbortController();
  const stateAccessor = {
    async load() { return null; },
    async save() { order.push('state-save'); },
  };
  const client = {
    callModel(request, requestOptions) {
      const toolContinuation = request.tools[0].function.execute(
        { title: 'Slow task' },
        { toolCall: { callId: 'cancel-call' }, numberOfTurns: 0 }
      ).then(async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        await request.state.save({ id: 'cancelled-state', messages: [] });
        return { status: 'cancelled' };
      });
      const abortRejection = new Promise((_, reject) => {
        requestOptions.signal.addEventListener('abort', () => reject(new Error('aborted stream')), { once: true });
      });
      return {
        getText() { return abortRejection; },
        getResponse() { return toolContinuation; },
        getState() { return toolContinuation; },
        async cancel() {},
      };
    },
  };
  const turn = runtime.executeAgentTurn({
    client,
    models: ['test/model'],
    input: 'Create a task',
    instructions: 'Test cancellation.',
    toolSpecs: [TASK_TOOL],
    executeTool: async (_name, _args, meta) => {
      await new Promise((resolve) => meta.signal.addEventListener('abort', resolve, { once: true }));
      order.push('tool-callback');
      return { status: 'failure', error: { code: 'cancelled' } };
    },
    stateAccessor,
    conversationId: 'cancel-conversation',
    safetyIdentifier: 'cancel-user',
    parallelToolCalls: false,
    maxToolCalls: 2,
    maxOutputTokens: 64,
    provider: { dataCollection: 'deny', zdr: true },
    maxSteps: 3,
    maxTokens: 1000,
    maxCostUsd: 0.1,
    requestTimeoutMs: 5000,
    overallTimeoutMs: 5000,
    metadata: {},
    signal: external.signal,
  });

  setTimeout(() => external.abort(new Error('cancel test')), 10);
  await assert.rejects(turn, /aborted|cancel/i);
  order.push('lock-release');
  assert.deepEqual(order, ['tool-callback', 'state-save', 'lock-release']);
});
