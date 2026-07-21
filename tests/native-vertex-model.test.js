'use strict';

// Contract tests for the multimodal Vertex adapter. The live behaviour
// (auth, real file reading) is smoke-tested separately against GCP; these
// pin the translation rules that keep Ari's executor authoritative.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isConfigured,
  _internals: { toModelMessages, toSdkTools, serviceAccountFromEnv, vertexLocation },
} = require('../src/services/native-vertex-model.service');

test('service-account credentials are read from base64 or raw JSON', () => {
  const account = { client_email: 'bot@project.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n' };
  const raw = JSON.stringify(account);
  assert.deepEqual(serviceAccountFromEnv({ GOOGLE_VERTEX_CREDENTIALS: raw }), account);
  assert.deepEqual(
    serviceAccountFromEnv({ GOOGLE_VERTEX_CREDENTIALS: Buffer.from(raw).toString('base64') }),
    account,
  );
  assert.equal(serviceAccountFromEnv({ GOOGLE_VERTEX_CREDENTIALS: '' }), null);
  assert.equal(serviceAccountFromEnv({ GOOGLE_VERTEX_CREDENTIALS: 'not json' }), null);
  assert.equal(serviceAccountFromEnv({ GOOGLE_VERTEX_CREDENTIALS: JSON.stringify({ client_email: 'x' }) }), null,
    'a half-filled credential is not usable');
});

test('location falls back to a concrete region because global has no native endpoint', () => {
  assert.equal(vertexLocation({ GOOGLE_VERTEX_LOCATION: 'global' }), 'us-central1');
  assert.equal(vertexLocation({}), 'us-central1');
  assert.equal(vertexLocation({ GOOGLE_VERTEX_LOCATION: 'europe-west1' }), 'europe-west1');
  assert.equal(vertexLocation({ ARI_VERTEX_MULTIMODAL_LOCATION: 'asia-south1', GOOGLE_VERTEX_LOCATION: 'global' }), 'asia-south1');
});

test('isConfigured requires a project plus some credential', () => {
  const creds = JSON.stringify({ client_email: 'a@b.iam.gserviceaccount.com', private_key: 'k' });
  assert.equal(isConfigured({ GOOGLE_VERTEX_PROJECT: 'p', GOOGLE_VERTEX_CREDENTIALS: creds }), true);
  assert.equal(isConfigured({ GOOGLE_VERTEX_PROJECT: 'p', GOOGLE_APPLICATION_CREDENTIALS: '/path/sa.json' }), true);
  assert.equal(isConfigured({ GOOGLE_VERTEX_CREDENTIALS: creds }), false, 'no project');
  assert.equal(isConfigured({ GOOGLE_VERTEX_PROJECT: 'p' }), false, 'no credential');
});

test('tools are declared WITHOUT execute so the SDK reports calls instead of running them', async () => {
  const { jsonSchema, tool } = await import('ai');
  const declared = toSdkTools([
    { type: 'function', function: { name: 'manage_tasks', description: 'Manage tasks', parameters: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] } } },
    { type: 'function', function: { name: 'web_search', description: 'Search', parameters: { type: 'object', properties: { query: { type: 'string' } } } } },
  ], jsonSchema, tool);

  assert.deepEqual(Object.keys(declared).sort(), ['manage_tasks', 'web_search']);
  for (const [name, spec] of Object.entries(declared)) {
    assert.equal(spec.execute, undefined, `${name} must have no execute — Ari's executor owns execution`);
    assert.ok(spec.inputSchema, `${name} must carry its JSON Schema`);
  }
});

test('messages translate to AI SDK parts, preserving tool calls and results', () => {
  const converted = toModelMessages([
    { role: 'system', content: 'You are Ari.' },
    { role: 'user', content: 'add a task' },
    { role: 'assistant', content: 'Adding it…', tool_calls: [{ id: 'call_1', function: { name: 'manage_tasks', arguments: '{"action":"add"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', name: 'manage_tasks', content: '{"status":"success"}' },
  ], null);

  assert.equal(converted[0].role, 'system');
  assert.equal(converted[1].role, 'user');

  const assistant = converted[2];
  assert.equal(assistant.role, 'assistant');
  const call = assistant.content.find((part) => part.type === 'tool-call');
  assert.equal(call.toolCallId, 'call_1');
  assert.equal(call.toolName, 'manage_tasks');
  assert.deepEqual(call.input, { action: 'add' });

  const toolResult = converted[3].content[0];
  assert.equal(converted[3].role, 'tool');
  assert.equal(toolResult.type, 'tool-result');
  assert.equal(toolResult.toolCallId, 'call_1');
});

test('file parts attach to the current turn (the last user message) only', () => {
  const files = [{ data: Buffer.from('col\n1\n'), mediaType: 'text/csv', name: 'leads.csv' }];
  const converted = toModelMessages([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'older question' },
    { role: 'assistant', content: 'older answer' },
    { role: 'user', content: 'what is in this file?' },
  ], files);

  const users = converted.filter((message) => message.role === 'user');
  const earlier = users[0].content.filter((part) => part.type === 'file');
  const current = users[1].content.filter((part) => part.type === 'file');
  assert.equal(earlier.length, 0, 'history must not gain attachments');
  assert.equal(current.length, 1);
  assert.equal(current[0].mediaType, 'text/csv');
  assert.equal(current[0].filename, 'leads.csv');
});

test('malformed tool-call arguments degrade to an empty object rather than throwing', () => {
  const converted = toModelMessages([
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 't', arguments: 'not json' } }] },
  ], null);
  const call = converted[0].content.find((part) => part.type === 'tool-call');
  assert.deepEqual(call.input, {});
});
