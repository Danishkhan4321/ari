'use strict';

process.env.AGENTIC_MODE_ALL = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');

const controller = require('../src/controllers/webhook.controller');
const agentLoop = require('../src/services/agent-loop.service');
const { agentRunService } = require('../src/services/agent-run.service');
const { fileArtifactService } = require('../src/services/file-artifact.service');
const { runWithChatSession } = require('../src/services/chat-session-context');

test('_runAgenticTurn persists lifecycle events and the terminal run status', async (t) => {
  const calls = [];
  const originals = {
    runAgentLoop: agentLoop.runAgentLoop,
    startRun: agentRunService.startRun,
    recordEvent: agentRunService.recordEvent,
    finishRun: agentRunService.finishRun,
    hints: controller.getIntentContextHints,
  };
  t.after(() => {
    agentLoop.runAgentLoop = originals.runAgentLoop;
    agentRunService.startRun = originals.startRun;
    agentRunService.recordEvent = originals.recordEvent;
    agentRunService.finishRun = originals.finishRun;
    controller.getIntentContextHints = originals.hints;
  });

  agentRunService.startRun = async (input) => {
    calls.push({ kind: 'start', input });
    return { runId: '33333333-3333-4333-8333-333333333333', persisted: true };
  };
  agentRunService.recordEvent = async (event) => { calls.push({ kind: 'event', event }); };
  agentRunService.finishRun = async (input) => { calls.push({ kind: 'finish', input }); return true; };
  controller.getIntentContextHints = async () => ({});
  agentLoop.runAgentLoop = async (options) => {
    await options.onEvent({ type: 'run.started', step: 0, summary: 'Understanding your request', payload: {} });
    await options.onEvent({ type: 'run.completed', step: 1, summary: 'Completed', payload: {} });
    return {
      status: 'completed', text: 'Done.', steps: 1, toolsUsed: ['view_calendar'],
      toolResults: [{
        status: 'success', tool: 'view_calendar', user_summary: 'Calendar loaded.',
        data: { events: 3 },
      }],
      latencyMs: 5, finalModel: 'test-model',
      usage: { inputTokens: 100, cachedInputTokens: 80, uncachedInputTokens: 20, outputTokens: 10, reasoningOutputTokens: 0, totalTokens: 110 },
    };
  };

  const response = await controller._runAgenticTurn(
    { from: '919999999999', text: 'prepare my day', source: 'dashboard' },
    { userTimezone: 'Asia/Kolkata' },
    []
  );

  assert.equal(response, 'Done.');
  assert.equal(calls[0].kind, 'start');
  assert.equal(calls[0].input.source, 'dashboard');
  // run.finished is the live-stream terminator emitted after finishRun so
  // connected dashboards finalize their draft (July 2026 streaming UX).
  assert.deepEqual(calls.filter((call) => call.kind === 'event').map((call) => call.event.type), [
    'run.started', 'run.completed', 'run.finished',
  ]);
  const finished = calls.find((call) => call.kind === 'finish').input;
  assert.equal(finished.status, 'completed');
  assert.equal(finished.model, 'test-model');
  assert.equal(finished.steps, 1);
  assert.equal(finished.outcome.usage.totalTokens, 110);
  assert.equal(finished.outcome.toolResults.length, 1,
    'durable run progress must retain typed tool checkpoints for recovery and audit');
  assert.equal(finished.outcome.toolResults[0].data.events, 3);
});

test('_tryAgenticPlatformTurn routes enabled dashboard messages through the agent loop', async (t) => {
  const originals = {
    shouldUseAgentLoop: controller._shouldUseAgentLoop,
    runAgenticTurn: controller._runAgenticTurn,
  };
  t.after(() => {
    controller._shouldUseAgentLoop = originals.shouldUseAgentLoop;
    controller._runAgenticTurn = originals.runAgenticTurn;
  });

  let received;
  controller._shouldUseAgentLoop = () => true;
  controller._runAgenticTurn = async (...args) => {
    received = args;
    return 'Dashboard action complete.';
  };

  const message = { from: 'dashboard:user-1', text: 'prepare my day', source: 'dashboard' };
  const context = { userTimezone: 'Asia/Kolkata' };
  const recentMessages = [{ role: 'user', content: 'hello' }];
  const response = await controller._tryAgenticPlatformTurn(message, context, recentMessages);

  assert.equal(response, 'Dashboard action complete.');
  assert.deepEqual(received, [message, context, recentMessages]);
});

test('_tryAgenticPlatformTurn leaves disabled platform messages on the existing intent path', async (t) => {
  const originals = {
    shouldUseAgentLoop: controller._shouldUseAgentLoop,
    runAgenticTurn: controller._runAgenticTurn,
  };
  t.after(() => {
    controller._shouldUseAgentLoop = originals.shouldUseAgentLoop;
    controller._runAgenticTurn = originals.runAgenticTurn;
  });

  let called = false;
  controller._shouldUseAgentLoop = () => false;
  controller._runAgenticTurn = async () => { called = true; };

  const response = await controller._tryAgenticPlatformTurn(
    { from: 'dashboard:user-1', text: 'hello', source: 'dashboard' },
    {},
    []
  );

  assert.equal(response, null);
  assert.equal(called, false);
});

