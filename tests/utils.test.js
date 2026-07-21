const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ========== BoundedMap Tests ==========
const BoundedMap = require('../src/utils/bounded-map');

describe('BoundedMap', () => {
  it('stores and retrieves values', () => {
    const map = new BoundedMap(100);
    map.set('key1', 'value1');
    assert.equal(map.get('key1'), 'value1');
    map.destroy();
  });

  it('returns undefined for missing keys', () => {
    const map = new BoundedMap(100);
    assert.equal(map.get('missing'), undefined);
    map.destroy();
  });

  it('evicts oldest entries when exceeding max size', () => {
    const map = new BoundedMap(3);
    map.set('a', 1);
    map.set('b', 2);
    map.set('c', 3);
    map.set('d', 4); // should evict 'a'
    assert.equal(map.get('a'), undefined);
    assert.equal(map.get('d'), 4);
    assert.equal(map.size, 3);
    map.destroy();
  });

  it('expires entries after TTL', async () => {
    const map = new BoundedMap(100, 50); // 50ms TTL
    map.set('fast', 'gone');
    assert.equal(map.get('fast'), 'gone');
    await new Promise(r => setTimeout(r, 60));
    assert.equal(map.get('fast'), undefined);
    map.destroy();
  });

  it('supports per-key TTL override', async () => {
    const map = new BoundedMap(100, 10000); // long default TTL
    map.set('short', 'val', 50); // 50ms override
    assert.equal(map.get('short'), 'val');
    await new Promise(r => setTimeout(r, 60));
    assert.equal(map.get('short'), undefined);
    map.destroy();
  });

  it('has() returns false for expired entries', async () => {
    const map = new BoundedMap(100, 50);
    map.set('x', 1);
    assert.equal(map.has('x'), true);
    await new Promise(r => setTimeout(r, 60));
    assert.equal(map.has('x'), false);
    map.destroy();
  });

  it('delete removes entries', () => {
    const map = new BoundedMap(100);
    map.set('a', 1);
    map.delete('a');
    assert.equal(map.get('a'), undefined);
    map.destroy();
  });

  it('clear removes all entries', () => {
    const map = new BoundedMap(100);
    map.set('a', 1);
    map.set('b', 2);
    map.clear();
    assert.equal(map.size, 0);
    map.destroy();
  });

  it('cleanup removes expired entries', async () => {
    const map = new BoundedMap(100, 50);
    map.set('a', 1);
    map.set('b', 2);
    await new Promise(r => setTimeout(r, 60));
    map.set('c', 3); // not expired yet
    map.cleanup();
    assert.equal(map.size, 1);
    assert.equal(map.get('c'), 3);
    map.destroy();
  });
});

// ========== Security Utils Tests ==========
const { escapeHtml, isSafeUrl, sanitizeInput, verifySlackSignature } = require('../src/utils/security');

