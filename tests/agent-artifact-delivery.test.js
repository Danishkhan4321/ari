'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.LOG_TO_FILES = 'false';
process.env.LOG_LEVEL = 'silent';

const controller = require('../src/controllers/webhook.controller');
const googleAuthService = require('../src/services/google-auth.service');
const gmailService = require('../src/services/gmail.service');
const googleDriveService = require('../src/services/google-drive.service');
const { fileArtifactService } = require('../src/services/file-artifact.service');
const {
  getAgentToolContract,
  validateAgentToolArguments,
} = require('../src/services/agent-tool-contracts.service');

const ARTIFACT_ID = 'session:33333333-3333-4333-8333-333333333333';

function installDeliveryStubs(t) {
  const originals = {
    isConnected: googleAuthService.isConnected,
    draftEmailWithAI: gmailService.draftEmailWithAI,
    draftSharedBulkEmail: gmailService.draftSharedBulkEmail,
    loadOwnedArtifacts: fileArtifactService.loadOwnedArtifacts,
    uploadFile: googleDriveService.uploadFile,
    signer: controller.getUserNameForSignature,
    parseSchedule: controller.parseEmailScheduleDetails,
    bulkMode: controller.getBulkEmailMode,
  };
  t.after(() => {
    googleAuthService.isConnected = originals.isConnected;
    gmailService.draftEmailWithAI = originals.draftEmailWithAI;
    gmailService.draftSharedBulkEmail = originals.draftSharedBulkEmail;
    fileArtifactService.loadOwnedArtifacts = originals.loadOwnedArtifacts;
    googleDriveService.uploadFile = originals.uploadFile;
    controller.getUserNameForSignature = originals.signer;
    controller.parseEmailScheduleDetails = originals.parseSchedule;
    controller.getBulkEmailMode = originals.bulkMode;
  });

  googleAuthService.isConnected = async () => true;
  gmailService.draftEmailWithAI = async () => ({
    success: true,
    to: 'owner@example.com',
    subject: 'Status',
    body: 'The project is ready.',
  });
  gmailService.draftSharedBulkEmail = async () => ({
    success: true,
    subject: 'Status',
    body: 'The project is ready.',
  });
  controller.getUserNameForSignature = async () => null;
  controller.getBulkEmailMode = () => 'shared';
  controller.parseEmailScheduleDetails = () => ({
    success: true,
    sendAt: new Date('2035-01-02T09:00:00.000Z'),
    timezone: 'UTC',
    isRecurring: false,
    recurrencePattern: null,
    recurrenceDays: null,
    recurrenceTime: null,
    recurrenceLabel: null,
  });
}

function ownedAttachment(name = 'selected.pdf', bytes = 'selected bytes') {
  return {
    artifactId: ARTIFACT_ID,
    buffer: Buffer.from(bytes),
    fileName: name,
    mimeType: 'application/pdf',
  };
}

test('agent email send attaches only explicitly requested owned artifacts', async (t) => {
  installDeliveryStubs(t);
  const phone = 'agent-attachment-send';
  const stale = Buffer.from('private stale document');
  const selected = ownedAttachment();
  let requested;
  fileArtifactService.loadOwnedArtifacts = async (userPhone, ids) => {
    requested = { userPhone, ids };
    return [selected];
  };
  controller.documentContext.set(phone, {
    timestamp: Date.now(), fileName: 'private.pdf', mimeType: 'application/pdf', buffer: stale,
  });
  t.after(() => {
    controller.documentContext.delete(phone);
    controller.calendarConfirmContext.delete(phone);
    controller.recentEmailContext.delete(phone);
  });

  await controller.handleEmailSend({
    from: phone,
    text: 'Draft an email to owner@example.com. Body: The project is ready.',
    agentRunId: 'agent-run-1',
  }, {}, {
    recipients: ['owner@example.com'], subject: 'Status', body: 'The project is ready.',
    attachment_ids: [ARTIFACT_ID],
  });

  assert.deepEqual(requested, { userPhone: phone, ids: [ARTIFACT_ID] });
  const pending = controller.calendarConfirmContext.get(phone);
  assert.equal(pending.attachments.length, 1);
  assert.equal(pending.attachments[0].fileName, 'selected.pdf');
  assert.equal(pending.attachments[0].buffer.toString(), 'selected bytes');
  assert.notEqual(pending.attachments[0].buffer, stale);
});