test('a failed Ari provider turn is surfaced instead of replayed through legacy intent NLP', async (t) => {
  const agnoAgent = require('../src/services/agno-agent.service');
  const openRouterAgent = require('../src/services/openrouter-agent.service');
  const desktopAi = require('../src/services/desktop-ai-preferences.service');
  const originals = {
    agnoConfigured: agnoAgent.isConfigured,
    openRouterConfigured: openRouterAgent.isConfigured,
    readPreferences: desktopAi.readPreferences,
    runAgentLoop: agentLoop.runAgentLoop,
    startRun: agentRunService.startRun,
    recordEvent: agentRunService.recordEvent,
    finishRun: agentRunService.finishRun,
    hints: controller.getIntentContextHints,
  };
  t.after(() => {
    agnoAgent.isConfigured = originals.agnoConfigured;
    openRouterAgent.isConfigured = originals.openRouterConfigured;
    desktopAi.readPreferences = originals.readPreferences;
    agentLoop.runAgentLoop = originals.runAgentLoop;
    agentRunService.startRun = originals.startRun;
    agentRunService.recordEvent = originals.recordEvent;
    agentRunService.finishRun = originals.finishRun;
    controller.getIntentContextHints = originals.hints;
  });

  desktopAi.readPreferences = () => ({ provider: 'ari', model: 'auto' });
  agnoAgent.isConfigured = () => false;
  openRouterAgent.isConfigured = () => false;
  agentRunService.startRun = async () => ({ runId: '14141414-1414-4414-8414-141414141414', persisted: true });
  agentRunService.recordEvent = async () => {};
  agentRunService.finishRun = async () => true;
  controller.getIntentContextHints = async () => ({ hasDocumentAttachment: true });
  agentLoop.runAgentLoop = async () => ({
    status: 'failed',
    errorCode: 'model_error',
    text: 'Vertex rejected the request: Agent Platform API is disabled.',
    steps: 0,
    toolsUsed: [],
    toolResults: [],
    latencyMs: 1,
  });

  const response = await controller._runAgenticTurn(
    { from: '919999999997', text: 'create CRM groups from this lead list', source: 'dashboard' },
    { userTimezone: 'Asia/Kolkata' },
    [],
  );

  assert.match(response, /Vertex rejected.*API is disabled/i);
  assert.doesNotMatch(response, /shopping list|Add milk/i);
});

test('_runAgenticTurn validates and adapts typed model tool calls at the shared executor boundary', async (t) => {
  const agnoAgent = require('../src/services/agno-agent.service');
  const openRouterAgent = require('../src/services/openrouter-agent.service');
  const desktopAi = require('../src/services/desktop-ai-preferences.service');
  const originals = {
    agnoConfigured: agnoAgent.isConfigured,
    isConfigured: openRouterAgent.isConfigured,
    runOpenRouterAgent: openRouterAgent.runOpenRouterAgent,
    readPreferences: desktopAi.readPreferences,
    startRun: agentRunService.startRun,
    recordEvent: agentRunService.recordEvent,
    finishRun: agentRunService.finishRun,
    hints: controller.getIntentContextHints,
    executeIntent: controller.executeIntent,
  };
  t.after(() => {
    agnoAgent.isConfigured = originals.agnoConfigured;
    openRouterAgent.isConfigured = originals.isConfigured;
    openRouterAgent.runOpenRouterAgent = originals.runOpenRouterAgent;
    desktopAi.readPreferences = originals.readPreferences;
    agentRunService.startRun = originals.startRun;
    agentRunService.recordEvent = originals.recordEvent;
    agentRunService.finishRun = originals.finishRun;
    controller.getIntentContextHints = originals.hints;
    controller.executeIntent = originals.executeIntent;
  });

  let executed;
  let openRouterCalls = 0;
  desktopAi.readPreferences = () => ({ provider: 'ari', model: 'auto' });
  agentRunService.startRun = async () => ({ runId: '23232323-2323-4323-8323-232323232323', persisted: true });
  agentRunService.recordEvent = async () => {};
  agentRunService.finishRun = async () => true;
  controller.getIntentContextHints = async () => ({});
  controller.executeIntent = async (intentType, args, message, context) => {
    executed = { intentType, args, message, context };
    return 'Draft prepared.';
  };
  agnoAgent.isConfigured = () => false;
  openRouterAgent.isConfigured = () => true;
  openRouterAgent.runOpenRouterAgent = async (options) => {
    openRouterCalls++;
    const sendEmail = options.tools.find((tool) => tool.function?.name === 'send_email');
    assert.ok(sendEmail, 'the runtime receives the canonical send_email contract');
    assert.deepEqual(sendEmail.function.parameters.required, ['recipients', 'body']);
    assert.equal(sendEmail.function.parameters.additionalProperties, false);
    assert.equal(Object.hasOwn(sendEmail.function.parameters.properties, 'full_text'), false);

    const result = await options.executeFn('send_email', {
      recipients: ['sam@example.com'],
      subject: 'Launch notes',
      body: 'The launch is ready.',
    }, { callId: 'call-23' });
    assert.equal(result.status, 'success');
    return {
      status: 'completed', text: 'Draft prepared.', steps: 1, toolsUsed: ['send_email'],
      toolResults: [result], latencyMs: 1, finalModel: 'openrouter:test',
    };
  };

  const response = await controller._runAgenticTurn(
    { from: '919999999923', text: 'Please email Sam the launch notes', source: 'dashboard' },
    { userTimezone: 'Asia/Kolkata' },
    [],
  );

  assert.equal(response, 'Draft prepared.');
  assert.equal(openRouterCalls, 1, 'unconfigured default Agno falls back to direct OpenRouter exactly once');
  assert.deepEqual(executed.args.recipients, ['sam@example.com']);
  assert.equal(executed.args.body, 'The launch is ready.');
  assert.match(executed.args.full_text, /(?:draft|send) an email to sam@example\.com/i);
  assert.equal(executed.message.text, executed.args.full_text);
  assert.equal(executed.context.agentExecution.toolEffect, 'external_write');
  assert.equal(executed.context.agentExecution.requiresConfirmation, true);
});

