'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { _internals } = require('../src/routes/webhook.routes');
const controller = require('../src/controllers/webhook.controller');
const aiService = require('../src/services/ai.service');
const fileService = require('../src/services/file.service');
const messagingService = require('../src/services/messaging.service');
const { currentChatSession, runWithChatSession } = require('../src/services/chat-session-context');

test('dashboard run reservation never overwrites an active session run', () => {
  const key = '919999999993:88888888-8888-4888-8888-888888888888';
  const first = { runId: 'run-first', abortController: new AbortController() };
  const second = { runId: 'run-second', abortController: new AbortController() };
  _internals.dashboardRuns.delete(key);

  try {
    assert.equal(_internals.reserveDashboardRun(key, first), true);
    assert.equal(_internals.reserveDashboardRun(key, second), false);
    assert.equal(_internals.dashboardRuns.get(key), first);
    assert.equal(_internals.releaseDashboardRun(key, second.runId), false);
    assert.equal(_internals.dashboardRuns.get(key), first);
    assert.equal(_internals.releaseDashboardRun(key, first.runId), true);
    assert.equal(_internals.dashboardRuns.has(key), false);
  } finally {
    _internals.dashboardRuns.delete(key);
  }
});

test('dashboard reply suppression is reference counted across concurrent sessions', () => {
  const user = '919999999994';
  messagingService.clearDashboardMode(user);
  messagingService.setDashboardMode(user);
  messagingService.setDashboardMode(user);
  assert.equal(messagingService.isInDashboardMode(user), true);
  messagingService.clearDashboardMode(user);
  assert.equal(messagingService.isInDashboardMode(user), true, 'one finishing session must not unsuppress the other');
  messagingService.clearDashboardMode(user);
  assert.equal(messagingService.isInDashboardMode(user), false);
});

test('the same user can hold independent processing locks in different dashboard sessions', async () => {
  const user = '919999999995';
  const keyA = await runWithChatSession({ sessionId: 'session-a' }, async () => require('../src/services/chat-session-context').conversationStateKey(user));
  const keyB = await runWithChatSession({ sessionId: 'session-b' }, async () => require('../src/services/chat-session-context').conversationStateKey(user));
  await controller.acquireUserLock(keyA);
  try {
    await Promise.race([
      controller.acquireUserLock(keyB),
      new Promise((_, reject) => setTimeout(() => reject(new Error('second session was blocked')), 100)),
    ]);
    controller.releaseUserLock(keyB);
  } finally {
    controller.releaseUserLock(keyA);
  }
});

test('dashboard attachment batches save every file before routing the caption once', async () => {
  const calls = [];
  const caption = 'Email these documents to priya@example.com';
  const attachments = [
    { filename: 'one.pdf', mime_type: 'application/pdf', buffer: Buffer.from('one') },
    { filename: 'two.pdf', mime_type: 'application/pdf', buffer: Buffer.from('two') },
    { filename: 'three.pdf', mime_type: 'application/pdf', buffer: Buffer.from('three') },
  ];

  await _internals.processDashboardAttachmentBatch({
    attachments,
    text: caption,
    userId: '919999999993',
    runId: 'run-attachment-batch',
    clientMessageId: '99999999-9999-4999-8999-999999999999',
    signal: null,
    controller: {
      handlePlatformMessage: async (message) => {
        calls.push(message);
        return message.type === 'document'
          ? { status: 'success', fileId: `file-${calls.length}`, documentName: message.document.filename }
          : undefined;
      },
    },
  });

  assert.equal(calls.length, attachments.length + 1);
  assert.ok(calls.slice(0, -1).every((message) =>
    message.type === 'document'
      && message.documentSaveOnly === true
      && message.text === ''
      && message.document.caption === ''));
  const actionable = calls.filter((message) => message.text === caption
    || message.document?.caption === caption);
  assert.equal(actionable.length, 1, 'the caption must reach exactly one agent turn');
  assert.equal(calls.at(-1).type, 'text');
  assert.equal(calls.at(-1).messageId, '99999999-9999-4999-8999-999999999999');
});

