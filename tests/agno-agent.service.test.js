'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  agnoWorkerEnvironment,
  createAgnoAgentService,
  isNativeModelFile,
} = require('../src/services/agno-agent.service');
const { conversationIdentity } = require('../src/services/openrouter-agent-state.service');
const { validateEnvironment } = require('../src/utils/env-check');

function fakePersistence(overrides = {}) {
  const calls = [];
  return {
    calls,
    ensureTables: async () => { calls.push({ kind: 'ensure' }); },
    withConversationLock: async (conversationKey, work) => {
      calls.push({ kind: 'lock', conversationKey });
      return work(async () => ({ rows: [], rowCount: 0 }));
    },
    claimToolExecution: async (input) => {
      calls.push({ kind: 'claim', input });
      return { claimed: true, argumentsHash: 'hash' };
    },
    finishToolExecution: async (input) => { calls.push({ kind: 'finish', input }); },
    ...overrides,
  };
}

function configuredEnv(extra = {}) {
  return {
    ARI_AGENT_RUNTIME: 'agno',
    OPENROUTER_API_KEY: 'test-key',
    OPENROUTER_MODELS: 'openai/gpt-4.1-mini,google/gemini-2.5-flash',
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    ARI_AGENT_TOOL_TIMEOUT_MS: '1000',
    ...extra,
  };
}

function geminiConfiguredEnv(extra = {}) {
  return {
    ARI_AGENT_RUNTIME: 'agno',
    ARI_AGNO_MODEL_PROVIDER: 'gemini',
    ARI_AGNO_MODEL_ID: 'gemini-test-model',
    GEMINI_API_KEY: 'test-gemini-key',
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    ARI_AGENT_TOOL_TIMEOUT_MS: '1000',
    ...extra,
  };
}

test('Agno is the default runtime and requires OpenRouter plus persistent storage', () => {
  const defaultEnv = configuredEnv();
  delete defaultEnv.ARI_AGENT_RUNTIME;
  assert.equal(createAgnoAgentService({ env: defaultEnv }).isConfigured(), true);
  assert.equal(createAgnoAgentService({
    env: configuredEnv({ ARI_AGENT_RUNTIME: '   ' }),
  }).isConfigured(), true);
  assert.equal(createAgnoAgentService({ env: configuredEnv() }).isConfigured(), true);
  assert.equal(createAgnoAgentService({ env: configuredEnv({ ARI_AGENT_RUNTIME: 'openrouter' }) }).isConfigured(), false);
  assert.equal(createAgnoAgentService({ env: configuredEnv({ ARI_AGENT_RUNTIME: 'legacy' }) }).isConfigured(), false);
  assert.equal(createAgnoAgentService({ env: configuredEnv({ OPENROUTER_API_KEY: '' }) }).isConfigured(), false);
  assert.equal(createAgnoAgentService({ env: configuredEnv({ DATABASE_URL: '' }) }).isConfigured(), false);
});

test('Agno accepts direct Gemini credentials without an OpenRouter key', () => {
  const env = geminiConfiguredEnv({ OPENROUTER_API_KEY: '' });
  const service = createAgnoAgentService({ env });

  assert.equal(service.isConfigured(), true);
  assert.equal(service.runtimeConfig().modelProvider, 'gemini');
  assert.equal(service.runtimeConfig().modelId, 'gemini-test-model');
  assert.deepEqual(service.runtimeConfig().models, ['gemini-test-model']);
});

test('direct Gemini credentials are mapped only into the local worker environment', () => {
  const childEnv = agnoWorkerEnvironment(geminiConfiguredEnv({
    GEMINI_API_KEY: 'ari-gemini-secret',
    GOOGLE_API_KEY: '',
  }));

  assert.equal(childEnv.GOOGLE_API_KEY, 'ari-gemini-secret');
  assert.equal(childEnv.GOOGLE_GENAI_USE_VERTEXAI, 'false');
  assert.equal(childEnv.OPENROUTER_API_KEY, '');
});