test('_runAgenticTurn uses the Agno OpenRouter runtime by default', async (t) => {
  const agnoAgent = require('../src/services/agno-agent.service');
  const openRouterAgent = require('../src/services/openrouter-agent.service');
  const desktopAi = require('../src/services/desktop-ai-preferences.service');
  const contextBuilder = require('../src/services/context-builder.service');
  const { agentConversationSummaryService } = require('../src/services/agent-conversation-summary.service');
  const originals = {
    agnoConfigured: agnoAgent.isConfigured,
    runAgnoAgent: agnoAgent.runAgnoAgent,
    openRouterConfigured: openRouterAgent.isConfigured,
    runOpenRouterAgent: openRouterAgent.runOpenRouterAgent,
    readPreferences: desktopAi.readPreferences,
    startRun: agentRunService.startRun,
    recordEvent: agentRunService.recordEvent,
    finishRun: agentRunService.finishRun,
    hints: controller.getIntentContextHints,
    executeIntent: controller.executeIntent,
    toAgentFiles: fileArtifactService.toAgentFilesForCurrentTurn,
    buildContext: contextBuilder.build,
    getSummaryContext: agentConversationSummaryService.getContext,
    runtime: process.env.ARI_AGENT_RUNTIME,
  };
  t.after(() => {
    agnoAgent.isConfigured = originals.agnoConfigured;
    agnoAgent.runAgnoAgent = originals.runAgnoAgent;
    openRouterAgent.isConfigured = originals.openRouterConfigured;
    openRouterAgent.runOpenRouterAgent = originals.runOpenRouterAgent;
    desktopAi.readPreferences = originals.readPreferences;
    agentRunService.startRun = originals.startRun;
    agentRunService.recordEvent = originals.recordEvent;
    agentRunService.finishRun = originals.finishRun;
    controller.getIntentContextHints = originals.hints;
    controller.executeIntent = originals.executeIntent;
    fileArtifactService.toAgentFilesForCurrentTurn = originals.toAgentFiles;
    contextBuilder.build = originals.buildContext;
    agentConversationSummaryService.getContext = originals.getSummaryContext;
    if (originals.runtime === undefined) delete process.env.ARI_AGENT_RUNTIME;
    else process.env.ARI_AGENT_RUNTIME = originals.runtime;
  });

  delete process.env.ARI_AGENT_RUNTIME;
  desktopAi.readPreferences = () => ({ provider: 'ari', model: 'auto' });
  agentRunService.startRun = async () => ({ runId: '24242424-2424-4424-8424-242424242424', persisted: true });
  agentRunService.recordEvent = async () => {};
  agentRunService.finishRun = async () => true;
  controller.getIntentContextHints = async () => ({});
  contextBuilder.build = async () => 'Current CRM context.';
  agentConversationSummaryService.getContext = async () => 'CANONICAL CROSS-PROVIDER CONVERSATION SUMMARY:\nProject Atlas is active.';
  controller.executeIntent = async () => ({ status: 'success', data: { events: [] }, user_summary: 'Calendar checked.' });
  const safeFiles = [{
    artifact_id: 'session:33333333-3333-4333-8333-333333333333',
    path: 'C:\\safe-root\\brief.pdf',
    name: 'brief.pdf',
    mime_type: 'application/pdf',
    size: 12,
  }];
  fileArtifactService.toAgentFilesForCurrentTurn = async () => safeFiles;
  agnoAgent.isConfigured = () => true;
  openRouterAgent.isConfigured = () => true;
  openRouterAgent.runOpenRouterAgent = async () => ({
    status: 'completed', text: 'Compatibility runtime was selected.', steps: 0,
    toolsUsed: [], toolResults: [], latencyMs: 1, finalModel: 'openrouter:test',
  });
  let agnoCalled = false;
  let agnoFiles;
  let agnoBackgroundBlock;
  agnoAgent.runAgnoAgent = async (options) => {
    agnoCalled = true;
    agnoFiles = options.files;
    agnoBackgroundBlock = options.backgroundBlock;
    const result = await options.executeFn('view_calendar', { limit: 5 }, {
      callId: 'agno-tool-1', runtime: 'agno-openrouter',
    });
    return {
      status: 'completed', text: 'Your calendar is clear.', steps: 1,
      toolsUsed: ['view_calendar'], toolResults: [result], latencyMs: 1,
      finalModel: 'openrouter:openai/gpt-4.1-mini', engine: 'agno-openrouter',
    };
  };

  const response = await runWithChatSession({
    sessionId: '11111111-1111-4111-8111-111111111111',
    clientMessageId: '22222222-2222-4222-8222-222222222222',
  }, () => controller._runAgenticTurn(
    { from: '919999999924', text: 'Am I free today?', source: 'dashboard' },
    { userTimezone: 'Asia/Kolkata' },
    [],
  ));

  assert.equal(agnoCalled, true);
  assert.deepEqual(agnoFiles, safeFiles);
  assert.match(agnoBackgroundBlock, /Current CRM context/);
  assert.match(agnoBackgroundBlock, /Project Atlas is active/);
  assert.equal(response, 'Your calendar is clear.');
});

