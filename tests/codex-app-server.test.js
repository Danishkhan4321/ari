'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BASE_INSTRUCTIONS,
  CORE_TOOLS,
  CodexAppServerClient,
  DEVELOPER_INSTRUCTIONS,
  applicationToolCallLimit,
  ariProviderTools,
  codexTurnTimeoutMs,
  deriveAppServerOutcome,
  dynamicToolSpecs,
  isRecoverableCapacityOutcome,
  itemActivity,
  normalizeUsage,
  promptForTurn,
  reconcilePersistedThreadOutcome,
  runCapacityContinuationLoop,
  safeJson,
  targetTriple,
  threadPreferenceKey,
} = require('../src/services/codex-app-server.service');

test('App Server gives a long task five minutes per resumable segment', () => {
  assert.equal(codexTurnTimeoutMs?.(), 300_000);
  assert.equal(codexTurnTimeoutMs?.('45000'), 45_000);
});

test('only a known application-capacity stop is safe to continue automatically', () => {
  const capacity = {
    status: 'partial',
    toolResults: [{ status: 'failure', error: { code: 'agent_tool_limit_reached' } }],
  };
  const unknown = {
    status: 'partial',
    toolResults: [{ status: 'partial', error: { code: 'tool_timeout_unknown_outcome' } }],
  };
  assert.equal(isRecoverableCapacityOutcome?.(capacity), true);
  assert.equal(isRecoverableCapacityOutcome?.(unknown), false);
});

test('capacity continuation resumes verified progress and aggregates every segment', async () => {
  const inputs = [];
  const segments = [
    {
      status: 'partial', text: '11 groups created.', steps: 22,
      toolsUsed: ['analyze_file', 'manage_contact_groups'],
      toolResults: [
        { status: 'success', tool: 'manage_contact_groups', data: { group: 'Group 11' } },
        { status: 'failure', tool: 'manage_contact_groups', error: { code: 'agent_tool_limit_reached' } },
      ],
      latencyMs: 80_000,
    },
    {
      status: 'completed', text: 'All 16 groups are ready.', steps: 9,
      toolsUsed: ['manage_contact_groups'],
      toolResults: [{ status: 'success', tool: 'manage_contact_groups', data: { group: 'Group 16' } }],
      latencyMs: 20_000,
    },
  ];
  const result = await runCapacityContinuationLoop?.({
    initialInput: 'Create all groups.',
    maxContinuations: 2,
    runSegment: async (input) => {
      inputs.push(input);
      return segments.shift();
    },
  });

  assert.equal(inputs.length, 2);
  assert.match(inputs[1], /do not repeat/i);
  assert.equal(result.status, 'completed');
  assert.equal(result.steps, 31);
  assert.equal(result.latencyMs, 100_000);
  assert.equal(result.meta.continuationCount, 1);
  assert.deepEqual(result.toolsUsed, ['analyze_file', 'manage_contact_groups']);
  assert.equal(result.toolResults.length, 3);
});

async function startTestTurn(client, threadId, onEvent = async () => {}) {
  client.start = async () => client;
  client._requestRaw = async (method) => method === 'turn/start'
    ? { turn: { id: `${threadId}-turn` } }
    : {};
  const running = client.runTurn({
    threadId,
    input: 'Run the requested business action.',
    userPhone: '919999999995',
    finalModel: 'codex:auto',
    onEvent,
  });
  await new Promise((resolve) => setImmediate(resolve));
  return { running };
}

function completeTestTurn(client, threadId, text = 'Done') {
  const turnId = `${threadId}-turn`;
  client._handleNotification({
    method: 'item/completed',
    params: { threadId, turnId, item: { type: 'agentMessage', text } },
  });
  client._handleNotification({
    method: 'turn/completed',
    params: { threadId, turnId, turn: { status: 'completed' } },
  });
}

function sendToolRequest(client, threadId, id, tool) {
  return client._handleServerRequest({
    id,
    method: 'item/tool/call',
    params: { threadId, tool, arguments: {} },
  });
}