test('Agno accepts Vertex Gemini credentials without API keys', () => {
  const env = geminiConfiguredEnv({
    GEMINI_API_KEY: '',
    ARI_AGNO_GEMINI_VERTEX: 'true',
    GOOGLE_VERTEX_PROJECT: 'ari-project',
    GOOGLE_VERTEX_LOCATION: 'global',
    GOOGLE_VERTEX_CREDENTIALS: '{"type":"service_account"}',
  });

  const config = createAgnoAgentService({ env }).runtimeConfig();
  assert.equal(createAgnoAgentService({ env }).isConfigured(), true);
  assert.equal(config.modelProvider, 'gemini');
  assert.equal(config.gemini.vertexai, true);
  assert.equal(config.gemini.projectId, 'ari-project');
  assert.equal(config.gemini.location, 'global');
  assert.equal(agnoWorkerEnvironment(env).GOOGLE_VERTEX_CREDENTIALS, '{"type":"service_account"}');
});

test('Agno does not advertise Vertex as configured without credentials', () => {
  const env = geminiConfiguredEnv({
    GEMINI_API_KEY: '',
    ARI_AGNO_GEMINI_VERTEX: 'true',
    GOOGLE_VERTEX_PROJECT: 'ari-project',
    GOOGLE_APPLICATION_CREDENTIALS: '',
    GOOGLE_VERTEX_CREDENTIALS: '',
    GOOGLE_VERTEX_ACCESS_TOKEN: '',
  });

  assert.equal(createAgnoAgentService({ env }).isConfigured(), false);
});

test('Agno does not treat direct Codex login as a model API credential', () => {
  const env = geminiConfiguredEnv({
    ARI_AGNO_MODEL_PROVIDER: 'codex',
    GEMINI_API_KEY: '',
    CODEX_CONNECTED: 'true',
  });
  const service = createAgnoAgentService({ env });

  assert.equal(service.isConfigured(), false);
  assert.throws(() => service.runtimeConfig(), /Unsupported Agno model provider/i);
});

test('direct Gemini runs through the full Agno request and shared typed executor', async () => {
  const persistence = fakePersistence();
  let request;
  let executionContext;
  const bridge = {
    run: async (input, options) => {
      request = input;
      const result = await options.onToolCall({
        callId: 'gemini-call-1', name: 'view_calendar', arguments: { limit: 2 },
      });
      assert.equal(result.status, 'success');
      return {
        type: 'final', status: 'completed', content: 'Two meetings.',
        run_id: 'gemini-run-1', model: 'gemini-test-model', model_provider: 'Google',
        metrics: { input_tokens: 22 }, tools: [],
      };
    },
  };
  const service = createAgnoAgentService({
    env: geminiConfiguredEnv(), bridge, persistence, buildContext: async () => '',
  });

  const outcome = await service.runAgentLoop({
    userMessage: 'What is on my calendar?', userPhone: '919999999919',
    sessionId: '22222222-2222-4222-8222-222222222222', recentMessages: [], contextHints: {},
    executeFn: async (_name, _args, context) => {
      executionContext = context;
      return { status: 'success', data: { events: 2 }, user_summary: 'Two meetings.' };
    },
  });

  assert.equal(request.config.model_provider, 'gemini');
  assert.equal(request.config.model_id, 'gemini-test-model');
  assert.equal(request.config.api_key, undefined, 'credentials must stay out of the NDJSON request');
  assert.equal(executionContext.runtime, 'agno-gemini');
  assert.equal(outcome.engine, 'agno-gemini');
  assert.equal(outcome.finalModel, 'google:gemini-test-model');
});