test('shared executor centrally gates destructive model calls before a handler can run', async (t) => {
  const openRouterAgent = require('../src/services/openrouter-agent.service');
  const desktopAi = require('../src/services/desktop-ai-preferences.service');
  const confirmationGate = require('../src/services/confirmation-gate.service');
  const originals = {
    isConfigured: openRouterAgent.isConfigured,
    runOpenRouterAgent: openRouterAgent.runOpenRouterAgent,
    readPreferences: desktopAi.readPreferences,
    startRun: agentRunService.startRun,
    recordEvent: agentRunService.recordEvent,
    finishRun: agentRunService.finishRun,
    hints: controller.getIntentContextHints,
    executeIntent: controller.executeIntent,
    pend: confirmationGate.pend,
    runtime: process.env.ARI_AGENT_RUNTIME,
  };
  t.after(() => {
    openRouterAgent.isConfigured = originals.isConfigured;
    openRouterAgent.runOpenRouterAgent = originals.runOpenRouterAgent;
    desktopAi.readPreferences = originals.readPreferences;
    agentRunService.startRun = originals.startRun;
    agentRunService.recordEvent = originals.recordEvent;
    agentRunService.finishRun = originals.finishRun;
    controller.getIntentContextHints = originals.hints;
    controller.executeIntent = originals.executeIntent;
    confirmationGate.pend = originals.pend;
    if (originals.runtime === undefined) delete process.env.ARI_AGENT_RUNTIME;
    else process.env.ARI_AGENT_RUNTIME = originals.runtime;
  });

  process.env.ARI_AGENT_RUNTIME = 'openrouter';
  desktopAi.readPreferences = () => ({ provider: 'ari', model: 'auto' });
  agentRunService.startRun = async () => ({ runId: '25252525-2525-4525-8525-252525252525', persisted: true });
  agentRunService.recordEvent = async () => {};
  agentRunService.finishRun = async () => true;
  controller.getIntentContextHints = async () => ({});
  let handlerCalls = 0;
  let pending;
  controller.executeIntent = async (_intent, _args, _message, context) => {
    handlerCalls++;
    assert.equal(context.agentExecution.confirmedByPolicy, true);
    return 'Deleted Acme.';
  };
  confirmationGate.pend = async (_user, options) => {
    pending = options;
    return 'Approve deleting Acme?';
  };
  openRouterAgent.isConfigured = () => true;
  openRouterAgent.runOpenRouterAgent = async (options) => {
    const result = await options.executeFn('manage_sales', {
      action: 'delete', lead_name: 'Acme',
    }, { callId: 'destructive-call' });
    assert.equal(result.status, 'waiting_approval');
    return {
      status: 'waiting_approval', text: result.user_summary, steps: 1,
      toolsUsed: ['manage_sales'], toolResults: [result], latencyMs: 1,
      finalModel: 'openrouter:test',
    };
  };

  const response = await controller._runAgenticTurn(
    { from: '919999999925', text: 'Delete the Acme lead', source: 'dashboard' },
    { userTimezone: 'Asia/Kolkata' },
    [],
  );

  assert.equal(handlerCalls, 0, 'destructive handler must not run before approval');
  assert.match(response, /approve deleting Acme/i);
  assert.equal(pending.actionType, 'agent_tool:manage_sales');
  assert.match(pending.summary, /action: delete/i);
  const confirmed = await pending.execute();
  assert.equal(confirmed, 'Deleted Acme.');
  assert.equal(handlerCalls, 1);
});

test('shared executor reports legacy workflow previews as waiting for approval', async (t) => {
  const openRouterAgent = require('../src/services/openrouter-agent.service');
  const desktopAi = require('../src/services/desktop-ai-preferences.service');
  const phone = '919999999927';
  const originals = {
    isConfigured: openRouterAgent.isConfigured,
    runOpenRouterAgent: openRouterAgent.runOpenRouterAgent,
    readPreferences: desktopAi.readPreferences,
    startRun: agentRunService.startRun,
    recordEvent: agentRunService.recordEvent,
    finishRun: agentRunService.finishRun,
    hints: controller.getIntentContextHints,
    executeIntent: controller.executeIntent,
    runtime: process.env.ARI_AGENT_RUNTIME,
  };
  t.after(() => {
    openRouterAgent.isConfigured = originals.isConfigured;
    openRouterAgent.runOpenRouterAgent = originals.runOpenRouterAgent;
    desktopAi.readPreferences = originals.readPreferences;
    agentRunService.startRun = originals.startRun;
    agentRunService.recordEvent = originals.recordEvent;
    agentRunService.finishRun = originals.finishRun;
    controller.getIntentContextHints = originals.hints;
    controller.executeIntent = originals.executeIntent;
    controller.calendarConfirmContext.delete(phone);
    if (originals.runtime === undefined) delete process.env.ARI_AGENT_RUNTIME;
    else process.env.ARI_AGENT_RUNTIME = originals.runtime;
  });

  process.env.ARI_AGENT_RUNTIME = 'openrouter';
  desktopAi.readPreferences = () => ({ provider: 'ari', model: 'auto' });
  agentRunService.startRun = async () => ({ runId: '27272727-2727-4727-8727-272727272727', persisted: true });
  agentRunService.recordEvent = async () => {};
  agentRunService.finishRun = async () => true;
  controller.getIntentContextHints = async () => ({});
  controller.executeIntent = async () => {
    controller.calendarConfirmContext.set(phone, {
      type: 'event_create_confirm', timestamp: Date.now(), title: 'Launch review',
    });
    return 'Calendar preview: Launch review tomorrow at 3pm. Reply yes to create it.';
  };
  openRouterAgent.isConfigured = () => true;
  openRouterAgent.runOpenRouterAgent = async (options) => {
    const result = await options.executeFn('create_calendar_event', {
      title: 'Launch review', start_time: 'tomorrow at 3pm',
    }, { callId: 'calendar-preview-call' });
    assert.equal(result.status, 'waiting_approval');
    assert.equal(result.data.pending, true);
    return {
      status: 'waiting_approval', text: result.user_summary, steps: 1,
      toolsUsed: ['create_calendar_event'], toolResults: [result], latencyMs: 1,
      finalModel: 'openrouter:test',
    };
  };

  const response = await controller._runAgenticTurn(
    { from: phone, text: 'Schedule launch review tomorrow at 3pm', source: 'dashboard' },
    { userTimezone: 'Asia/Kolkata' },
    [],
  );

  assert.match(response, /reply yes to create it/i);
});