describe('escapeHtml', () => {
  it('escapes HTML special characters', () => {
    assert.equal(escapeHtml('<script>alert("xss")</script>'),
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  it('handles null/undefined', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
  });

  it('handles ampersand and quotes', () => {
    assert.equal(escapeHtml("Rock & Roll's \"best\""),
      "Rock &amp; Roll&#39;s &quot;best&quot;");
  });
});

describe('isSafeUrl', () => {
  it('allows HTTPS URLs', () => {
    assert.equal(isSafeUrl('https://example.com/path'), true);
  });

  it('allows HTTP URLs', () => {
    assert.equal(isSafeUrl('http://example.com'), true);
  });

  it('blocks localhost', () => {
    assert.equal(isSafeUrl('http://localhost:3000'), false);
    assert.equal(isSafeUrl('http://127.0.0.1'), false);
  });

  it('blocks private IP ranges', () => {
    assert.equal(isSafeUrl('http://10.0.0.1'), false);
    assert.equal(isSafeUrl('http://172.16.0.1'), false);
    assert.equal(isSafeUrl('http://192.168.1.1'), false);
    assert.equal(isSafeUrl('http://169.254.1.1'), false);
  });

  it('blocks non-http protocols', () => {
    assert.equal(isSafeUrl('ftp://example.com'), false);
    assert.equal(isSafeUrl('file:///etc/passwd'), false);
  });

  it('blocks internal hostnames', () => {
    assert.equal(isSafeUrl('http://server.local'), false);
    assert.equal(isSafeUrl('http://api.internal'), false);
  });

  it('handles null/empty', () => {
    assert.equal(isSafeUrl(null), false);
    assert.equal(isSafeUrl(''), false);
    assert.equal(isSafeUrl('not-a-url'), false);
  });
});

describe('sanitizeInput', () => {
  it('truncates long strings', () => {
    const long = 'a'.repeat(10000);
    assert.equal(sanitizeInput(long, 100).length, 100);
  });

  it('returns short strings as-is', () => {
    assert.equal(sanitizeInput('hello'), 'hello');
  });

  it('handles null/undefined', () => {
    assert.equal(sanitizeInput(null), '');
    assert.equal(sanitizeInput(undefined), '');
  });

  it('converts numbers to strings', () => {
    assert.equal(sanitizeInput(42), '42');
  });
});

describe('verifySlackSignature', () => {
  const crypto = require('crypto');
  const secret = 'test-secret-12345';
  const body = '{"text":"hello"}';
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sigBase = `v0:${timestamp}:${body}`;
  const validSig = 'v0=' + crypto.createHmac('sha256', secret).update(sigBase, 'utf8').digest('hex');

  it('accepts valid signatures', () => {
    assert.equal(verifySlackSignature(secret, body, timestamp, validSig), true);
  });

  it('rejects invalid signatures', () => {
    assert.equal(verifySlackSignature(secret, body, timestamp, 'v0=badhash'), false);
  });

  it('rejects old timestamps (replay protection)', () => {
    const oldTimestamp = (Math.floor(Date.now() / 1000) - 600).toString();
    const oldSigBase = `v0:${oldTimestamp}:${body}`;
    const oldSig = 'v0=' + crypto.createHmac('sha256', secret).update(oldSigBase, 'utf8').digest('hex');
    assert.equal(verifySlackSignature(secret, body, oldTimestamp, oldSig), false);
  });

  it('rejects missing parameters', () => {
    assert.equal(verifySlackSignature(null, body, timestamp, validSig), false);
    assert.equal(verifySlackSignature(secret, body, null, validSig), false);
    assert.equal(verifySlackSignature(secret, body, timestamp, null), false);
  });
});

// ========== Retry Tests ==========
const { withRetry } = require('../src/utils/retry');
const webhookController = require('../src/controllers/webhook.controller');
const gmailService = require('../src/services/gmail.service');
const aiService = require('../src/services/ai.service');
const axios = require('axios');
const llmProvider = require('../src/services/llm-provider');
const scheduledEmailJob = require('../src/jobs/scheduled-email.job');
const googleAuthService = require('../src/services/google-auth.service');

describe('withRetry', () => {
  it('returns result on first success', async () => {
    const result = await withRetry(() => Promise.resolve('ok'));
    assert.equal(result, 'ok');
  });

  it('retries on failure then succeeds', async () => {
    let attempts = 0;
    const result = await withRetry(() => {
      attempts++;
      if (attempts < 3) throw { response: { status: 500 } };
      return 'recovered';
    }, { maxRetries: 3, baseDelay: 10 });
    assert.equal(result, 'recovered');
    assert.equal(attempts, 3);
  });

  it('throws on non-retryable status codes', async () => {
    await assert.rejects(
      () => withRetry(() => { throw { response: { status: 401 } }; }, { maxRetries: 3, baseDelay: 10 }),
      (err) => err.response.status === 401
    );
  });

  it('throws after max retries exceeded', async () => {
    let attempts = 0;
    await assert.rejects(
      () => withRetry(() => {
        attempts++;
        throw { response: { status: 500 } };
      }, { maxRetries: 2, baseDelay: 10 }),
      (err) => err.response.status === 500
    );
    assert.equal(attempts, 3); // initial + 2 retries
  });
});

describe('scheduled email attachment serialization', () => {
  it('serializes attachment buffers into a JSON string for JSONB storage', () => {
    const json = scheduledEmailJob.serializeAttachments([
      {
        fileName: 'resume.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('hello attachment')
      }
    ]);

    assert.equal(typeof json, 'string');
    const parsed = JSON.parse(json);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].fileName, 'resume.pdf');
    assert.equal(parsed[0].mimeType, 'application/pdf');
    assert.equal(parsed[0].base64, Buffer.from('hello attachment').toString('base64'));
  });

  it('drops attachments without binary content', () => {
    assert.equal(
      scheduledEmailJob.serializeAttachments([{ fileName: 'broken.pdf', mimeType: 'application/pdf', buffer: null }]),
      null
    );
  });
});

describe('scheduled email timezone parsing', () => {
  it('does not infer EST from email addresses like test.com', () => {
    const timezone = webhookController.extractTimezoneFromText(
      'send email to a@test.com, b@test.com tomorrow 9am about project update',
      'Asia/Kolkata'
    );
    assert.equal(timezone, 'Asia/Kolkata');
  });

  it('still honors explicit timezone aliases in message text', () => {
    const timezone = webhookController.extractTimezoneFromText(
      'schedule email to a@test.com tomorrow 9am timezone est about project update',
      'Asia/Kolkata'
    );
    assert.equal(timezone, 'America/New_York');
  });

  it('keeps scheduled email times in the fallback timezone when no timezone is specified', () => {
    const result = webhookController.parseEmailScheduleDetails(
      'send email to a@test.com, b@test.com tomorrow 9am about project update',
      'Asia/Kolkata'
    );
    assert.equal(result.success, true);
    assert.equal(result.timezone, 'Asia/Kolkata');
    assert.equal(result.recurrenceTime, '09:00');
  });
});

describe('direct email flow detection', () => {
  it('routes multi-recipient document prompts to bulk email', () => {
    const flowType = webhookController.getDirectEmailFlowType(
      'Personalize and schedule email to\n' +
      'dk557876@gmail.com (He is from hiring team of growlegal hiring for marketing manager)\n' +
      'test1@example.com he is ceo of techimmi hiring for social media manager\n' +
      'test2@example.com he is co founder of opensphere hiring for performance manager\n\n' +
      'use my cv to write custom personalised email to all of them and schedule for 6:00 pm today'
    );
    assert.equal(flowType, 'email_bulk');
  });

  it('routes single-recipient scheduled email prompts to email_schedule', () => {
    const flowType = webhookController.getDirectEmailFlowType(
      'send email to singhsneha8001@gmail.com for today 6pm about dinner'
    );
    assert.equal(flowType, 'email_schedule');
  });
});