test('Agno keeps Office files as analyze_file artifacts instead of sending unsupported MIME types to Gemini', async () => {
  const persistence = fakePersistence();
  let request;
  const bridge = {
    run: async (input) => {
      request = input;
      return {
        type: 'final', status: 'completed', content: 'I will analyze the workbook.',
        run_id: 'gemini-file-run', model: 'gemini-test-model', model_provider: 'Google',
        metrics: {}, tools: [],
      };
    },
  };
  const service = createAgnoAgentService({
    env: geminiConfiguredEnv(), bridge, persistence, buildContext: async () => '',
  });
  const spreadsheet = {
    artifact_id: 'session:11111111-1111-4111-8111-111111111111',
    path: 'C:\\safe\\leads.xlsx',
    name: 'leads.xlsx',
    mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: 1234,
  };
  const pdf = {
    artifact_id: 'session:22222222-2222-4222-8222-222222222222',
    path: 'C:\\safe\\brief.pdf', name: 'brief.pdf', mime_type: 'application/pdf', size: 456,
  };

  await service.runAgentLoop({
    userMessage: 'Create CRM groups from this workbook.', userPhone: '919999999918',
    sessionId: '33333333-3333-4333-8333-333333333333', recentMessages: [],
    contextHints: { hasDocumentAttachment: true }, files: [spreadsheet, pdf],
    executeFn: async () => ({ status: 'success' }),
  });

  assert.equal(isNativeModelFile(spreadsheet), false);
  assert.equal(isNativeModelFile(pdf), true);
  assert.deepEqual(request.files.map((file) => file.name), ['brief.pdf']);
  assert.match(request.instructions.join('\n'), /leads\.xlsx/);
  assert.match(request.instructions.join('\n'), /native_model_file=false/);
  assert.match(request.instructions.join('\n'), /analyze_file/);
  assert.match(request.instructions.join('\n'), /manage_contact_groups once with action="sync_from_file"/);
});

test('startup validation accepts the documented Agno OpenRouter credentials', (t) => {
  const values = {
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    META_WHATSAPP_TOKEN: 'test-token',
    META_PHONE_NUMBER_ID: 'test-phone-id',
    META_WEBHOOK_VERIFY_TOKEN: 'test-verify-token',
    META_APP_SECRET: 'test-app-secret',
    OPENROUTER_API_KEY: 'test-openrouter-key',
    NODE_ENV: 'test',
  };
  const cleared = [
    'FIREWORKS_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY',
    'ANTHROPIC_API_KEY', 'GOOGLE_VERTEX_PROJECT', 'GOOGLE_CLOUD_PROJECT',
    'GCLOUD_PROJECT', 'GCP_PROJECT', 'VERTEX_PROJECT_ID', 'GOOGLE_CLIENT_ID',
    'MICROSOFT_CLIENT_ID', 'ENCRYPTION_KEY',
  ];
  const touched = [...Object.keys(values), ...cleared];
  const original = Object.fromEntries(touched.map((key) => [key, process.env[key]]));
  const originalExit = process.exit;
  t.after(() => {
    process.exit = originalExit;
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, values);
  for (const key of cleared) delete process.env[key];
  process.exit = (code) => { throw new Error(`unexpected process.exit(${code})`); };

  assert.doesNotThrow(() => validateEnvironment());
});

test('Agno service exposes selected strict contracts and journals a typed tool execution', async () => {
  const persistence = fakePersistence();
  let request;
  let handlerCall;
  const bridge = {
    run: async (input, options) => {
      request = input;
      const result = await options.onToolCall({
        callId: 'agno-call-1', name: 'view_calendar', arguments: { limit: 5 },
      });
      assert.equal(result.status, 'success');
      return {
        type: 'final', status: 'completed', content: 'You have two meetings.',
        run_id: 'agno-run-1', model: 'openai/gpt-4.1-mini', metrics: { input_tokens: 44 },
        tools: [{ tool_name: 'view_calendar' }],
      };
    },
  };
  const service = createAgnoAgentService({ env: configuredEnv(), bridge, persistence, buildContext: async () => '' });
  const outcome = await service.runAgentLoop({
    userMessage: 'What is on my calendar today?',
    userPhone: '919999999901',
    sessionId: '11111111-1111-4111-8111-111111111111',
    recentMessages: [], contextHints: {}, runId: 'ari-run-1',
    executeFn: async (name, args, context) => {
      handlerCall = { name, args, context };
      return { status: 'success', data: { events: 2 }, user_summary: 'Two meetings.' };
    },
  });

  const calendar = request.tools.find((tool) => tool.name === 'view_calendar');
  assert.ok(calendar);
  assert.equal(calendar.input_schema.additionalProperties, false);
  assert.equal(Object.hasOwn(calendar.input_schema.properties, 'full_text'), false);
  assert.equal(request.config.models[0], 'openai/gpt-4.1-mini');
  assert.equal(request.user_id.startsWith('ari:'), true);
  assert.equal(request.session_id, '11111111-1111-4111-8111-111111111111');
  assert.equal(handlerCall.context.runtime, 'agno-openrouter');
  assert.equal(handlerCall.context.callId, 'agno-call-1');
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.text, 'You have two meetings.');
  assert.deepEqual(outcome.toolsUsed, ['view_calendar']);
  assert.equal(persistence.calls.filter((call) => call.kind === 'claim').length, 1);
  assert.equal(persistence.calls.find((call) => call.kind === 'finish').input.status, 'completed');
});