test('clear chat defers the agent journal for the Agno runtime to avoid a nested lock', async (t) => {
  const aiService = require('../src/services/ai.service');
  const original = aiService.clearHistory;
  t.after(() => { aiService.clearHistory = original; });
  let received;
  aiService.clearHistory = async (_phone, options) => {
    received = options;
    return true;
  };

  const reply = await controller.executeIntent(
    'clear_history',
    {},
    { from: '919999999926', text: 'clear this chat' },
    { agentExecution: { runtime: 'agno-openrouter' } },
  );

  assert.equal(received.deferAgentState, true);
  assert.match(reply, /Chat history cleared/i);
});

test('typed handler arguments survive the controller bridge without being discarded', async (t) => {
  const names = [
    'handleDelegate',
    'handleTeamManage',
    'handleLeaveManage',
    'handlePollManage',
    'handleScheduledMessage',
    'handleDriveUpload',
    'handleEmailSend',
    'handleEmailSchedule',
    'handleEmailBulk',
  ];
  const originals = Object.fromEntries(names.map((name) => [name, controller[name]]));
  t.after(() => Object.assign(controller, originals));

  const seen = [];
  for (const name of names) {
    controller[name] = async (...args) => {
      seen.push({ name, args });
      return name;
    };
  }
  const params = { action: 'typed', marker: 'keep-me' };
  const message = { from: '919999999928', text: 'natural request' };
  const context = { userTimezone: 'Asia/Kolkata' };
  const routes = [
    ['delegate', 'handleDelegate'],
    ['team_manage', 'handleTeamManage'],
    ['leave_manage', 'handleLeaveManage'],
    ['poll_manage', 'handlePollManage'],
    ['scheduled_message', 'handleScheduledMessage'],
    ['drive_upload', 'handleDriveUpload'],
    ['email_send', 'handleEmailSend'],
    ['email_schedule', 'handleEmailSchedule'],
    ['email_bulk', 'handleEmailBulk'],
  ];
  for (const [intent, method] of routes) {
    assert.equal(await controller.handleSpecialCommand(intent, message, context, params), method);
  }
  for (const call of seen) {
    assert.equal(call.args.at(-1), params, `${call.name} discarded typed args`);
  }
});

test('typed memory recall and forget use current versioned keys instead of synthetic prose', async (t) => {
  const versionedMemory = require('../src/services/versioned-memory.service');
  const originals = {
    recall: versionedMemory.recallCurrentFacts,
    forget: versionedMemory.forgetCurrentFact,
  };
  t.after(() => {
    versionedMemory.recallCurrentFacts = originals.recall;
    versionedMemory.forgetCurrentFact = originals.forget;
  });
  let recallInput;
  let forgetInput;
  versionedMemory.recallCurrentFacts = async (input) => {
    recallInput = input;
    return {
      success: true,
      facts: [{ subject: 'user', key_name: 'home_city', value: 'Mumbai' }],
    };
  };
  versionedMemory.forgetCurrentFact = async (input) => {
    forgetInput = input;
    return { success: true, forgotten: 1 };
  };
  const message = { from: '919999999929', text: 'what city do I live in?' };

  const recalled = await controller.executeIntent(
    'memory_recall', { action: 'recall', query: 'home city' }, message, {},
  );
  assert.equal(recallInput.query, 'home city');
  assert.match(recalled, /home_city: Mumbai/);

  const forgotten = await controller.executeIntent(
    'memory_recall', { action: 'forget', key: 'home_city' }, message, {},
  );
  assert.equal(forgetInput.key, 'home_city');
  assert.match(forgotten, /Forgot "home_city"/);
});

test('a cancelled queued dashboard message exits before agent or intent fallback', async (t) => {
  const originals = {
    acquireUserLock: controller.acquireUserLock,
    releaseUserLock: controller.releaseUserLock,
    runAgent: controller._tryAgenticPlatformTurn,
    isRateLimited: controller.isRateLimited,
  };
  t.after(() => Object.assign(controller, originals));

  const calls = [];
  controller.isRateLimited = () => false;
  controller.acquireUserLock = async () => { calls.push('lock'); };
  controller.releaseUserLock = () => { calls.push('release'); };
  controller._tryAgenticPlatformTurn = async () => { calls.push('agent'); return null; };
  const aborted = new AbortController();
  aborted.abort(new Error('cancelled while queued'));

  await controller.handlePlatformMessage({
    userId: '919999999998',
    text: 'delete the lead',
    type: 'text',
    platform: 'whatsapp',
    source: 'dashboard',
    signal: aborted.signal,
  });

  assert.deepEqual(calls, ['lock', 'release']);
});