describe('direct email handler rerouting', () => {
  it('reroutes single-email handling to bulk when multiple recipients are present', async () => {
    const originalBulk = webhookController.handleEmailBulk;
    const originalSchedule = webhookController.handleEmailSchedule;
    try {
      webhookController.handleEmailBulk = async () => 'bulk-path';
      webhookController.handleEmailSchedule = async () => 'schedule-path';
      const result = await webhookController.handleEmailSend({
        from: 'test-user',
        text: 'send email to a@test.com, b@test.com today 7pm about dinner'
      }, {});
      assert.equal(result, 'bulk-path');
    } finally {
      webhookController.handleEmailBulk = originalBulk;
      webhookController.handleEmailSchedule = originalSchedule;
    }
  });

  it('reroutes single-email handling to scheduled email when one recipient has a time', async () => {
    const originalBulk = webhookController.handleEmailBulk;
    const originalSchedule = webhookController.handleEmailSchedule;
    try {
      webhookController.handleEmailBulk = async () => 'bulk-path';
      webhookController.handleEmailSchedule = async () => 'schedule-path';
      const result = await webhookController.handleEmailSend({
        from: 'test-user',
        text: 'send email to a@test.com today 7pm about dinner'
      }, {});
      assert.equal(result, 'schedule-path');
    } finally {
      webhookController.handleEmailBulk = originalBulk;
      webhookController.handleEmailSchedule = originalSchedule;
    }
  });

  it('reroutes scheduled-email handling to bulk when multiple recipients are present', async () => {
    const originalBulk = webhookController.handleEmailBulk;
    try {
      webhookController.handleEmailBulk = async () => 'bulk-path';
      const result = await webhookController.handleEmailSchedule({
        from: 'test-user',
        text: 'schedule email to a@test.com, b@test.com today 7pm about dinner'
      }, {});
      assert.equal(result, 'bulk-path');
    } finally {
      webhookController.handleEmailBulk = originalBulk;
    }
  });
});

describe('bulk email scheduling helpers', () => {
  it('detects schedule time questions without treating them as edits', () => {
    assert.equal(webhookController.isScheduleStatusRequest('tell me the schedule time?'), true);
    assert.equal(webhookController.isScheduleAdjustmentRequest('tell me the schedule time?'), false);
  });

  it('detects schedule change instructions inside bulk confirmation', () => {
    assert.equal(webhookController.isScheduleAdjustmentRequest('hye change the time scheedule it for 2:37pm not am'), true);
  });

  it('builds bulk previews without truncating the email body', () => {
    const fullBody = 'Hello there. '.repeat(30) + 'Tail marker stays visible.';
    const preview = webhookController.buildBulkEmailPreview({
      drafts: [{ to: 'a@test.com', subject: 'Long body', body: fullBody }],
      mode: 'personalized',
      attachments: null,
      sendAt: null,
      timezone: null,
      isRecurring: false,
      recurrencePattern: null,
      recurrenceDays: null,
      recurrenceTime: null,
      recurrenceLabel: null
    });
    assert.match(preview, /Tail marker stays visible\./);
    assert.equal(preview.includes('...'), false);
  });

  it('updates the scheduled time in bulk confirmation instead of revising the email body', async () => {
    const originalParse = webhookController.parseEmailScheduleDetails;
    const userPhone = 'bulk-schedule-test';
    const nextSendAt = new Date('2030-01-01T09:07:00.000Z');

    try {
      webhookController.parseEmailScheduleDetails = () => ({
        success: true,
        sendAt: nextSendAt,
        timezone: 'Asia/Kolkata',
        isRecurring: false,
        recurrencePattern: null,
        recurrenceDays: null,
        recurrenceTime: '14:37',
        recurrenceLabel: null
      });

      webhookController.bulkEmailContext.set(userPhone, {
        drafts: [{ to: 'a@test.com', subject: 'Hi', body: 'Original body' }],
        allRecipients: ['a@test.com'],
        mode: 'personalized',
        attachments: null,
        sendAt: new Date('2030-01-01T01:00:00.000Z'),
        timezone: 'Asia/Kolkata',
        isRecurring: false,
        recurrencePattern: null,
        recurrenceDays: null,
        recurrenceTime: null,
        recurrenceLabel: null,
        timestamp: Date.now()
      });

      const response = await webhookController.handleBulkEmailConfirm({
        from: userPhone,
        text: 'change the time scheedule it for 2:37pm not am'
      });

      assert.match(response, /Scheduled for:/);
      assert.doesNotMatch(response, /Revised Personalized Emails/);
      assert.equal(webhookController.bulkEmailContext.get(userPhone).sendAt.getTime(), nextSendAt.getTime());
    } finally {
      webhookController.parseEmailScheduleDetails = originalParse;
      webhookController.bulkEmailContext.delete(userPhone);
    }
  });

  it('shows the current schedule instead of rewriting emails when asked for schedule time', async () => {
    const userPhone = 'bulk-schedule-status-test';
    webhookController.bulkEmailContext.set(userPhone, {
      drafts: [{ to: 'a@test.com', subject: 'Hi', body: 'Original body remains here' }],
      allRecipients: ['a@test.com'],
      mode: 'personalized',
      attachments: null,
      sendAt: new Date('2030-01-01T01:00:00.000Z'),
      timezone: 'Asia/Kolkata',
      isRecurring: false,
      recurrencePattern: null,
      recurrenceDays: null,
      recurrenceTime: null,
      recurrenceLabel: null,
      timestamp: Date.now()
    });

    try {
      const response = await webhookController.handleBulkEmailConfirm({
        from: userPhone,
        text: 'tell me the schedule time?'
      });

      assert.match(response, /Scheduled for:/);
      assert.match(response, /Original body remains here/);
      assert.doesNotMatch(response, /Revised Personalized Emails/);
    } finally {
      webhookController.bulkEmailContext.delete(userPhone);
    }
  });
});