test('agent email send never auto-attaches a recent document when attachment_ids are omitted', async (t) => {
  installDeliveryStubs(t);
  const phone = 'agent-attachment-none';
  let resolverCalls = 0;
  fileArtifactService.loadOwnedArtifacts = async () => { resolverCalls += 1; return [ownedAttachment()]; };
  controller.documentContext.set(phone, {
    timestamp: Date.now(), fileName: 'private.pdf', mimeType: 'application/pdf', buffer: Buffer.from('secret'),
  });
  t.after(() => {
    controller.documentContext.delete(phone);
    controller.calendarConfirmContext.delete(phone);
    controller.recentEmailContext.delete(phone);
  });

  await controller.handleEmailSend({
    from: phone,
    text: 'Draft an email to owner@example.com. Body: The project is ready.',
    agentRunId: 'agent-run-2',
  }, {}, { recipients: ['owner@example.com'], subject: 'Status', body: 'The project is ready.' });

  assert.equal(resolverCalls, 0);
  assert.equal(controller.calendarConfirmContext.get(phone).attachments, null);
});

test('agent scheduled and bulk email previews retain the explicitly selected artifact', async (t) => {
  installDeliveryStubs(t);
  const selected = ownedAttachment('approved.pdf');
  fileArtifactService.loadOwnedArtifacts = async () => [selected];
  const scheduledPhone = 'agent-attachment-scheduled';
  const bulkPhone = 'agent-attachment-bulk';
  for (const phone of [scheduledPhone, bulkPhone]) {
    controller.documentContext.set(phone, {
      timestamp: Date.now(), fileName: 'wrong.pdf', mimeType: 'application/pdf', buffer: Buffer.from('wrong'),
    });
  }
  t.after(() => {
    controller.documentContext.delete(scheduledPhone);
    controller.documentContext.delete(bulkPhone);
    controller.scheduledEmailContext.delete(scheduledPhone);
    controller.bulkEmailContext.delete(bulkPhone);
    controller.recentEmailContext.delete(scheduledPhone);
    controller.recentEmailContext.delete(bulkPhone);
  });

  await controller.handleEmailSchedule({
    from: scheduledPhone,
    text: 'Schedule email to owner@example.com for 2 January 2035 at 9am. Body: Ready.',
    agentRunId: 'agent-run-3',
  }, {}, {
    recipients: ['owner@example.com'], subject: 'Status', body: 'Ready.',
    attachment_ids: [ARTIFACT_ID], send_at: '2035-01-02T09:00:00Z', timezone: 'UTC',
  });
  await controller.handleEmailBulk({
    from: bulkPhone,
    text: 'Send email to first@example.com and second@example.com. Body: Ready.',
    agentRunId: 'agent-run-4',
  }, {}, {
    recipients: ['first@example.com', 'second@example.com'], subject: 'Status', body: 'Ready.',
    attachment_ids: [ARTIFACT_ID],
  });

  assert.equal(controller.scheduledEmailContext.get(scheduledPhone).attachments[0].fileName, 'approved.pdf');
  assert.equal(controller.bulkEmailContext.get(bulkPhone).attachments[0].fileName, 'approved.pdf');
});

