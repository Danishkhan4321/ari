'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFileAnalysisService } = require('../src/services/file-analysis.service');
const { normalizeToolResult, serializeToolResult } = require('../src/services/tool-result.service');

test('null tool output is an explicit failure rather than invented success', () => {
  const result = normalizeToolResult(null, { toolName: 'manage_tasks' });

  assert.equal(result.status, 'failure');
  assert.equal(result.ok, false);
  assert.equal(result.tool, 'manage_tasks');
  assert.equal(result.data, null);
  assert.equal(result.error.code, 'empty_tool_result');
  assert.equal(result.error.retryable, false);
  assert.match(result.user_summary, /not verified/i);
});

test('waiting approval remains a non-error, non-success typed result after serialization', () => {
  const waiting = normalizeToolResult({
    status: 'waiting_approval',
    data: { approval_id: 'approval-7', pending: true },
    user_summary: 'Approve sending the proposal?',
    evidence: [{ type: 'draft', id: 'draft-7' }],
  }, { toolName: 'send_email' });

  assert.equal(waiting.status, 'waiting_approval');
  assert.equal(waiting.ok, false);
  assert.equal(waiting.error, null);
  assert.equal(waiting.meta.typed, true);
  const roundTrip = JSON.parse(serializeToolResult(waiting));
  assert.equal(roundTrip.status, 'waiting_approval');
  assert.equal(roundTrip.ok, false);
  assert.equal(roundTrip.error, null);
  assert.equal(roundTrip.data.approval_id, 'approval-7');
});

test('legacy business error strings cannot be normalized as successful tool work', () => {
  const failures = [
    'Aborted — 2 drafts contain other recipients\' emails. Nothing was sent.',
    'Scheduling failed for all recipients.',
    'Found your email but couldn\'t load the thread.',
    'I searched but couldn\'t read any matching emails.',
    'Task error. Please try again.',
    'Translation failed. Try again?',
    'Sent to 0/5, then hit a problem on first@example.com.',
  ];

  for (const text of failures) {
    const result = normalizeToolResult(text, { toolName: 'legacy_business_action' });
    assert.equal(result.status, 'failure', text);
    assert.equal(result.ok, false, text);
    assert.equal(result.error.code, 'legacy_tool_error', text);
  }
});

test('legacy mixed outcomes are normalized as partial rather than completed', () => {
  const partials = [
    'Sent to 2/5, then hit a problem on third@example.com.',
    'Task created, but I couldn\'t deliver the notification to Priya.',
    '2/3 emails scheduled.\nFailed: recipient@example.com',
  ];

  for (const text of partials) {
    const result = normalizeToolResult(text, { toolName: 'legacy_business_action' });
    assert.equal(result.status, 'partial', text);
    assert.equal(result.ok, false, text);
    assert.equal(result.error.code, 'legacy_tool_partial', text);
  }
});

test('PDF analysis routes through the injected OpenRouter file-parser backend', async () => {
  const calls = [];
  const pdfBuffer = Buffer.from('%PDF-1.7 fake test document');
  const service = createFileAnalysisService({
    queryFn: async () => ({
      rows: [{
        id: 7,
        file_url: 'https://files.example.test/proposal.pdf',
        file_name: 'proposal.pdf',
        mime_type: 'application/pdf',
      }],
    }),
    httpGet: async () => ({ data: pdfBuffer }),
    openrouterFactory: () => ({
      analyzePdfWithOpenRouter: async (request) => {
        calls.push(request);
        return { text: 'Proposal total: $42,000', responseItems: [{ type: 'file' }] };
      },
    }),
    openaiFactory: () => null,
    anthropicFactory: () => null,
  });

  const result = await service.analyzeDocument('919000000001', 'What is the proposal total?');

  assert.equal(result.provider, 'openrouter');
  assert.equal(result.fileName, 'proposal.pdf');
  assert.equal(result.text, 'Proposal total: $42,000');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].buffer, pdfBuffer);
  assert.equal(calls[0].filename, 'proposal.pdf');
  assert.equal(calls[0].mimeType, 'application/pdf');
  assert.match(calls[0].instruction, /What is the proposal total/);
  assert.match(calls[0].instruction, /ONLY from the attached file/);
});

test('non-PDF attachments never route to the OpenRouter PDF parser', async () => {
  let openRouterCalls = 0;
  const service = createFileAnalysisService({
    queryFn: async () => ({
      rows: [{
        id: 8,
        file_url: 'https://files.example.test/leads.csv',
        file_name: 'leads.csv',
        mime_type: 'text/csv',
      }],
    }),
    openrouterFactory: () => ({
      analyzePdfWithOpenRouter: async () => {
        openRouterCalls += 1;
        return { text: 'should not run' };
      },
    }),
    openaiFactory: () => null,
    anthropicFactory: () => null,
  });

  const result = await service.analyzeDocument('919000000001', 'List the leads');

  assert.equal(openRouterCalls, 0);
  assert.equal(result.error, 'not_configured');
  assert.match(result.message, /no compatible OpenRouter, OpenAI, or Anthropic key/i);
});

test('parsed PDF state is cached by file hash and reused without embedded file bytes', async () => {
  const cache = new Map();
  const calls = [];
  const pdfBuffer = Buffer.from('%PDF reusable document');
  const doc = {
    id: 9,
    file_url: 'https://files.example.test/reusable.pdf',
    file_name: 'reusable.pdf',
    mime_type: 'application/pdf',
  };
  const service = createFileAnalysisService({
    queryFn: async (sql, params = []) => {
      if (/FROM user_files/i.test(sql)) return { rows: [doc], rowCount: 1 };
      if (/SELECT state, annotations/i.test(sql)) {
        const state = cache.get(`${params[0]}:${params[1]}`);
        return { rows: state ? [{ state }] : [], rowCount: state ? 1 : 0 };
      }
      if (/INSERT INTO ari_file_analysis_cache/i.test(sql)) {
        cache.set(`${params[0]}:${params[1]}`, JSON.parse(params[6]));
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${String(sql).slice(0, 80)}`);
    },
    httpGet: async () => ({ data: pdfBuffer }),
    openrouterFactory: () => ({
      analyzePdfWithOpenRouter: async (request) => {
        calls.push(request);
        const annotation = {
          type: 'file',
          file: { hash: 'openrouter-file-hash', name: 'reusable.pdf', content: [{ type: 'text', text: 'Revenue is 42.' }] },
        };
        return {
          text: calls.length === 1 ? 'Revenue is 42.' : 'The same document says revenue is 42.',
          responseItems: [{ type: 'message', content: [{ type: 'output_text', text: 'answer', annotations: [annotation] }] }],
          state: request.state || {
            id: 'pdf-state', status: 'complete', createdAt: 1, updatedAt: 2,
            messages: [
              { role: 'user', content: [
                { type: 'input_text', text: request.instruction },
                { type: 'input_file', filename: request.filename, fileData: 'data:application/pdf;base64,SECRET' },
              ] },
              { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer', annotations: [annotation] }] },
            ],
          },
        };
      },
    }),
    openaiFactory: () => null,
    anthropicFactory: () => null,
  });

  await service.analyzeDocument('919000000010', 'What is revenue?');
  await service.analyzeDocument('919000000010', 'Confirm that number.');

  assert.equal(calls.length, 2);
  assert.equal(calls[0].state, null);
  assert.ok(calls[1].state, 'follow-up must load parsed OpenRouter state');
  assert.doesNotMatch(JSON.stringify(calls[1].state), /base64,SECRET/);
  assert.match(JSON.stringify(calls[1].state), /openrouter-file-hash/);
});
