'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  AriResponsesGateway,
  messagesFromResponses,
  toolsFromResponses,
} = require('../src/services/ari-responses-gateway.service');
const {
  BASE_INSTRUCTIONS,
  CodexAppServerClient,
  DEVELOPER_INSTRUCTIONS,
} = require('../src/services/codex-app-server.service');
const { isolationConfig } = require('../src/services/ari-agent-policy.service');

function post(url, token, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(`${url}/responses`);
    const request = http.request(target, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
    }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, text }));
    });
    request.once('error', reject);
    request.end(JSON.stringify(body));
  });
}

test('Responses input translates messages, tool calls, and tool observations', () => {
  const metadata = new Map([['call_1', { google: { thought_signature: 'signed-thought' } }]]);
  const messages = messagesFromResponses({
    instructions: 'Ari policy',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Show tasks' }] },
      { type: 'function_call', call_id: 'call_1', name: 'manage_tasks', arguments: '{"action":"list"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"status":"success"}' },
    ],
  }, { toolMetadata: metadata });
  assert.deepEqual(messages.map((message) => message.role), ['system', 'user', 'assistant', 'tool']);
  assert.equal(messages[2].tool_calls[0].function.name, 'manage_tasks');
  assert.equal(messages[2].tool_calls[0].extra_content.google.thought_signature, 'signed-thought');
  assert.equal(messages[3].tool_call_id, 'call_1');
});

test('Responses tools translate to provider-neutral Chat Completions tools', () => {
  const tools = toolsFromResponses({ tools: [{
    type: 'function', name: 'manage_tasks', description: 'Manage tasks',
    parameters: { type: 'object', properties: { action: { type: 'string' } } },
  }] });
  assert.equal(tools[0].function.name, 'manage_tasks');
  assert.equal(tools[0].function.parameters.type, 'object');
});

test('Ari gateway returns a Codex-compatible Responses event stream', async (t) => {
  let received;
  const gateway = new AriResponsesGateway({
    llm: {
      defaultModel: () => 'gemini-test',
      chatCompletion: async (body) => {
        received = body;
        return { data: {
          choices: [{ message: { role: 'assistant', content: 'Shared runtime works.' } }],
          usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
        } };
      },
    },
  });
  t.after(() => gateway.stop());
  const connection = await gateway.start();
  const response = await post(connection.baseUrl, connection.token, {
    model: 'gemini-test',
    instructions: 'You are Ari.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }],
    tools: [],
    stream: true,
  });
  assert.equal(response.status, 200);
  assert.match(response.text, /event: response\.output_text\.delta/);
  assert.match(response.text, /Shared runtime works/);
  assert.match(response.text, /event: response\.completed/);
  assert.equal(received.messages[0].role, 'system');
  assert.equal(received.messages.at(-1).content, 'Hello');
  assert.equal(received.temperature, 0);
});

test('Ari gateway preserves Gemini thought signatures across a multi-step tool call', async (t) => {
  const received = [];
  const gateway = new AriResponsesGateway({
    llm: {
      defaultModel: () => 'gemini-test',
      complexModel: () => 'gemini-pro-test',
      defaultBodyExtras: (slot) => ({ extra_body: { google: { slot } } }),
      chatCompletion: async (body) => {
        received.push(body);
        if (received.length === 1) {
          return { data: {
            choices: [{ message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_signed',
                type: 'function',
                function: { name: 'manage_tasks', arguments: '{"action":"list"}' },
                extra_content: { google: { thought_signature: 'opaque-signature' } },
              }],
            } }],
            usage: {},
          } };
        }
        return { data: { choices: [{ message: { role: 'assistant', content: 'Done.' } }], usage: {} } };
      },
    },
  });
  t.after(() => gateway.stop());
  const connection = await gateway.start();

  const first = await post(connection.baseUrl, connection.token, {
    model: 'gemini-test',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Show tasks' }] }],
    tools: [{ type: 'function', name: 'manage_tasks', parameters: { type: 'object', properties: {} } }],
    stream: true,
  });
  assert.equal(first.status, 200);

  const second = await post(connection.baseUrl, connection.token, {
    model: 'gemini-test',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Show tasks' }] },
      { type: 'function_call', call_id: 'call_signed', name: 'manage_tasks', arguments: '{"action":"list"}' },
      { type: 'function_call_output', call_id: 'call_signed', output: '{"status":"success"}' },
    ],
    tools: [{ type: 'function', name: 'manage_tasks', parameters: { type: 'object', properties: {} } }],
    stream: true,
  });
  assert.equal(second.status, 200);
  const assistantCall = received[1].messages.find((message) => message.role === 'assistant');
  assert.equal(assistantCall.tool_calls[0].extra_content.google.thought_signature, 'opaque-signature');
  assert.equal(received[0].extra_body.google.slot, 'agent');
});

test('Codex App Server completes a turn through the Ari model gateway', async (t) => {
  const gateway = new AriResponsesGateway({
    llm: {
      defaultModel: () => 'ari-test',
      chatCompletion: async () => ({ data: {
        choices: [{ message: { role: 'assistant', content: 'App Server and Ari AI share one runtime.' } }],
        usage: { prompt_tokens: 25, completion_tokens: 8, total_tokens: 33 },
      } }),
    },
  });
  const connection = await gateway.start();
  const client = new CodexAppServerClient({ turnTimeoutMs: 30_000 });
  t.after(async () => {
    client.stop();
    await gateway.stop();
  });
  const started = await client.request('thread/start', {
    cwd: process.cwd(),
    approvalPolicy: 'never',
    sandbox: 'read-only',
    ephemeral: true,
    baseInstructions: BASE_INSTRUCTIONS,
    developerInstructions: DEVELOPER_INSTRUCTIONS,
    selectedCapabilityRoots: [],
    environments: [],
    model: 'ari-test',
    modelProvider: 'ari_gateway',
    config: {
      ...isolationConfig([]),
      model_provider: 'ari_gateway',
      model_providers: {
        ari_gateway: {
          name: 'Ari Test',
          base_url: connection.baseUrl,
          wire_api: 'responses',
          experimental_bearer_token: connection.token,
        },
      },
    },
    dynamicTools: [],
  });
  const result = await client.runTurn({
    threadId: started.thread.id,
    input: 'Confirm the shared runtime.',
    userPhone: 'test-user',
    finalModel: 'ari:ari-test',
    engine: 'app-server:ari',
    onEvent: async () => {},
    turnOptions: {
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      model: 'ari-test',
    },
  });
  assert.equal(result.text, 'App Server and Ari AI share one runtime.');
  assert.equal(result.engine, 'app-server:ari');
  assert.equal(result.usage.totalTokens, 33);
});