test('_runAgenticTurn forwards the dashboard cancellation signal to Codex', async (t) => {
  const codexAgent = require('../src/services/codex-agent.service');
  const desktopAi = require('../src/services/desktop-ai-preferences.service');
  const originals = {
    runCodexAgent: codexAgent.runCodexAgent,
    readPreferences: desktopAi.readPreferences,
    shouldUseSharedAppServer: desktopAi.shouldUseSharedAppServer,
    startRun: agentRunService.startRun,
    recordEvent: agentRunService.recordEvent,
    finishRun: agentRunService.finishRun,
    hints: controller.getIntentContextHints,
  };
  t.after(() => {
    codexAgent.runCodexAgent = originals.runCodexAgent;
    desktopAi.readPreferences = originals.readPreferences;
    desktopAi.shouldUseSharedAppServer = originals.shouldUseSharedAppServer;
    agentRunService.startRun = originals.startRun;
    agentRunService.recordEvent = originals.recordEvent;
    agentRunService.finishRun = originals.finishRun;
    controller.getIntentContextHints = originals.hints;
  });

  const abortController = new AbortController();
  let receivedSignal = null;
  desktopAi.readPreferences = () => ({ provider: 'codex', model: 'auto' });
  desktopAi.shouldUseSharedAppServer = () => true;
  agentRunService.startRun = async () => ({ runId: '44444444-4444-4444-8444-444444444444', persisted: true });
  agentRunService.recordEvent = async () => {};
  agentRunService.finishRun = async () => true;
  controller.getIntentContextHints = async () => ({});
  codexAgent.runCodexAgent = async (options) => {
    receivedSignal = options.signal;
    return {
      text: 'Done.', status: 'completed', steps: 0, toolsUsed: [],
      latencyMs: 1, finalModel: 'codex:auto',
    };
  };

  const response = await controller._runAgenticTurn(
    {
      from: '919999999997', text: 'prepare my day', source: 'dashboard',
      signal: abortController.signal,
    },
    { userTimezone: 'Asia/Kolkata' },
    [],
  );

  assert.equal(response, 'Done.');
  assert.equal(receivedSignal, abortController.signal);
});

test('Codex cancellation during an in-flight tool is persisted as partial, not clean cancelled', async (t) => {
  const codexAgent = require('../src/services/codex-agent.service');
  const desktopAi = require('../src/services/desktop-ai-preferences.service');
  const originals = {
    runCodexAgent: codexAgent.runCodexAgent,
    readPreferences: desktopAi.readPreferences,
    shouldUseSharedAppServer: desktopAi.shouldUseSharedAppServer,
    startRun: agentRunService.startRun,
    recordEvent: agentRunService.recordEvent,
    finishRun: agentRunService.finishRun,
    hints: controller.getIntentContextHints,
  };
  t.after(() => {
    codexAgent.runCodexAgent = originals.runCodexAgent;
    desktopAi.readPreferences = originals.readPreferences;
    desktopAi.shouldUseSharedAppServer = originals.shouldUseSharedAppServer;
    agentRunService.startRun = originals.startRun;
    agentRunService.recordEvent = originals.recordEvent;
    agentRunService.finishRun = originals.finishRun;
    controller.getIntentContextHints = originals.hints;
  });

  const finishes = [];
  const events = [];
  const abortController = new AbortController();
  abortController.abort(new Error('dashboard stop'));
  desktopAi.readPreferences = () => ({ provider: 'codex', model: 'auto' });
  desktopAi.shouldUseSharedAppServer = () => true;
  agentRunService.startRun = async () => ({ runId: '66666666-6666-4666-8666-666666666666', persisted: true });
  agentRunService.recordEvent = async (event) => { events.push(event); };
  agentRunService.finishRun = async (input) => { finishes.push(input); return true; };
  controller.getIntentContextHints = async () => ({});
  codexAgent.runCodexAgent = async () => {
    const error = new Error('tool outcome unknown');
    error.code = 'agent_cancelled_partial';
    error.toolCallsAttempted = 1;
    throw error;
  };

  const response = await controller._runAgenticTurn(
    {
      from: '919999999995', text: 'update the CRM', source: 'dashboard',
      signal: abortController.signal,
    },
    { userTimezone: 'Asia/Kolkata' },
    [],
  );

  assert.match(response, /cannot safely claim whether that action completed/i);
  assert.equal(finishes.at(-1).status, 'partial');
  assert.equal(finishes.at(-1).errorCode, 'cancelled_tool_unknown');
  assert.ok(events.some((event) => event.type === 'run.partial'
    && event.payload.code === 'cancelled_tool_unknown'));
  assert.equal(events.some((event) => event.type === 'run.cancelled'), false);
});