test('a post-success journal failure cannot turn a verified tool action into a failure', async () => {
  const journalError = Object.assign(new Error('inconsistent types deduced for parameter $3'), { code: '42P08' });
  const persistence = fakePersistence({
    finishToolExecution: async () => { throw journalError; },
  });
  let providerResult;
  const bridge = {
    run: async (_request, options) => {
      providerResult = await options.onToolCall({
        callId: 'crm-sync-call',
        name: 'manage_contact_groups',
        arguments: { action: 'sync_from_file', file_name: 'contacts.xlsx' },
      });
      return {
        type: 'final', status: 'completed',
        content: 'I was not able to synchronize the workbook.',
        run_id: 'crm-sync-run', model: 'gemini-test-model', model_provider: 'Google', tools: [],
      };
    },
  };
  const service = createAgnoAgentService({
    env: geminiConfiguredEnv(), bridge, persistence, buildContext: async () => '',
  });
  const outcome = await service.runAgentLoop({
    userMessage: 'Create CRM groups from this workbook.',
    userPhone: '919999999917', recentMessages: [], contextHints: { hasDocumentAttachment: true },
    executeFn: async () => ({
      status: 'success',
      data: { completedGroups: 15, totalRecords: 2939 },
      user_summary: 'Synchronized all 15 CRM groups and 2939 unique people.',
    }),
  });

  assert.equal(providerResult.status, 'success');
  assert.equal(providerResult.meta.journal_persisted, false);
  assert.equal(providerResult.meta.journal_error_code, '42P08');
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.text, 'Synchronized all 15 CRM groups and 2939 unique people.');
  assert.equal(outcome.toolResults[0].status, 'success');
});

test('successful dependent tool steps execute in order and carry stable result IDs', async () => {
  const persistence = fakePersistence();
  const executions = [];
  const bridge = {
    run: async (_request, options) => {
      const created = await options.onToolCall({
        callId: 'create-task',
        name: 'manage_tasks',
        arguments: { action: 'add', task_title: 'Prepare launch brief' },
      });
      assert.equal(created.status, 'success');
      assert.equal(created.data.task_id, 417);

      const followUp = await options.onToolCall({
        callId: 'follow-up-task',
        name: 'manage_tasks',
        arguments: {
          action: 'set_task_followup',
          task_id: created.data.task_id,
          follow_up_directive: 'tomorrow at 10am',
        },
      });
      assert.equal(followUp.status, 'success');
      return {
        type: 'final', status: 'completed', content: 'Task created and follow-up set.',
        run_id: 'agno-run-chain', model: 'openai/gpt-4.1-mini', tools: [],
      };
    },
  };
  const service = createAgnoAgentService({
    env: configuredEnv(), bridge, persistence, buildContext: async () => '',
  });
  const outcome = await service.runAgentLoop({
    userMessage: 'Create a launch brief task, then follow up tomorrow at 10.',
    userPhone: '919999999911', recentMessages: [], contextHints: {},
    executeFn: async (name, args) => {
      executions.push({ name, args });
      if (args.action === 'add') {
        return { status: 'success', data: { task_id: 417 }, user_summary: 'Task created.' };
      }
      return { status: 'success', data: { task_id: args.task_id }, user_summary: 'Follow-up set.' };
    },
  });

  assert.deepEqual(executions.map((entry) => entry.args.action), ['add', 'set_task_followup']);
  assert.equal(executions[1].args.task_id, 417);
  assert.deepEqual(outcome.toolsUsed, ['manage_tasks', 'manage_tasks']);
  assert.equal(outcome.status, 'completed');
  assert.equal(persistence.calls.filter((call) => call.kind === 'claim').length, 2);
  assert.equal(persistence.calls.filter((call) => call.kind === 'finish').length, 2);
});