test('dashboard attachment batch stops on a failed second save and surfaces partial truth', async () => {
  const calls = [];
  const attachments = [
    { filename: 'one.pdf', mime_type: 'application/pdf', buffer: Buffer.from('one') },
    { filename: 'corrupt.pdf', mime_type: 'application/pdf', buffer: Buffer.from('not-a-pdf') },
    { filename: 'three.pdf', mime_type: 'application/pdf', buffer: Buffer.from('three') },
  ];
  let caught;

  await assert.rejects(
    _internals.processDashboardAttachmentBatch({
      attachments,
      text: 'Email these documents to priya@example.com',
      userId: '919999999993',
      runId: 'run-attachment-failure',
      clientMessageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      signal: null,
      controller: {
        handlePlatformMessage: async (message) => {
          calls.push(message);
          if (message.document?.filename === 'one.pdf') {
            return { status: 'success', fileId: 'file-one', documentName: 'one.pdf' };
          }
          if (message.document?.filename === 'corrupt.pdf') return null;
          throw new Error('the third attachment must never be attempted');
        },
      },
    }),
    (error) => {
      caught = error;
      assert.equal(error.code, 'attachment_batch_partial');
      assert.equal(error.status, 'partial');
      assert.equal(error.completedAttachments, 1);
      assert.equal(error.failedAttachment, 'corrupt.pdf');
      return true;
    },
  );

  assert.equal(calls.length, 2, 'the third save and caption turn must not run');
  assert.equal(calls.some((message) => message.type === 'text'), false);
  assert.equal(_internals.dashboardSubmissionStatusForError(caught, false), 'partial');
  assert.match(_internals.dashboardAttachmentFailureMessage(caught), /saved 1 of 3 documents/i);
  assert.match(_internals.dashboardAttachmentFailureMessage(caught), /did not run your instruction/i);

  const history = [];
  const surfaced = await runWithChatSession({
    userPhone: '919999999993',
    sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    clientMessageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  }, () => _internals.surfaceDashboardAttachmentFailure({
    error: caught,
    userId: '919999999993',
    text: 'Email these documents to priya@example.com',
    attachmentCount: attachments.length,
    saveMessage: async (...args) => history.push({ args, session: currentChatSession() }),
  }));
  assert.equal(surfaced.status, 'partial');
  assert.match(surfaced.error, /saved 1 of 3 documents/i);
  assert.deepEqual(history.map((entry) => entry.args[1]), ['user', 'assistant']);
  assert.equal(history[0].args[2], 'Email these documents to priya@example.com');
  assert.match(history[1].args[2], /did not run your instruction/i);
  assert.ok(history.every((entry) => entry.session.sessionId === 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
  assert.ok(history.every((entry) => entry.session.clientMessageId === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
});

test('dashboard save-only ingestion throws typed MIME and persistence failures', async (t) => {
  await assert.rejects(
    controller.handleDocument({
      from: '919999999987',
      text: '',
      documentSaveOnly: true,
      document: {
        filename: 'corrupt.pdf', mime_type: 'application/pdf', buffer: Buffer.from('not-a-pdf'), caption: '',
      },
    }),
    (error) => error?.code === 'document_mime_mismatch',
  );

  const originalSave = fileService.saveUploadedBuffer;
  t.after(() => { fileService.saveUploadedBuffer = originalSave; });
  fileService.saveUploadedBuffer = async () => ({ success: false, error: 'database offline' });
  await assert.rejects(
    controller.handleDocument({
      from: '919999999987',
      text: '',
      documentSaveOnly: true,
      document: {
        filename: 'notes.txt', mime_type: 'text/plain', buffer: Buffer.from('plain notes'), caption: '',
      },
    }),
    (error) => error?.code === 'document_save_failed' && /database offline/i.test(error.message),
  );
});

test('platform save-only boundary propagates typed ingestion failures without sending a generic reply', async (t) => {
  const originals = {
    acquireUserLock: controller.acquireUserLock,
    releaseUserLock: controller.releaseUserLock,
    isRateLimited: controller.isRateLimited,
    send: messagingService.send,
  };
  t.after(() => {
    controller.acquireUserLock = originals.acquireUserLock;
    controller.releaseUserLock = originals.releaseUserLock;
    controller.isRateLimited = originals.isRateLimited;
    messagingService.send = originals.send;
  });
  let sends = 0;
  controller.acquireUserLock = async () => {};
  controller.releaseUserLock = () => {};
  controller.isRateLimited = () => false;
  messagingService.send = async () => { sends += 1; };

  await assert.rejects(
    controller.handlePlatformMessage({
      userId: '919999999986',
      text: '',
      type: 'document',
      platform: 'whatsapp',
      source: 'dashboard',
      messageId: 'save-only-propagation:0',
      documentSaveOnly: true,
      documentBatchId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      document: {
        filename: 'corrupt.pdf', mime_type: 'application/pdf', buffer: Buffer.from('not-a-pdf'), caption: '',
      },
    }),
    (error) => error?.code === 'document_mime_mismatch',
  );
  assert.equal(sends, 0);
});

test('dashboard save-only document ingestion cannot enter the agent or duplicate history', async (t) => {
  const originals = {
    acquireUserLock: controller.acquireUserLock,
    releaseUserLock: controller.releaseUserLock,
    isRateLimited: controller.isRateLimited,
    handleDocument: controller.handleDocument,
    tryAgent: controller._tryAgenticPlatformTurn,
    saveMessage: aiService.saveMessage,
  };
  t.after(() => {
    controller.acquireUserLock = originals.acquireUserLock;
    controller.releaseUserLock = originals.releaseUserLock;
    controller.isRateLimited = originals.isRateLimited;
    controller.handleDocument = originals.handleDocument;
    controller._tryAgenticPlatformTurn = originals.tryAgent;
    aiService.saveMessage = originals.saveMessage;
  });

  const history = [];
  let agentCalls = 0;
  let received = null;
  controller.acquireUserLock = async () => {};
  controller.releaseUserLock = () => {};
  controller.isRateLimited = () => false;
  controller.handleDocument = async (message) => {
    received = message;
    return { status: 'success', fileId: 'file-one', documentName: 'one.pdf' };
  };
  controller._tryAgenticPlatformTurn = async () => { agentCalls += 1; return 'must not run'; };
  aiService.saveMessage = async (...args) => { history.push(args); };

  const result = await controller.handlePlatformMessage({
    userId: '919999999989',
    text: '',
    type: 'document',
    platform: 'whatsapp',
    source: 'dashboard',
    messageId: 'batch-save-only:0',
    documentSaveOnly: true,
    documentBatchId: '99999999-9999-4999-8999-999999999999',
    document: {
      filename: 'one.pdf', mime_type: 'application/pdf', buffer: Buffer.from('%PDF-test'), caption: '',
    },
  });

  assert.deepEqual(result, { status: 'success', fileId: 'file-one', documentName: 'one.pdf' });
  assert.equal(received.documentSaveOnly, true);
  assert.equal(received.documentBatchId, '99999999-9999-4999-8999-999999999999');
  assert.equal(agentCalls, 0);
  assert.deepEqual(history, []);
});