test('App Server supports every packaged Windows and macOS architecture', () => {
  assert.deepEqual(targetTriple('win32', 'x64').slice(1), ['x86_64-pc-windows-msvc', 'codex.exe']);
  assert.deepEqual(targetTriple('win32', 'arm64').slice(1), ['aarch64-pc-windows-msvc', 'codex.exe']);
  assert.deepEqual(targetTriple('darwin', 'x64').slice(1), ['x86_64-apple-darwin', 'codex']);
  assert.deepEqual(targetTriple('darwin', 'arm64').slice(1), ['aarch64-apple-darwin', 'codex']);
});

test('App Server exposes every Ari action and defers uncommon tools', () => {
  const specs = dynamicToolSpecs();
  const namespace = specs.find((tool) => tool.type === 'namespace');
  const tools = [
    ...specs.filter((tool) => tool.type === 'function'),
    ...namespace.tools,
  ];
  // 90 = 86 original + manage_campaigns + get_meeting_recordings + complete_reminder + manage_team_comms
  // (July 2026 tool-coverage additions). Codex sees the same catalog as every runtime.
  assert.equal(tools.length, 90);
  assert.equal(new Set(tools.map((tool) => tool.name)).size, 90);
  assert.equal(tools.some((tool) => tool.name === 'meeting_bot'), false);
  for (const tool of specs.filter((item) => item.type === 'function')) {
    assert.equal(tool.type, 'function');
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.deferLoading, false);
  }
  assert.equal(namespace.name, 'ari_extended');
  assert.ok(namespace.tools.length > 60);
  assert.ok(namespace.tools.every((tool) => tool.deferLoading === true));
  assert.equal(specs.find((tool) => tool.name === 'manage_tasks').deferLoading, false);
});

test('App Server usage records the exact last turn instead of thread cumulative usage', () => {
  assert.deepEqual(normalizeUsage({
    total: { totalTokens: 9000, inputTokens: 8500, cachedInputTokens: 8000, outputTokens: 500, reasoningOutputTokens: 100 },
    last: { totalTokens: 1200, inputTokens: 1100, cachedInputTokens: 900, outputTokens: 100, reasoningOutputTokens: 20 },
  }), {
    inputTokens: 1100,
    cachedInputTokens: 900,
    uncachedInputTokens: 200,
    outputTokens: 100,
    reasoningOutputTokens: 20,
    totalTokens: 1200,
    scope: 'turn',
  });
});

test('App Server maps dynamic tool lifecycle events into Ari activity', () => {
  const started = itemActivity('item/started', {
    type: 'dynamicToolCall', tool: 'manage_tasks', status: 'inProgress',
  }, 2);
  const completed = itemActivity('item/completed', {
    type: 'dynamicToolCall', tool: 'manage_tasks', status: 'completed',
  }, 2);
  assert.equal(started.type, 'tool.started');
  assert.equal(completed.type, 'tool.succeeded');
  assert.equal(completed.toolName, 'manage_tasks');
});

test('App Server prompt seeds history only for a new Ari thread', () => {
  const history = [{ role: 'user', content: 'Earlier request' }];
  assert.match(promptForTurn({ userMessage: 'Now', recentMessages: history, includeHistory: true }), /Earlier request/);
  assert.doesNotMatch(promptForTurn({ userMessage: 'Now', recentMessages: history, includeHistory: false }), /Earlier request/);
});

test('App Server persists a different agent thread for every chat session', () => {
  const runtime = { kind: 'codex', modelPreference: 'auto' };
  const first = threadPreferenceKey('919000000001', runtime, '11111111-1111-4111-8111-111111111111');
  const second = threadPreferenceKey('919000000001', runtime, '22222222-2222-4222-8222-222222222222');
  assert.notEqual(first, second);
  assert.match(first, /11111111-1111-4111-8111-111111111111/);
});