describe('context-aware intent helpers', () => {
  it('builds controller intent hints from active workflow state', async () => {
    const userPhone = 'intent-hints-test';
    webhookController.bulkEmailContext.set(userPhone, {
      drafts: [{ to: 'a@test.com' }],
      sendAt: new Date('2030-01-01T01:00:00.000Z'),
      timestamp: Date.now()
    });
    webhookController.scheduledEmailContext.set(userPhone, {
      draft: { to: 'solo@test.com' },
      timestamp: Date.now()
    });
    webhookController.calendarConfirmContext.set(userPhone, {
      type: 'cancel_confirm',
      timestamp: Date.now()
    });
    webhookController.leaveConfirmContext.set(userPhone, {
      leaveId: 'leave-1',
      timestamp: Date.now()
    });
    webhookController.standupSetupContext.set(userPhone, {
      step: 'members',
      timestamp: Date.now()
    });
    webhookController.standupResponseContext.set(userPhone, {
      configId: 'standup-1',
      questionIndex: 1,
      timestamp: Date.now()
    });
    webhookController.pollVoteContext.set(userPhone, {
      pollId: 'poll-1',
      timestamp: Date.now()
    });
    webhookController.recentEmailContext.set(userPhone, {
      type: 'bulk',
      timestamp: Date.now()
    });
    webhookController.documentContext.set(userPhone, {
      fileName: 'resume.pdf',
      timestamp: Date.now()
    });

    try {
      const hints = await webhookController.getIntentContextHints(userPhone);
      assert.equal(hints.activeBulkEmail, true);
      assert.equal(hints.bulkEmailRecipientCount, 1);
      assert.equal(hints.bulkEmailScheduled, true);
      assert.equal(hints.activeScheduledEmail, true);
      assert.equal(hints.activeCalendarConfirmation, true);
      assert.equal(hints.calendarConfirmationType, 'cancel_confirm');
      assert.equal(hints.activeLeaveApproval, true);
      assert.equal(hints.activeStandupSetup, true);
      assert.equal(hints.standupSetupStep, 'members');
      assert.equal(hints.activeStandupResponse, true);
      assert.equal(hints.standupQuestionIndex, 2);
      assert.equal(hints.activePollVote, true);
      assert.equal(hints.hasRecentEmailContext, true);
      assert.equal(hints.recentEmailType, 'bulk');
      assert.equal(hints.hasDocumentAttachment, true);
    } finally {
      webhookController.bulkEmailContext.delete(userPhone);
      webhookController.scheduledEmailContext.delete(userPhone);
      webhookController.calendarConfirmContext.delete(userPhone);
      webhookController.leaveConfirmContext.delete(userPhone);
      webhookController.standupSetupContext.delete(userPhone);
      webhookController.standupResponseContext.delete(userPhone);
      webhookController.pollVoteContext.delete(userPhone);
      webhookController.recentEmailContext.delete(userPhone);
      webhookController.documentContext.delete(userPhone);
    }
  });

  it('includes recent conversation and workflow hints in AI intent classification', async () => {
    const originalPost = axios.post;
    const originalRecentContext = aiService.getRecentContext;
    const originalChatCompletion = llmProvider.chatCompletion;
    const originalSemanticRouter = process.env.SEMANTIC_ROUTER_ENABLED;
    const originalRagMcp = process.env.OPT_RAG_MCP_ENABLED;
    let capturedBody = null;

    try {
      process.env.SEMANTIC_ROUTER_ENABLED = 'false';
      process.env.OPT_RAG_MCP_ENABLED = 'false';
      aiService.getRecentContext = async () => ([
        { role: 'user', content: 'send email to a@test.com and b@test.com about dinner tomorrow' },
        { role: 'assistant', content: 'Bulk Email Preview (2 recipients)' },
        { role: 'assistant', content: 'Reply approve or reject to review the leave request.' }
      ]);
      axios.post = async (_url, body) => {
        capturedBody = body;
        return { data: { choices: [{ message: { content: '{"type":"email_bulk"}' } }] } };
      };
      llmProvider.chatCompletion = async (body) => {
        capturedBody = body;
        return { data: { choices: [{ message: { tool_calls: [{
          function: {
            name: 'bulk_email',
            arguments: JSON.stringify({ full_text: 'change the time to 5pm' })
          }
        }] } }] } };
      };

      const result = await aiService.detectSpecialCommand('change the time to 5pm', {
        userPhone: 'intent-context-ai-test',
        recentMessages: await aiService.getRecentContext('intent-context-ai-test'),
        contextHints: {
          activeBulkEmail: true,
          bulkEmailRecipientCount: 2,
          bulkEmailScheduled: true,
          activeCalendarConfirmation: true,
          calendarConfirmationType: 'cancel_confirm',
          activeLeaveApproval: true,
          activeStandupSetup: true,
          standupSetupStep: 'members',
          activeStandupResponse: true,
          standupQuestionIndex: 2,
          activePollVote: true,
          hasRecentEmailContext: true,
          recentEmailType: 'bulk'
        }
      });

      assert.equal(result.type, 'email_bulk');
      const promptText = capturedBody.messages.map(m => m.content).join('\n');
      assert.match(capturedBody.messages[0].content, /WORKFLOW CONTEXT/);
      assert.match(promptText, /Bulk Email Preview/);
      assert.match(promptText, /active bulk email draft/i);
      assert.match(promptText, /calendar confirmation flow/i);
      assert.match(promptText, /leave request/i);
      assert.match(promptText, /standup/i);
      assert.match(promptText, /poll voting prompt/i);
      assert.match(promptText, /change the time to 5pm/);
    } finally {
      axios.post = originalPost;
      aiService.getRecentContext = originalRecentContext;
      llmProvider.chatCompletion = originalChatCompletion;
      if (originalSemanticRouter === undefined) delete process.env.SEMANTIC_ROUTER_ENABLED;
      else process.env.SEMANTIC_ROUTER_ENABLED = originalSemanticRouter;
      if (originalRagMcp === undefined) delete process.env.OPT_RAG_MCP_ENABLED;
      else process.env.OPT_RAG_MCP_ENABLED = originalRagMcp;
    }
  });
});