test('Agno service rejects invalid model arguments before journaling or business execution', async () => {
  const persistence = fakePersistence();
  let executeCount = 0;
  const bridge = {
    run: async (_request, options) => {
      const result = await options.onToolCall({
        callId: 'bad-call', name: 'send_email', arguments: { body: 'Missing recipients', surprise: true },
      });
      assert.equal(result.status, 'failure');
      assert.equal(result.error.code, 'invalid_tool_arguments');
      return { type: 'final', status: 'completed', content: 'I need a recipient.', tools: [] };
    },
  };
  const service = createAgnoAgentService({ env: configuredEnv(), bridge, persistence, buildContext: async () => '' });
  await service.runAgentLoop({
    userMessage: 'send it', userPhone: '919999999902', recentMessages: [], contextHints: {},
    executeFn: async () => { executeCount++; },
  });

  assert.equal(executeCount, 0);
  assert.equal(persistence.calls.some((call) => call.kind === 'claim'), false);
});

test('Agno service replays a completed journal entry without duplicating the action', async () => {
  const replayed = { status: 'success', tool: 'manage_sales', data: { lead_id: 7 }, user_summary: 'Acme moved to won.' };
  const persistence = fakePersistence({
    claimToolExecution: async () => ({
      claimed: false,
      conflict: null,
      existing: { status: 'completed', result: replayed },
    }),
  });
  let executeCount = 0;
  const bridge = {
    run: async (_request, options) => {
      const result = await options.onToolCall({
        callId: 'same-call', name: 'manage_sales', arguments: { action: 'move_stage', lead_name: 'Acme', stage: 'won' },
      });
      assert.equal(result.data.lead_id, 7);
      return { type: 'final', status: 'completed', content: 'Already completed.', tools: [] };
    },
  };
  const service = createAgnoAgentService({ env: configuredEnv(), bridge, persistence, buildContext: async () => '' });
  const outcome = await service.runAgentLoop({
    userMessage: 'move Acme to won', userPhone: '919999999903', recentMessages: [], contextHints: {},
    executeFn: async () => { executeCount++; },
  });

  assert.equal(executeCount, 0);
  assert.equal(outcome.toolResults[0].meta.replayed, true);
});

test('a waiting approval result fences every later tool in the same Agno run', async () => {
  const persistence = fakePersistence();
  const executed = [];
  const bridge = {
    run: async (_request, options) => {
      const approval = await options.onToolCall({
        callId: 'approval-call', name: 'send_email',
        arguments: { recipients: ['sam@example.com'], body: 'Hello' },
      });
      assert.equal(approval.status, 'waiting_approval');
      const later = await options.onToolCall({
        callId: 'should-not-run', name: 'manage_tasks',
        arguments: { action: 'add', task_title: 'This must be fenced' },
      });
      assert.equal(later.status, 'waiting_approval');
      return { type: 'final', status: 'completed', content: 'Done — the email was sent.', tools: [] };
    },
  };
  const service = createAgnoAgentService({ env: configuredEnv(), bridge, persistence, buildContext: async () => '' });
  const outcome = await service.runAgentLoop({
    userMessage: 'email Sam then create a task', userPhone: '919999999904', recentMessages: [], contextHints: {},
    executeFn: async (name) => {
      executed.push(name);
      return { status: 'waiting_approval', data: { pending: true }, user_summary: 'Approve this email?' };
    },
  });

  assert.deepEqual(executed, ['send_email']);
  assert.equal(outcome.status, 'waiting_approval');
  assert.equal(outcome.text, 'Approve this email?', 'terminal tool truth must fence a hallucinated model final');
  assert.equal(
    persistence.calls.find((call) => call.kind === 'finish').input.status,
    'pending_approval',
    'an approval preview must not be journaled as a completed side effect',
  );
});

test('fallback sessions use one stable conversation identity instead of hashing it twice', async () => {
  const phone = '919999999905';
  const persistence = fakePersistence();
  const service = createAgnoAgentService({
    env: configuredEnv(),
    persistence,
    buildContext: async () => '',
    bridge: { run: async () => ({ type: 'final', status: 'completed', content: 'Hello.', tools: [] }) },
  });

  await service.runAgentLoop({
    userMessage: 'hello', userPhone: phone, recentMessages: [], contextHints: {},
    executeFn: async () => ({ status: 'success', user_summary: 'unused' }),
  });

  assert.equal(persistence.calls.find((call) => call.kind === 'lock').conversationKey,
    conversationIdentity(phone, null));
});