test('App Server preserves resumable capacity-stopped threads and clears unsafe partial threads', () => {
  const runtime = { kind: 'codex', modelPreference: 'auto', persistThread: true };
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const key = threadPreferenceKey('919000000001', runtime, sessionId);
  let preferences = {
    codexAppServerThreads: { [key]: 'thread-truth', unrelated: 'thread-other' },
  };
  const store = {
    readPreferences: () => preferences,
    writePreferences: (patch) => { preferences = { ...preferences, ...patch }; return preferences; },
  };

  assert.equal(reconcilePersistedThreadOutcome({
    userPhone: '919000000001', runtime, sessionId, threadId: 'thread-truth', status: 'completed', store,
  }), true);
  assert.equal(preferences.codexAppServerThreads[key], 'thread-truth');

  assert.equal(reconcilePersistedThreadOutcome({
    userPhone: '919000000001',
    runtime,
    sessionId,
    threadId: 'thread-truth',
    status: 'partial',
    outcome: { status: 'partial', meta: { safeToResumeAfterInterruption: true } },
    store,
  }), true);
  assert.equal(preferences.codexAppServerThreads[key], 'thread-truth');

  assert.equal(reconcilePersistedThreadOutcome({
    userPhone: '919000000001', runtime, sessionId, threadId: 'thread-truth', status: 'waiting_for_user', store,
  }), true);
  assert.equal(preferences.codexAppServerThreads[key], 'thread-truth');

  assert.equal(reconcilePersistedThreadOutcome({
    userPhone: '919000000001',
    runtime,
    sessionId,
    threadId: 'thread-truth',
    status: 'partial',
    outcome: {
      status: 'partial',
      toolResults: [{ status: 'failure', error: { code: 'agent_tool_limit_reached' } }],
    },
    store,
  }), true);
  assert.equal(preferences.codexAppServerThreads[key], 'thread-truth');

  assert.equal(reconcilePersistedThreadOutcome({
    userPhone: '919000000001', runtime, sessionId, threadId: 'thread-truth', status: 'partial', store,
  }), false);
  assert.equal(preferences.codexAppServerThreads[key], undefined);
  assert.equal(preferences.codexAppServerThreads.unrelated, 'thread-other');
});

test('Ari provider exposes a focused tool set for vague prompts', async () => {
  const vague = await ariProviderTools('do the thing with Priya tomorrow', {}, [], { skipSemantic: true });
  assert.ok(vague.length <= 18);
  assert.ok(vague.some((tool) => tool.name === 'request_clarification'));
  assert.ok(vague.length < 85);

  const sales = await ariProviderTools('what is going on with sales', {}, [], { skipSemantic: true });
  assert.ok(sales.some((tool) => tool.name === 'manage_sales'));

  const meeting = await ariProviderTools('help me prepare for the meeting', {}, [], { skipSemantic: true });
  assert.ok(meeting.some((tool) => tool.name === 'view_calendar'));
  assert.ok(meeting.some((tool) => tool.name === 'request_clarification'));

  const attachment = await ariProviderTools(
    'go through this and let me know what you see',
    { hasDocumentAttachment: true },
    [],
    { skipSemantic: true },
  );
  assert.ok(attachment.some((tool) => tool.name === 'analyze_file'));
});

test('App Server prompt carries shared background and workflow context', () => {
  const prompt = promptForTurn({
    userMessage: 'move that one',
    recentMessages: [],
    includeHistory: true,
    userTimezone: 'Asia/Kolkata',
    nowIso: '2026-07-16T12:30:00.000Z',
    backgroundBlock: 'CRM: Priya is in proposal stage.',
    contextHints: { lastActionRef: { ageSec: 10, action: 'created', entityType: 'meeting', entityId: 7 } },
  });
  assert.match(prompt, /Thursday, July 16, 2026/);
  assert.match(prompt, /Priya is in proposal stage/);
  assert.match(prompt, /meeting #7/);
});

test('App Server developer instructions keep Codex business-focused', () => {
  assert.match(BASE_INSTRUCTIONS, /business assistant, not a coding workspace/i);
  assert.match(DEVELOPER_INSTRUCTIONS, /vague, incomplete/i);
  assert.match(DEVELOPER_INSTRUCTIONS, /Never use shell commands/i);
});

test('Ari-provider tools are non-deferred and still use the shared registry', () => {
  const selected = dynamicToolSpecs({
    tools: [{ name: 'manage_tasks', description: 'Manage tasks', inputSchema: { type: 'object', properties: {} } }],
    deferExtended: false,
  });
  assert.deepEqual(selected.map((tool) => tool.name), ['manage_tasks']);
  assert.equal(selected[0].deferLoading, false);
});

test('App Server tool observations are bounded and BigInt-safe', () => {
  assert.match(safeJson({ status: 'success', data: { id: 12n } }), /"12"/);
  assert.match(safeJson({ data: 'x'.repeat(100) }, 30), /truncated by Ari/);
});

test('App Server cancellation interrupts the active turn and rejects as cancelled', async () => {
  const client = new CodexAppServerClient({ binary: process.execPath });
  client.start = async () => client;
  const requests = [];
  client._requestRaw = async (method, params) => {
    requests.push({ method, params });
    if (method === 'turn/start') return { turn: { id: 'turn-cancel-1' } };
    return {};
  };
  const controller = new AbortController();
  const running = client.runTurn({
    threadId: 'thread-cancel-1',
    input: 'Start a long request.',
    userPhone: 'test-user',
    finalModel: 'codex:auto',
    onEvent: async () => {},
    signal: controller.signal,
  });

  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error('dashboard stop'));

  await assert.rejects(running, (error) => {
    assert.equal(error.code, 'agent_cancelled');
    return true;
  });
  assert.ok(requests.some(({ method, params }) =>
    method === 'turn/interrupt'
      && params.threadId === 'thread-cancel-1'
      && params.turnId === 'turn-cancel-1'));
  assert.equal(client.runs.has('thread-cancel-1'), false);
});