describe('bulk email add-recipient and clarification flow', () => {
  it('adds a new personalized recipient without rewriting existing drafts', async () => {
    const originalDraftBulk = gmailService.draftPersonalizedBulkEmails;
    const originalGetSignatureName = webhookController.getUserNameForSignature;
    const userPhone = 'bulk-add-recipient-test';

    try {
      gmailService.draftPersonalizedBulkEmails = async () => ({
        success: true,
        drafts: [{
          to: 'new@test.com',
          subject: 'Growth Associate Application',
          body: 'Hello,\n\nI would like to apply for the Growth Associate role.'
        }]
      });
      webhookController.getUserNameForSignature = async () => 'Danish Khan';

      webhookController.bulkEmailContext.set(userPhone, {
        drafts: [
          { to: 'one@test.com', subject: 'Subject One', body: 'Body one', htmlBody: 'Body one' },
          { to: 'two@test.com', subject: 'Subject Two', body: 'Body two', htmlBody: 'Body two' }
        ],
        previousDrafts: [
          { to: 'one@test.com', subject: 'Subject One', body: 'Body one', htmlBody: 'Body one' },
          { to: 'two@test.com', subject: 'Subject Two', body: 'Body two', htmlBody: 'Body two' }
        ],
        allRecipients: ['one@test.com', 'two@test.com'],
        mode: 'personalized',
        attachments: null,
        sendAt: new Date('2030-01-01T01:00:00.000Z'),
        timezone: 'Asia/Kolkata',
        isRecurring: false,
        recurrencePattern: null,
        recurrenceDays: null,
        recurrenceTime: null,
        recurrenceLabel: null,
        timestamp: Date.now()
      });

      const response = await webhookController.handleBulkEmailConfirm({
        from: userPhone,
        text: 'also write for new@test.com he is hiring for growth associate'
      });

      const updatedCtx = webhookController.bulkEmailContext.get(userPhone);
      assert.equal(updatedCtx.drafts.length, 3);
      assert.equal(updatedCtx.drafts[0].subject, 'Subject One');
      assert.equal(updatedCtx.drafts[1].subject, 'Subject Two');
      assert.equal(updatedCtx.drafts[2].to, 'new@test.com');
      assert.match(response, /Updated Personalized Emails/);
      assert.match(response, /--- \*3\. new@test\.com\* _\(updated\)_ ---/);
      assert.doesNotMatch(response, /--- \*1\. one@test\.com\* _\(updated\)_ ---/);
    } finally {
      gmailService.draftPersonalizedBulkEmails = originalDraftBulk;
      webhookController.getUserNameForSignature = originalGetSignatureName;
      webhookController.bulkEmailContext.delete(userPhone);
    }
  });

  it('asks for clarification when adding a recipient without enough context', async () => {
    const userPhone = 'bulk-add-recipient-clarify-test';
    webhookController.bulkEmailContext.set(userPhone, {
      drafts: [
        { to: 'one@test.com', subject: 'Subject One', body: 'Body one', htmlBody: 'Body one' },
        { to: 'two@test.com', subject: 'Subject Two', body: 'Body two', htmlBody: 'Body two' }
      ],
      previousDrafts: [
        { to: 'one@test.com', subject: 'Subject One', body: 'Body one', htmlBody: 'Body one' },
        { to: 'two@test.com', subject: 'Subject Two', body: 'Body two', htmlBody: 'Body two' }
      ],
      allRecipients: ['one@test.com', 'two@test.com'],
      mode: 'personalized',
      attachments: null,
      sendAt: null,
      timezone: null,
      isRecurring: false,
      recurrencePattern: null,
      recurrenceDays: null,
      recurrenceTime: null,
      recurrenceLabel: null,
      timestamp: Date.now()
    });

    try {
      const response = await webhookController.handleBulkEmailConfirm({
        from: userPhone,
        text: 'add one more mail singhsneha8001@gmail.com'
      });

      assert.match(response, /I can add singhsneha8001@gmail.com, but I need a little more context/i);
      assert.equal(webhookController.bulkEmailContext.get(userPhone).drafts.length, 2);
    } finally {
      webhookController.bulkEmailContext.delete(userPhone);
    }
  });

  it('restores previous subjects before adding a new recipient', async () => {
    const originalDraftBulk = gmailService.draftPersonalizedBulkEmails;
    const originalGetSignatureName = webhookController.getUserNameForSignature;
    const userPhone = 'bulk-restore-subject-test';

    try {
      gmailService.draftPersonalizedBulkEmails = async () => ({
        success: true,
        drafts: [{
          to: 'sneha@test.com',
          subject: 'Growth Associate Position at Sneha Marketing Firm',
          body: 'Hi Sneha,\n\nI would like to apply for the Growth Associate role.'
        }]
      });
      webhookController.getUserNameForSignature = async () => 'Danish Khan';

      webhookController.bulkEmailContext.set(userPhone, {
        drafts: [
          { to: 'one@test.com', subject: 'Changed Subject One', body: 'Body one changed', htmlBody: 'Body one changed' },
          { to: 'two@test.com', subject: 'Changed Subject Two', body: 'Body two changed', htmlBody: 'Body two changed' }
        ],
        previousDrafts: [
          { to: 'one@test.com', subject: 'Original Subject One', body: 'Body one', htmlBody: 'Body one' },
          { to: 'two@test.com', subject: 'Original Subject Two', body: 'Body two', htmlBody: 'Body two' }
        ],
        allRecipients: ['one@test.com', 'two@test.com'],
        mode: 'personalized',
        attachments: null,
        sendAt: null,
        timezone: null,
        isRecurring: false,
        recurrencePattern: null,
        recurrenceDays: null,
        recurrenceTime: null,
        recurrenceLabel: null,
        timestamp: Date.now()
      });

      const response = await webhookController.handleBulkEmailConfirm({
        from: userPhone,
        text: "hey i didn't meant to change the subject, keep the subject as previous as it was, also add 1 more mail sneha@test.com i want to apply for the growth associate at her firm sneha marketing firm"
      });

      const updatedCtx = webhookController.bulkEmailContext.get(userPhone);
      assert.equal(updatedCtx.drafts.length, 3);
      assert.equal(updatedCtx.drafts[0].subject, 'Original Subject One');
      assert.equal(updatedCtx.drafts[1].subject, 'Original Subject Two');
      assert.equal(updatedCtx.drafts[2].to, 'sneha@test.com');
      assert.match(response, /Updated Personalized Emails/);
      assert.match(response, /--- \*1\. one@test\.com\* _\(updated\)_ ---/);
      assert.match(response, /--- \*2\. two@test\.com\* _\(updated\)_ ---/);
      assert.match(response, /--- \*3\. sneha@test\.com\* _\(updated\)_ ---/);
    } finally {
      gmailService.draftPersonalizedBulkEmails = originalDraftBulk;
      webhookController.getUserNameForSignature = originalGetSignatureName;
      webhookController.bulkEmailContext.delete(userPhone);
    }
  });
});