test('Codex Stop after a completed tool is persisted as partial', async (t) => {
  const codexAgent = require('../src/services/codex-agent.service');
  const desktopAi = require('../src/services/desktop-ai-preferences.service');
  const originals = {
    runCodexAgent: codexAgent.runCodexAgent,
    readPreferences: desktopAi.readPreferences,
    shouldUseSharedAppServer: desktopAi.shouldUseSharedAppServer,
    startRun: agentRunService.startRun,
    recordEvent: agentRunService.recordEvent,
    finishRun: agentRunService.finishRun,
    hints: controller.getIntentContextHints,
  };
  t.after(() => {
    codexAgent.runCodexAgent = originals.runCodexAgent;
    desktopAi.readPreferences = originals.readPreferences;
    desktopAi.shouldUseSharedAppServer = originals.shouldUseSharedAppServer;
    agentRunService.startRun = originals.startRun;
    agentRunService.recordEvent = originals.recordEvent;
    agentRunService.finishRun = originals.finishRun;
    controller.getIntentContextHints = originals.hints;
  });

  const finishes = [];
  const events = [];
  const abortController = new AbortController();
  abortController.abort(new Error('dashboard stop after tool'));
  desktopAi.readPreferences = () => ({ provider: 'codex', model: 'auto' });
  desktopAi.shouldUseSharedAppServer = () => true;
  agentRunService.startRun = async () => ({ runId: '12121212-1212-4212-8212-121212121212', persisted: true });
  agentRunService.recordEvent = async (event) => { events.push(event); };
  agentRunService.finishRun = async (input) => { finishes.push(input); return true; };
  controller.getIntentContextHints = async () => ({});
  codexAgent.runCodexAgent = async () => {
    const error = new Error('stopped after tool completion');
    error.code = 'agent_cancelled';
    error.toolCallsAttempted = 1;
    error.partialOutcome = {
      status: 'partial',
      errorCode: 'agent_cancelled',
      text: 'I completed: Moved Acme to won. The remaining work was interrupted.',
      steps: 1,
      toolsUsed: ['manage_sales'],
      toolResults: [{
        status: 'success', tool: 'manage_sales', user_summary: 'Moved Acme to won.',
        data: { leadId: 42 },
      }],
      latencyMs: 3,
      finalModel: 'codex:auto',
      meta: { safeToResumeAfterInterruption: true },
    };
    throw error;
  };

  const message = {
    from: '919999999991', text: 'update the CRM', source: 'dashboard',
    signal: abortController.signal,
  };
  const response = await controller._runAgenticTurn(message, { userTimezone: 'Asia/Kolkata' }, []);

  assert.match(response, /stopped after completing: Moved Acme to won/i);
  assert.equal(finishes.at(-1).status, 'partial');
  assert.equal(finishes.at(-1).errorCode, 'cancelled_after_tool');
  assert.equal(finishes.at(-1).outcome.toolResults[0].data.leadId, 42,
    'completed tool evidence must survive a provider or user interruption');
  assert.equal(message.agentRunStatus, 'partial');
  assert.ok(events.some((event) => event.type === 'run.partial'
    && event.payload.code === 'cancelled_after_tool'));
  assert.equal(events.some((event) => event.type === 'run.cancelled'), false);
});

test('OpenRouter cancellation with an unknown in-flight tool outcome remains partial', async (t) => {
  const openRouterAgent = require('../src/services/openrouter-agent.service');
  const desktopAi = require('../src/services/desktop-ai-preferences.service');
  const originals = {
    isConfigured: openRouterAgent.isConfigured,
    runOpenRouterAgent: openRouterAgent.runOpenRouterAgent,
    readPreferences: desktopAi.readPreferences,
    startRun: agentRunService.startRun,
    recordEvent: agentRunService.recordEvent,
    finishRun: agentRunService.finishRun,
    hints: controller.getIntentContextHints,
    runtime: process.env.ARI_AGENT_RUNTIME,
  };
  t.after(() => {
    openRouterAgent.isConfigured = originals.isConfigured;
    openRouterAgent.runOpenRouterAgent = originals.runOpenRouterAgent;
    desktopAi.readPreferences = originals.readPreferences;
    agentRunService.startRun = originals.startRun;
    agentRunService.recordEvent = originals.recordEvent;
    agentRunService.finishRun = originals.finishRun;
    controller.getIntentContextHints = originals.hints;
    if (originals.runtime === undefined) delete process.env.ARI_AGENT_RUNTIME;
    else process.env.ARI_AGENT_RUNTIME = originals.runtime;
  });

  process.env.ARI_AGENT_RUNTIME = 'openrouter';
  const finishes = [];
  const abortController = new AbortController();
  abortController.abort(new Error('dashboard stop'));
  desktopAi.readPreferences = () => ({ provider: 'ari', model: 'auto' });
  agentRunService.startRun = async () => ({ runId: '77777777-7777-4777-8777-777777777777', persisted: true });
  const events = [];
  agentRunService.recordEvent = async (event) => { events.push(event); };
  agentRunService.finishRun = async (input) => { finishes.push(input); return true; };
  controller.getIntentContextHints = async () => ({});
  openRouterAgent.isConfigured = () => true;
  openRouterAgent.runOpenRouterAgent = async () => ({
    status: 'failed',
    text: 'I could not verify whether the CRM update took effect.',
    steps: 1,
    toolsUsed: ['manage_sales'],
    toolResults: [{
      status: 'failure',
      error: { code: 'tool_aborted_unknown_outcome', category: 'unknown_outcome', retryable: false },
    }],
    latencyMs: 1,
    finalModel: 'openrouter:test',
  });

  const response = await controller._runAgenticTurn(
    {
      from: '919999999994', text: 'update the CRM', source: 'dashboard',
      signal: abortController.signal,
    },
    { userTimezone: 'Asia/Kolkata' },
    [],
  );

  assert.match(response, /could not verify/i);
  assert.equal(finishes.at(-1).status, 'partial');
  assert.equal(finishes.at(-1).errorCode, 'cancelled_tool_unknown');
  assert.ok(events.some((event) => event.type === 'run.partial'
    && event.payload.code === 'cancelled_tool_unknown'));
});

