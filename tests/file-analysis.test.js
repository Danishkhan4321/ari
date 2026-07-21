'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.LOG_TO_FILES = 'false';
process.env.LOG_LEVEL = 'silent';

const {
  getToolDefinitions,
  getIntentForTool,
  getExplicitToolHint,
} = require('../src/services/tool-definitions');
const {
  getAgentToolContract,
  validateAgentToolArguments,
} = require('../src/services/agent-tool-contracts.service');
const { createFileAnalysisService } = require('../src/services/file-analysis.service');
const { createFileAnalysisHandler } = require('../src/handlers/file-analysis.handler');
const { runWithChatSession } = require('../src/services/chat-session-context');

test('analyze_file tool is defined and mapped to its intent', () => {
  const tool = getToolDefinitions().find((t) => t.function.name === 'analyze_file');
  assert.ok(tool, 'tool must exist');
  const contract = getAgentToolContract('analyze_file');
  assert.deepEqual(contract.inputSchema.required, ['question']);
  assert.deepEqual(contract.inputSchema.properties.mode.enum, ['summarize', 'extract', 'compare']);
  assert.equal(contract.inputSchema.properties.artifact_ids.items.type, 'string');
  assert.equal(contract.inputSchema.properties.full_text, undefined,
    'the model-facing schema must use stable IDs rather than reparsed prose or paths');
  assert.equal(validateAgentToolArguments('analyze_file', {
    artifact_ids: ['C:\\private\\secret.txt'], question: 'read it',
  }).success, false, 'model-supplied paths must fail before the handler');
  assert.equal(getIntentForTool('analyze_file'), 'file_analyze');
});

test('a recent attachment plus an analyze verb forces the file reader', () => {
  const hints = { hasDocumentAttachment: true };
  assert.equal(getExplicitToolHint('analyze this sheet and create groups per tab', hints), 'analyze_file');
  assert.equal(getExplicitToolHint('summarize the attached doc', hints), 'analyze_file');
  assert.equal(getExplicitToolHint('go through this and let me know what you see', hints), 'analyze_file');
  // No attachment context → no forcing.
  assert.notEqual(getExplicitToolHint('analyze this sheet', {}), 'analyze_file');
  // Attachment but unrelated request → no forcing.
  assert.notEqual(getExplicitToolHint('remind me to call Priya at 5', hints), 'analyze_file');
});

test('dashboard file analysis reads the attachment from its isolated session path', async () => {
  const calls = { sql: [], localReads: [], remoteReads: 0 };
  const root = 'C:\\Users\\tester\\AppData\\Roaming\\ari-desktop\\session-attachments';
  const localPath = `${root}\\session-a\\file-a.xlsx`;
  const service = createFileAnalysisService({
    queryFn: async (sql, params) => {
      calls.sql.push({ sql, params });
      return { rows: [{ local_path: localPath, file_name: 'leads.xlsx', mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }] };
    },
    localFileRoot: root,
    readFileFn: async (requestedPath) => {
      calls.localReads.push(requestedPath);
      return Buffer.from('xlsx-bytes');
    },
    httpGet: async () => {
      calls.remoteReads += 1;
      throw new Error('remote download must not run');
    },
    anthropicFactory: () => null,
    openaiFactory: () => ({
      files: {
        create: async () => ({ id: 'local-file-1' }),
        delete: async () => {},
      },
      responses: {
        create: async () => ({ output_text: 'Tab "Prospects": Maya | maya@example.com | Northstar' }),
      },
    }),
  });

  const result = await runWithChatSession({
    sessionId: '11111111-1111-4111-8111-111111111111',
    clientMessageId: '22222222-2222-4222-8222-222222222222',
  }, () => service.analyzeDocument('919000000001', 'tell me what you see'));

  assert.match(calls.sql[0].sql, /ari_chat_attachments/);
  assert.equal(calls.sql[0].params[1], '11111111-1111-4111-8111-111111111111');
  assert.deepEqual(calls.localReads, [localPath]);
  assert.equal(calls.remoteReads, 0);
  assert.match(result.text, /Prospects/);
});