describe('scheduled email follow-up management', () => {
  it('detects natural scheduled email list requests', () => {
    assert.equal(webhookController.isScheduledEmailListRequest('show schedule email'), true);
    assert.equal(webhookController.isScheduledEmailListRequest('scheduled emails'), true);
  });

  it('updates the most recent scheduled bulk batch when the user changes the time', async () => {
    const originalParse = webhookController.parseEmailScheduleDetails;
    const originalUpdate = scheduledEmailJob.updateScheduledEmailsByIds;
    const userPhone = 'scheduled-followup-update-test';
    const nextSendAt = new Date('2030-01-01T14:25:00.000Z');
    let capturedUpdate = null;

    try {
      webhookController.storeRecentEmailContext(userPhone, {
        type: 'bulk',
        drafts: [
          { to: 'a@test.com', subject: 'Subject A', body: 'Body A', htmlBody: 'Body A' },
          { to: 'b@test.com', subject: 'Subject B', body: 'Body B', htmlBody: 'Body B' }
        ],
        referenceDraft: { to: 'a@test.com', subject: 'Subject A', body: 'Body A', htmlBody: 'Body A' },
        mode: 'personalized',
        sendAt: new Date('2030-01-01T13:23:00.000Z'),
        timezone: 'Asia/Kolkata',
        scheduledIds: [41, 42]
      });

      webhookController.parseEmailScheduleDetails = () => ({
        success: true,
        sendAt: nextSendAt,
        timezone: 'Asia/Kolkata',
        isRecurring: false,
        recurrencePattern: null,
        recurrenceDays: null,
        recurrenceTime: '19:55',
        recurrenceLabel: null
      });

      scheduledEmailJob.updateScheduledEmailsByIds = async (phone, ids, schedule) => {
        capturedUpdate = { phone, ids, schedule };
        return {
          success: true,
          emails: ids.map(id => ({
            id,
            recipients: [id === 41 ? 'a@test.com' : 'b@test.com'],
            subject: id === 41 ? 'Subject A' : 'Subject B',
            send_at: nextSendAt.toISOString(),
            timezone: schedule.timezone,
            is_recurring: false,
            recurrence_pattern: null,
            recurrence_days: null
          }))
        };
      };

      const response = await webhookController.handleRecentScheduledEmailManagement({
        from: userPhone,
        text: 'hey change the time of this schedule email to 7:55pm today'
      }, 'Asia/Kolkata');

      assert.deepEqual(capturedUpdate.ids, [41, 42]);
      assert.equal(capturedUpdate.phone, userPhone);
      assert.equal(capturedUpdate.schedule.timezone, 'Asia/Kolkata');
      assert.match(response, /Updated 2 scheduled emails!/);
      assert.match(response, /Sends at:/);
      const recentCtx = webhookController.recentEmailContext.get(userPhone);
      assert.equal(new Date(recentCtx.sendAt).getTime(), nextSendAt.getTime());
      assert.deepEqual(recentCtx.scheduledIds, [41, 42]);
    } finally {
      webhookController.parseEmailScheduleDetails = originalParse;
      scheduledEmailJob.updateScheduledEmailsByIds = originalUpdate;
      webhookController.recentEmailContext.delete(userPhone);
    }
  });

  it('shows the recent scheduled batch when asked to show schedule email', async () => {
    const originalGetScheduledEmails = scheduledEmailJob.getScheduledEmails;
    const userPhone = 'scheduled-followup-list-test';

    try {
      webhookController.storeRecentEmailContext(userPhone, {
        type: 'bulk',
        drafts: [
          { to: 'a@test.com', subject: 'Subject A', body: 'Body A', htmlBody: 'Body A' },
          { to: 'b@test.com', subject: 'Subject B', body: 'Body B', htmlBody: 'Body B' }
        ],
        referenceDraft: { to: 'a@test.com', subject: 'Subject A', body: 'Body A', htmlBody: 'Body A' },
        mode: 'personalized',
        sendAt: new Date('2030-01-01T13:23:00.000Z'),
        timezone: 'Asia/Kolkata',
        scheduledIds: [41, 42]
      });

      scheduledEmailJob.getScheduledEmails = async () => ([
        {
          id: 41,
          recipients: ['a@test.com'],
          subject: 'Subject A',
          send_at: '2030-01-01T13:23:00.000Z',
          timezone: 'Asia/Kolkata',
          is_recurring: false,
          recurrence_pattern: null,
          recurrence_days: null
        },
        {
          id: 42,
          recipients: ['b@test.com'],
          subject: 'Subject B',
          send_at: '2030-01-01T13:23:00.000Z',
          timezone: 'Asia/Kolkata',
          is_recurring: false,
          recurrence_pattern: null,
          recurrence_days: null
        },
        {
          id: 99,
          recipients: ['other@test.com'],
          subject: 'Other Subject',
          send_at: '2030-01-01T13:23:00.000Z',
          timezone: 'Asia/Kolkata',
          is_recurring: false,
          recurrence_pattern: null,
          recurrence_days: null
        }
      ]);

      const response = await webhookController.handleRecentScheduledEmailManagement({
        from: userPhone,
        text: 'show schedule email'
      }, 'Asia/Kolkata');

      assert.match(response, /Scheduled Emails/);
      assert.match(response, /ID: 41/);
      assert.match(response, /ID: 42/);
      assert.doesNotMatch(response, /ID: 99/);
    } finally {
      scheduledEmailJob.getScheduledEmails = originalGetScheduledEmails;
      webhookController.recentEmailContext.delete(userPhone);
    }
  });
});