test('App Server refuses a new business tool after cancellation', async () => {
  const client = new CodexAppServerClient({ binary: process.execPath });
  const writes = [];
  client._write = (message) => writes.push(message);
  const controller = new AbortController();
  controller.abort();
  client.runs.set('thread-cancelled', {
    cancelled: true,
    signal: controller.signal,
    toolCallsAttempted: 0,
  });

  await client._handleServerRequest({
    id: 77,
    method: 'item/tool/call',
    params: { threadId: 'thread-cancelled', tool: 'set_reminder', arguments: {} },
  });

  assert.equal(writes.length, 1);
  assert.equal(writes[0].id, 77);
  assert.match(writes[0].error.message, /cancelled before this tool/i);
});

test('App Server reports cancellation during an in-flight business tool as partial', async (t) => {
  const webhookController = require('../src/controllers/webhook.controller');
  const timezoneService = require('../src/services/timezone.service');
  const originals = {
    timezone: timezoneService.getUserTimezone,
    detectLanguage: webhookController.detectLanguage,
    getContext: webhookController.getContext,
    executeIntent: webhookController.executeIntent,
  };
  t.after(() => {
    timezoneService.getUserTimezone = originals.timezone;
    webhookController.detectLanguage = originals.detectLanguage;
    webhookController.getContext = originals.getContext;
    webhookController.executeIntent = originals.executeIntent;
  });

  let releaseTool;
  let receivedMessage;
  let receivedContext;
  const toolStarted = new Promise((resolve) => {
    webhookController.executeIntent = async (_intent, _args, message, context) => {
      receivedMessage = message;
      receivedContext = context;
      resolve();
      return new Promise((finish) => { releaseTool = () => finish('Reminder saved.'); });
    };
  });
  timezoneService.getUserTimezone = async () => 'Asia/Kolkata';
  webhookController.detectLanguage = () => 'english';
  webhookController.getContext = async () => ({});

  const client = new CodexAppServerClient({ binary: process.execPath });
  client.start = async () => client;
  client._write = () => {};
  client._requestRaw = async (method) => method === 'turn/start'
    ? { turn: { id: 'turn-inflight-1' } }
    : {};
  const controller = new AbortController();
  const running = client.runTurn({
    threadId: 'thread-inflight-1',
    input: 'Set a reminder.',
    userPhone: '919999999996',
    chatSession: { sessionId: '55555555-5555-4555-8555-555555555555' },
    finalModel: 'codex:auto',
    onEvent: async () => {},
    signal: controller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const toolRequest = client._handleServerRequest({
    id: 78,
    method: 'item/tool/call',
    params: {
      threadId: 'thread-inflight-1',
      tool: 'set_reminder',
      arguments: { reminder_message: 'Review the launch plan', due_time: 'tomorrow at 9am' },
    },
  });
  await toolStarted;
  controller.abort(new Error('dashboard stop'));

  const early = await Promise.race([
    running.then(() => 'resolved', () => 'rejected'),
    new Promise((resolve) => setTimeout(() => resolve('pending'), 25)),
  ]);
  assert.equal(early, 'pending');
  assert.equal(receivedMessage.signal, controller.signal);
  assert.equal(receivedContext.agentExecution.signal, controller.signal);

  releaseTool();
  await toolRequest;
  await assert.rejects(running, (error) => {
    assert.equal(error.code, 'agent_cancelled_partial');
    assert.equal(error.toolCallsAttempted, 1);
    assert.match(error.message, /partial or unknown/i);
    return true;
  });
});

test('App Server interruption carries a resumable checkpoint after completed tools', async () => {
  const client = new CodexAppServerClient({
    binary: process.execPath,
    toolExecutor: async () => ({
      status: 'success',
      summary: 'The first CRM group was created.',
      data: { groupId: 41 },
    }),
  });
  client._write = () => {};
  const { running } = await startTestTurn(client, 'thread-checkpointed-interruption');

  await sendToolRequest(client, 'thread-checkpointed-interruption', 112, 'manage_contact_groups');
  client._rejectRun(
    client.runs.get('thread-checkpointed-interruption'),
    Object.assign(new Error('provider stream ended'), { code: 'provider_interrupted' }),
  );

  await assert.rejects(running, (error) => {
    assert.equal(error.code, 'provider_interrupted');
    assert.equal(error.partialOutcome.status, 'partial');
    assert.equal(error.partialOutcome.meta.safeToResumeAfterInterruption, true);
    assert.equal(error.partialOutcome.toolResults[0].data.groupId, 41);
    assert.match(error.partialOutcome.text, /first CRM group was created/i);
    return true;
  });
});

test('App Server tool failure overrides a model Done response with failed truth', async () => {
  const writes = [];
  const client = new CodexAppServerClient({
    binary: process.execPath,
    toolExecutor: async () => ({
      status: 'failure',
      summary: 'The CRM write failed because the record no longer exists.',
      error: { code: 'record_missing', category: 'business_rule', retryable: false },
    }),
  });
  client._write = (message) => writes.push(message);
  const { running } = await startTestTurn(client, 'thread-truth-failed');

  await sendToolRequest(client, 'thread-truth-failed', 101, 'manage_sales');
  completeTestTurn(client, 'thread-truth-failed', 'Done');
  const outcome = await running;

  assert.equal(outcome.status, 'failed');
  assert.doesNotMatch(outcome.text, /^Done$/i);
  assert.match(outcome.text, /CRM write failed/i);
  assert.equal(outcome.toolResults.length, 1);
  assert.equal(outcome.toolResults[0].status, 'failure');
  assert.equal(writes.find((message) => message.id === 101).result.success, false);
});

test('App Server derives partial truth from mixed successful and failed tools', async () => {
  const client = new CodexAppServerClient({
    binary: process.execPath,
    toolExecutor: async (_phone, tool) => tool === 'manage_tasks'
      ? { status: 'success', summary: 'The task was created.', data: { id: 41 } }
      : {
        status: 'failure',
        summary: 'The follow-up could not be scheduled.',
        error: { code: 'calendar_unavailable', retryable: false },
      },
  });
  client._write = () => {};
  const { running } = await startTestTurn(client, 'thread-truth-partial');

  await sendToolRequest(client, 'thread-truth-partial', 102, 'manage_tasks');
  await sendToolRequest(client, 'thread-truth-partial', 103, 'manage_follow_ups');
  completeTestTurn(client, 'thread-truth-partial', 'Everything is done.');
  const outcome = await running;

  assert.equal(outcome.status, 'partial');
  assert.match(outcome.text, /only complete part/i);
  assert.match(outcome.text, /task was created/i);
  assert.match(outcome.text, /follow-up could not be scheduled/i);
  assert.deepEqual(outcome.toolResults.map((result) => result.status), ['success', 'failure']);
});

test('App Server serializes concurrent tools and stops the queue after approval is required', async () => {
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const executed = [];
  const events = [];
  const client = new CodexAppServerClient({
    binary: process.execPath,
    toolExecutor: async (_phone, tool) => {
      executed.push(tool);
      if (tool === 'manage_sales') {
        markFirstStarted();
        await gate;
        return { status: 'waiting_approval', summary: 'Approve the CRM stage change to continue.' };
      }
      return { status: 'success', summary: 'This queued action should never execute.' };
    },
  });
  client._write = () => {};
  const { running } = await startTestTurn(
    client,
    'thread-serialized-approval',
    async (event) => events.push(event),
  );

  const first = sendToolRequest(client, 'thread-serialized-approval', 104, 'manage_sales');
  await firstStarted;
  const second = sendToolRequest(client, 'thread-serialized-approval', 105, 'set_reminder');
  releaseFirst();
  await Promise.all([first, second]);
  completeTestTurn(client, 'thread-serialized-approval');
  const outcome = await running;

  assert.deepEqual(executed, ['manage_sales']);
  assert.equal(outcome.status, 'waiting_for_approval');
  assert.deepEqual(outcome.toolResults.map((result) => result.status), ['waiting_approval', 'failure']);
  assert.equal(outcome.toolResults[1].error.code, 'tool_blocked_pending_user');
  assert.ok(events.some((event) => event.type === 'run.waiting_for_approval'));
});

test('App Server preserves approval and user-input waiting states', () => {
  assert.equal(deriveAppServerOutcome([
    { status: 'waiting_approval', user_summary: 'Approve this.' },
  ]).status, 'waiting_for_approval');
  assert.equal(deriveAppServerOutcome([
    { status: 'waiting_input', user_summary: 'Choose a date.' },
  ]).status, 'waiting_for_user');
});

test('App Server stops queued tools after an unknown application outcome', async () => {
  const executed = [];
  const writes = [];
  const client = new CodexAppServerClient({
    binary: process.execPath,
    toolExecutor: async (_phone, tool) => {
      executed.push(tool);
      return {
        status: 'partial',
        summary: 'The CRM update may have run, but its outcome could not be verified.',
        error: {
          code: 'tool_timeout_unknown_outcome',
          category: 'unknown_outcome',
          retryable: false,
        },
      };
    },
  });
  client._write = (message) => writes.push(message);
  const { running } = await startTestTurn(client, 'thread-unknown-outcome');

  await sendToolRequest(client, 'thread-unknown-outcome', 108, 'manage_sales');
  await sendToolRequest(client, 'thread-unknown-outcome', 109, 'set_reminder');
  completeTestTurn(client, 'thread-unknown-outcome');
  const outcome = await running;

  assert.deepEqual(executed, ['manage_sales']);
  assert.equal(outcome.status, 'partial');
  assert.equal(writes.find((message) => message.id === 108).result.success, false);
  assert.equal(outcome.toolResults[1].error.code, 'tool_blocked_terminal_outcome');
});

test('App Server enforces the shared application tool-call limit before execution', async () => {
  const writes = [];
  let executions = 0;
  const client = new CodexAppServerClient({
    binary: process.execPath,
    maxToolCalls: 1,
    toolExecutor: async () => {
      executions += 1;
      return { status: 'success', summary: 'The first action completed.' };
    },
  });
  client._write = (message) => writes.push(message);
  const { running } = await startTestTurn(client, 'thread-tool-limit');

  await sendToolRequest(client, 'thread-tool-limit', 106, 'manage_tasks');
  await sendToolRequest(client, 'thread-tool-limit', 107, 'set_reminder');
  await sendToolRequest(client, 'thread-tool-limit', 110, 'manage_contact_groups');
  completeTestTurn(client, 'thread-tool-limit');
  const outcome = await running;

  assert.equal(applicationToolCallLimit(''), 12);
  assert.equal(executions, 1);
  assert.equal(outcome.status, 'partial');
  assert.equal(outcome.toolResults[1].error.code, 'agent_tool_limit_reached');
  assert.equal(outcome.toolResults[2].error.code, 'tool_blocked_capacity');
  assert.match(outcome.toolResults[2].user_summary, /capacity|tool safety limit/i);
  assert.doesNotMatch(outcome.toolResults[2].user_summary, /unknown outcome/i);
  assert.equal(writes.find((message) => message.id === 107).result.success, false);
});