test('loadRecentDocument selects the newest attachment from the active chat session', async () => {
  const root = 'C:\\Users\\tester\\AppData\\Roaming\\ari-desktop\\session-attachments';
  const localPath = `${root}\\session-a\\latest.xlsx`;
  const calls = [];
  const service = createFileAnalysisService({
    localFileRoot: root,
    queryFn: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{
        id: 'attachment-1',
        local_path: localPath,
        file_name: 'latest.xlsx',
        mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        created_at: '2026-07-17T12:00:00.000Z',
      }] };
    },
    readFileFn: async () => Buffer.from('latest-workbook'),
  });

  const result = await runWithChatSession({
    sessionId: '11111111-1111-4111-8111-111111111111',
    clientMessageId: '22222222-2222-4222-8222-222222222222',
  }, () => service.loadRecentDocument('919000000001'));

  assert.equal(calls.length, 1, 'a session attachment must win without querying legacy user_files');
  assert.match(calls[0].sql, /FROM ari_chat_attachments/);
  assert.equal(calls[0].params[1], '11111111-1111-4111-8111-111111111111');
  assert.deepEqual(result.buffer, Buffer.from('latest-workbook'));
});

test('loadRecentDocument applies a parameterized filename hint within the active session', async () => {
  const root = 'C:\\safe-root';
  let captured;
  const service = createFileAnalysisService({
    localFileRoot: root,
    queryFn: async (sql, params) => {
      captured = { sql, params };
      return { rows: [{ local_path: `${root}\\pipeline.xlsx`, file_name: 'pipeline.xlsx' }] };
    },
    readFileFn: async () => Buffer.from('sheet'),
  });

  await runWithChatSession({
    sessionId: '11111111-1111-4111-8111-111111111111',
    clientMessageId: '22222222-2222-4222-8222-222222222222',
  }, () => service.loadRecentDocument('919000000001', 'pipeline'));

  assert.match(captured.sql, /file_name ILIKE \$3/);
  assert.equal(captured.params[2], '%pipeline%');
});

test('loadRecentDocument returns bytes and stable document metadata', async () => {
  const service = createFileAnalysisService({
    queryFn: async () => ({ rows: [{
      id: 42,
      file_url: 'https://files.example.test/leads.csv',
      document_name: 'leads.csv',
      mime_type: 'text/csv',
      created_at: '2026-07-17T12:34:56.000Z',
    }] }),
    httpGet: async () => ({ data: Buffer.from('name,email\nA,a@example.test\n') }),
  });

  const result = await service.loadRecentDocument('919000000001');

  assert.deepEqual(result, {
    id: 42,
    buffer: Buffer.from('name,email\nA,a@example.test\n'),
    fileName: 'leads.csv',
    mimeType: 'text/csv',
    createdAt: '2026-07-17T12:34:56.000Z',
  });
});

test('loadRecentDocument returns a typed no-document result', async () => {
  const service = createFileAnalysisService({
    queryFn: async () => ({ rows: [] }),
  });

  const result = await service.loadRecentDocument('919000000001', 'missing.xlsx');

  assert.equal(result.error, 'no_document');
  assert.match(result.message, /missing\.xlsx/);
});

test('loadRecentDocument rejects a local path outside the configured attachment root', async () => {
  let diskRead = false;
  const service = createFileAnalysisService({
    localFileRoot: 'C:\\safe-root',
    queryFn: async () => ({ rows: [{
      id: 'attachment-unsafe',
      local_path: 'C:\\outside\\stolen.xlsx',
      file_name: 'stolen.xlsx',
    }] }),
    readFileFn: async () => {
      diskRead = true;
      return Buffer.from('must-not-read');
    },
  });

  await assert.rejects(
    () => service.loadRecentDocument('919000000001'),
    /outside the session directory/
  );
  assert.equal(diskRead, false);
});

test('the file_analyze handler is registered', () => {
  const registry = require('../src/handlers');
  assert.ok(registry.has('file_analyze'));
});

function fakeDeps({ rows, analysisText }) {
  const calls = { uploaded: [], deleted: [], responses: [] };
  return {
    calls,
    queryFn: async () => ({ rows }),
    httpGet: async () => ({ data: Buffer.from('col1,col2\na,b\n') }),
    anthropicFactory: () => null,
    openaiFactory: () => ({
      files: {
        create: async ({ file, purpose }) => {
          calls.uploaded.push({ name: file.name, purpose });
          return { id: 'file-test-1' };
        },
        delete: async (id) => { calls.deleted.push(id); },
      },
      responses: {
        create: async (req) => {
          calls.responses.push(req);
          return { output_text: analysisText };
        },
      },
    }),
  };
}