test('bulk-email retries only load artifacts explicitly selected on the valid typed call', async (t) => {
  installDeliveryStubs(t);
  const phone = 'agent-attachment-bulk-clarify';
  const selected = ownedAttachment('approved.pdf');
  let artifactLoads = 0;
  fileArtifactService.loadOwnedArtifacts = async () => {
    artifactLoads += 1;
    return [selected];
  };
  controller.documentContext.set(phone, {
    timestamp: Date.now(), fileName: 'private.pdf', mimeType: 'application/pdf', buffer: Buffer.from('private'),
  });
  t.after(() => {
    controller.documentContext.delete(phone);
    controller.bulkEmailContext.delete(phone);
    controller.recentEmailContext.delete(phone);
  });

  const question = await controller.handleEmailBulk({
    from: phone,
    text: 'Send email to first@example.com and second@example.com. Body: Ready.',
    agentRunId: 'agent-run-clarify',
    agentToolCallId: 'agent-call-clarify',
  }, {}, { recipients: [], body: 'Ready.', attachment_ids: [ARTIFACT_ID] });
  assert.equal(question.status, 'waiting_input');
  assert.equal(artifactLoads, 0);

  await controller.handleEmailBulk({
    from: phone,
    text: 'Send email to first@example.com and second@example.com. Body: Ready.',
    agentRunId: 'agent-run-clarify-retry',
    agentToolCallId: 'agent-call-clarify-retry',
  }, {}, {
    recipients: ['first@example.com', 'second@example.com'],
    subject: 'Status', body: 'Ready.', attachment_ids: [ARTIFACT_ID],
  });

  assert.equal(artifactLoads, 1, 'only the explicit artifact ID on the valid retry is resolved');
  assert.equal(controller.bulkEmailContext.get(phone).attachments[0].fileName, 'approved.pdf');
});

test('agent Drive upload resolves owned artifact IDs before uploading and ignores recent context', async (t) => {
  installDeliveryStubs(t);
  const phone = 'agent-drive-owned';
  const selected = ownedAttachment('source.pdf', 'owned');
  let requested;
  fileArtifactService.loadOwnedArtifacts = async (userPhone, ids) => {
    requested = { userPhone, ids };
    return [selected];
  };
  const uploads = [];
  googleDriveService.uploadFile = async (_userPhone, file) => {
    uploads.push(file);
    return { success: true, file: { name: file.name, webViewLink: 'https://drive.example.test/file' } };
  };
  controller.documentContext.set(phone, {
    timestamp: Date.now(), fileName: 'private.pdf', mimeType: 'application/pdf', buffer: Buffer.from('private'),
  });
  t.after(() => controller.documentContext.delete(phone));

  const result = await controller.handleDriveUpload({
    from: phone, text: 'upload selected file', agentRunId: 'agent-run-5',
  }, { artifact_ids: [ARTIFACT_ID], rename_to: 'renamed.pdf' });

  assert.deepEqual(requested, { userPhone: phone, ids: [ARTIFACT_ID] });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].name, 'renamed.pdf');
  assert.equal(uploads[0].content.toString(), 'owned');
  assert.match(result, /Uploaded to Drive/);
});

test('unknown agent artifact IDs fail generically before any Drive write', async (t) => {
  installDeliveryStubs(t);
  fileArtifactService.loadOwnedArtifacts = async () => {
    const error = new Error('The requested artifact is unavailable.');
    error.code = 'artifact_not_found';
    throw error;
  };
  let uploads = 0;
  googleDriveService.uploadFile = async () => { uploads += 1; return { success: true }; };

  const result = await controller.handleDriveUpload({
    from: 'agent-drive-foreign', text: 'upload selected file', agentRunId: 'agent-run-6',
  }, { artifact_ids: [ARTIFACT_ID] });

  assert.equal(result, 'Unable to use the requested artifact. Select a file from this chat and try again.');
  assert.equal(uploads, 0);
});

test('agent delivery contracts expose only fields the handlers honor', () => {
  const send = getAgentToolContract('send_email').inputSchema.properties;
  assert.equal(Object.hasOwn(send, 'cc'), false);
  assert.equal(Object.hasOwn(send, 'bcc'), false);
  assert.equal(Object.hasOwn(send, 'reply_to_message_id'), false);

  const drive = getAgentToolContract('upload_to_drive').inputSchema;
  assert.equal(Object.hasOwn(drive.properties, 'folder'), false);
  assert.equal(drive.properties.artifact_ids.maxItems, 10);
});

test('agent delivery schemas reject raw paths and URLs before a handler runs', () => {
  const badEmail = validateAgentToolArguments('send_email', {
    recipients: ['owner@example.com'],
    body: 'Please review this.',
    attachment_ids: ['C:\\private\\payroll.pdf'],
  });
  const badDrive = validateAgentToolArguments('upload_to_drive', {
    artifact_ids: ['https://files.example.test/private.pdf'],
  });

  assert.equal(badEmail.success, false);
  assert.equal(badDrive.success, false);
});