describe('email send formatting', () => {
  it('does not append a second signature when the body already ends with Best, Name', () => {
    const body = 'Hi,\n\nLooking forward to discussing this opportunity.\n\nBest,\nDanish Khan';
    assert.equal(
      webhookController.addDefaultSignature(body, 'Danish Khan'),
      body
    );
  });

  it('normalizes smart punctuation in subjects before sending', () => {
    assert.equal(
      gmailService.normalizeSubject('Lead Generator Role at KTM \u00C3\u00A2\u00C2\u20AC\u00C2\u201C Application by Danish Khan'),
      'Lead Generator Role at KTM - Application by Danish Khan'
    );
    assert.equal(
      gmailService.normalizeSubject('Lead Generator Role at KTM \u00C3\u00A2\u00C2\u20AC\u00C2\u201C Application by Danish Khan'),
      'Lead Generator Role at KTM - Application by Danish Khan'
    );
  });

  it('MIME-encodes truly non-ASCII subjects before sending', () => {
    const raw = gmailService.buildMimeMessage(
      'me@example.com',
      ['to@example.com'],
      'R\u00e9sum\u00e9 for Jos\u00e9',
      '<div>Hello</div>'
    );
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');

    assert.match(decoded, /Subject: =\?UTF-8\?B\?/);
    assert.doesNotMatch(decoded, /Subject: R\u00e9sum\u00e9 for Jos\u00e9/);
  });
});

describe('bulk email targeted rewrites', () => {
  it('keeps the requested target when parsing ordinal rewrite instructions', () => {
    assert.deepEqual(
      webhookController.parseTargetedEmailNumbers('rewrite the 3rd number properly', 5),
      [2]
    );
  });

  it('normalizes ambiguous numbered rewrite instructions into a usable AI prompt', () => {
    assert.equal(
      webhookController.normalizeBulkRevisionInstruction('rewrite the 3rd number properly'),
      'Rewrite this email to be clearer, more polished, and professional while keeping the same intent.'
    );
  });

  it('revises only the targeted numbered email', async () => {
    const originalRevise = gmailService.reviseEmailWithAI;
    const userPhone = 'bulk-targeted-rewrite-test';
    const calls = [];

    try {
      gmailService.reviseEmailWithAI = async (draft, instruction) => {
        calls.push({ to: draft.to, instruction });
        return {
          success: true,
          subject: `${draft.subject} (updated)`,
          body: `Updated body for ${draft.to}`
        };
      };

      webhookController.bulkEmailContext.set(userPhone, {
        drafts: [
          { to: 'one@test.com', subject: 'One', body: 'Body one' },
          { to: 'two@test.com', subject: 'Two', body: 'Body two' },
          { to: 'three@test.com', subject: 'Three', body: 'Body three' }
        ],
        allRecipients: ['one@test.com', 'two@test.com', 'three@test.com'],
        mode: 'personalized',
        attachments: null,
        sendAt: null,
        timezone: null,
        isRecurring: false,
        recurrencePattern: null,
        recurrenceDays: null,
        recurrenceTime: null,
        recurrenceLabel: null,
        timestamp: Date.now()
      });

      const response = await webhookController.handleBulkEmailConfirm({
        from: userPhone,
        text: 'rewrite the 3rd number properly'
      });

      assert.equal(calls.length, 1);
      assert.equal(calls[0].to, 'three@test.com');
      assert.equal(
        calls[0].instruction,
        'Rewrite this email to be clearer, more polished, and professional while keeping the same intent.'
      );
      assert.equal(webhookController.bulkEmailContext.get(userPhone).drafts[0].body, 'Body one');
      assert.equal(webhookController.bulkEmailContext.get(userPhone).drafts[1].body, 'Body two');
      assert.equal(webhookController.bulkEmailContext.get(userPhone).drafts[2].body, 'Updated body for three@test.com');
      assert.match(response, /--- \*1\. one@test\.com\* ---\n\*Subject:\* One\nBody one/s);
      assert.match(response, /--- \*3\. three@test\.com\* _\(updated\)_ ---\n\*Subject:\* Three \(updated\)\nUpdated body for three@test\.com/s);
    } finally {
      gmailService.reviseEmailWithAI = originalRevise;
      webhookController.bulkEmailContext.delete(userPhone);
    }
  });
});