test('analyzeDocument uploads, analyzes, and always cleans up the OpenAI file', async () => {
  const deps = fakeDeps({
    rows: [{ id: 1, file_url: 'https://x/f.xlsx', file_name: 'leads.xlsx', mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
    analysisText: 'Tab "Investors": Priya | priya@x.io | Northstar',
  });
  const service = createFileAnalysisService(deps);
  const result = await service.analyzeDocument('919000000001', 'list every tab and its leads');

  assert.equal(result.fileName, 'leads.xlsx');
  assert.match(result.text, /Investors/);
  assert.deepEqual(deps.calls.uploaded, [{ name: 'leads.xlsx', purpose: 'user_data' }]);
  await new Promise((r) => setTimeout(r, 10)); // fire-and-forget delete
  assert.deepEqual(deps.calls.deleted, ['file-test-1']);
  const content = deps.calls.responses[0].input[0].content;
  assert.equal(content[0].type, 'input_file');
  assert.match(content[1].text, /list every tab and its leads/);
});

test('no saved document returns an honest message instead of throwing', async () => {
  const deps = fakeDeps({ rows: [], analysisText: '' });
  const service = createFileAnalysisService(deps);
  const result = await service.analyzeDocument('919000000001', 'summarize');
  assert.equal(result.error, 'no_document');
  assert.match(result.message, /Attach the file/);
});

test('no provider keys degrades to a clear not-configured message', async () => {
  const service = createFileAnalysisService({
    queryFn: async () => ({ rows: [{ file_url: 'https://x/f.pdf', file_name: 'f.pdf' }] }),
    openaiFactory: () => null,
    anthropicFactory: () => null,
  });
  const result = await service.analyzeDocument('919000000001', 'summarize');
  assert.equal(result.error, 'not_configured');
});

test('falls back to Anthropic code execution when OpenAI is out of quota', async () => {
  const cleanup = { openai: [], anthropic: [] };
  const service = createFileAnalysisService({
    queryFn: async () => ({ rows: [{ file_url: 'https://x/leads.xlsx', file_name: 'leads.xlsx' }] }),
    httpGet: async () => ({ data: Buffer.from('fake') }),
    openaiFactory: () => ({
      files: {
        create: async () => ({ id: 'file-oai-1' }),
        delete: async (id) => { cleanup.openai.push(id); },
      },
      responses: {
        create: async () => { const e = new Error('quota'); e.status = 429; throw e; },
      },
    }),
    anthropicFactory: () => ({
      beta: { files: {
        upload: async () => ({ id: 'file-ant-1' }),
        delete: async (id) => { cleanup.anthropic.push(id); },
      } },
      messages: {
        create: async () => ({
          stop_reason: 'end_turn',
          content: [
            { type: 'server_tool_use', name: 'code_execution' },
            { type: 'text', text: 'Tab "Investors": Priya | priya@x.io' },
          ],
        }),
      },
    }),
  });

  const result = await service.analyzeDocument('919000000001', 'list the tabs');
  assert.equal(result.provider, 'anthropic');
  assert.match(result.text, /Investors/);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(cleanup.openai, ['file-oai-1'], 'failed OpenAI upload still cleaned up');
  assert.deepEqual(cleanup.anthropic, ['file-ant-1'], 'Anthropic upload cleaned up');
});

test('oversized analyses are truncated to fit the agent-loop tool budget', async () => {
  const deps = fakeDeps({
    rows: [{ file_url: 'https://x/f.xlsx', file_name: 'big.xlsx' }],
    analysisText: 'x'.repeat(10000),
  });
  const service = createFileAnalysisService(deps);
  const result = await service.analyzeDocument('919000000001', 'dump it all');
  assert.ok(result.text.length < 4000, `got ${result.text.length}`);
  assert.match(result.text, /truncated/);
  assert.equal(result.complete, false);
  assert.equal(result.truncated, true);
});

test('analyzeArtifacts preserves requested order and returns typed coverage and evidence', async () => {
  const requested = ['user_file:42', 'session:33333333-3333-4333-8333-333333333333'];
  const artifacts = new Map([
    [requested[0], { artifactId: requested[0], buffer: Buffer.from('first'), fileName: 'first.csv', mimeType: 'text/csv' }],
    [requested[1], { artifactId: requested[1], buffer: Buffer.from('second'), fileName: 'second.pdf', mimeType: 'application/pdf' }],
  ]);
  const analyzed = [];
  const service = createFileAnalysisService({
    artifactService: {
      loadOwnedArtifact: async (_phone, id) => artifacts.get(id),
      listCurrentTurnArtifacts: async () => [],
    },
    openrouterFactory: () => null,
    anthropicFactory: () => null,
    openaiFactory: () => ({
      files: {
        create: async ({ file }) => { analyzed.push(file.name); return { id: `provider-${analyzed.length}` }; },
        delete: async () => {},
      },
      responses: { create: async () => ({ output_text: `evidence from ${analyzed.at(-1)}` }) },
    }),
  });

  const result = await service.analyzeArtifacts('919000000001', requested, 'find the differences', { mode: 'compare' });

  assert.deepEqual(analyzed, ['first.csv', 'second.pdf']);
  assert.deepEqual(result.files.map((file) => file.artifact_id), requested);
  assert.deepEqual(result.coverage, { requested: 2, analyzed: 2, failed: 0 });
  assert.equal(result.complete, true);
  assert.deepEqual(result.evidence.map((item) => item.artifact_id), requested);
  assert.equal(result.mode, 'compare');
});

test('plural analysis reports partial coverage and never claims completion for a truncated file', async () => {
  const first = 'user_file:7';
  const missing = 'session:55555555-5555-4555-8555-555555555555';
  const service = createFileAnalysisService({
    artifactService: {
      loadOwnedArtifact: async (_phone, id) => {
        if (id === missing) {
          const error = new Error('The requested artifact is unavailable.');
          error.code = 'artifact_not_found';
          throw error;
        }
        return { artifactId: first, buffer: Buffer.from('large'), fileName: 'large.csv', mimeType: 'text/csv' };
      },
      listCurrentTurnArtifacts: async () => [],
    },
    openrouterFactory: () => null,
    anthropicFactory: () => null,
    openaiFactory: () => ({
      files: { create: async () => ({ id: 'provider-large' }), delete: async () => {} },
      responses: { create: async () => ({ output_text: 'x'.repeat(10000) }) },
    }),
  });

  const result = await service.analyzeArtifacts('919000000001', [first, missing], 'extract it');

  assert.deepEqual(result.coverage, { requested: 2, analyzed: 1, failed: 1 });
  assert.equal(result.complete, false);
  assert.equal(result.files[0].complete, false);
  assert.equal(result.files[1].error.code, 'artifact_not_found');
});

test('file handler returns a typed plural result while retaining the legacy fallback', async () => {
  const handler = createFileAnalysisHandler({
    analysisService: {
      analyzeArtifacts: async () => ({
        files: [{ artifact_id: 'user_file:42', file_name: 'leads.csv', text: 'A | a@example.test', complete: true }],
        coverage: { requested: 1, analyzed: 1, failed: 0 },
        complete: true,
        evidence: [{ artifact_id: 'user_file:42', file_name: 'leads.csv' }],
        mode: 'extract',
      }),
      analyzeDocument: async () => ({ fileName: 'legacy.pdf', text: 'legacy preview', complete: true }),
    },
  });

  const typed = await handler({ text: 'read it' }, {
    userPhone: '919000000001',
    intentParams: { artifact_ids: ['user_file:42'], question: 'list leads', mode: 'extract' },
  });
  assert.equal(typed.status, 'success');
  assert.equal(typed.data.files[0].artifact_id, 'user_file:42');
  assert.equal(typed.data.coverage.analyzed, 1);
  assert.equal(typed.evidence[0].artifact_id, 'user_file:42');

  const legacy = await handler({ text: 'summarize my latest file' }, {
    userPhone: '919000000001', intentParams: {},
  });
  assert.match(legacy, /Contents of legacy\.pdf/);
});