test('successful clear history clears the Node journal only after the Agno turn is persisted', async () => {
  const order = [];
  let lockQueryFn;
  const persistence = fakePersistence({
    withConversationLock: async (conversationKey, work) => {
      const queryFn = async () => ({ rows: [], rowCount: 0 });
      lockQueryFn = queryFn;
      return work(queryFn);
    },
    clearConversation: async (input) => {
      order.push({ kind: 'clear', input });
    },
  });
  const bridge = {
    run: async (_request, options) => {
      const result = await options.onToolCall({
        callId: 'clear-call', name: 'clear_chat_history', arguments: {},
      });
      assert.equal(result.status, 'success');
      order.push({ kind: 'bridge_final' });
      return { type: 'final', status: 'completed', content: 'Chat history cleared.', tools: [] };
    },
  };
  const service = createAgnoAgentService({ env: configuredEnv(), bridge, persistence, buildContext: async () => '' });
  await service.runAgentLoop({
    userMessage: 'clear this chat', userPhone: '919999999906',
    sessionId: '11111111-1111-4111-8111-111111111111', recentMessages: [], contextHints: {},
    executeFn: async () => ({ status: 'success', data: { cleared: true }, user_summary: 'Chat history cleared.' }),
  });

  assert.deepEqual(order.map((entry) => entry.kind), ['bridge_final', 'clear']);
  assert.equal(order[1].input.queryFn, lockQueryFn);
  assert.equal(order[1].input.conversationKey,
    conversationIdentity('919999999906', '11111111-1111-4111-8111-111111111111'));
});

test('dynamic destructive actions become unknown outcomes when interrupted', async () => {
  const persistence = fakePersistence();
  const abortController = new AbortController();
  const bridge = {
    run: async (_request, options) => {
      const pending = options.onToolCall({
        callId: 'forget-call',
        name: 'recall_memory',
        arguments: { action: 'forget', key: 'home_city' },
      });
      setImmediate(() => abortController.abort(new Error('user stopped')));
      const result = await pending;
      assert.equal(result.error.code, 'tool_aborted_unknown_outcome');
      assert.equal(result.error.category, 'unknown_outcome');
      return { type: 'final', status: 'completed', content: 'Memory deleted.', tools: [] };
    },
  };
  const service = createAgnoAgentService({
    env: configuredEnv(), bridge, persistence, buildContext: async () => '',
  });
  const outcome = await service.runAgentLoop({
    userMessage: 'forget my home city',
    userPhone: '919999999907',
    recentMessages: [],
    contextHints: {},
    signal: abortController.signal,
    executeFn: async () => new Promise(() => {}),
  });

  assert.equal(outcome.status, 'partial');
  assert.doesNotMatch(outcome.text, /memory deleted/i);
  assert.equal(
    persistence.calls.find((call) => call.kind === 'finish').input.status,
    'unknown',
  );
});

test('large business observations are bounded before crossing the worker protocol', async () => {
  const persistence = fakePersistence();
  let workerResult;
  const bridge = {
    run: async (_request, options) => {
      workerResult = await options.onToolCall({
        callId: 'large-read', name: 'web_search', arguments: { query: 'current market' },
      });
      return { type: 'final', status: 'completed', content: 'Search complete.', tools: [] };
    },
  };
  const service = createAgnoAgentService({
    env: configuredEnv(), bridge, persistence, buildContext: async () => '',
  });
  await service.runAgentLoop({
    userMessage: 'search the current market', userPhone: '919999999908',
    recentMessages: [], contextHints: {},
    executeFn: async () => ({
      status: 'success',
      data: { pages: [{ text: 'x'.repeat(2_000_000) }] },
      user_summary: 'Search complete.',
    }),
  });

  assert.ok(JSON.stringify(workerResult).length < 13_000);
  assert.ok(JSON.stringify(
    persistence.calls.find((call) => call.kind === 'finish').input.result,
  ).length < 13_000);
});