describe('email follow-up context helpers', () => {
  it('detects scheduling instructions inside email follow-ups', () => {
    assert.equal(webhookController.isExplicitEmailScheduleInstruction('shcedule it for 5pm today'), true);
  });

  it('detects previous-email reuse phrasing but not fresh email commands', () => {
    assert.equal(webhookController.isLikelyPreviousEmailReuseRequest('also schedule to singhsneha8001@gmail.com'), true);
    assert.equal(webhookController.isLikelyPreviousEmailReuseRequest('schedule email to singhsneha8001@gmail.com about dinner tomorrow'), false);
  });

  it('treats bare schedule corrections as email follow-ups when a recent email draft exists', () => {
    assert.equal(
      webhookController.isImplicitScheduleFollowUpForRecentEmail('schedule for today 10:32', { type: 'bulk' }),
      true
    );
    assert.equal(
      webhookController.isImplicitScheduleFollowUpForRecentEmail('schedule meeting for today 10:32', { type: 'bulk' }),
      false
    );
  });

  it('clones drafts for a new recipient and removes stale named greetings', () => {
    const draft = webhookController.cloneDraftForRecipient({
      to: 'danish@opensphere.ai',
      subject: 'Dinner Tomorrow Evening',
      body: 'Hi Danish,\n\nDinner is on me!',
      htmlBody: ''
    }, 'singhsneha8001@gmail.com');
    assert.equal(draft.to, 'singhsneha8001@gmail.com');
    assert.match(draft.body, /^Hi,/);
  });

  it('reuses a recent schedule when a follow-up asks to also schedule the same email', () => {
    const sendAt = new Date(Date.now() + 60 * 60 * 1000);
    const result = webhookController.resolveScheduleFromRecentEmailContext(
      'also schedule to singhsneha8001@gmail.com',
      'Asia/Kolkata',
      { sendAt, timezone: 'Asia/Kolkata', isRecurring: false, recurrencePattern: null, recurrenceDays: null, recurrenceTime: null, recurrenceLabel: null }
    );
    assert.equal(result.success, true);
    assert.equal(result.schedule.timezone, 'Asia/Kolkata');
    assert.equal(new Date(result.schedule.sendAt).getTime(), sendAt.getTime());
  });

  it('reuses the saved bulk draft when the user only corrects the schedule time', async () => {
    const originalIsConnected = googleAuthService.isConnected;
    const originalParseSchedule = webhookController.parseEmailScheduleDetails;
    const userPhone = 'bulk-schedule-correction-followup-test';
    const nextSendAt = new Date('2030-01-01T17:02:00.000Z');

    try {
      googleAuthService.isConnected = async () => true;
      webhookController.parseEmailScheduleDetails = () => ({
        success: true,
        sendAt: nextSendAt,
        timezone: 'Asia/Kolkata',
        isRecurring: false,
        recurrencePattern: null,
        recurrenceDays: null,
        recurrenceTime: '22:32',
        recurrenceLabel: null
      });

      webhookController.storeRecentEmailContext(userPhone, {
        type: 'bulk',
        drafts: [
          { to: 'a@test.com', subject: 'Subject A', body: 'Body A', htmlBody: 'Body A' },
          { to: 'b@test.com', subject: 'Subject B', body: 'Body B', htmlBody: 'Body B' }
        ],
        referenceDraft: { to: 'a@test.com', subject: 'Subject A', body: 'Body A', htmlBody: 'Body A' },
        mode: 'personalized',
        attachments: null
      });

      const response = await webhookController.handleRecentEmailReuse({
        from: userPhone,
        text: 'schedule for today 10:32'
      }, 'Asia/Kolkata');

      assert.match(response, /Bulk Email Preview/);
      assert.match(response, /Scheduled for:/);
      assert.equal(webhookController.bulkEmailContext.get(userPhone).sendAt.getTime(), nextSendAt.getTime());
    } finally {
      googleAuthService.isConnected = originalIsConnected;
      webhookController.parseEmailScheduleDetails = originalParseSchedule;
      webhookController.recentEmailContext.delete(userPhone);
      webhookController.bulkEmailContext.delete(userPhone);
    }
  });
});