test('cancellation after a successful tool remains partial instead of clean cancelled', async (t) => {
  const openRouterAgent = require('../src/services/openrouter-agent.service');
  const desktopAi = require('../src/services/desktop-ai-preferences.service');
  const originals = {
    isConfigured: openRouterAgent.isConfigured,
    runOpenRouterAgent: openRouterAgent.runOpenRouterAgent,
    readPreferences: desktopAi.readPreferences,
    startRun: agentRunService.startRun,
    recordEvent: agentRunService.recordEvent,
    finishRun: agentRunService.finishRun,
    hints: controller.getIntentContextHints,
    runtime: process.env.ARI_AGENT_RUNTIME,
  };
  t.after(() => {
    openRouterAgent.isConfigured = originals.isConfigured;
    openRouterAgent.runOpenRouterAgent = originals.runOpenRouterAgent;
    desktopAi.readPreferences = originals.readPreferences;
    agentRunService.startRun = originals.startRun;
    agentRunService.recordEvent = originals.recordEvent;
    agentRunService.finishRun = originals.finishRun;
    controller.getIntentContextHints = originals.hints;
    if (originals.runtime === undefined) delete process.env.ARI_AGENT_RUNTIME;
    else process.env.ARI_AGENT_RUNTIME = originals.runtime;
  });

  process.env.ARI_AGENT_RUNTIME = 'openrouter';
  const finishes = [];
  const abortController = new AbortController();
  abortController.abort(new Error('dashboard stop after tool'));
  desktopAi.readPreferences = () => ({ provider: 'ari', model: 'auto' });
  agentRunService.startRun = async () => ({ runId: '99999999-9999-4999-8999-999999999999', persisted: true });
  const events = [];
  agentRunService.recordEvent = async (event) => { events.push(event); };
  agentRunService.finishRun = async (input) => { finishes.push(input); return true; };
  controller.getIntentContextHints = async () => ({});
  openRouterAgent.isConfigured = () => true;
  openRouterAgent.runOpenRouterAgent = async () => ({
    status: 'partial',
    text: '',
    steps: 1,
    toolsUsed: ['manage_sales'],
    toolResults: [{
      status: 'success', tool: 'manage_sales', user_summary: 'Moved Acme to won.',
    }],
    latencyMs: 1,
    finalModel: 'openrouter:test',
  });

  const message = {
    from: '919999999992', text: 'move Acme to won', source: 'dashboard',
    signal: abortController.signal,
  };
  const response = await controller._runAgenticTurn(
    message,
    { userTimezone: 'Asia/Kolkata' },
    [],
  );

  assert.match(response, /stopped after completing: Moved Acme to won/i);
  assert.equal(finishes.at(-1).status, 'partial');
  assert.equal(finishes.at(-1).errorCode, 'cancelled_after_tool');
  assert.equal(message.agentRunStatus, 'partial');
  assert.ok(events.some((event) => event.type === 'run.partial'
    && event.payload.code === 'cancelled_after_tool'));
});

test('clean cancellation discards a model reply that arrives after Stop', async (t) => {
  const openRouterAgent = require('../src/services/openrouter-agent.service');
  const desktopAi = require('../src/services/desktop-ai-preferences.service');
  const originals = {
    isConfigured: openRouterAgent.isConfigured,
    runOpenRouterAgent: openRouterAgent.runOpenRouterAgent,
    readPreferences: desktopAi.readPreferences,
    startRun: agentRunService.startRun,
    recordEvent: agentRunService.recordEvent,
    finishRun: agentRunService.finishRun,
    hints: controller.getIntentContextHints,
    runtime: process.env.ARI_AGENT_RUNTIME,
  };
  t.after(() => {
    openRouterAgent.isConfigured = originals.isConfigured;
    openRouterAgent.runOpenRouterAgent = originals.runOpenRouterAgent;
    desktopAi.readPreferences = originals.readPreferences;
    agentRunService.startRun = originals.startRun;
    agentRunService.recordEvent = originals.recordEvent;
    agentRunService.finishRun = originals.finishRun;
    controller.getIntentContextHints = originals.hints;
    if (originals.runtime === undefined) delete process.env.ARI_AGENT_RUNTIME;
    else process.env.ARI_AGENT_RUNTIME = originals.runtime;
  });

  process.env.ARI_AGENT_RUNTIME = 'openrouter';
  const finishes = [];
  const events = [];
  const abortController = new AbortController();
  abortController.abort(new Error('dashboard stop'));
  desktopAi.readPreferences = () => ({ provider: 'ari', model: 'auto' });
  agentRunService.startRun = async () => ({ runId: '13131313-1313-4313-8313-131313131313', persisted: true });
  agentRunService.recordEvent = async (event) => { events.push(event); };
  agentRunService.finishRun = async (input) => { finishes.push(input); return true; };
  controller.getIntentContextHints = async () => ({});
  openRouterAgent.isConfigured = () => true;
  openRouterAgent.runOpenRouterAgent = async () => ({
    status: 'completed',
    text: 'late reply',
    steps: 0,
    toolsUsed: [],
    toolResults: [],
    latencyMs: 1,
    finalModel: 'openrouter:test',
  });

  const message = {
    from: '919999999990', text: 'summarize my day', source: 'dashboard',
    signal: abortController.signal,
  };
  const response = await controller._runAgenticTurn(message, { userTimezone: 'Asia/Kolkata' }, []);

  assert.equal(response, null);
  assert.equal(finishes.at(-1).status, 'cancelled');
  assert.equal(finishes.at(-1).errorCode, 'user_cancelled');
  assert.equal(message.agentRunStatus, 'cancelled');
  assert.ok(events.some((event) => event.type === 'run.cancelled'));
});
