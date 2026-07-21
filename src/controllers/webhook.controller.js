const axios = require('axios');
const whatsappService = require('../services/whatsapp.service');
const messagingService = require('../services/messaging.service');
const aiService = require('../services/ai.service');
// Apr 30 2026 — pendingVisaState removed; visa profile builder feature
// moved to a separate dedicated bot.
const reminderService = require('../services/reminder.service');
const memoryService = require('../services/memory.service');
const taskService = require('../services/task.service');
const habitService = require('../services/habit.service');
const searchService = require('../services/search.service');
const listService = require('../services/list.service');
const briefingService = require('../services/briefing.service');
const timezoneService = require('../services/timezone.service');
const fileService = require('../services/file.service');
const imageService = require('../services/image.service');
const dashboardService = require('../services/dashboard.service');
const contactService = require('../services/contact.service');
const googleAuthService = require('../services/google-auth.service');
const calendarService = require('../services/calendar.service');
const calendarNLPService = require('../services/calendar-nlp.service');
const gmailService = require('../services/gmail.service');
const calendarReminderJob = require('../jobs/calendar-reminder.job');
const leaveService = require('../services/leave.service');
const standupService = require('../services/standup.service');
const pollService = require('../services/poll.service');
const inboxOrganizerService = require('../services/inbox-organizer.service');
const googleDriveService = require('../services/google-drive.service');
const googleDocsService = require('../services/google-docs.service');
const googleSheetsService = require('../services/google-sheets.service');
const googleSlidesService = require('../services/google-slides.service');
const { fileArtifactService } = require('../services/file-artifact.service');
const entityContextService = require('../services/entity-context.service');
const microsoftAuthService = require('../services/microsoft-auth.service');
const outlookCalendarService = require('../services/outlook-calendar.service');
const unifiedCalendarService = require('../services/unified-calendar.service');
const languageService = require('../services/language.service');
const batchReminderService = require('../services/batch-reminder.service');
const appleCalendarService = require('../services/apple-calendar.service');
const autoUpdateService = require('../services/auto-update.service');
const salesService = require('../services/sales.service');
const scheduledEmailJob = require('../jobs/scheduled-email.job');
const accountLinkService = require('../services/account-link.service');
const subscriptionService = require('../services/subscription.service');
const handlerRegistry = require('../handlers');
const { parseHabitCommand } = require('../handlers/habit.handler');
const PlainBoundedMap = require('../utils/bounded-map');
const { currentChatSession, conversationStateKey, SessionScopedBoundedMap: BoundedMap } = require('../services/chat-session-context');
const { sanitizeInput, validateUserId, sanitizeFilename, validateMimeType } = require('../utils/security');
const abuseProtection = require('../middleware/abuse-protection');
const logger = require('../utils/logger');
const { turnTrace } = require('../services/turn-trace.service');
const { extractActionableCaption } = require('../utils/document-caption');
const { sendWithTemplateFallback } = require('../utils/whatsapp-24h');
const TEMPLATES = require('../config/whatsapp-templates');

function normalizedPhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function classifySensitiveConfirmation(text) {
  const gate = require('../services/confirmation-gate.service');
  return { decision: gate.classifyExplicitReply(text) };
}

function createDocumentIngestionError(code, message, { fileName, cause } = {}) {
  const error = new Error(message);
  error.name = 'DocumentIngestionError';
  error.code = code;
  if (fileName) error.fileName = fileName;
  if (cause) error.cause = cause;
  return error;
}

const DISABLED_GOOGLE_INTENTS = new Set([
  'inbox_check',
  'inbox_search',
  'email_query',
  'email_followup',
  'labels_manage',
  'email_automation',
  'reply_track',
  'google_contacts_search',
]);

function disabledGoogleFeatureMessage(feature = 'Gmail inbox features') {
  return `${feature} aren't available in this version. I can still send and schedule email.`;
}

function getDisabledGoogleFeatureReply(text) {
  const lower = String(text || '').trim().toLowerCase();
  if (!lower) return null;

  if (/\b(auto(?:matic)?\s*label|email\s+automation|reply\s+tracking|track\s+(?:the\s+)?reply|notify\s+me\s+if\s+.+\brepl(?:y|ies))\b/.test(lower)) {
    return disabledGoogleFeatureMessage('Gmail automation and reply tracking');
  }
  if (/\b(archive|label|unlabel|mark)\b.*\b(email|mail|inbox)\b/.test(lower)) {
    return disabledGoogleFeatureMessage('Gmail labels and archive actions');
  }
  if (/\b(follow[ -]?up|followup)\b.*\b(email|mail|sent|previous|earlier)\b/.test(lower)) {
    return disabledGoogleFeatureMessage('Email-history follow-ups');
  }
  if (/\b(google|gmail)\s+contacts?\b/.test(lower)) {
    return disabledGoogleFeatureMessage('Gmail-history contact search');
  }
  if (/\b(inbox|received?\s+(?:emails?|mail)|emails?\s+(?:did|have|from|about)|(?:did|has|have|any|new|unread)\s+(?:i\s+)?(?:get|receive|emails?|mail)|(?:check|search|find|read|show|open)\s+(?:my\s+)?(?:emails?|mail|inbox)|(?:did|has|have)\b.*\b(reply|respond|email|mail)\b)/.test(lower)) {
    return disabledGoogleFeatureMessage('Gmail inbox and email-history features');
  }
  return null;
}

function isDashboardLoginQuery(text) {
  const lower = String(text || '').trim().toLowerCase().replace(/[?!.]+$/g, '');
  if (!lower) return false;
  return (
    /^(open|launch|send|give|gimme)\s+(me\s+)?(the\s+)?(dashboard|web|website)(\s+(login|link))?$/.test(lower)
    || /^(show)\s+(me\s+)?(the\s+)?dashboard\s+(login|link)$/.test(lower)
    || /^(dashboard|web)\s+(login|link)$/.test(lower)
    || /^login\s+(to\s+)?(dashboard|web)$/.test(lower)
    || /^(link|connect)\s+(me\s+)?(to\s+)?(the\s+)?(dashboard|web)$/.test(lower)
    || lower === 'link account'
    || lower === 'link'
  );
}

function isReminderListQuery(text) {
  const lower = String(text || '').trim().toLowerCase().replace(/[?!.]+$/g, '');
  if (!lower) return false;
  return (
    /^(?:show|view|list)(?:\s+me)?(?:\s+my)?\s+reminders?$/.test(lower)
    || /^my\s+reminders?$/.test(lower)
    || /^reminders?\s+list$/.test(lower)
    || /^pending\s+reminders?$/.test(lower)
    // common typo
    || /^(?:show|view|list)(?:\s+me)?(?:\s+my)?\s+remonders?$/.test(lower)
  );
}

function isCancelLastReminderQuery(text) {
  const lower = String(text || '').trim().toLowerCase().replace(/[?!.]+$/g, '');
  if (!lower) return false;
  return (
    /^(?:cancel|delete|remove|stop)\s+(?:my\s+)?last\s+reminders?$/.test(lower)
    || /^last\s+reminder\s+(?:cancel|delete|remove|stop)$/.test(lower)
    || /^(?:cancel|delete|remove|stop)\s+(?:the\s+)?last\s+one$/.test(lower)
  );
}

function matchesCancelAllReminders(text) {
  const lower = String(text || '').trim().toLowerCase();
  if (!/\b(?:cancel|delete|remove|clear|stop)\b/.test(lower)) return false;
  if (!/\b(?:reminder|reminders)\b/.test(lower)) return false;
  return (
    /\b(?:all+|sab|sare|saare)\b/.test(lower)
    || /\b(?:everything|all of them)\b/.test(lower)
  );
}

function shouldUseExaWebSearch(text) {
  const lower = String(text || '').trim().toLowerCase();
  if (!lower) return false;

  // Account and workspace commands must reach tool routing. Treating the
  // provider name "Google" as the verb "google this" caused commands such as
  // "connect google" and "search Google Drive" to be stolen by this early
  // web-search path before detectIntent() could select their real handlers.
  const authAction = '\\b(connect|disconnect|link|unlink|authorize|sign\\s*in|log\\s*in|remove)\\b';
  const accountProvider = '\\b(google|gmail|outlook|microsoft|apple|icloud|discord)\\b';
  if (new RegExp(`${authAction}.*${accountProvider}|${accountProvider}.*${authAction}`).test(lower)) {
    return false;
  }
  if (/\b(search|find|show|list|create|make|share|upload|read|summarize|append|add|mark|label|archive)\b.*\b(?:google\s+)?(?:drive|docs?|sheets?|slides?|tasks?|contacts?|calendar|gmail|inbox)\b/.test(lower)) {
    return false;
  }

  // Never send searches for user-owned data to the public web.
  if (/\b(search|find|look\s+up|show|get)\b.*\b(my|meri|mere|mera|saved|ari)\b.*\b(notes?|tasks?|reminders?|contacts?|memories?|inbox|emails?|files?|docs?|meetings?)\b/.test(lower)) {
    return false;
  }
  if (/\b(my|meri|mere|mera)\b.*\b(order|refund|booking|ticket|delivery|shipment|package|appointment)\b/.test(lower)) {
    return false;
  }

  const explicitWeb = (
    /\b(search\s+(?:the\s+)?web|web\s+search|internet\s+search|search\s+online|check\s+online|look\s+up|find\s+out|search\s+for)\b/.test(lower)
    || /^(?:please\s+)?google\s+(?!drive\b|docs?\b|sheets?\b|slides?\b|tasks?\b|contacts?\b|calendar\b|gmail\b|account\b).+/.test(lower)
    || /\bgoogle\s+(it|this|that)\b/.test(lower)
  ) && !/\b(notes?|tasks?|reminders?|contacts?|memories?|inbox|emails?|files?|docs?|meetings?)\b/.test(lower);

  const liveData =
    /\b(today|current|currently|now|right\s+now|latest|recent|newest|breaking|live|this\s+week|this\s+month|202[5-9])\b/.test(lower)
    && /\b(news|weather|price|prices|rate|rates|score|scores|match|stock|stocks|crypto|bitcoin|ethereum|usd|inr|eur|gold|silver|oil|review|reviews|launch|released|update|status)\b/.test(lower);

  const commonLiveQuestions =
    /\b(weather\s+(in|for)|temperature\s+(in|for)|forecast\s+(in|for))\b/.test(lower)
    || /\b(price|rate)\s+of\b/.test(lower)
    || /\b(usd|eur|gbp|aed|cad|aud)\s*(to|\/)\s*(inr|usd|eur|gbp|aed|cad|aud)\b/.test(lower)
    || /\b(bitcoin|btc|ethereum|eth|stock|share|nifty|sensex|nasdaq|dow)\b.*\b(price|rate|today|now|current)\b/.test(lower)
    || /\b(best|top)\b.*\b(under|near me|restaurants?|hotels?|flights?|phones?|laptops?|tools?|software)\b/.test(lower)
    || /\b(who won|score|match result|latest news|what happened)\b/.test(lower);

  return explicitWeb || liveData || commonLiveQuestions;
}

function documentAttachmentsFromContext(documentContext) {
  if (!documentContext) return [];
  const source = Array.isArray(documentContext.attachments) && documentContext.attachments.length > 0
    ? documentContext.attachments
    : [documentContext];
  return source.filter((item) => Buffer.isBuffer(item?.buffer) && item?.fileName).map((item) => ({
    buffer: item.buffer,
    mimeType: item.mimeType || 'application/octet-stream',
    fileName: item.fileName,
  }));
}

function documentTextFromContext(documentContext) {
  if (!documentContext) return null;
  const source = Array.isArray(documentContext.attachments) && documentContext.attachments.length > 0
    ? documentContext.attachments
    : [documentContext];
  const combined = source.map((item) => {
    const text = String(item?.extractedText || '').trim();
    return text ? `[${item.fileName || 'document'}]\n${text}` : '';
  }).filter(Boolean).join('\n\n');
  return combined ? combined.slice(0, 100_000) : null;
}

function isAgentToolMessage(message) {
  return Boolean(message?.agentRunId || message?.agentToolCallId);
}

function unavailableAgentArtifactMessage() {
  // Keep unknown, expired, and foreign IDs indistinguishable so artifact IDs
  // cannot be used to probe another tenant's files.
  return 'Unable to use the requested artifact. Select a file from this chat and try again.';
}

class WebhookController {

  constructor() {
    this.workflowContextTtls = {
      calendarConfirm: parseInt(process.env.CALENDAR_CONFIRM_CONTEXT_TTL_MS, 10) || 60 * 60 * 1000,
      emailConfirm: parseInt(process.env.EMAIL_CONFIRM_CONTEXT_TTL_MS, 10) || 5 * 60 * 1000,
      leaveConfirm: parseInt(process.env.LEAVE_CONFIRM_CONTEXT_TTL_MS, 10) || 60 * 60 * 1000,
      standupSetup: parseInt(process.env.STANDUP_SETUP_CONTEXT_TTL_MS, 10) || 30 * 60 * 1000,
      standupResponse: parseInt(process.env.STANDUP_RESPONSE_CONTEXT_TTL_MS, 10) || 6 * 60 * 60 * 1000,
      pollVote: parseInt(process.env.POLL_VOTE_CONTEXT_TTL_MS, 10) || 24 * 60 * 60 * 1000,
      taskAssignConfirm: parseInt(process.env.TASK_ASSIGN_CONTEXT_TTL_MS, 10) || 15 * 60 * 1000,
      document: parseInt(process.env.DOCUMENT_CONTEXT_TTL_MS, 10) || 30 * 60 * 1000,
      salesEmail: parseInt(process.env.SALES_EMAIL_CONTEXT_TTL_MS, 10) || 30 * 60 * 1000,
      scheduledEmail: parseInt(process.env.SCHEDULED_EMAIL_CONTEXT_TTL_MS, 10) || 30 * 60 * 1000,
      bulkEmail: parseInt(process.env.BULK_EMAIL_CONTEXT_TTL_MS, 10) || 30 * 60 * 1000,
      recentEmail: parseInt(process.env.RECENT_EMAIL_CONTEXT_TTL_MS, 10) || 2 * 60 * 60 * 1000
    };

    // All context Maps are bounded to prevent memory leaks at scale
    this.imageContext = new BoundedMap(5000, 10 * 60 * 1000); // 10min TTL
    this.imageListContext = new BoundedMap(5000, 10 * 60 * 1000);
    this.dashboardImageContext = new BoundedMap(5000, 10 * 60 * 1000);
    this.processedMessages = new BoundedMap(10000, 60 * 60 * 1000); // 1hr TTL
    this.calendarConfirmContext = new BoundedMap(5000, this.workflowContextTtls.calendarConfirm);
    // Long-lived fallback for "book anyway" — never touched by reminder/task handlers.
    // Set on every booking confirmation / conflict, provides a safety net if calendarConfirmContext is lost.
    this.lastBookingEventData = new BoundedMap(5000, 60 * 60 * 1000); // 1 hour TTL
    this.leaveConfirmContext = new BoundedMap(5000, this.workflowContextTtls.leaveConfirm);
    this.standupSetupContext = new BoundedMap(5000, this.workflowContextTtls.standupSetup);
    this.standupResponseContext = new BoundedMap(5000, this.workflowContextTtls.standupResponse);
    this.pollVoteContext = new BoundedMap(5000, this.workflowContextTtls.pollVote);
    this.taskAssignConfirmContext = new BoundedMap(5000, this.workflowContextTtls.taskAssignConfirm);
    this.lastSavedContact = new BoundedMap(5000, 30 * 60 * 1000);
    this.reminderListContext = new BoundedMap(5000, 5 * 60 * 1000); // 5min TTL for reminder list follow-ups
    this.teamAddContext = new BoundedMap(500, 5 * 60 * 1000); // 5min TTL for "give me the phone number" follow-up
    this.contactSaveContext = new BoundedMap(500, 3 * 60 * 1000); // 3min TTL for "should I save this number?" follow-up
    this.csvImportContext = new BoundedMap(100, 5 * 60 * 1000); // 5min TTL for CSV import confirmation
    this.pendingFileShareContext = new BoundedMap(5000, 5 * 60 * 1000); // 5min TTL — "Yes I have your resume, want me to share?" follow-up
    this.documentContext = new BoundedMap(5000, this.workflowContextTtls.document);
    this.salesEmailContext = new BoundedMap(5000, this.workflowContextTtls.salesEmail);
    this.scheduledEmailContext = new BoundedMap(5000, this.workflowContextTtls.scheduledEmail);
    this.bulkEmailContext = new BoundedMap(5000, this.workflowContextTtls.bulkEmail);
    this.recentEmailContext = new BoundedMap(5000, this.workflowContextTtls.recentEmail);
    this.taskListContext = new BoundedMap(5000, 5 * 60 * 1000); // 5min TTL for task list follow-ups (mark done by number)
    // ─── PENDING CLARIFICATION TRACKER ──────────────────────────────────
    // Universal mechanism for multi-turn flows. When a tool needs more info
    // (e.g. "assign task to ammi" → bot asks "What task?"), instead of falling
    // back to chat (which can hallucinate completion), we set a pending entry.
    // The next user message is intercepted and re-routed back to the original
    // tool with the user's reply as the missing field. 5-min TTL.
    //
    // Shape: { tool, action, params, awaitingField, askedAt, prompt }
    //   tool: e.g. 'task_manage'
    //   action: e.g. 'assign'
    //   params: partial intentParams collected so far (e.g. { assignee_name: 'ammi' })
    //   awaitingField: which field the next message should fill ('task_title', 'follow_up_directive', etc.)
    //   prompt: the human-readable question we asked (for logging / debug)
    this.pendingClarificationContext = new BoundedMap(5000, 5 * 60 * 1000);
    // Intent-level clarifications (the request_clarification tool): the bot
    // asked "meeting or reminder?" and the NEXT message is probably the
    // answer. Fed to detectIntent as a context hint so the answer resolves
    // deterministically even if the history write raced or was truncated.
    // Consumed (deleted) after the next message's intent detection.
    this.lastClarificationContext = new BoundedMap(5000, 10 * 60 * 1000);
    this.gmailContactCache = new BoundedMap(5000, 30 * 60 * 1000); // 30min TTL — caches name → email/phone resolved from Gmail history
    this.lastBotAction = new BoundedMap(10000, 5 * 60 * 1000); // 5min TTL - tracks what the bot last did for each user
    // SEPARATE from lastBotAction. Handlers write STRUCTURED entity
    // pointers here via recordLastAction(). Controller bookkeeping never
    // touches this, so agentic-turn / general-chat markers cannot wipe
    // "I just created reminder #42 for Rohan". 10-minute TTL — plenty of
    // time for follow-ups like "change the time" or "also for Rohan".
    this.lastEntityRef = new BoundedMap(10000, 10 * 60 * 1000);
    this.rateLimitMap = new PlainBoundedMap(50000, 2 * 60 * 1000); // 2min TTL
    this._emailListContext = new BoundedMap(5000, 10 * 60 * 1000); // 10min TTL
    this._followUpContext = new BoundedMap(5000, 10 * 60 * 1000); // 10min TTL for follow-up email selection
    // Apr 30 2026 — lastVisaBatchContext removed; visa feature retired.

    // Onboarding context: tracks users mid-onboarding flow (post-payment)
    // TTL: 24h — gives users plenty of time to reply without losing state
    this.onboardingContext = new BoundedMap(5000, 24 * 60 * 60 * 1000);

    // FIFO per-user processing lock. A TTL-backed boolean lock could expire
    // while a legitimate long-running agent turn was still executing, which
    // let the next message race it and observe stale conversation state.
    this._userProcessingLock = new Map();
  }

  shouldUseExaWebSearch(text) {
    return shouldUseExaWebSearch(text);
  }

  // ========== ATOMIC PENDING-STATE CLEANUP (RC #3 FIX) ==========

  /**
   * Snapshot approval state created by legacy business workflows. Agent
   * adapters compare object identity before/after a handler so a preview is
   * returned as waiting_approval instead of being mislabeled as success.
   */
  snapshotAgentApprovalState(userPhone) {
    let central = null;
    try {
      const gate = require('../services/confirmation-gate.service');
      central = gate.pendingIdentity?.(userPhone)
        ?? (gate.hasPending?.(userPhone) ? 'pending' : null);
    } catch (_) { /* confirmation service unavailable during isolated tests */ }
    const names = [
      'calendarConfirmContext',
      'scheduledEmailContext',
      'bulkEmailContext',
      'salesEmailContext',
      'pendingPollContext',
    ];
    return {
      central,
      workflows: Object.fromEntries(names.map((name) => [
        name,
        this[name]?.get?.(userPhone) || null,
      ])),
    };
  }

  didAgentCreateApproval(before, after) {
    if (after?.central && after.central !== before?.central) return true;
    return Object.entries(after?.workflows || {}).some(([name, value]) => (
      Boolean(value) && value !== before?.workflows?.[name]
    ));
  }

  /**
   * Wipe ALL DRAFT/PENDING workflow state for a user atomically.
   *
   * Why this exists
   * ---------------
   * Before this method, "Edit" on a confirmation gate cleared ONLY that one
   * gate's pending action — but ~20 other workflow context maps persisted.
   * Stale state then leaked into the next message's response template,
   * producing hallucinated content (e.g. "Remind Danish: kainsl vn en too at
   * 2:00 pm" — a title pulled from a draft created minutes earlier).
   *
   * What this clears (DRAFT/PENDING — short-lived, content-bearing):
   *   - All confirmation-bearing contexts (calendar/leave/standup/poll/sales)
   *   - All draft contexts (email/bulk-email/scheduled-email/visa)
   *   - All "waiting for reply" contexts (file-share, contact-save, csv-import)
   *   - List position contexts (reminderList/taskList/_emailList) — avoid
   *     "1" resolving to a stale list
   *   - Pending clarification context (the "tell me what X means" buffer)
   *
   * What this DOES NOT clear (long-lived caches, factual records):
   *   - gmailContactCache / recentEmailContext (factual, not a draft)
   *   - lastSavedContact / lastBotAction / lastVisaBatch (history pointers)
   *   - onboardingContext (UX timing)
   *
   * Call sites:
   *   - confirmation-gate.service.js Edit handler
   *   - "never mind" / "cancel" / "forget it" intent handlers (recommended)
   *
   * @param {string} userPhone
   * @returns {string[]}  names of contexts that had data for this user (audit)
   */
  clearAllPendingState(userPhone) {
    if (!userPhone) return [];

    const draftAndPendingMaps = [
      'calendarConfirmContext',
      'leaveConfirmContext',
      'standupSetupContext',
      'standupResponseContext',
      'pollVoteContext',
      'pendingPollContext',
      'taskAssignConfirmContext',
      'contactSaveContext',
      'csvImportContext',
      'pendingFileShareContext',
      'salesEmailContext',
      'scheduledEmailContext',
      'bulkEmailContext',
      'pendingClarificationContext',
      'lastClarificationContext',
      'reminderListContext',
      'taskListContext',
      'imageListContext',
      'dashboardImageContext',
      '_emailListContext',
      '_followUpContext',
      'teamAddContext',
    ];

    const cleared = [];
    for (const mapName of draftAndPendingMaps) {
      const map = this[mapName];
      if (map && typeof map.delete === 'function' && map.has?.(userPhone)) {
        map.delete(userPhone);
        cleared.push(mapName);
      }
    }
    if (cleared.length > 0) {
      logger.info(`[clearAllPendingState] ${userPhone.slice(0, 6)}* cleared: ${cleared.join(', ')}`);
    }
    return cleared;
  }

  // ========== NEW-INTENT OVERRIDE (RC #3 EXTENSION) ==========

  /**
   * Detect when a user message clearly STARTS a new action — so a stale
   * pending workflow context can't hijack it.
   *
   * Live bug observed (Apr 26 2026): a pending calendar confirmation absorbed
   * a fresh "send a bulk email to X" command and added X as a meeting attendee
   * instead of starting the bulk email flow. Same root cause as the Ari.md
   * "kainsl vn en too" hallucination — pending state too sticky.
   *
   * Returns true when the message contains an unambiguous "start a new
   * thing" verb. The caller (`tryWorkflowShortCircuit`) calls
   * `clearAllPendingState()` and lets the message fall through to
   * `detectIntent` cleanly.
   *
   * Conservative whitelist — better to miss an override than to wipe a
   * legitimate pending state. Only fires on long-form messages that look
   * like fresh requests, never on short confirmation replies (yes/no/1/2).
   *
   * @param {string} text
   * @returns {boolean}
   */
  _messageIndicatesNewIntent(text) {
    if (!text || typeof text !== 'string') return false;
    const trimmed = text.trim();
    // Short messages (yes/no/1/2/cancel/edit) are confirmation replies, not
    // new intents — never override on those.
    if (trimmed.length < 12) return false;

    // English new-intent patterns
    const ENGLISH_NEW_INTENT = [
      /\bsend\s+(a|an|the)?\s*(bulk|mass|email|reminder|message)\b/i,
      /\b(schedule|book|create|set\s*up)\s+(a|an|the)?\s*(new\s+)?(meeting|appointment|reminder|event|call|standup)\b/i,
      /\b(remind\s+me|set\s+a\s+reminder)\s+to\b/i,
      /\b(remind\s+\w+\s+(to|at|about))\b/i,
      /\b(create\s+(a\s+)?(poll|task|note|list|reminder))\b/i,
      /\b(add\s+(a\s+)?(task|reminder|note|expense|habit|contact))\b/i,
      /\b(delete|cancel)\s+(all\s+|every\s+)?(my\s+)?(reminders|tasks|notes|contacts)\b/i,
      /\bshow\s+(my\s+)?(reminders|tasks|notes|contacts|calendar|inbox|emails)\b/i,
      /\b(start|begin)\s+(a|the)?\s*(focus\s+session|standup|timer|tracking)\b/i,
      /\b(track|log)\s+(my\s+)?(expense|habit|workout|water)\b/i,
      /\bemail\s+\w+\s+(about|regarding)\b/i,
      /\bsend\s+(a|an)?\s*email\s+to\b/i,
    ];

    // Hinglish new-intent patterns
    const HINGLISH_NEW_INTENT = [
      /\b(yaad\s+dilana|reminder\s+set\s+karo|reminder\s+lagao)\b/i,
      /\b(meeting\s+(set|book)\s+karo|meeting\s+lagao)\b/i,
      /\b(email\s+bhejo|mail\s+bhejo|message\s+bhejo)\b/i,
      /\bdikhao\b.*\b(reminders|tasks|notes|contacts|calendar|emails)\b/i,
      /\b(naya|naye)\s+(reminder|task|note|meeting)\b/i,
    ];

    const allPatterns = [...ENGLISH_NEW_INTENT, ...HINGLISH_NEW_INTENT];
    return allPatterns.some(re => re.test(trimmed));
  }

  // ========== COLD-START ONBOARDING (free users) ==========

  /**
   * If the message-author has never written to us before, send a one-time
   * welcome that names what Ari can do. Returns true if we sent the
   * welcome (caller should `return`); false otherwise.
   *
   * Detection: a single COUNT against conversation_history scoped by phone.
   * Threshold = 0 user-role rows. Cached per-process via BoundedMap so we
   * don't requery for repeat senders. The welcome itself writes a memory
   * trunk row so a later restart doesn't re-trigger it.
   */
  async _maybeSendColdStartWelcome(message) {
    if (!message?.from || !message?.text) return false;
    if (!this._coldStartSeen) {
      const BoundedMap = require('../utils/bounded-map');
      this._coldStartSeen = new BoundedMap(50000, 24 * 60 * 60 * 1000);
    }
    if (this._coldStartSeen.get(message.from)) return false;

    // Skip if user is mid-onboarding (post-payment flow handles them).
    const step = this.onboardingContext.get(message.from)
      || await subscriptionService.getOnboardingStep(message.from).catch(() => null);
    if (step && step !== 'complete') {
      this._coldStartSeen.set(message.from, true);
      return false;
    }

    // Check conversation_history. If they have any prior user-role messages,
    // they're not new — skip and remember.
    try {
      const { query } = require('../config/database');
      const r = await query(
        `SELECT 1 FROM conversation_history
          WHERE user_phone = $1 AND role = 'user'
          LIMIT 1`,
        [message.from]
      );
      if (r.rows.length > 0) {
        this._coldStartSeen.set(message.from, true);
        return false;
      }
    } catch (_) {
      // If the table doesn't exist yet, this is definitely a cold start.
    }

    this._coldStartSeen.set(message.from, true);

    // Never consume an explicit first command just to show onboarding copy.
    // Discovery is useful for a greeting; losing "add this lead" or "remind
    // me" on the first turn is not. Normal processing will persist commands.
    const orientationOnly = /^(?:(?:hi|hello|hey|namaste|yo)(?:\s+ari)?|start|help(?:\s+me)?|what\s+can\s+(?:you|ari)\s+do|how\s+(?:do\s+i|can\s+i)\s+use\s+(?:you|ari)|who\s+are\s+you)[\s!?.]*$/i;
    if (!orientationOnly.test(message.text.trim())) return false;

    const welcome =
`👋 Hey! I'm Ari — your team operating assistant.

You can use reminders, memory, web search, calendar, email, tasks, CRM, team workflows, meeting tools, and daily briefings.

Try telling me what you want to get done, or say *help* to see examples.`;

    try {
      await messagingService.send(message.from, welcome);
      await this.saveConversationExchange(message.from, message.text, welcome, 'cold-start welcome');
      // Save a marker memory so we don't ever re-welcome this user.
      try {
        await memoryService.saveToTrunk(message.from, new Date().toISOString(), 'system', 'first_seen_at');
      } catch (_) { /* non-critical */ }
      logger.info(`[Onboarding] Cold-start welcome sent to ${message.from}`);
      return true;
    } catch (e) {
      logger.warn(`Cold-start welcome send failed for ${message.from}: ${e.message}`);
      return false;
    }
  }

  // ========== POST-PAYMENT ONBOARDING ==========

  /**
   * Handle onboarding messages for users who just paid via Razorpay.
   * Returns true if the message was consumed by the onboarding flow.
   *
   * Steps:
   *   awaiting_name       → user replies with their name
   *   awaiting_integrations → user has been sent auth links (no mandatory reply)
   *   complete            → onboarding done; fall through to normal handling
   */
  async handleOnboardingStep(message) {
    const userPhone = message.from;
    const text = (message.text || '').trim();

    // Fast path: check in-memory cache first, fall back to DB
    let step = this.onboardingContext.get(userPhone);
    if (!step) {
      step = await subscriptionService.getOnboardingStep(userPhone);
      if (step) {
        this.onboardingContext.set(userPhone, step);
      }
    }

    if (!step || step === 'complete') return false;

    // ── Step 1: awaiting_name ─────────────────────────────────────────────
    if (step === 'awaiting_name') {
      // Accept any non-empty reply as the name (trim to 60 chars)
      const name = sanitizeInput(text, 60);
      if (!name) return false; // empty / whitespace — let normal flow handle it

      // Persist name
      await subscriptionService.saveUserName(userPhone, name);

      // Also store in AI memory so the bot recalls the name conversationally
      try {
        await memoryService.saveToTrunk(userPhone, name, 'personal', 'name');
      } catch (e) { /* non-critical */ }

      // Build integration links
      const googleUrl = await googleAuthService.generateAuthUrl(userPhone);
      const microsoftUrl = microsoftAuthService.generateAuthUrl
        ? microsoftAuthService.generateAuthUrl(userPhone)
        : null;

      let integrationsMsg =
        `Nice to meet you, *${name}!* 🙌\n\n` +
        `To unlock calendar sync, email management, and meeting transcription, ` +
        `connect your accounts:\n\n`;

      if (googleUrl) {
        integrationsMsg += `📅 *Google* (Calendar, Gmail, Drive)\n${googleUrl}\n\n`;
      }
      if (microsoftUrl) {
        integrationsMsg += `📧 *Microsoft* (Outlook, Teams Calendar)\n${microsoftUrl}\n\n`;
      }

      integrationsMsg +=
        `You can also connect later by saying:\n` +
        `_"connect google"_ or _"connect outlook"_\n\n` +
        `🚀 *You're all set!* Just type what you need and I'll handle it.`;

      await messagingService.send(userPhone, integrationsMsg);

      // Advance onboarding state
      await subscriptionService.updateOnboardingStep(userPhone, 'complete');
      this.onboardingContext.set(userPhone, 'complete');

      logger.info(`[Onboarding] Completed for ${userPhone} (name: ${name})`);
      return true;
    }

    return false;
  }

  /**
   * Acquire a per-user processing lock. If another message is being processed,
   * wait up to `timeoutMs` for it to finish before proceeding.
   * This prevents race conditions where concurrent messages get stale AI context.
   */
  async acquireUserLock(userPhone, timeoutMs = 240000) {
    const active = this._userProcessingLock.get(userPhone);
    if (!active) {
      this._userProcessingLock.set(userPhone, { queue: [] });
      return;
    }

    await new Promise((resolve, reject) => {
      const waiter = { resolve: null, timer: null };
      waiter.resolve = () => {
        clearTimeout(waiter.timer);
        resolve();
      };
      waiter.timer = setTimeout(() => {
        const index = active.queue.indexOf(waiter);
        if (index >= 0) active.queue.splice(index, 1);
        reject(new Error('Previous message is still processing'));
      }, timeoutMs);
      waiter.timer.unref?.();
      active.queue.push(waiter);
    });
  }

  releaseUserLock(userPhone) {
    const active = this._userProcessingLock.get(userPhone);
    if (!active) return;
    const next = active.queue.shift();
    if (next) {
      next.resolve();
      return;
    }
    this._userProcessingLock.delete(userPhone);
  }

  async saveConversationExchange(userPhone, userText, assistantText, routeLabel) {
    const historyReply = String(assistantText || '').slice(0, 12000);
    try {
      await aiService.saveMessage(userPhone, 'user', userText);
      await aiService.saveMessage(userPhone, 'assistant', historyReply);
    } catch (error) {
      logger.warn(`history save (${routeLabel}) failed: ${error.message}`);
    }
  }

  // Rate limit: max 30 messages per minute per user
  isRateLimited(userPhone) {
    const now = Date.now();
    const window = 60 * 1000; // 1 minute
    const maxRequests = 30;

    let entry = this.rateLimitMap.get(userPhone);
    if (!entry || (now - entry.windowStart) >= window) {
      this.rateLimitMap.set(userPhone, { windowStart: now, count: 1 });
      return false;
    }
    entry.count++;
    if (entry.count > maxRequests) {
      logger.security('user_rate_limited', {
        userPhone,
        count: entry.count,
        window: '1min',
        maxRequests
      });
      return true;
    }
    return false;
  }

  parseDeterministicCommand(text) {
    const original = String(text || '').trim();
    const normalized = original.toLowerCase().replace(/[?!.]+$/g, '').trim();
    if (!normalized) return null;

    if (/^(?:help|show help|help menu|menu|commands|what can you do)$/.test(normalized)) {
      return { type: 'help', params: {} };
    }

    const habitParams = parseHabitCommand(original);
    return habitParams ? { type: 'habit_manage', params: habitParams } : null;
  }

  shouldRouteDeterministicHabit(command, habits = []) {
    if (command?.type !== 'habit_manage') return false;
    if (command.params?.action !== 'log') return true;

    const requested = String(command.params.habit_name || '').trim().toLowerCase().replace(/\s+/g, ' ');
    return habits.some(habit => (
      String(habit.name || '').trim().toLowerCase().replace(/\s+/g, ' ') === requested
    ));
  }

  async tryDeterministicCommand(message) {
    const command = this.parseDeterministicCommand(message?.text);
    if (!command) return false;

    try {
      if (command.type === 'habit_manage' && command.params.action === 'log') {
        const habits = await habitService.getHabits(message.from);
        if (!this.shouldRouteDeterministicHabit(command, habits)) return false;
        const matchedHabit = habits.find(habit => (
          String(habit.name || '').trim().toLowerCase().replace(/\s+/g, ' ')
          === String(command.params.habit_name || '').trim().toLowerCase().replace(/\s+/g, ' ')
        ));
        command.params.habit_name = matchedHabit.name;
      }

      const response = command.type === 'help'
        ? this.getHelpMessage(message.lang || 'english')
        : await this.executeIntent(command.type, command.params, message, {
          userPhone: message.from,
          intentParams: command.params,
        });

      if (!response) return false;

      this.lastBotAction.set(message.from, { action: command.type, timestamp: Date.now() });
      await this.saveConversationExchange(message.from, message.text, response, 'deterministic command');
      await this.sendLongMessage(message.from, response);
      logger.info(`[Deterministic] ${command.type} handled without LLM for ${message.from}`);
      return true;
    } catch (error) {
      logger.warn(`[Deterministic] ${command.type} intercept failed: ${error.message}`);
      return false;
    }
  }

  // ========== LANGUAGE DETECTION (100+ languages) ==========
  detectLanguage(text) {
    // Quick sync detection for backwards compatibility
    if (/[\u0900-\u097F]/.test(text)) return 'hindi';

    const hinglishWords = [
      'kya', 'hai', 'hain', 'mein', 'mujhe', 'kaise', 'kab', 'kahan', 'kyun',
      'nahi', 'haan', 'acha', 'theek', 'bol', 'bata', 'dekh', 'sun', 'kar',
      'karna', 'lena', 'dena', 'jana', 'aana', 'rakhna', 'bhej', 'dikha',
      'yaad', 'dilana', 'abhi', 'baad', 'pehle', 'kal', 'aaj', 'subah', 'shaam',
      'raat', 'baje', 'ghante', 'roz', 'rozana', 'har', 'din'
    ];

    const words = text.toLowerCase().split(/\s+/);
    const hinglishCount = words.filter(w => hinglishWords.includes(w)).length;

    if (hinglishCount / words.length > 0.2) return 'hinglish';

    return 'english';
  }

  // Detect language using AI (runs in background, no blocking)
  // Always detects fresh per message so bot switches language instantly
  startLanguageDetection(text, userPhone) {
    return languageService.detectLanguage(text).then(langInfo => {
      languageService.setUserLanguage(userPhone, langInfo);
      return langInfo;
    }).catch(() => ({ code: 'en', name: 'English' }));
  }

  // The AI detector must never serialize a turn. Known users get their cached
  // language instantly (the in-flight detection refreshes the cache for the
  // next turn). Only a first-contact user waits, and only briefly, before the
  // heuristic result stands in.
  async resolveUserLanguage(langDetectionPromise, userPhone, heuristicLang) {
    const cached = languageService.getUserLanguage(userPhone);
    if (cached) return cached;
    const fallback = heuristicLang === 'hinglish'
      ? { code: 'hi-Latn', name: 'Hinglish' }
      : { code: 'en', name: 'English' };
    return Promise.race([
      Promise.resolve(langDetectionPromise).catch(() => fallback),
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(fallback), 1200);
        timer.unref?.();
      }),
    ]);
  }

  getTemplates(lang) {
    if (lang === 'english') {
      return {
        reminderSet: [
`Reminder set\n\n"{message}"\n\n{time}`,
`Got it - reminder set\n\n"{message}"\n\n{time}`,
`Reminder set\n\n"{message}"\n\n{time}`
        ],
        recurringSet: [
`Done - Recurring reminder set\n\n"{message}"\n\n{pattern}\nFirst reminder: {time}`,
`Got it - I'll remind you regularly\n\n"{message}"\n\n{pattern}\nStarting: {time}`
        ],
        reminderError: "Couldn't understand the time.\n\nTry:\n- \"remind me in 5 minutes\"\n- \"remind me at 5pm\"\n- \"remind me every day at 9am\"",
        imageSaved: "Image saved\n\nTo find later:\n- \"show my saved images\"",
        imageProcessing: "Analyzing image...",
        voiceError: "Couldn't understand. Please type it out?",
        memorySaved: "Got it, I'll remember that",
        timeFormat: (mins, clockTime, isTomorrow, dayName, date) => {
          if (mins <= 1) return 'in 1 minute';
          if (mins < 60) return `in ${mins} minutes`;
          const hours = Math.floor(mins / 60);
          const m = mins % 60;
          if (hours < 24) {
            if (m === 0) return `in ${hours} hour${hours > 1 ? 's' : ''} (${clockTime})`;
            return `in ${hours}h ${m}m`;
          }
          if (isTomorrow) return `tomorrow at ${clockTime}`;
          return `${dayName} (${date}) at ${clockTime}`;
        }
      };
    } else {
      return {
        reminderSet: [
`Reminder set ho gaya\n\n"{message}"\n\n{time}`,
`Reminder set ho gaya\n\n"{message}"\n\n{time}`,
`Pakka yaad dilaunga\n\n"{message}"\n\n{time}`
        ],
        recurringSet: [
`Done - Recurring reminder set\n\n"{message}"\n\n{pattern}\nPehla reminder: {time}`,
`Set ho gaya - Regular yaad dilaunga\n\n"{message}"\n\n{pattern}\nShuru: {time}`
        ],
        reminderError: "Time samajh nahi aaya\n\nAise bol:\n- \"5 min mein yaad dilana\"\n- \"remind me at 5pm\"\n- \"har din 9 baje remind karna\"",
        imageSaved: "Image save ho gayi\n\nBaad mein: \"show my saved images\"",
        imageProcessing: "Dekh raha hun...",
        voiceError: "Samajh nahi aaya. Type kar de?",
        memorySaved: "Yaad rakh liya",
        timeFormat: (mins, clockTime, isTomorrow, dayName, date) => {
          if (mins <= 1) return 'abhi 1 min mein';
          if (mins < 60) return `${mins} min mein`;
          const hours = Math.floor(mins / 60);
          const m = mins % 60;
          if (hours < 24) {
            if (m === 0) return `${hours} ghante mein (${clockTime})`;
            return `${hours} ghante ${m} min mein`;
          }
          if (isTomorrow) return `kal ${clockTime} ko`;
          return `${dayName} (${date}) ${clockTime} ko`;
        }
      };
    }
  }

  // Clean up expired contexts to prevent stale state and memory leaks
  cleanExpiredContexts(userPhone) {
    const now = Date.now();
    const checks = [
      [this.standupResponseContext, this.workflowContextTtls.standupResponse],
      [this.leaveConfirmContext, this.workflowContextTtls.leaveConfirm],
      [this.pollVoteContext, this.workflowContextTtls.pollVote],
      [this.standupSetupContext, this.workflowContextTtls.standupSetup],
      [this.calendarConfirmContext, this.workflowContextTtls.calendarConfirm],
      [this.imageContext, 10 * 60 * 1000],
      [this.imageListContext, 5 * 60 * 1000],
      [this.documentContext, this.workflowContextTtls.document],
      [this.taskAssignConfirmContext, this.workflowContextTtls.taskAssignConfirm],
      [this.recentEmailContext, this.workflowContextTtls.recentEmail],
      // Apr 30 2026 — visa workflow maps removed.
    ];
    for (const [map, ttl] of checks) {
      if (!map) continue;  // lazy-init guard
      const ctx = map.get(userPhone);
      if (ctx && ctx.timestamp && (now - ctx.timestamp) >= ttl) {
        map.delete(userPhone);
      }
    }
  }

  async getIntentContextHints(userPhone, messageText = '') {
    const bulkCtx = this.bulkEmailContext.get(userPhone);
    const scheduledCtx = this.scheduledEmailContext.get(userPhone);
    const calendarCtx = this.calendarConfirmContext.get(userPhone);
    const leaveCtx = this.leaveConfirmContext.get(userPhone);
    const standupSetupCtx = this.standupSetupContext.get(userPhone);
    const standupResponseCtx = this.standupResponseContext.get(userPhone);
    const pollCtx = this.pollVoteContext.get(userPhone);
    const recentEmail = this.recentEmailContext.get(userPhone);
    const documentCtx = this.documentContext.get(userPhone);
    // Apr 30 2026 — visa context recovery removed (visaBatchCtx, visaPickerCtx,
    // visaResumeCtx). Visa profile builder feature moved to a separate bot.

    // Enrich lastBotAction with a structured reference (entity id, label, etc.)
    // so the LLM can resolve follow-up phrases like "change the time",
    // "cancel that one", "the rohan reminder" to the correct row.
    // Read STRUCTURED entity ref from its own map (never overwritten by
    // agentic-turn / general-chat bookkeeping). Fall back to lastBotAction
    // only if the structured map is empty (backwards compatibility for any
    // legacy handler that didn't upgrade).
    const clarificationCtx = this.lastClarificationContext.get(userPhone) || null;
    const rawEntityRef = this.lastEntityRef.get(userPhone) || null;
    const rawLastAction = rawEntityRef || this.lastBotAction.get(userPhone) || null;
    const lastActionAgeMs = rawLastAction?.timestamp ? (Date.now() - rawLastAction.timestamp) : null;
    const recentLastAction = rawLastAction && lastActionAgeMs !== null && lastActionAgeMs < 10 * 60 * 1000
      ? rawLastAction : null;

    return {
      // Apr 30 2026 — visa context flags removed (hasRecentVisaBatch,
      // recentVisaBatchEmailableCount, hasActiveVisaPicker,
      // hasActiveVisaResumeConfirm, visaResumeSubjectName).
      activeBulkEmail: Boolean(bulkCtx),
      bulkEmailRecipientCount: bulkCtx?.drafts?.length || 0,
      bulkEmailScheduled: Boolean(bulkCtx?.sendAt),
      activeScheduledEmail: Boolean(scheduledCtx),
      activeEmailDraftConfirmation: Boolean(calendarCtx && calendarCtx.type === 'email_send_confirm'),
      activeCalendarConfirmation: Boolean(calendarCtx && calendarCtx.type !== 'email_send_confirm'),
      calendarConfirmationType: calendarCtx?.type || null,
      activeLeaveApproval: Boolean(leaveCtx),
      activeStandupSetup: Boolean(standupSetupCtx),
      standupSetupStep: standupSetupCtx?.step || null,
      activeStandupResponse: Boolean(standupResponseCtx),
      standupQuestionIndex: Number.isInteger(standupResponseCtx?.questionIndex) ? standupResponseCtx.questionIndex + 1 : null,
      activePollVote: Boolean(pollCtx),
      hasRecentEmailContext: Boolean(recentEmail),
      recentEmailType: recentEmail?.type || null,
      hasDocumentAttachment: Boolean(documentCtx),
      documentAttachment: documentCtx ? {
        fileName: documentCtx.fileName || documentCtx.documentName || null,
        fileNames: documentAttachmentsFromContext(documentCtx).map((item) => item.fileName),
        count: documentAttachmentsFromContext(documentCtx).length || 1,
        mimeType: documentCtx.mimeType || null,
        documentType: documentCtx.documentType || null,
      } : null,
      // The bot's own outstanding clarifying question (request_clarification).
      // The next message is almost certainly the answer — detectIntent must
      // combine it with the original request instead of routing it fresh.
      pendingIntentClarification: clarificationCtx ? {
        question: clarificationCtx.question,
        options: clarificationCtx.options || [],
        originalText: clarificationCtx.originalText,
      } : null,
      lastBotAction: this.lastBotAction.get(userPhone) || null,
      // Structured pointer to the most recent thing Ari acted on — lets the
      // LLM resolve "the one we just set" / "change the time" follow-ups.
      lastActionRef: recentLastAction ? {
        action: recentLastAction.action,
        entityType: recentLastAction.entityType || null,
        entityId: recentLastAction.entityId || null,
        label: recentLastAction.label || null,
        targetPhone: recentLastAction.targetPhone || null,
        at: recentLastAction.at || null,
        ageSec: Math.round(lastActionAgeMs / 1000)
      } : null,
      imageWaitingForSaveConfirm: Boolean(this.imageContext?.get(userPhone)),
      dashboardImageListActive: Boolean(this.dashboardImageContext?.get(userPhone) && (Date.now() - (this.dashboardImageContext.get(userPhone)?.timestamp || 0)) < 5 * 60 * 1000),
      // Deterministic bare-number resolution against the most recent list the
      // user was shown — a "2" reply carries the exact item id to the model
      // instead of letting an unrelated tool claim it (smoke-test H-1).
      positionalSelection: messageText
        ? require('../services/positional-resolver.service').resolve(userPhone, messageText)
        : null,
    };
  }

  /**
   * Deterministic short-circuit for active workflow confirmations.
   * Returns the handler response if a workflow context is active, or undefined to fall through to LLM.
   * Only intercepts messages that look like confirmations/cancellations/selections — not long new requests.
   */
  async tryWorkflowShortCircuit(message, context) {
    const text = message.text.trim();
    const userPhone = message.from;
    const now = Date.now();

    // Meeting-action selections ("do 1 and 3" / "all" / "skip") resolve
    // against their pending proposal BEFORE anything else can hijack the
    // numbers. No pending proposal (or expired) → falls straight through.
    try {
      const meetingActions = require('../services/meeting-actions.service');
      if (meetingActions.hasPending(userPhone)) {
        const selectionReply = await meetingActions.resolveSelection(userPhone, text);
        if (selectionReply !== null) return selectionReply;
      }
    } catch (e) {
      logger.warn(`meeting-actions resolveSelection failed (non-fatal): ${e.message}`);
    }

    // ────────────────────────────────────────────────────────────────────
    // HARD SAFETY GATE: if there's a pending outbound-to-others action,
    // try to resolve it with this message BEFORE anything else runs.
    // This guarantees Ari never auto-sends emails/messages/invites
    // even if the LLM tries to call a send-tool again.
    // ────────────────────────────────────────────────────────────────────
    if (!message._gateFastPathDone) {
      try {
        const confirmationGate = require('../services/confirmation-gate.service');
        const gateResult = await confirmationGate.tryResolve(userPhone, text);
        if (gateResult !== null) {
          return gateResult;
        }
      } catch (e) {
        logger.warn(`confirmation-gate tryResolve failed (non-fatal): ${e.message}`);
      }
    }

    // ────────────────────────────────────────────────────────────────────
    // NEW-INTENT OVERRIDE (RC #3 extension, Apr 26 2026)
    // If the message clearly starts a fresh action ("send a bulk email…",
    // "schedule a new meeting…", "remind me to…"), wipe ALL stale pending
    // state so it can't hijack the new request. Bug observed live: a
    // pending calendar confirmation absorbed "send a bulk email to X"
    // and added X as a meeting attendee instead of starting the email.
    // ────────────────────────────────────────────────────────────────────
    if (this._messageIndicatesNewIntent(text)) {
      const cleared = this.clearAllPendingState(userPhone);
      if (cleared.length > 0) {
        logger.info(`[NewIntentOverride] ${userPhone.slice(0, 6)}* "${text.slice(0, 60)}" cleared ${cleared.length} pending: ${cleared.join(', ')}`);
      }
    }

    // ────────────────────────────────────────────────────────────────────
    // N5 FIX (Apr 2026) — failed-calendar time-correction recovery.
    // When a recent calendar attempt failed with "time in the past" we
    // stashed the parsed event. If the user's next turn looks like a
    // pure time/date correction ("actually thursday at 5pm", "make it 3pm
    // tomorrow", "let's do friday morning"), retry the create with the
    // ORIGINAL title/attendees/duration + new time — instead of letting
    // it fall through to calendar_reschedule which would pick a random
    // unrelated entity (e.g. a recently-created Spanish reminder).
    // ────────────────────────────────────────────────────────────────────
    try {
      const failedCal = this.failedCalendarTimeContext?.get(userPhone);
      if (failedCal && (now - failedCal.timestamp) < 5 * 60 * 1000) {
        const TIME_CORRECTION_PATTERNS = [
          /^(actually|let'?s?\s+do|make\s+it|change\s+it\s+to|move\s+it\s+to|how\s+about|try)\s+/i,
          /\b(at|on)\s+\d{1,2}(:\d{2})?\s*(am|pm)?\b/i,
          /\b(tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\s+(week|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i,
          /\b\d{1,2}\s*(am|pm)\b/i,
        ];
        const looksLikeTimeCorrection = TIME_CORRECTION_PATTERNS.some(re => re.test(text)) && text.length < 80;
        if (looksLikeTimeCorrection) {
          this.failedCalendarTimeContext.delete(userPhone);
          logger.info(`[FailedCalendarRecovery] ${userPhone.slice(0,6)}* "${text}" — retrying meeting create with original title="${failedCal.eventData.title || 'Meeting'}"`);
          // Build a fresh "create meeting" message that merges the original
          // event details with the new time. Pass through handleCalendarCreate
          // which will re-parse the time and show the confirmation.
          const originalTitle = failedCal.eventData.title || 'Meeting';
          const attendees = (failedCal.eventData.attendees || [])
            .map(a => typeof a === 'string' ? a : a.email)
            .filter(Boolean)
            .join(', ');
          const merged = `book meeting ${attendees ? `with ${attendees} ` : ''}${text.replace(/^(actually|let'?s?\s+do|make\s+it|change\s+it\s+to|move\s+it\s+to|how\s+about|try)\s+/i, '')} about ${originalTitle}`;
          const newMsg = { ...message, text: merged };
          return await this.handleCalendarCreate(newMsg, context);
        }
      }
    } catch (recoveryErr) {
      logger.warn(`[FailedCalendarRecovery] non-fatal: ${recoveryErr.message}`);
    }

    // Apr 30 2026 — visa intercept blocks removed (PDF upload during
    // resume-confirm, resume-confirm resolver, criteria picker resolver).
    // Visa profile builder feature moved to a separate dedicated bot.

    // Short messages (< 80 chars) during active workflows are almost always confirmations.
    // Longer messages are likely new requests that should go through the LLM.
    const isShortMessage = text.length < 80;
    // Confirmation-like pattern: yes/no/numbers/approve/cancel/send/short phrases
    const isConfirmationLike = /^(yes|no|yeah|yep|nope|nah|sure|ok|okay|cancel|approve|reject|send|confirm|done|skip|haan|ha|nahi|mat|bhej|1|2|3|4|5|6|7|8|9|10|book anyway|force|override|keep)\b/i.test(text);

    // Defensive "book anyway" recovery: even if calendarConfirmContext was lost
    // (expired, or clobbered by reminder/task interjections), fall back to lastBookingEventData.
    if (/^(book\s*anyway|force\s*book|override|force)\b/i.test(text)) {
      const primaryCtx = this.calendarConfirmContext.get(userPhone);
      if (primaryCtx && (primaryCtx.type === 'conflict_resolution' || primaryCtx.type === 'booking_confirm')) {
        const result = await this.handleCalendarConfirmation(message, primaryCtx);
        if (result) return result;
      }
      const last = this.lastBookingEventData.get(userPhone);
      if (last && (now - last.timestamp) < 60 * 60 * 1000) {
        this.lastBookingEventData.delete(userPhone);
        this.calendarConfirmContext.delete(userPhone);
        const eventData = { ...last.eventData, force: true };
        const createResult = await calendarService.createEvent(userPhone, eventData);
        if (!createResult.success) {
          return createResult.error || 'Failed to book.';
        }
        const tz = last.timezone || 'Asia/Kolkata';
        const startStr = createResult.start.toLocaleString('en-IN', {
          timeZone: tz, weekday: 'short', day: 'numeric', month: 'short',
          hour: 'numeric', minute: '2-digit', hour12: true
        });
        const endStr = createResult.end.toLocaleTimeString('en-IN', {
          timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true
        });
        return `Meeting booked (forced)!\n\n*${createResult.title}*\n${startStr} - ${endStr}`;
      }
    }

    // Calendar confirmation (also handles email_send_confirm since it's stored in calendarConfirmContext)
    const calCtx = this.calendarConfirmContext.get(userPhone);
    if (calCtx) {
      const isEmail = calCtx.type === 'email_send_confirm';
      const ttl = isEmail ? this.workflowContextTtls.emailConfirm : this.workflowContextTtls.calendarConfirm;
      const isExpired = (now - calCtx.timestamp) >= ttl;
      if (isExpired) {
        // Auto-clear expired email drafts so a stale "yes" can never send them
        if (isEmail) this.calendarConfirmContext.delete(userPhone);
      } else if (isEmail) {
        // Email drafts: require short message AND explicit revision intent for non-yes/no text.
        // Topic shifts (long messages) bypass this handler entirely and go to the normal router,
        // which will clear the draft if the new intent is unrelated.
        const isExplicitRevision = /^(make it|change|add|remove|rewrite|revise|edit|more |less |shorter|longer|formal|casual)/i.test(text);
        if (isShortMessage || isExplicitRevision) {
          const result = await this.handleCalendarConfirmation(message, calCtx);
          if (result !== null) return result;
        }
      } else if (isShortMessage) {
        // Calendar confirms: only intercept short/confirmation-like messages
        const result = await this.handleCalendarConfirmation(message, calCtx);
        if (result !== null) return result;
      }
    }

    // Scheduled email confirmation
    const schedCtx = this.scheduledEmailContext.get(userPhone);
    if (schedCtx && (now - schedCtx.timestamp) < this.workflowContextTtls.scheduledEmail && isShortMessage) {
      const result = await this.handleScheduledEmailConfirm(message);
      if (result !== null && result !== undefined) return result;
    }

    // Bulk email confirmation
    const bulkCtx = this.bulkEmailContext.get(userPhone);
    if (bulkCtx && (now - bulkCtx.timestamp) < this.workflowContextTtls.bulkEmail && isShortMessage) {
      const result = await this.handleBulkEmailConfirm(message);
      if (result !== null && result !== undefined) return result;
    }

    // Follow-up email selection (user picks a number from the list)
    const followUpCtx = this._followUpContext?.get(userPhone);
    if (followUpCtx && (now - followUpCtx.timestamp) < 10 * 60 * 1000 && isShortMessage) {
      const numMatch = text.match(/^(\d+)$/);
      if (numMatch) {
        const idx = parseInt(numMatch[1]) - 1;
        if (idx >= 0 && idx < followUpCtx.emails.length) {
          this._followUpContext.delete(userPhone);
          return await this._draftFollowUpFromEmail(
            { ...message, text: followUpCtx.userMessage },
            followUpCtx.recipientEmail,
            followUpCtx.emails[idx]
          );
        }
      }
    }

    // Sales email confirmation
    const salesCtx = this.salesEmailContext.get(userPhone);
    if (salesCtx && (now - salesCtx.timestamp) < this.workflowContextTtls.salesEmail && isShortMessage) {
      const result = await this.handleSalesEmailConfirm(message);
      if (result !== null && result !== undefined) return result;
    }

    // Leave approval confirmation
    const leaveCtx = this.leaveConfirmContext.get(userPhone);
    if (leaveCtx && (now - leaveCtx.timestamp) < this.workflowContextTtls.leaveConfirm && isShortMessage) {
      const result = await this.handleLeaveApproval(message, leaveCtx);
      if (result !== null && result !== undefined) return result;
    }

    // Standup setup (team names, times, etc.)
    const setupCtx = this.standupSetupContext.get(userPhone);
    if (setupCtx && (now - setupCtx.timestamp) < this.workflowContextTtls.standupSetup && isShortMessage) {
      const result = await this.handleStandupSetup(message, setupCtx);
      if (result !== null && result !== undefined) return result;
    }

    // Standup response (answering standup questions)
    const standupCtx = this.standupResponseContext.get(userPhone);
    if (standupCtx && (now - standupCtx.timestamp) < this.workflowContextTtls.standupResponse) {
      // Standup responses can be longer — always intercept when context is active
      const result = await this.handleStandupResponse(message, standupCtx);
      if (result !== null && result !== undefined) return result;
    }

    // Pending poll broadcast confirmation (before the actual vote-context check)
    if (this.pendingPollContext) {
      const pendingPoll = this.pendingPollContext.get(userPhone);
      if (pendingPoll && (now - pendingPoll.timestamp) < 10 * 60 * 1000 && isShortMessage) {
        if (/^(yes|yep|yeah|send|ok|okay|confirm|go|do it)\b/i.test(text)) {
          this.pendingPollContext.delete(userPhone);
          // Actually create + broadcast
          const createRes = await pollService.createPoll(
            userPhone, pendingPoll.question, pendingPoll.options, pendingPoll.recipients, pendingPoll.isAnonymous
          );
          if (!createRes.success) return 'Could not create poll. Try again?';
          // Include sender name so recipients know who asked (memory -> users table -> masked phone)
          let senderName = await this.getUserNameForSignature(userPhone).catch(() => null);
          if (!senderName) {
            try {
              const { query } = require('../config/database');
              const r = await query(`SELECT name FROM users WHERE phone_number = $1 LIMIT 1`, [userPhone]);
              if (r.rows[0]?.name) senderName = r.rows[0].name;
            } catch (_) {}
          }
          if (!senderName) {
            // Final fallback: mask phone number (e.g. "+91 ***8667") — at least tells recipient it came from a real number
            const digits = String(userPhone).replace(/\D/g, '');
            senderName = digits.length >= 4 ? `+${digits.slice(0, 2)} ***${digits.slice(-4)}` : 'your team admin';
          }
          const pollMsg = pollService.formatPollMessage(createRes.poll, senderName);
          const failed = [];
          for (const recipient of pendingPoll.recipients) {
            try {
              const optionsList = pendingPoll.options.map((o, i) => `${i + 1}. ${o}`).join(' ');
              await sendWithTemplateFallback(recipient.phone, pollMsg, TEMPLATES.POLL_BROADCAST, [senderName, pendingPoll.question, optionsList]);
              this.pollVoteContext.set(recipient.phone, { pollId: createRes.poll.id, timestamp: Date.now() });
            } catch (e) {
              failed.push(recipient.name);
              logger.warn(`Could not send poll to ${recipient.name}: ${e.message}`);
            }
          }
          const sentCount = pendingPoll.recipients.length - failed.length;
          let reply = `Poll sent to ${sentCount} member${sentCount === 1 ? '' : 's'}!`;
          if (failed.length > 0) reply += `\n(Failed: ${failed.join(', ')})`;
          reply += `\n\nI'll let you know when everyone has voted.`;
          return reply;
        }
        if (/^(no|cancel|nah|nope|stop)\b/i.test(text)) {
          this.pendingPollContext.delete(userPhone);
          return 'Poll cancelled. Nothing was sent.';
        }
      }
    }

    // Poll vote
    const pollCtx = this.pollVoteContext.get(userPhone);
    if (pollCtx && (now - pollCtx.timestamp) < this.workflowContextTtls.pollVote && (isConfirmationLike || isShortMessage)) {
      const result = await this.handlePollVote(message, pollCtx);
      if (result !== null && result !== undefined) return result;
    }

    // Contact save confirmation: user mentioned a phone number, bot asked "should I save?"
    const contactSaveCtx = this.contactSaveContext.get(userPhone);
    if (contactSaveCtx && (now - contactSaveCtx.timestamp) < 3 * 60 * 1000 && isShortMessage) {
      const classification = classifySensitiveConfirmation(text);
      if (classification.decision === 'confirm') {
        const saveResult = await contactService.saveContact(userPhone, contactSaveCtx.name, contactSaveCtx.phone);
        this.contactSaveContext.delete(userPhone);
        if (saveResult.success) {
          this.lastSavedContact.set(userPhone, { name: saveResult.contact.name, phone: saveResult.contact.phone, timestamp: Date.now() });
          return `Saved *${saveResult.contact.name}* — ${contactService.maskPhone(saveResult.contact.phone)}`;
        }
        return `Couldn't save: ${saveResult.error}`;
      }
      if (classification.decision === 'cancel') {
        this.contactSaveContext.delete(userPhone);
        return `Okay, won't save it.`;
      }
      // 'new_request' or 'edit' — fall through to LLM for the new request
    }

    // CSV import confirmation: user uploaded a CSV and was shown preview
    const csvCtx = this.csvImportContext.get(userPhone);
    if (csvCtx && (now - csvCtx.timestamp) < 5 * 60 * 1000 && isShortMessage) {
      const classification = classifySensitiveConfirmation(text);
      if (classification.decision === 'confirm') {
        this.csvImportContext.delete(userPhone);
        const total = csvCtx.contacts.length;
        await messagingService.send(userPhone, `Importing ${total} contacts...`);
        const result = await contactService.bulkSaveContacts(userPhone, csvCtx.contacts);
        let response = `*CSV Import Complete*\n\n`;
        if (result.saved.length > 0) response += `- *${result.saved.length}* new contacts saved\n`;
        if (result.updated.length > 0) response += `- *${result.updated.length}* existing contacts updated\n`;
        if (result.failed.length > 0) {
          response += `- *${result.failed.length}* failed\n`;
          result.failed.slice(0, 3).forEach(c => { response += ` ↳ ${c.name}: ${c.reason}\n`; });
        }
        const newTotal = await contactService.getContactCount(userPhone);
        response += `\nTotal contacts: *${newTotal}*`;
        return response;
      }
      if (classification.decision === 'cancel') {
        this.csvImportContext.delete(userPhone);
        return 'CSV import cancelled.';
      }
      // 'new_request' — fall through to LLM
    }

    // File-share confirmation: user asked for a document they'd saved before,
    // bot replied "Yes I have it, want me to share?" — now we resolve their reply.
    const shareCtx = this.pendingFileShareContext.get(userPhone);
    if (shareCtx && (now - shareCtx.timestamp) < 5 * 60 * 1000 && isShortMessage) {
      const classification = classifySensitiveConfirmation(text);
      if (classification.decision === 'confirm') {
        this.pendingFileShareContext.delete(userPhone);
        let deliveredNames = [];
        for (const f of shareCtx.files) {
          if (!f.file_url) continue;
          const caption = f.document_name || f.file_name || 'Your file';
          const filename = f.file_name || (f.document_name ? `${f.document_name}.pdf` : 'file.pdf');
          try {
            if (f.file_type === 'image') {
              await messagingService.sendImage(userPhone, f.file_url, caption);
            } else {
              await messagingService.sendDocument(userPhone, f.file_url, caption, filename);
            }
            deliveredNames.push(caption);
          } catch (e) {
            logger.warn(`Failed to deliver saved file ${f.id}: ${e.message}`);
          }
        }
        if (deliveredNames.length === 0) {
          return `Found the file but couldn't send it right now. Try again in a moment.`;
        }
        return `Sent ✓ — ${deliveredNames.join(', ')}`;
      }
      if (classification.decision === 'cancel') {
        this.pendingFileShareContext.delete(userPhone);
        return `Okay, leaving it there. Just ask again whenever you need it.`;
      }
      // 'new_request' — fall through
    }

    // Team add phone follow-up: user was asked for a phone number
    const teamAddCtx = this.teamAddContext.get(userPhone);
    if (teamAddCtx && (now - teamAddCtx.timestamp) < 5 * 60 * 1000) {
      const phoneMatch = text.replace(/[\s\-\(\)]/g, '').match(/\+?(\d{10,15})/);
      if (phoneMatch) {
        let phone = phoneMatch[1];
        if (phone.length === 10) phone = '91' + phone;
        const result = await taskService.addTeamMember(userPhone, phone, teamAddCtx.name, 'member', teamAddCtx.teamName);
        if (!result.success) {
          this.teamAddContext.delete(userPhone);
          return `Could not add ${teamAddCtx.name}: ${result.error}`;
        }
        // Also save as contact for future lookups
        await contactService.saveContact(userPhone, teamAddCtx.name, phone).catch(() => {});
        let response = `Added *${teamAddCtx.name}* to *${teamAddCtx.teamName} team*\n(${contactService.maskPhone(phone)})\n_Also saved as a contact._`;

        // If there are more pending names, ask for the next one
        if (teamAddCtx.pendingNames && teamAddCtx.pendingNames.length > 0) {
          const nextName = teamAddCtx.pendingNames[0];
          const remaining = teamAddCtx.pendingNames.slice(1);
          this.teamAddContext.set(userPhone, {
            name: nextName,
            teamName: teamAddCtx.teamName,
            pendingNames: remaining,
            timestamp: Date.now()
          });
          response += `\n\nNow send me *${nextName}*'s phone number.`;
        } else {
          this.teamAddContext.delete(userPhone);
        }
        return response;
      }
    }

    // Reminder list follow-up: handles "2nd one", "the 3rd", "stop 3", "#2", ordinals after showing a list
    const remCtx = this.reminderListContext.get(userPhone);
    if (remCtx && (now - remCtx.timestamp) < 5 * 60 * 1000 && isShortMessage) {
      const ordinalResult = this._parseReminderOrdinal(text);
      if (ordinalResult !== null) {
        const idx = ordinalResult; // 1-based
        if (idx >= 1 && idx <= remCtx.items.length) {
          const item = remCtx.items[idx - 1];
          try {
            const { query: dbQuery } = require('../config/database');
            // Defensive scope (Batch F6): item.id came from this user's
            // context, but anchor the WHERE on user_phone too so a
            // future refactor that reuses this path on stale context
            // cannot cross-cancel another user's reminder.
            await dbQuery(`UPDATE reminders SET status = 'cancelled' WHERE id = $1 AND user_phone = $2`, [item.id, userPhone]);
            this.reminderListContext.delete(userPhone);
            return `Cancelled: "${item.message}"`;
          } catch (e) {
            return 'Could not cancel that reminder.';
          }
        }
        return `Invalid number. You have ${remCtx.items.length} pending reminder${remCtx.items.length !== 1 ? 's' : ''}.`;
      }
    }

    // Task list context: user replied with "3 done" or just "3" after viewing task list
    const taskCtx = this.taskListContext.get(userPhone);
    if (taskCtx && (now - taskCtx.timestamp) < 5 * 60 * 1000 && isShortMessage) {
      const doneMatch = text.match(/^(\d+)\s*(done|complete|✓|ho gaya|hogaya|kiya|kar diya)?$/i);
      const num = doneMatch ? parseInt(doneMatch[1], 10) : NaN;
      if (!isNaN(num) && num >= 1 && num <= taskCtx.tasks.length) {
        const task = taskCtx.tasks[num - 1];
        if (taskCtx.type === 'assigned_to_me') {
          // Mark as done
          const result = await taskService.completeTaskById(task.id);
          if (!result.success) return result.error || 'Could not complete task.';
          this.taskListContext.delete(userPhone);

          let response = `Done: "${result.task.description}"`;
          // Notify assigner
          if (result.task.assigned_by && result.task.assigned_by !== userPhone) {
            try {
              const completeName = await this.resolveContactName(result.task.assigned_by, userPhone);
              const taskDoneMsg = `${completeName} completed the task: "${result.task.description}"`;
              await sendWithTemplateFallback(
                result.task.assigned_by,
                taskDoneMsg,
                TEMPLATES.TASK_COMPLETED,
                [result.task.description, completeName]
              );
              response += '\nAssigner notified.';
            } catch (e) {
              // Don't fail the user's "done" reply if assigner notify breaks.
              // But log it — the previous empty catch hid template/template-
              // fallback errors entirely, making support tickets impossible.
              logger.warn(`[Tasks] Could not notify assigner ${result.task.assigned_by}: ${e.message}`);
            }
          }
          return response;
        } else if (taskCtx.type === 'assigned_by_me') {
          // Assigner wants to mark someone else's task done
          const result = await taskService.completeTaskById(task.id);
          if (!result.success) return result.error || 'Could not complete task.';
          this.taskListContext.delete(userPhone);
          return `Marked as done: "${result.task.description}"`;
        }
      }
      if (!isNaN(parseInt(text, 10))) {
        return `Invalid number. Pick between 1 and ${taskCtx.tasks.length}.`;
      }
    }

    return undefined; // No active workflow — fall through to LLM
  }

  async verifyWebhook(req, res) {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
      // Validate challenge is a simple numeric/alphanumeric string (Meta sends integers)
      if (!challenge || typeof challenge !== 'string' || challenge.length > 100 || !/^[a-zA-Z0-9_-]+$/.test(challenge)) {
        return res.status(400).send('Invalid challenge');
      }
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  async handleMessage(req, res) {
    // Declared OUTSIDE the try so the catch/finally blocks can actually see
    // it. It used to be `const message` inside the try, which made the
    // `typeof message !== 'undefined'` guards below permanently false — the
    // per-user lock was never released here (every rapid follow-up message
    // spin-waited the full 15s in acquireUserLock) and the error apology was
    // never sent.
    let message;
    // Only the request that ACQUIRED the lock may release it. Early returns
    // between parseWebhookMessage and acquireUserLock (rate-limit, burst,
    // duplicate webhook retries) must not delete a lock held by another
    // in-flight message from the same user.
    let userLockAcquired = false;
    try {
      res.status(200).send('EVENT_RECEIVED');

      // Log delivery status webhooks (sent, delivered, read, failed)
      // Also updates team broadcast receipt tracking
      try {
        const statuses = req.body?.entry?.[0]?.changes?.[0]?.value?.statuses;
        if (statuses && statuses.length > 0) {
          for (const s of statuses) {
            logger.info(`[WA STATUS] ${s.recipient_id} → ${s.status} (ts: ${s.timestamp})${s.errors ? ' ERROR: ' + JSON.stringify(s.errors) : ''}`);
            // delivery status logged above
          }
        }
      } catch (e) { /* ignore status parse errors */ }

      message = whatsappService.parseWebhookMessage(req.body);
      if (!message) return;

      // Validate sender ID format
      if (!validateUserId(message.from)) {
        logger.warn(`[WA] Rejected invalid sender ID: ${String(message.from).substring(0, 30)}`);
        return;
      }

      // Sanitize document metadata early
      if (message.document) {
        if (message.document.filename) {
          message.document.filename = sanitizeFilename(message.document.filename);
        }
        if (message.document.mime_type) {
          message.document.mime_type = validateMimeType(message.document.mime_type) || 'application/octet-stream';
        }
      }

      // Rate limiting per user (30 msg/min)
      if (this.isRateLimited(message.from)) {
        return; // Silently drop — don't waste API calls
      }

      // Burst detection (5 msg in 10 seconds = likely bot)
      if (abuseProtection.isMessageBurst(message.from)) {
        if (!abuseProtection.shouldSilentDrop(message.from, 'burst')) {
          await messagingService.send(message.from, 'Slow down! You are sending messages too fast.');
        }
        return;
      }

      // Bot behavior detection (constant timing patterns)
      const botCheck = abuseProtection.detectBotBehavior(message.from);
      if (botCheck.isBot) {
        if (!abuseProtection.shouldSilentDrop(message.from, 'bot')) {
          await messagingService.send(message.from, 'Unusual activity detected. Please try again in a few minutes.');
        }
        return;
      }

      // Duplicate message protection (Meta retries webhooks)
      if (message.messageId) {
        if (this.processedMessages.has(message.messageId)) {
          return;
        }
        this.processedMessages.set(message.messageId, true);

        // H1-N fix (Batch F4): Postgres-backed dedup with 25h retention
        // so Meta's 24h retry window can't replay a message after the
        // 1h BoundedMap TTL evicts it. The INSERT ... ON CONFLICT pattern
        // races safely between concurrent webhooks for the same messageId.
        // Cheap: indexed by messageId, expired rows pruned weekly.
        try {
          const { query: dbq } = require('../config/database');
          const ins = await dbq(
            `INSERT INTO processed_messages (message_id, user_phone, processed_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (message_id) DO NOTHING
             RETURNING message_id`,
            [message.messageId, message.from || null]
          );
          if (ins.rowCount === 0) {
            logger.info(`[Dedup] Replay detected for messageId ${message.messageId} from ${message.from} — dropping`);
            return;
          }
        } catch (dedupErr) {
          // If the table doesn't exist or DB blips, fall through to the
          // in-memory dedup. Schema ensure happens lazily below.
          if (!this._processedMessagesSchemaWarned) {
            logger.warn(`[Dedup] Postgres dedup not available, in-memory only: ${dedupErr.message}`);
            this._processedMessagesSchemaWarned = true;
          }
          // Best-effort schema create — first failure triggers it once.
          if (!this._processedMessagesSchemaTried) {
            this._processedMessagesSchemaTried = true;
            const { query: dbq } = require('../config/database');
            dbq(`CREATE TABLE IF NOT EXISTS processed_messages (
                   message_id VARCHAR(255) PRIMARY KEY,
                   user_phone VARCHAR(50),
                   processed_at TIMESTAMP DEFAULT NOW()
                 )`).catch(() => {});
            dbq(`CREATE INDEX IF NOT EXISTS idx_processed_messages_at
                   ON processed_messages(processed_at DESC)`).catch(() => {});
          }
        }
      } else {
        // H2-N fix: derive a fallback dedup key when messageId is missing
        // (unsupported message types, status notifications). Combines
        // sender + message timestamp + a content hash so two real
        // distinct messages don't collide while replays do.
        try {
          const crypto = require('crypto');
          const ts = message.timestamp || message.audio?.id || message.image?.id || message.document?.id || '';
          const text = message.text || '';
          const fp = crypto.createHash('sha1')
            .update(`${message.from || ''}|${ts}|${text}`)
            .digest('hex').slice(0, 32);
          const fbKey = `fb_${fp}`;
          if (this.processedMessages.has(fbKey)) {
            return;
          }
          this.processedMessages.set(fbKey, true);
        } catch (_) { /* swallow */ }
      }

      // Mark message as read (blue ticks) + show typing indicator
      if (message.messageId) {
        whatsappService.markAsReadAndType(message.messageId).catch((e) => {
          logger.warn(`[WA] markAsReadAndType error: ${e.message}`);
        });
      }

      // Per-user lock: ensure messages are processed sequentially per user
      // This prevents race conditions where concurrent messages get stale AI context
      await this.acquireUserLock(message.from);
      userLockAcquired = true;

      // Sanitize input length to prevent abuse
      if (message.text) {
        message.text = sanitizeInput(message.text, 5000).trim();
        if (!message.text) message.text = ''; // collapse whitespace-only to empty
      }

      // Turn trace — one durable JSONL record per accepted WhatsApp turn
      // (logs/agent-turns.jsonl). Flushed in the finally below so every
      // early-returning branch still produces its record.
      turnTrace.begin(message.from, {
        channel: 'whatsapp',
        type: message.type,
        text: message.text,
        document: message.document ? (message.document.filename || 'document') : undefined,
      });

      // Voice messages
      if (message.type === 'audio' && message.audio) {
        if (abuseProtection.isMediaProcessLimited(message.from)) {
          if (!abuseProtection.shouldSilentDrop(message.from, 'media')) {
            await messagingService.send(message.from, 'Too many media files. Please wait a minute.');
          }
          return;
        }

        logger.info(`Voice from ${message.from}`);
        try {
          const transcription = await whatsappService.transcribeAudio(message.audio.id, message.from);
          if (transcription) {
            message.text = transcription;
            message.isVoice = true;
          } else {
            await messagingService.send(message.from, "Couldn't catch that. Please type?");
            return;
          }
        } catch (error) {
          await messagingService.send(message.from, "Voice failed. Please type?");
          return;
        }
      }

      // Images
      if (message.type === 'image' && message.image) {
        if (abuseProtection.isMediaProcessLimited(message.from)) {
          if (!abuseProtection.shouldSilentDrop(message.from, 'media')) {
            await messagingService.send(message.from, 'Too many images. Please wait a minute.');
          }
          return;
        }
        await this.handleImage(message);
        return;
      }

      // Documents (PDFs, audio/video files, etc.)
      if (message.type === 'document' && message.document) {
        if (abuseProtection.isMediaProcessLimited(message.from)) {
          if (!abuseProtection.shouldSilentDrop(message.from, 'media')) {
            await messagingService.send(message.from, 'Too many files. Please wait a minute.');
          }
          return;
        }
        const caption = extractActionableCaption(message);
        const savedDocument = await this.handleDocument(message);
        if (!(savedDocument && caption)) return;
        // The caption is an instruction ("here's the sheet — create a group
        // named X") — after the save, route it like a normal text message
        // instead of dropping it. WhatsApp captions arrive via
        // document.caption and skipped the text sanitization pass above.
        turnTrace.note(message.from, 'document_caption_routed', { savedDocument });
        message.type = 'text';
        message.text = sanitizeInput(caption, 5000).trim();
        if (!message.text) return;
      }

      // Handle interactive button replies (e.g., task Done/Not done buttons)
      if (message.type === 'interactive' && message.interactive) {
        const btnReply = message.interactive.button_reply || message.interactive.list_reply;
        if (btnReply) {
          message.text = btnReply.id;
        }
      }

      if (!message.text) return;

      // Task button reply handler (task_done_XX / task_notdone_XX / task_stopfollowup_XX)
      if (message.text.startsWith('task_done_') || message.text.startsWith('task_notdone_')) {
        await this.handleTaskButtonReply(message);
        return;
      }
      if (message.text.startsWith('task_stopfollowup_')) {
        const taskId = parseInt(message.text.replace('task_stopfollowup_', ''), 10);
        if (Number.isFinite(taskId)) {
          try {
            const { query } = require('../config/database');
            // IDOR fix (May 19 2026 — Batch F1): until now any user could
            // type the button ID `task_stopfollowup_42` as text and stop
            // follow-ups on task 42 regardless of ownership. Scope the
            // UPDATE so it only affects tasks the sender either owns or
            // is assigned to. RETURNING tells us whether anything actually
            // changed so we can give honest UX.
            const result = await query(
              `UPDATE tasks SET next_followup_at = NULL, followup_cadence_minutes = NULL
                 WHERE id = $1
                   AND (user_phone = $2 OR assigned_to = $2)
                 RETURNING id`,
              [taskId, message.from]
            );
            if (result.rowCount > 0) {
              await messagingService.send(message.from, 'OK, stopped following up on this task. It is still pending — reply "Done" any time when complete.');
            } else {
              // Don't echo task details — could leak existence of tasks
              // belonging to others. Generic decline.
              await messagingService.send(message.from, "I couldn't find that task under your account.");
              logger.security('task_stopfollowup_idor_attempt', { userPhone: message.from, taskId });
            }
          } catch (e) {
            logger.error(`task_stopfollowup_ failed: ${e.message}`);
          }
        }
        return;
      }

      // Delegated-task TEXT reply bypass.
      //
      // Scenario: a paid user assigned a task to someone (free OR paid).
      // The recipient gets a WhatsApp notification with Done/Not-Done buttons.
      // Button replies already bypass gates (above). But many users type their
      // status as text ("done", "completed", "not done yet", "skip it") — and
      // for a free user those text replies would hit the pack-gated task_done
      // intent and get an upgrade prompt. That's hostile UX: the paying user
      // assigned the task, the recipient is just acknowledging it.
      //
      // Rule: if the sender has at least one pending delegated task AND their
      // message is a short status phrase, mark-or-followup without any gate.
      try {
        const delegateHandled = await this._tryDelegatedTaskTextReply(message);
        if (delegateHandled) return;
      } catch (e) {
        logger.warn(`delegated task text reply intercept failed: ${e.message}`);
        // fall through to normal flow
      }

      // Briefing-reply intercept — exact-word CTAs from the morning brief:
      //   `plan` / `more` / `skip` / `done` / `status` / `delegations`
      // These replies bypass the LLM so they're cheap and fast. Most fire on
      // the keyword alone; `done` additionally requires a cached brief context
      // (so we know WHICH task to complete).
      try {
        const briefingHandled = await this._tryBriefingReply(message);
        if (briefingHandled) return;
      } catch (e) {
        logger.warn(`briefing reply intercept failed: ${e.message}`);
        // fall through to normal flow
      }

      // === Cold-start onboarding intercept (Free users, first message) ===
      // Until May 19 2026 a brand-new free user who texted "hi" was sent
      // straight to the LLM with no feature discovery. That hurt activation.
      // Now: on the user's first-ever message, send a short welcome that
      // names the top features and how to ask for help — exactly once, gated
      // by a per-process BoundedMap so we don't accidentally re-fire across
      // restarts (and the welcome itself writes a marker memory).
      try {
        if (await this._maybeSendColdStartWelcome(message)) return;
      } catch (e) {
        logger.warn(`cold-start welcome failed (non-fatal): ${e.message}`);
      }

      // === Post-payment onboarding intercept ===
      // Check if this user is mid-onboarding (recently paid). This runs before AI processing
      // so name / integration responses are captured reliably.
      const onboardingHandled = await this.handleOnboardingStep(message);
      if (onboardingHandled) return;

      // === Dashboard sign-in intercept ===
      // Legacy dashboard phrases now point to the shared Google + Composio sign-in.
      if (isDashboardLoginQuery(message.text)) {
        const linkReply = await this.handleAccountLink(message);
        await messagingService.send(message.from, linkReply);
        return;
      }

      // === Reminder list intercept — always read DB, never AI chat ===
      if (isReminderListQuery(message.text)) {
        const listReply = await dashboardService.getRemindersView(message.from);
        await messagingService.send(message.from, listReply);
        return;
      }

      // === Meeting-to-action intercept (Phase 3) ===
      // "turn my last meeting into actions" / "meeting actions" — numbered
      // proposals with explicit confirmation; deterministic, never LLM-routed.
      if (
        /\b(turn|convert)\b[\s\S]{0,40}\bmeeting\b[\s\S]{0,30}\b(action|task)s?\b/i.test(message.text)
        || /^meeting actions?$/i.test(message.text.trim())
        || /\bactions? (from|for) (my )?(last |latest )?meeting\b/i.test(message.text)
      ) {
        const meetingActions = require('../services/meeting-actions.service');
        const proposal = await meetingActions.proposeFromLastMeeting(message.from);
        if (proposal) {
          await messagingService.send(message.from, proposal);
          return;
        }
      }

      // === Meeting prep brief intercept (Phase 3) ===
      // "prep me for my meeting with Meera" → CRM card + last decisions +
      // open tasks, assembled from the entity context layer.
      {
        const meetingActions = require('../services/meeting-actions.service');
        if (meetingActions.isPrepQuery(message.text)) {
          const brief = await meetingActions.buildPrepBrief(message.from, message.text);
          if (brief) {
            await messagingService.send(message.from, brief);
            return;
          }
        }
      }

      // === MCP token intercepts (Phase 4 platform) ===
      // "connect claude" mints a personal bearer token for the /mcp endpoint
      // (shown once); "revoke mcp tokens" kills all of the user's tokens.
      if (/^(connect (claude|cursor|mcp)|create (an? )?(mcp|api) (token|key)|mcp (token|access))$/i.test(message.text.trim())) {
        const mcpTokens = require('../services/mcp-token.service');
        const minted = await mcpTokens.mint(message.from, 'whatsapp');
        let tokenReply;
        if (minted?.token) {
          const base = (process.env.APP_BASE_URL || 'http://127.0.0.1:43100').replace(/\/$/, '');
          tokenReply =
            `🔌 *Your Ari MCP access* (shown once — save it now)\n\n` +
            `URL: ${base}/mcp\n` +
            `Token: ${minted.token}\n\n` +
            `In Claude or Cursor, add a *custom MCP connector* with that URL and the token as the Bearer/Authorization value. ` +
            `Your CRM, meetings, tasks, and facts become tools there — read-only except note-grade memory.\n\n` +
            `Say *"revoke mcp tokens"* anytime to cut access.`;
        } else if (minted?.error) {
          tokenReply = minted.error;
        } else {
          tokenReply = `Couldn't create an access token right now — try again in a minute.`;
        }
        await messagingService.send(message.from, tokenReply);
        return;
      }
      if (/^revoke (all )?(mcp|api) (tokens?|keys?|access)$/i.test(message.text.trim())) {
        const mcpTokens = require('../services/mcp-token.service');
        const n = await mcpTokens.revokeAll(message.from);
        await messagingService.send(
          message.from,
          n > 0 ? `🔒 Revoked ${n} MCP token${n === 1 ? '' : 's'}. External access is cut off.` : `No active MCP tokens to revoke.`
        );
        return;
      }

      // === Cancel last reminder intercept — bypass flaky intent routing ===
      if (isCancelLastReminderQuery(message.text)) {
        const cancelReply = await this.handleReminderCancel(message);
        await messagingService.send(message.from, cancelReply);
        return;
      }

      // === Cancel all reminders intercept (incl. "delete alll reminders") ===
      if (matchesCancelAllReminders(message.text)) {
        const cancelAllReply = await this.handleReminderCancel(message);
        await messagingService.send(message.from, cancelAllReply);
        return;
      }

      const disabledGoogleReply = getDisabledGoogleFeatureReply(message.text);
      if (disabledGoogleReply) {
        await messagingService.send(message.from, disabledGoogleReply);
        return;
      }

      // Help and explicit habit commands stay available during LLM outages.
      if (await this.tryDeterministicCommand(message)) return;

      logger.info(`Message from ${message.from}: ${message.text}`);

      // Deterministic approval fast-path: when THIS user has an armed
      // confirmation, a strict yes/no/edit reply resolves right here —
      // before timezone/context/history loads — so approving a pended
      // action costs milliseconds instead of another full pre-stack.
      // Gate replies embed user-authored content, so they are sent
      // untranslated (same as the workflow_confirm skip below).
      const confirmationGateFastPath = require('../services/confirmation-gate.service');
      if (message.type === 'text' && confirmationGateFastPath.hasPending(message.from)) {
        let gateReply = null;
        try {
          gateReply = await confirmationGateFastPath.tryResolve(message.from, message.text);
        } catch (gateError) {
          logger.warn(`confirmation fast-path failed (non-fatal): ${gateError.message}`);
        }
        message._gateFastPathDone = true;
        if (gateReply !== null) {
          turnTrace.note(message.from, 'route', { route: 'confirmation_fast_path' });
          this.lastBotAction.set(message.from, { action: 'workflow_confirm', timestamp: Date.now() });
          await this.saveConversationExchange(message.from, message.text, gateReply, 'confirmation fast-path');
          turnTrace.note(message.from, 'response_sent', { response: gateReply });
          await this.sendLongMessage(message.from, gateReply);
          return;
        }
      }

      // Fire AI language detection in parallel (non-blocking)
      const langDetectionPromise = this.startLanguageDetection(message.text, message.from);

      const lang = this.detectLanguage(message.text);
      message.lang = lang;


      // Clean up expired contexts to prevent stale state
      this.cleanExpiredContexts(message.from);

      // Timezone and recent history are independent — fetch them in one wave
      // instead of serializing three database round-trips per turn.
      const [userTimezone, recentMessages] = await Promise.all([
        timezoneService.getUserTimezone(message.from),
        aiService.getRecentContext(message.from, 15),
      ]);
      const context = await this.getContext(message.from, userTimezone);
      context.lang = lang;
      // Attach detected language so AI responds natively
      context.userLanguage = await this.resolveUserLanguage(langDetectionPromise, message.from, lang);
      let response;

      // Exa-first live web search path. Obvious current/live/search-online
      // requests bypass LLM intent routing so they do not fall back to stale
      // model knowledge when the LLM misses the web_search tool.
      if (response === undefined && this.shouldUseExaWebSearch(message.text)) {
        response = await this.handleWebSearch(message, context, { query: message.text });
        this.lastBotAction.set(message.from, { action: 'web_search', timestamp: Date.now() });
        if (response) {
          await this.saveConversationExchange(message.from, message.text, response, 'Exa web path');
        }
      }

      // === Deterministic context short-circuits ===
      // When a workflow confirmation context is active, route directly to its handler
      // BEFORE calling the LLM. This ensures "yes"/"no"/numbers/revisions are always
      // intercepted reliably instead of depending on LLM tool selection.
      const shortCircuitResult = await this.tryWorkflowShortCircuit(message, context);
      if (shortCircuitResult !== undefined) {
        response = shortCircuitResult;
        this.lastBotAction.set(message.from, { action: 'workflow_confirm', timestamp: Date.now() });
        if (response) {
          await this.saveConversationExchange(message.from, message.text, response, 'workflow short-circuit');
        }
      }

      if (response === undefined) {
      // NOTE: Pre-LLM shortcuts removed in favor of enriched LLM tool definitions.
      // The LLM's delegate_message, manage_expenses, and check_inbox tools
      // now handle these patterns directly with better natural language understanding.
      // See tool-definitions.js for the enriched action enums and entity params.
      //
      // Removed shortcuts (Phase D — LLM-first migration):
      // 1. Team broadcast regex — now handled by delegate_message tool with target_name="team"
      // 2. Expense update/delete regex — now handled by manage_expenses with action=update/delete
      // Apr 30 2026 — visa-batch short-circuit pre-route removed.

      // ─── PENDING CLARIFICATION INTERCEPT ─────────────────────────────
      // If the bot just asked the user a clarifying question (e.g. "What
      // task should I assign?"), this user message IS the answer — not a
      // new command. Route directly back to the original tool with the
      // user's text filling the missing field, BYPASSING intent detection
      // and the chat fallback (which is where the hallucinations happened).
      // Runs BEFORE the agent loop: the loop doesn't know about tool-level
      // slot filling and would misroute the answer as a fresh command.
      // ────────────────────────────────────────────────────────────────
      if (response === undefined) {
        const clarificationReply = await this._tryPendingClarification(message, context);
        if (clarificationReply !== undefined) {
          response = clarificationReply;
          turnTrace.note(message.from, 'route', { route: 'pending_clarification' });
          // Persist the answer + outcome so the next follow-up has the
          // exchange in recentMessages (parity with the platform path).
          if (response) {
            await this.saveConversationExchange(message.from, message.text, response, 'clarification path');
          }
        }
      }

      // Fast-path bypass for clear bulk-email intent. Runs BEFORE the agent
      // loop: this deterministic guard exists because LLM routing misbuckets
      // exactly these messages, so it must not sit behind an LLM router.
      // When the shape is unambiguous (2+ valid emails + a send keyword),
      // skip every classifier.
      if (response === undefined) {
        const directBulk = this.shouldFastPathBulkEmail(message.text);
        if (directBulk) {
          logger.info(`[FastPath] bulk_email — ${directBulk.reason} (${directBulk.recipientCount} recipients)`);
          turnTrace.note(message.from, 'route', { route: 'bulk_email_fastpath' });
          response = await this.executeIntent('email_bulk', {}, message, context);
          this.lastBotAction.set(message.from, { action: 'email_bulk', timestamp: Date.now() });
        }
      }

      // ─────────────────────────────────────────────────────────────
      // AGENTIC LOOP — the default brain (kill switch: AGENTIC_MODE_ALL=false).
      //
      // Multi-step agent loop that can chain tools to handle complex
      // requests ("organize my morning", "find X and do Y to each").
      // A null return (loop did nothing, or failed BEFORE any tool ran)
      // leaves `response` undefined so single-shot detectIntent below
      // still runs — a null assignment here used to skip every fallback
      // AND the final send, silently dropping the message. Once a tool
      // has executed, _runAgenticTurn never returns null.
      // ─────────────────────────────────────────────────────────────
      if (response === undefined && this._shouldUseAgentLoop(message.from)) {
        const agentReply = await this._runAgenticTurn(message, context, recentMessages);
        if (agentReply) {
          response = agentReply;
          turnTrace.note(message.from, 'route', { route: 'agent_loop' });
          // The clarification hint (if any) informed this turn — consume it
          // so later unrelated messages aren't biased. Mirrors the
          // detectIntent path below, which rarely runs now.
          this.lastClarificationContext.delete(message.from);
          // Persist the agentic exchange (parity with the platform path) —
          // without this, the next follow-up arrives with no record of what
          // the agent just did or asked.
          await this.saveConversationExchange(message.from, message.text, agentReply, 'agentic path');
        }
      }

      // Unified LLM intent detection via OpenAI tool calling
      if (response === undefined) {
      const intentStartedAt = Date.now();
      const intent = await aiService.detectIntent(message.text, {
        userPhone: message.from,
        contextHints: await this.getIntentContextHints(message.from, message.text),
        recentMessages
      });
      turnTrace.note(message.from, 'intent_detected', {
        type: intent ? intent.type : null,
        toolName: intent ? (intent.toolName || null) : null,
        params: intent ? intent.params : null,
        latencyMs: Date.now() - intentStartedAt,
      });

      // The clarification context has served its purpose (it informed this
      // detection) — consume it so later unrelated messages aren't biased.
      // If THIS turn asks a new clarification, the clarify case re-sets it.
      this.lastClarificationContext.delete(message.from);

      if (intent) {
        logger.info(`Detected intent: ${intent.type} (tool: ${intent.toolName || 'n/a'})`);
        turnTrace.note(message.from, 'route', { route: `intent:${intent.type}` });
        response = await this.executeIntent(intent.type, intent.params || {}, message, context);
        turnTrace.note(message.from, 'intent_executed', { type: intent.type, hasResponse: !!response });
        this.lastBotAction.set(message.from, { action: intent.type, timestamp: Date.now() });
        // Persist the tool-path exchange to conversation history (fire and
        // forget). Chat turns are saved inside aiService.chat, but tool-routed
        // turns never were — so follow-ups ("change it to 6pm", "the 2nd one",
        // the answer to a clarifying question) arrived with NO record of what
        // the bot just did or asked. That gap was a root cause of short
        // replies being treated as brand-new unrelated queries.
        if (response) {
          await this.saveConversationExchange(message.from, message.text, response, 'intent path');
        }
      } else {
        // General chat — LLM decided no tool/action needed.
        {
        try {
          const autoMemResult = await memoryService.saveAutoMemories(message.from, message.text);
          if (autoMemResult.saved) logger.info(`Auto-saved ${autoMemResult.count} memories`);
        } catch (e) {
          logger.warn('Auto-memory save failed:', e.message);
        }

        // Detect if user mentioned a phone number + name in casual conversation
        // e.g. "Neha's number is +91XXXX", "neha ka number +91XXXX", "ye hai rahul ka no +91XXXX"
        const casualPhoneCtx = this._extractCasualPhoneAndName(message.text, message.from);
        if (casualPhoneCtx) {
          this.contactSaveContext.set(message.from, { ...casualPhoneCtx, timestamp: Date.now() });
        }

        // Ari patch (Phase 2): Pass a tool executor to aiService.chat so it
        // can run the Vercel AI SDK agentic loop when AGENTIC_CHAT_ENABLED=true.
        // If the flag is off, aiService.chat ignores the extra argument and
        // behaves exactly as before (plain LLM text reply, no tools).
        turnTrace.note(message.from, 'route', { route: 'chat_fallback' });
        response = await aiService.chat(message.from, message.text, context, {
          toolExecutor: this.executeIntent.bind(this),
          messageContext: message,
        });

        // Intercept CONTACT_LOOKUP:name pattern — resolve to actual phone number
        const lookupMatch = response && response.match(/CONTACT_LOOKUP:(\w+)/i);
        if (lookupMatch) {
          const lookupName = lookupMatch[1];
          try {
            const contactResult = await contactService.resolveNameToPhone(message.from, lookupName);
            if (contactResult.found && !contactResult.ambiguous) {
              response = `*${contactResult.name}*'s number: +${contactResult.phone}`;
            } else if (contactResult.found && contactResult.ambiguous) {
              const names = contactResult.matches.map(m => m.name).join(', ');
              response = `I found multiple contacts matching "${lookupName}": ${names}. Which one?`;
            } else {
              // Try memory as fallback
              const memPhone = await memoryService.findPhoneForName(message.from, lookupName);
              if (memPhone) {
                response = `*${lookupName}*'s number: +${memPhone}`;
              } else {
                response = `I don't have ${lookupName}'s number saved. Would you like to save it?`;
              }
            }
          } catch (e) {
            logger.warn(`Contact lookup interceptor failed: ${e.message}`);
            response = `I couldn't look up ${lookupName}'s number right now. Try again?`;
          }
        }

        // Append save-prompt to AI response if we detected a number in this message
        if (casualPhoneCtx) {
          const masked = contactService.maskPhone(casualPhoneCtx.phone);
          response += `\n\nShould I save *${casualPhoneCtx.name}*'s number (${masked}) to your contacts? _(Reply yes/no)_`;
        }

        this.lastBotAction.set(message.from, { action: 'general_chat', timestamp: Date.now() });
        } // end else-branch (quota allowed)
      }
      } // end if (response === undefined) — LLM intent detection
      } // end if (response === undefined) — short-circuit wasn't triggered


      if (response) {
        // Now await language detection (already running in background, likely finished)
        const langInfo = await langDetectionPromise;
        // Translate response if user's language is not English/Hinglish
        // Skip translation for intents where response contains user-provided text that shouldn't be altered
        const lastAction = this.lastBotAction.get(message.from);
        const skipTranslationIntents = new Set([
          'reminder_set', 'reminder_view', 'memory_save', 'memory_recall',
          'translate_text', 'workflow_confirm'
        ]);
        const shouldTranslate = langInfo.code !== 'en' && langInfo.code !== 'hi-Latn' && langInfo.code !== 'hi'
          && !skipTranslationIntents.has(lastAction?.action);
        if (shouldTranslate) {
          logger.info(`Translating response to ${langInfo.name} (${langInfo.code})`);
          response = await languageService.translateResponse(response, langInfo.code, langInfo.name);
        }
        turnTrace.note(message.from, 'response_sent', { response });
        await this.sendLongMessage(message.from, response);
      }
    } catch (error) {
      logger.error('Error:', error.message || JSON.stringify(error), { stack: error.stack?.split('\n').slice(0, 5).join(' | '), errorType: typeof error, keys: error ? Object.keys(error) : [] });
      try {
        if (typeof message !== 'undefined' && message?.from) await messagingService.send(message.from, "Something went wrong. Please try again.");
      } catch (_) {}
      if (typeof message !== 'undefined' && message?.from) {
        turnTrace.end(message.from, { outcome: 'error', error: error.message || String(error) });
      }
    } finally {
      // Flush the turn trace — every accepted turn produces exactly one
      // JSONL record, including branches that return mid-function.
      if (typeof message !== 'undefined' && message?.from) turnTrace.end(message.from, {});
      // Release the per-user processing lock — but only if THIS request
      // acquired it (early returns before acquireUserLock must not free a
      // lock held by another in-flight message from the same user).
      if (userLockAcquired && message?.from) this.releaseUserLock(message.from);
    }
  }

  // ========== UNIVERSAL PLATFORM MESSAGE HANDLER ==========
  // Entry point for Discord, Telegram, Slack, Google Chat messages
  async handlePlatformMessage(normalizedMessage) {
    // Validate userId — reject malformed platform IDs
    const validUserId = validateUserId(normalizedMessage.userId);
    if (!validUserId) {
      logger.warn(`[Platform] Rejected invalid userId: ${String(normalizedMessage.userId).substring(0, 30)}`);
      return;
    }

    const message = {
      from: validUserId,
      text: normalizedMessage.text || '',
      type: normalizedMessage.type,
      messageId: normalizedMessage.messageId,
      name: sanitizeInput(normalizedMessage.name, 100),
      platform: normalizedMessage.platform,
      source: normalizedMessage.source || normalizedMessage.platform || 'platform',
      image: normalizedMessage.image,
      document: normalizedMessage.document,
      documentSaveOnly: normalizedMessage.documentSaveOnly === true,
      documentBatchId: normalizedMessage.documentBatchId || null,
      audio: normalizedMessage.audio,
      signal: normalizedMessage.signal || null
    };

    // Sanitize text input (same as WhatsApp path — strips null bytes, control chars, truncates)
    if (message.text) {
      message.text = sanitizeInput(message.text, 5000).trim();
      if (!message.text) message.text = '';
    }

    // Sanitize document metadata if present
    if (message.document) {
      if (message.document.fileName) {
        message.document.fileName = sanitizeFilename(message.document.fileName);
      }
      if (message.document.mimeType) {
        message.document.mimeType = validateMimeType(message.document.mimeType) || 'application/octet-stream';
      }
    }

    if (!message.text && message.type === 'text') return;

    // Rate limiting
    if (this.isRateLimited(message.from)) return;

    // Duplicate protection
    if (message.messageId) {
      const dedupKey = `${message.platform}_${message.messageId}`;
      if (this.processedMessages.has(dedupKey)) return;
      this.processedMessages.set(dedupKey, true);
    }

    // Serialize the complete accepted platform turn. Rapid follow-ups must
    // not read stale history or race pending workflows.
    // Dashboard conversations are independent workspaces. Keep WhatsApp and
    // other unscoped channels serialized by phone, but isolate dashboard work
    // by its AsyncLocalStorage session ID so one chat cannot block another.
    const processingLockKey = conversationStateKey(message.from);
    await this.acquireUserLock(processingLockKey);
    try {
    if (message.signal?.aborted) return;

    // Turn trace — every accepted message gets one durable JSONL record
    // (logs/agent-turns.jsonl) describing which route handled it and why.
    turnTrace.begin(message.from, {
      channel: message.source || message.platform || 'platform',
      type: message.type,
      text: message.text,
      document: message.document ? (message.document.filename || message.document.fileName || 'document') : undefined,
    });

    // Image handling (Discord/Telegram/Slack send images with URLs)
    if (message.type === 'image' && message.image) {
      try {
        const messagingService = require('../services/messaging.service');
        const imageUrl = message.image.url || message.image.file_id;
        if (imageUrl) {
          const imageBuffer = await messagingService.downloadMedia(message.from, imageUrl);
          const result = await imageService.analyzeImageBuffer(imageBuffer, message.text);
          if (result) {
            this.imageContext.set(message.from, { context: result, timestamp: Date.now() });
            await this.sendLongMessage(message.from, result);
          }
        }
        return;
      } catch (error) {
        await messagingService.send(message.from, "Couldn't process that image. Try again?");
        return;
      }
    }

    // Dashboard and other platform uploads can provide an in-memory document
    // buffer. Process it through the same safe document path as WhatsApp.
    if (message.type === 'document' && message.document) {
      const documentName = message.document.filename || message.document.fileName || 'document';
      const caption = extractActionableCaption(message);
      const historyText = message.text || `Attached: ${documentName}`;
      turnTrace.note(message.from, 'route', { route: 'document', documentName, hasCaption: !!caption });
      // Actionable dashboard captions continue into the normal text turn,
      // which persists the user message exactly once. Save early only for a
      // true attachment-only turn; batch save-only calls stay invisible.
      if (message.source === 'dashboard' && !caption && !message.documentSaveOnly) {
        await aiService.saveMessage(message.from, 'user', historyText)
          .catch(e => logger.warn(`history save (dashboard document) failed: ${e.message}`));
      }
      const savedDocument = await this.handleDocument(message);
      if (message.documentSaveOnly) {
        turnTrace.end(message.from, { outcome: savedDocument ? 'completed' : 'error' });
        return savedDocument;
      }
      if (savedDocument && caption) {
        // The user attached a file AND said what to do with it. Saving the
        // file used to be the end of the turn — the instruction was silently
        // dropped. Acknowledge the save in history, then let the caption
        // continue through normal routing (agent loop / intent detection).
        turnTrace.note(message.from, 'document_caption_routed', { savedDocument });
        message.type = 'text';
        message.text = sanitizeInput(caption, 5000).trim();
        if (!message.text) {
          turnTrace.end(message.from, { outcome: 'completed' });
          return;
        }
      } else {
        if (message.source === 'dashboard') {
          const completion = savedDocument
            ? `Saved ${savedDocument}. What would you like me to do with it?`
            : `I couldn't finish processing ${documentName}. Please try a standard document format or a smaller file.`;
          await aiService.saveMessage(message.from, 'assistant', completion)
            .catch(e => logger.warn(`history save (dashboard document completion) failed: ${e.message}`));
          turnTrace.note(message.from, 'response_sent', { response: completion });
        }
        turnTrace.end(message.from, { outcome: savedDocument ? 'completed' : 'error' });
        return;
      }
    }

    // Audio handling for non-WhatsApp
    if (message.type === 'audio' && message.audio) {
      try {
        const messagingService = require('../services/messaging.service');
        const audioId = message.audio.file_id || message.audio.url;
        const transcription = await messagingService.transcribeAudio(message.from, audioId);
        if (transcription) {
          message.text = transcription;
        } else {
          await messagingService.send(message.from, "Couldn't transcribe that. Please type instead?");
          return;
        }
      } catch (error) {
        await messagingService.send(message.from, "Voice processing failed. Please type?");
        return;
      }
    }

    if (!message.text) return;

    const disabledGoogleReply = getDisabledGoogleFeatureReply(message.text);
    if (disabledGoogleReply) {
      turnTrace.note(message.from, 'response_sent', { response: disabledGoogleReply });
      turnTrace.end(message.from, { outcome: 'completed' });
      await messagingService.send(message.from, disabledGoogleReply);
      return;
    }

    // Unified LLM intent detection — same as WhatsApp flow
    if (await this.tryDeterministicCommand(message)) {
      turnTrace.note(message.from, 'route', { route: 'deterministic_command' });
      turnTrace.end(message.from, { outcome: 'completed' });
      return;
    }

    try {
      // Resolve primary userId for data access (linked accounts share data)
      const primaryUserId = await accountLinkService.getPrimaryUserId(message.from);
      const dataUserId = primaryUserId;

      // Deterministic approval fast-path (parity with handleMessage): an
      // armed confirmation resolves strict replies before any context load.
      const platformGateFastPath = require('../services/confirmation-gate.service');
      if (message.type === 'text' && platformGateFastPath.hasPending(message.from)) {
        let gateReply = null;
        try {
          gateReply = await platformGateFastPath.tryResolve(message.from, message.text);
        } catch (gateError) {
          logger.warn(`confirmation fast-path failed (non-fatal): ${gateError.message}`);
        }
        message._gateFastPathDone = true;
        if (gateReply !== null) {
          turnTrace.note(message.from, 'route', { route: 'confirmation_fast_path' });
          this.lastBotAction.set(message.from, { action: 'workflow_confirm', timestamp: Date.now() });
          await this.saveConversationExchange(message.from, message.text, gateReply, 'confirmation fast-path');
          turnTrace.note(message.from, 'response_sent', { response: gateReply });
          await this.sendLongMessage(message.from, gateReply);
          return;
        }
      }

      const lang = this.detectLanguage(message.text);
      message.lang = lang;

      // Fire AI language detection (non-blocking)
      const langDetectionPromise = this.startLanguageDetection(message.text, message.from);

      // Clean up expired contexts
      this.cleanExpiredContexts(message.from);

      // Timezone and recent history are independent — one wave, not three
      // serialized round-trips.
      const [userTimezone, recentMessages] = await Promise.all([
        timezoneService.getUserTimezone(dataUserId),
        aiService.getRecentContext(message.from, 15),
      ]);
      const context = await this.getContext(message.from, userTimezone);
      context.lang = lang;
      context.userLanguage = await this.resolveUserLanguage(langDetectionPromise, message.from, lang);

      // === Deterministic context short-circuits (platform parity with handleMessage) ===
      const shortCircuitResult = await this.tryWorkflowShortCircuit(message, context);
      if (shortCircuitResult !== undefined) {
        let response = shortCircuitResult;
        turnTrace.note(message.from, 'route', { route: 'workflow_short_circuit' });
        this.lastBotAction.set(message.from, { action: 'workflow_confirm', timestamp: Date.now() });
        if (response) {
          await this.saveConversationExchange(message.from, message.text, response, 'platform workflow short-circuit');
        }
        if (context.userLanguage && context.userLanguage.code !== 'en' && context.userLanguage.code !== 'hi-Latn' && context.userLanguage.code !== 'hi') {
          response = await languageService.translateResponse(response, context.userLanguage.code, context.userLanguage.name);
        }
        turnTrace.note(message.from, 'response_sent', { response });
        await this.sendLongMessage(message.from, response);
        return;
      }

      // Tool-level slot filling must intercept BEFORE the agent loop — the
      // loop would treat the user's answer as a fresh command. (Parity with
      // the WhatsApp path; this was missing here while agentic mode was
      // already live on dashboard/desktop.)
      const clarificationReply = await this._tryPendingClarification(message, context);
      if (clarificationReply !== undefined) {
        // The pending clarification CONSUMED this message (undefined means
        // "nothing pending"). Even a falsy reply must end the turn here —
        // falling through would re-route the user's answer as a fresh
        // command after the tool already executed.
        turnTrace.note(message.from, 'route', { route: 'pending_clarification' });
        if (!clarificationReply) return;
        let response = clarificationReply;
        await this.saveConversationExchange(message.from, message.text, response, 'platform clarification path');
        if (context.userLanguage && context.userLanguage.code !== 'en' && context.userLanguage.code !== 'hi-Latn' && context.userLanguage.code !== 'hi') {
          response = await languageService.translateResponse(response, context.userLanguage.code, context.userLanguage.name);
        }
        turnTrace.note(message.from, 'response_sent', { response });
        await this.sendLongMessage(message.from, response);
        return;
      }

      // Route enabled platform conversations through the multi-step harness.
      // The deterministic short-circuits above remain the fast path.
      let agentResponse = await this._tryAgenticPlatformTurn(message, context, recentMessages);
      if (message.signal?.aborted && !agentResponse) {
        turnTrace.end(message.from, { outcome: 'cancelled' });
        return;
      }
      if (agentResponse) {
        turnTrace.note(message.from, 'route', { route: 'agent_loop' });
        // Consume the clarification hint (mirrors the detectIntent path,
        // which rarely runs now that the loop is the default).
        this.lastClarificationContext.delete(message.from);
        await this.saveConversationExchange(message.from, message.text, agentResponse, 'platform agent path');
        this.lastBotAction.set(message.from, { action: 'agent_loop', timestamp: Date.now() });
        if (context.userLanguage && context.userLanguage.code !== 'en' && context.userLanguage.code !== 'hi-Latn' && context.userLanguage.code !== 'hi') {
          agentResponse = await languageService.translateResponse(agentResponse, context.userLanguage.code, context.userLanguage.name);
        }
        turnTrace.note(message.from, 'response_sent', { response: agentResponse });
        await this.sendLongMessage(message.from, agentResponse);
        return;
      }

      // Unified LLM intent detection via OpenAI tool calling
      const intentStartedAt = Date.now();
      const intent = await aiService.detectIntent(message.text, {
        userPhone: message.from,
        contextHints: await this.getIntentContextHints(message.from, message.text),
        recentMessages
      });
      turnTrace.note(message.from, 'intent_detected', {
        type: intent ? intent.type : null,
        toolName: intent ? (intent.toolName || null) : null,
        params: intent ? intent.params : null,
        latencyMs: Date.now() - intentStartedAt,
      });

      // Consume the clarification context (see handleMessage).
      this.lastClarificationContext.delete(message.from);

      if (intent) {
        turnTrace.note(message.from, 'route', { route: `intent:${intent.type}` });
        let response = await this.executeIntent(intent.type, intent.params || {}, message, context);
        turnTrace.note(message.from, 'intent_executed', { type: intent.type, hasResponse: !!response });
        this.lastBotAction.set(message.from, { action: intent.type, timestamp: Date.now() });
        if (response) {
          // Persist the tool-path exchange (see handleMessage) so follow-ups
          // on platform chats have conversational context too.
          await this.saveConversationExchange(message.from, message.text, response, 'platform intent path');
          // Translate if needed
          if (context.userLanguage && context.userLanguage.code !== 'en' && context.userLanguage.code !== 'hi-Latn' && context.userLanguage.code !== 'hi') {
            response = await languageService.translateResponse(response, context.userLanguage.code, context.userLanguage.name);
          }
          turnTrace.note(message.from, 'response_sent', { response });
          await this.sendLongMessage(message.from, response);
          return;
        }
      }

      // General AI chat
      // Reaching here means NO tool was selected (or the handler returned
      // nothing) — the single most common cause of "Ari refused to act".
      turnTrace.note(message.from, 'route', { route: 'chat_fallback', intentWasNull: !intent });
      let response = await aiService.chat(message.from, message.text, context);
      if (response && context.userLanguage && context.userLanguage.code !== 'en' && context.userLanguage.code !== 'hi-Latn' && context.userLanguage.code !== 'hi') {
        response = await languageService.translateResponse(response, context.userLanguage.code, context.userLanguage.name);
      }
      turnTrace.note(message.from, 'response_sent', { response });
      await this.sendLongMessage(message.from, response);
    } catch (error) {
      logger.error(`Platform handler error (${message.platform}):`, error);
      turnTrace.note(message.from, 'error', { message: error.message });
      const apology = "Something went wrong. Please try again.";
      if (message.source === 'dashboard') {
        // The WhatsApp send below is suppressed for dashboard turns, so the
        // error reply must be persisted to chat history or the desktop user
        // sees pure silence after a failed turn.
        await aiService.saveMessage(message.from, 'assistant', apology)
          .catch(e => logger.warn(`error-reply persist failed: ${e.message}`));
        turnTrace.note(message.from, 'response_sent', { response: apology, errorReply: true });
      }
      try { await messagingService.send(message.from, apology); } catch (_) {}
      turnTrace.end(message.from, { outcome: 'error', error: error.message });
    } finally {
      // Flush whatever remains — every accepted platform turn produces
      // exactly one JSONL record even on paths that return early.
      turnTrace.end(message.from, {});
    }
    } finally {
      this.releaseUserLock(processingLockKey);
    }
  }

  // ========== TEAM REMINDER BROADCAST ==========
  async handleTeamReminder(message, userTimezone) {
    // Extract specific team name if mentioned ("stitch boat team", "design team", etc.)
    const teamName = taskService.resolveTeamNameFromText(message.text);

    const members = await taskService.getTeamMembers(message.from, teamName);
    if (!members || members.length === 0) {
      if (teamName) {
        const allTeams = await taskService.getTeamNames(message.from);
        if (allTeams.length === 0) {
          return `No teams yet.\n\nCreate one:\n"add Rahul +919876543210 to stitch boat team"`;
        }
        const teamList = allTeams.map(t => `- ${t.team_name} (${t.member_count} members)`).join('\n');
        return `No team named *"${teamName}"* found.\n\nYour teams:\n${teamList}`;
      }
      return `No team members yet.\n\nAdd one first:\n"add Rahul +919876543210 to stitch boat team"`;
    }

    // Strip team reference from text so AI parses time + message correctly
    const cleanedText = message.text
      .replace(/\bsend\s+(?:a\s+)?(?:reminder|message)\s+to\s+(?:the\s+)?(?:[a-zA-Z\s]+?\s+)?team\b/gi, 'remind me')
      .replace(/\bremind\s+(?:the\s+)?(?:[a-zA-Z\s]+?\s+)?team\b/gi, 'remind me')
      .replace(/\b(?:to|for)\s+(?:the\s+)?(?:[a-zA-Z\s]+?\s+)?team\b/gi, '')
      .replace(/\b[a-zA-Z\s]+?\s+team\s+ko\b/gi, '')
      .replace(/\s+/g, ' ').trim();

    // Deduplicate members before any async work
    const uniqueMembers = [...new Map(members.map(m => [m.member_phone, m])).values()];
    const label = teamName ?`*${teamName} team*` : '*your team*';

    // ── Recurring team reminders (daily standup, weekly meeting, etc.) ──
    if (reminderService.isRecurringRequest(cleanedText)) {
      const successList = [], failList = [];
      for (const m of uniqueMembers) {
        try {
          await reminderService.parseRecurringReminder(message.from, cleanedText, userTimezone, m.member_phone);
          successList.push(m.member_name);
        } catch (e) {
          logger.error(`Recurring team reminder failed for ${m.member_name}: ${e.message}`);
          failList.push(m.member_name);
        }
      }
      const patternHint = /every\s+day|daily/i.test(cleanedText) ? 'Daily'
        : /every\s+week|weekly/i.test(cleanedText) ? 'Weekly' : 'Recurring';
      let response = `${patternHint} reminder set for ${label} — ${successList.length} member${successList.length !== 1 ? 's' : ''}!\n\n`;
      response += `${successList.join(', ')}`;
      if (failList.length) response += `\nFailed: ${failList.join(', ')}`;
      return response;
    }

    // ── One-time team reminder ──
    const parsed = await reminderService.parseReminderTimeAndMessage(message.from, cleanedText, userTimezone);
    if (!parsed.success) {
      return `Couldn't understand the reminder time.\n\nTry:\n- "Remind the stitch boat team at 5pm: we have a meeting"\n- "Schedule daily standup for design team at 9am"`;
    }

    const reminderMsg = parsed.reminderMessage;
    const reminderTime = new Date(parsed.reminderTime);

    const successList = [], failList = [];
    for (const m of uniqueMembers) {
      try {
        await reminderService.createReminder(message.from, reminderMsg, reminderTime, m.member_phone);
        successList.push(m.member_name);
      } catch (e) {
        logger.error(`Team reminder failed for ${m.member_name}: ${e.message}`);
        failList.push(m.member_name);
      }
    }

    const clockTime = reminderTime.toLocaleString('en-IN', {
      timeZone: userTimezone, hour: 'numeric', minute: '2-digit', hour12: true
    }).toLowerCase();
    const diffMins = Math.round((reminderTime - new Date()) / 60000);
    const timeText = diffMins < 60 ?`in ${diffMins} min (${clockTime})` : clockTime;

    let response = `Reminder set for ${label} — ${successList.length} member${successList.length !== 1 ? 's' : ''}!\n\n`;
    response += `"${reminderMsg}"\n`;
    response += `${timeText}\n\n`;
    response += `${successList.join(', ')}`;
    if (failList.length > 0) response += `\n\nFailed: ${failList.join(', ')}`;

    return response;
  }

  // ========== REMINDER WITH RECURRING SUPPORT ==========
  async handleReminder(message, userTimezone = 'Asia/Kolkata', intentParams = null) {
    const lang = message.lang || this.detectLanguage(message.text);
    const templates = this.getTemplates(lang);

    // Check for team reminder before individual parsing.
    //
    // Apr 28 2026 — RC7 fix: trust the LLM's target_name when provided.
    // The previous regexes treated phrases like "for team standup" as a
    // team-reminder signal, even when the LLM had correctly identified it
    // as a regular self-reminder with reminder_message="team standup".
    // We now ONLY use regex as a FALLBACK when the LLM didn't provide
    // intentParams (legacy code paths). When intentParams exist, trust
    // target_name === 'team' as the sole signal.
    //
    // We also negative-lookahead "team standup/meeting/call/sync/etc."
    // since those are noun-compounds, not team names.
    const TEAM_NOUN_COMPOUNDS = /(?:standup|meeting|call|sync|huddle|review|catchup|catch[- ]up|chat|announcement|discussion|brainstorm)\b/i;
    const looksLikeNounCompound = (txt) => {
      const m = txt.match(/\bteam\s+(\w+)/i);
      return m && TEAM_NOUN_COMPOUNDS.test(m[1]);
    };

    let isTeamTarget;
    if (intentParams) {
      // LLM provided structured params — trust target_name
      isTeamTarget = intentParams.target_name === 'team';
    } else {
      // Legacy / no LLM params — use regex but skip noun-compound cases
      isTeamTarget = (
        /\b(send\s+)?(reminder|remind)\s+(to\s+)?(?:the\s+)?(?:\w+\s+)*team\b/i.test(message.text)
        || /\b(to|for|in)\s+(?:the\s+)?(?:\w+\s+)*team\b/i.test(message.text)
        || /\b\w+\s+team\s+ko\b/i.test(message.text)
        || /\bteam\s+ko\b/i.test(message.text)
      ) && !looksLikeNounCompound(message.text);
    }
    if (isTeamTarget) {
      return await this.handleTeamReminder(message, userTimezone);
    }

    // Pass last saved contact for contextual references
    const lastContact = this.lastSavedContact.get(message.from);
    const recentContact = lastContact && (Date.now() - lastContact.timestamp) < 30 * 60 * 1000
      ? lastContact : null;

    const result = await reminderService.parseAndCreateReminder(message.from, message.text, userTimezone, recentContact, intentParams);

    if (!result.success) {
      // Handle special cases from contact resolution
      if (result.needsContactClarification) {
        const names = result.matches.map((m, i) =>
`${i + 1}. ${m.name} (${contactService.maskPhone(m.phone)})`
        ).join('\n');
        return `Multiple contacts match "${result.targetName}":\n${names}\n\nWhich one? Say the full name.`;
      }
      if (result.needsPhoneNumber) {
        return `I don't have a phone number for "${result.targetName}".\n\nSave it first:\n"Save ${result.targetName}'s number: +91XXXXXXXXXX"`;
      }
      if (result.needsClarification) {
        return "Remind you about what? Tell me what you'd like to be reminded about.\n\nExample: \"Remind me in 30 minutes to call mom\"";
      }
      // Past-date: surface a specific message so the user knows WHY their
      // reminder didn't land — until May 19 2026 the bot returned the
      // generic "couldn't understand the time" template even when the
      // parsed time was clear but already in the past.
      if (result.reason === 'past_date') {
        return lang === 'hindi'
          ? "Wo time aur date toh past mein hai 🙂\n\nFuture mein koi time bhej, jaise: \"kal subah 9 baje\" ya \"30 min mein\"."
          : "That time has already passed. 🙂\n\nTry a future time, like:\n- \"tomorrow at 9am\"\n- \"in 30 minutes\"\n- \"next Friday at 2pm\"";
      }
      return templates.reminderError;
    }

    // Handle recurring reminder response
    if (result.isRecurring) {
      const patternText = this.formatRecurrencePattern(result.pattern, result.days, result.exceptDays, lang);
      const timeText = this.formatReminderTime(result.time, userTimezone, lang);

      let response;
      const template = templates.recurringSet[Math.floor(Math.random() * templates.recurringSet.length)];
      response = template
        .replace('{message}', result.message)
        .replace('{pattern}', patternText)
        .replace('{time}', timeText);

      // Add target info for reminders to other people
      if (result.targetPhone && result.targetPhone !== message.from) {
        const recipientDisplay = await this.getRecipientDisplay(message.from, result.targetPhone);
        response += `\n\nTo: ${recipientDisplay}`;
      }
      return response;
    }

    // Handle one-time reminder response
    const reminderDate = new Date(result.time);
    const now = new Date();
    const diffMs = reminderDate - now;
    const diffMins = Math.round(diffMs / 60000);

    const clockTime = reminderDate.toLocaleString('en-IN', {
      timeZone: userTimezone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    }).toLowerCase();

    const tomorrow = new Date(now.getTime() + 86400000);
    const isTomorrow = tomorrow.toDateString() === reminderDate.toDateString();

    const dayName = reminderDate.toLocaleDateString('en-IN', { timeZone: userTimezone, weekday: 'long' });
    const dateStr = reminderDate.toLocaleDateString('en-IN', { timeZone: userTimezone, day: 'numeric', month: 'short' });

    const timeText = templates.timeFormat(diffMins, clockTime, isTomorrow, dayName, dateStr);

    // Check if reminder is for someone else
    if (result.targetPhone && result.targetPhone !== message.from) {
      // Enhanced confirmation with contact info
      const recipientDisplay = await this.getRecipientDisplay(message.from, result.targetPhone);
      const senderName = await this.getSenderName(message.from, message.name);
      const fullDateStr = reminderDate.toLocaleString('en-IN', {
        timeZone: userTimezone,
        day: 'numeric', month: 'short', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true
      });
      let response = `Reminder scheduled\n\n`;
      response += `To: ${recipientDisplay}\n`;
      response += `When: ${fullDateStr} (${timeText})\n`;
      response += `Message: "${result.message}"\n\n`;
      response += `_${recipientDisplay.split(' (')[0]} will receive: "*${senderName} sent you a reminder:*\n${result.message}"_\n\n`;

      // 24h-window note removed by product decision: users don't want to see
      // internal delivery-mechanism messaging (free-form vs template). The
      // underlying send logic still falls back to approved templates outside
      // the 24h window — that's invisible to both sender and recipient.
      return response;
    }

    // Record a structured pointer to the just-created reminder so that any
    // immediate follow-up ("change the time", "cancel that one", "the rohan
    // reminder") can be unambiguously resolved by the LLM via context hints.
    if (result.reminderId) {
      this.recordLastAction(message.from, {
        action: 'reminder_create',
        entityType: 'reminder',
        entityId: result.reminderId,
        label: result.message,
        targetPhone: result.targetPhone || null,
        at: result.time ? new Date(result.time).toISOString() : null,
        ambiguousTimeResolved: result.ambiguousTimeResolved || null
      });
    }

    const template = templates.reminderSet[Math.floor(Math.random() * templates.reminderSet.length)];
    let response = template.replace('{message}', result.message).replace('{time}', timeText);

    // If the user said "today at X" and X was already hours in the past,
    // surface the rollforward explicitly instead of silently scheduling
    // for tomorrow. Gives the user a chance to correct ("oh I meant PM")
    // right after the confirmation.
    if (result.silentRollForward) {
      const r = result.silentRollForward;
      response += `\n\n_Note: ${r.rolledFrom} was ${r.hoursPast}h ago — scheduled for ${r.rolledTo}. Reply "no, I meant PM" to change._`;
    }

    return response;
  }

  /**
   * Record a structured reference to Ari's most recent side-effecting action.
   * This powers coreference resolution in follow-up turns: when a user says
   * "change the time" right after we created a reminder, we already know
   * *which* reminder they mean because we stored its id + label here.
   *
   * All fields after `action` are optional — handlers pass what they have.
   */
  recordLastAction(userPhone, info = {}) {
    if (!userPhone || !info.action) return;
    const record = { ...info, timestamp: Date.now() };

    // Always mark lastBotAction (routing hint — cheap, overwritable).
    this.lastBotAction.set(userPhone, { action: info.action, timestamp: record.timestamp });

    // If this action created/touched a concrete entity, also write the
    // structured ref to the SEPARATE lastEntityRef map. That map is
    // never touched by agentic-turn / general-chat bookkeeping, so
    // coreference ("the one we just did") keeps working across turns.
    if (info.entityType && info.entityId) {
      this.lastEntityRef.set(userPhone, record);
    }
  }

  /**
   * Decide whether this user's message should be processed via the agentic
   * multi-step loop (Phase 1) instead of single-shot intent detection.
   *
   * Three opt-in mechanisms (checked in priority order):
   *   1. AGENTIC_MODE_ALL=true            (everyone)
   *   2. AGENTIC_MODE_PHONES=a,b,c        (specific numbers, comma-separated)
   *   3. [future] users.agentic_mode DB flag
   *
   * Default: off — safe rollout behind a flag.
   */
  /**
   * Tool-level slot filling: if the bot just asked for a missing field
   * ("What task should I assign?"), the user's next message IS the answer —
   * not a new command. Routes it straight back to the original tool with
   * the missing field filled, bypassing intent detection AND the agent
   * loop (both would misroute the answer as a fresh request).
   * Returns a response string when a pending clarification consumed the
   * message, else undefined.
   */
  async _tryPendingClarification(message, context) {
    const pending = this.pendingClarificationContext.get(message.from);
    if (!(pending && pending.tool && pending.awaitingField)) return undefined;

    // Universal cancel keywords — clear pending state and fall through
    const cancelRe = /^(cancel|nevermind|never mind|skip|stop|forget it|leave it|ignore)\b/i;
    if (cancelRe.test(String(message.text).trim())) {
      this.pendingClarificationContext.delete(message.from);
      logger.info(`[PendingClarification] User cancelled pending ${pending.tool}/${pending.action}`);
      return "OK, cancelled. What would you like to do?";
    }

    logger.info(`[PendingClarification] Routing reply back to ${pending.tool}/${pending.action}, filling ${pending.awaitingField} with: "${String(message.text).slice(0, 80)}"`);
    // Fill the missing field with the user's message text.
    const filledParams = {
      ...pending.params,
      [pending.awaitingField]: message.text,
      full_text: message.text,
    };
    // Clear the pending entry BEFORE re-execution so a fresh "missing
    // field" inside the handler can set a new pending entry without
    // collision. If the handler needs more info, it'll set a fresh one.
    this.pendingClarificationContext.delete(message.from);
    try {
      const response = await this.executeIntent(pending.tool, filledParams, message, context);
      this.lastBotAction.set(message.from, { action: pending.tool, timestamp: Date.now() });
      return response;
    } catch (clarifyErr) {
      logger.error(`[PendingClarification] Re-execution of ${pending.tool} failed: ${clarifyErr.message}`);
      return "Something went wrong while finishing that — please try again from the start.";
    }
  }

  _shouldUseAgentLoop(userPhone) {
    try {
      // Default ON — the agent loop is the primary brain. Kill switch:
      // AGENTIC_MODE_ALL=false (also accepts 0/off/no, trimmed) reverts
      // everyone to single-shot intent detection (AGENTIC_MODE_PHONES then
      // re-enables specific numbers). An incident rollback must not fail on
      // a trailing space or a different falsy spelling.
      const allFlag = String(process.env.AGENTIC_MODE_ALL ?? 'true').trim().toLowerCase();
      if (!['false', '0', 'off', 'no'].includes(allFlag)) return true;
      const phones = (process.env.AGENTIC_MODE_PHONES || '')
        .split(',').map(p => p.trim()).filter(Boolean);
      if (phones.length > 0 && userPhone && phones.includes(userPhone)) return true;
    } catch (_) {}
    return false;
  }

  async _tryAgenticPlatformTurn(message, context, recentMessages) {
    if (!this._shouldUseAgentLoop(message.from)) return null;
    return this._runAgenticTurn(message, context, recentMessages);
  }

  /**
   * Run one user turn through the agentic loop. Reuses the existing
   * tool registry and executeIntent handlers — the loop just orchestrates
   * multiple steps and feeds each tool's result back into the next decision.
   *
   * Returns a string to send to the user, OR null if the loop produced no
   * text (in which case the caller falls back to single-shot detection).
   */
  async _runAgenticTurn(message, context, recentMessages) {
    message.agentRunStatus = null;
    message.agentRunErrorCode = null;
    let run = null;
    // Mirrors the codex branch's toolCallsAttempted: once ANY tool has run,
    // falling back to single-shot would re-execute the whole message and
    // duplicate side effects — never allowed. Declared here (not in the try)
    // so the catch can read it.
    let toolsExecuted = 0;
    try {
      const { runAgentLoop } = require('../services/agent-loop.service');
      const { getIntentForTool } = require('../services/tool-definitions');
      const {
        listAgentToolContracts,
        prepareAgentToolInvocation,
        renderConfirmationPreview,
      } = require('../services/agent-tool-contracts.service');
      const { agentRunService } = require('../services/agent-run.service');

      // The run insert, context hints, background block, and cross-provider
      // summary are independent — start them together instead of serializing
      // four round-trips in front of every model call.
      const runPromise = agentRunService.startRun({
        userPhone: message.from,
        prompt: message.text,
        source: message.source || message.platform || 'unknown',
      });
      const contextHintsPromise = this.getIntentContextHints(message.from, message.text);
      const backgroundPromise = (async () => {
        try {
          return await require('../services/context-builder.service')
            .build(message.from, message.text);
        } catch (_) { return ''; }
      })();
      // Provider-owned threads remain isolated, while this Postgres-backed
      // summary lets a fresh Codex thread and a fresh Agno/Gemini session
      // inherit the same facts.
      const summaryPromise = (async () => {
        try {
          const { agentConversationSummaryService } = require('../services/agent-conversation-summary.service');
          return await agentConversationSummaryService.getContext({
            userPhone: message.from,
            sessionId: currentChatSession()?.sessionId || null,
            provider: 'shared',
          });
        } catch (summaryError) {
          logger.warn({ err: summaryError.message }, 'Cross-provider summary could not be attached');
          return null;
        }
      })();
      run = await runPromise;
      const runEventBus = require('../services/run-event-bus.service');
      const onEvent = (event) => {
        // Live push first — the dashboard streams from the in-process bus.
        // High-frequency text deltas are bus-only; everything else is also
        // persisted to agent_run_events for the durable activity feed.
        runEventBus.publish(message.from, {
          runId: run.runId,
          type: event.type,
          step: Number.isInteger(event.step) ? event.step : null,
          toolName: event.toolName || null,
          summary: event.summary || '',
          payload: event.payload || {},
        });
        if (String(event.type || '').startsWith('assistant.delta')) return Promise.resolve();
        return agentRunService.recordEvent({
          runId: run.runId,
          userPhone: message.from,
          type: event.type,
          step: Number.isInteger(event.step) ? event.step : null,
          toolName: event.toolName || null,
          summary: event.summary || '',
          payload: event.payload || {},
        });
      };

      let outcome = null;
      const contextHints = await contextHintsPromise;
      const backgroundBlock = [await backgroundPromise, await summaryPromise]
        .filter(Boolean).join('\n\n').slice(0, 30_000);
      // One canonical catalog generates the OpenAI-compatible definitions
      // consumed by every runtime. The model sees atomic typed fields; the
      // legacy controller text bridge is private to executeFn below.
      const tools = listAgentToolContracts().map(({ name, description, inputSchema }) => ({
        type: 'function',
        function: { name, description, parameters: inputSchema },
      }));

      // One executor for every model runtime. It is the only bridge from a
      // model-selected tool name into Ari's existing CRM/business handlers.
      const executeFn = async (toolName, args, executionContext = {}) => {
        if (message.signal?.aborted || executionContext.signal?.aborted) {
          const cancelled = new Error('The agent turn was cancelled before this tool started.');
          cancelled.code = 'agent_cancelled';
          throw cancelled;
        }
        const invocation = prepareAgentToolInvocation(toolName, args, {
          originalText: message.text,
        });
        if (!invocation.validation.success) {
          const { normalizeToolResult } = require('../services/tool-result.service');
          return normalizeToolResult({
            status: 'failure',
            error: {
              code: 'invalid_tool_arguments',
              category: 'validation',
              retryable: true,
              message: String(invocation.validation.error.message).slice(0, 800),
            },
            user_summary: `${toolName} needs corrected inputs.`,
          }, { toolName });
        }
        toolsExecuted++;
        const intentType = getIntentForTool(toolName);
        const handlerMessage = {
          ...message,
          text: invocation.messageText,
          agentRunId: run?.runId || null,
          agentToolCallId: executionContext.callId || null,
        };
        const executeHandler = (confirmedByPolicy = false) => this.executeIntent(
          intentType,
          invocation.handlerArgs,
          confirmedByPolicy ? { ...handlerMessage, signal: null } : handlerMessage,
          {
            ...context,
            agentExecution: {
              ...executionContext,
              ...(confirmedByPolicy ? { signal: null } : {}),
              toolName,
              toolEffect: invocation.effect,
              confirmationMode: invocation.confirmationMode,
              requiresConfirmation: invocation.requiresConfirmation,
              confirmedByPolicy,
            },
          },
        );

        if (invocation.confirmationMode === 'central' && executionContext.confirmedByPolicy !== true) {
          const confirmationGate = require('../services/confirmation-gate.service');
          const preview = renderConfirmationPreview(toolName, invocation.validation.data);
          const prompt = await confirmationGate.pend(message.from, {
            actionType: `agent_tool:${toolName}`,
            summary: preview,
            ctx: {
              toolName,
              effect: invocation.effect,
              callId: executionContext.callId || null,
              runId: run?.runId || null,
            },
            execute: () => executeHandler(true),
          });
          const { normalizeToolResult } = require('../services/tool-result.service');
          return normalizeToolResult({
            status: 'waiting_approval',
            data: { pending: true, preview },
            user_summary: prompt,
          }, { toolName });
        }

        const approvalBefore = this.snapshotAgentApprovalState(message.from);
        const hadPendingClarification = this.pendingClarificationContext.has(message.from);
        const raw = await executeHandler(executionContext.confirmedByPolicy === true);
        const approvalAfter = this.snapshotAgentApprovalState(message.from);
        if (this.didAgentCreateApproval(approvalBefore, approvalAfter)) {
          const { normalizeToolResult } = require('../services/tool-result.service');
          return normalizeToolResult({
            status: 'waiting_approval',
            data: {
              pending: true,
              preview: typeof raw === 'string' ? raw.slice(0, 4000) : null,
            },
            user_summary: typeof raw === 'string'
              ? raw
              : 'This action is waiting for your approval.',
          }, { toolName });
        }
        const nowPendingClarification = this.pendingClarificationContext.has(message.from);
        if (toolName === 'request_clarification' || (!hadPendingClarification && nowPendingClarification)) {
          return {
            status: 'waiting_input',
            data: { pending: true },
            user_summary: typeof raw === 'string' ? raw : 'I need one more detail before I can continue.',
          };
        }
        // The legacy CRM handlers predate the agent runtime and return a mix
        // of strings and objects. Normalize exactly once at this shared
        // executor boundary so every model runtime receives the same explicit
        // success/failure/waiting contract.
        const { normalizeToolResult } = require('../services/tool-result.service');
        const normalized = normalizeToolResult(raw, { toolName });
        // Stop raced a mutation that had already committed: the result stands
        // (it happened), but the annotation lets the post-run classification
        // report an honest partial instead of a clean completion.
        if ((message.signal?.aborted || executionContext.signal?.aborted)
          && ['reversible_write', 'external_write', 'destructive', 'mixed'].includes(invocation.effect)) {
          normalized.meta = { ...(normalized.meta || {}), aborted_after_completion: true };
        }
        return normalized;
      };

      const desktopAi = require('../services/desktop-ai-preferences.service');
      const desktopPreferences = desktopAi.readPreferences();
      const selectedProvider = desktopPreferences.provider;
      // Codex App Server remains an explicitly selected alternate runtime.
      // Ari itself no longer takes the Ari -> App Server -> loopback gateway
      // detour; its primary path below is Agno over native Gemini or
      // OpenRouter. The direct OpenRouter SDK remains a compatibility path.
      if (selectedProvider === 'codex' && desktopAi.shouldUseSharedAppServer()) {
        try {
          const { runCodexAgent } = require('../services/codex-agent.service');
          await onEvent({
            type: 'run.progress',
            step: 0,
            summary: `Codex is understanding the request (${desktopPreferences.model || 'auto'} model mode)`,
            payload: { provider: selectedProvider, runtime: 'codex-app-server' },
          });
          outcome = await runCodexAgent({
            userMessage: message.text,
            userPhone: message.from,
            sessionId: currentChatSession()?.sessionId || null,
            userTimezone: context?.userTimezone || 'Asia/Kolkata',
            recentMessages,
            contextHints,
            backgroundBlock,
            runId: run.runId,
            onEvent,
            signal: message.signal || currentChatSession()?.signal || null,
          });
        } catch (codexError) {
          const toolCallsAttempted = Number(codexError.toolCallsAttempted || 0);
          const checkpoint = codexError.partialOutcome;
          if (checkpoint?.status === 'partial' && Array.isArray(checkpoint.toolResults)) {
            outcome = checkpoint;
            await onEvent({
              type: 'run.partial',
              step: checkpoint.steps || toolCallsAttempted,
              summary: String(checkpoint.text || 'Ari preserved completed work after an interruption').slice(0, 500),
              payload: {
                code: checkpoint.errorCode || codexError.code || 'app_server_partial',
                retryable: checkpoint.meta?.safeToResumeAfterInterruption === true,
                toolCallsAttempted,
                provider: selectedProvider,
                checkpointed: true,
              },
            });
          } else {
            if (codexError.code === 'agent_cancelled' && toolCallsAttempted === 0) throw codexError;
            const cancelledUnknown = codexError.code === 'agent_cancelled_partial';
            const cancelledAfterTool = codexError.code === 'agent_cancelled' && toolCallsAttempted > 0;
            if (cancelledUnknown || toolCallsAttempted > 0) {
              const errorCode = cancelledUnknown
                ? 'cancelled_tool_unknown'
                : cancelledAfterTool ? 'cancelled_after_tool' : 'app_server_partial';
              await onEvent({
                type: 'run.partial',
                summary: cancelledUnknown
                  ? 'The run was stopped while an Ari action was in progress; its outcome is unknown'
                  : cancelledAfterTool
                    ? 'The run was stopped after an Ari action had completed'
                    : 'The shared agent runtime stopped after an Ari action had started',
                payload: { code: errorCode, retryable: false, toolCallsAttempted, provider: selectedProvider },
              });
              await agentRunService.finishRun({
                runId: run.runId,
                status: 'partial',
                steps: toolCallsAttempted,
                model: `${selectedProvider}:${desktopPreferences.model || 'auto'}`,
                errorCode,
              });
              message.agentRunStatus = 'partial';
              message.agentRunErrorCode = errorCode;
              return cancelledUnknown
                ? 'I stopped the run while an action was in progress, so I cannot safely claim whether that action completed. I did not replay it. Check the activity or CRM state before continuing.'
                : cancelledAfterTool
                  ? 'I stopped after an Ari action had already completed. The rest of the request did not finish, and I did not replay anything.'
                  : 'Ari stopped after starting part of this request. I did not replay it because that could duplicate an action. Check the activity above, then tell me to continue when you are ready.';
            }
            if (message.signal?.aborted) throw codexError;
            logger.warn({ err: codexError.message }, 'Codex App Server unavailable before tool execution; using Ari provider fallback');
            await onEvent({
              type: 'provider.fallback',
              step: 0,
              summary: 'Codex is unavailable, so Ari is continuing with its configured provider',
              payload: { from: selectedProvider, to: 'ari', code: 'app_server_unavailable' },
            });
          }
        }
      }

      if (!outcome) {
        const requestedRuntime = String(process.env.ARI_AGENT_RUNTIME || '').trim().toLowerCase() || 'agno';
        if (requestedRuntime === 'native') {
          const nativeAgent = require('../services/native-agent.service');
          // File turns run natively too: the loop swaps in the Vertex native
          // API adapter (@ai-sdk/google-vertex) when attachments are present,
          // because Vertex's OpenAI-compat endpoint carries no file part.
          // Attachments are re-validated inside the runtime before their bytes
          // are read.
          let currentTurnFiles = [];
          try {
            const { fileArtifactService } = require('../services/file-artifact.service');
            currentTurnFiles = await fileArtifactService.toAgentFilesForCurrentTurn(message.from);
          } catch (artifactError) {
            currentTurnFiles = [];
            logger.warn({
              code: artifactError.code || 'artifact_prepare_failed',
              err: artifactError.message,
            }, 'Current-turn files were not prepared for the native runtime');
          }
          if (nativeAgent.isConfigured()) {
            await onEvent({
              type: 'run.progress',
              step: 0,
              summary: 'Ari is understanding the request',
              payload: {
                provider: 'vertex-gemini',
                runtime: 'native-gemini',
                attachments: currentTurnFiles.length,
              },
            });
            try {
              outcome = await nativeAgent.runNativeAgent({
                userMessage: message.text,
                userPhone: message.from,
                sessionId: currentChatSession()?.sessionId || null,
                userTimezone: context?.userTimezone || 'Asia/Kolkata',
                executeFn,
                contextHints,
                recentMessages,
                backgroundBlock,
                files: currentTurnFiles,
                runId: run.runId,
                onEvent,
                signal: message.signal || currentChatSession()?.signal || null,
              });
            } catch (nativeError) {
              // Preserve the artifact list so a fallback runtime can still see
              // the attachments if the native attempt failed before any tool.
              if (currentTurnFiles.length > 0) message.agentFiles = currentTurnFiles;
              // Runtime fallback is safe only before any business tool starts.
              if (message.signal?.aborted || toolsExecuted > 0) throw nativeError;
              logger.warn({
                err: nativeError.message,
                code: nativeError.code,
                from: 'native-gemini',
              }, 'Native runtime failed before tool execution; using the configured compatibility runtime');
              await onEvent({
                type: 'provider.fallback', step: 0,
                summary: 'The native runtime is unavailable, so Ari is continuing on its configured compatibility runtime',
                payload: { from: 'native-gemini', to: 'compat', code: nativeError.code || 'native_unavailable' },
              });
            }
          } else if (currentTurnFiles.length > 0) {
            message.agentFiles = currentTurnFiles;
          }
        }

        if (!outcome && (requestedRuntime === 'agno'
          || (requestedRuntime === 'native' && Array.isArray(message.agentFiles) && message.agentFiles.length > 0))) {
          const agnoAgent = require('../services/agno-agent.service');
          if (agnoAgent.isConfigured()) {
            const agnoConfig = agnoAgent.runtimeConfig();
            const agnoRuntime = `agno-${agnoConfig.modelProvider}`;
            if (!Array.isArray(message.agentFiles)) {
              try {
                const { fileArtifactService } = require('../services/file-artifact.service');
                message.agentFiles = await fileArtifactService.toAgentFilesForCurrentTurn(message.from);
              } catch (artifactError) {
                // File tool calls still receive stable artifact IDs and can
                // report the exact failure. Never forward an unchecked path
                // merely to keep multimodal context available.
                message.agentFiles = [];
                logger.warn({
                  code: artifactError.code || 'artifact_prepare_failed',
                  err: artifactError.message,
                }, 'Current-turn files were not forwarded to Agno');
              }
            }
            await onEvent({
              type: 'run.progress',
              step: 0,
              summary: 'Ari is understanding the request',
              payload: { provider: agnoConfig.modelProvider, runtime: agnoRuntime },
            });
            try {
              outcome = await agnoAgent.runAgnoAgent({
                userMessage: message.text,
                userPhone: message.from,
                sessionId: currentChatSession()?.sessionId || null,
                userTimezone: context?.userTimezone || 'Asia/Kolkata',
                executeFn,
                contextHints,
                recentMessages,
                backgroundBlock,
                runId: run.runId,
                onEvent,
                signal: message.signal || currentChatSession()?.signal || null,
                files: Array.isArray(message.agentFiles) ? message.agentFiles : [],
              });
            } catch (agnoError) {
              // Runtime fallback is safe only before any business tool starts.
              // Once a tool was attempted, the outer partial-outcome guard
              // prevents a second runtime from replaying the user's request.
              if (message.signal?.aborted || toolsExecuted > 0) throw agnoError;
              const openRouterCompatibility = require('../services/openrouter-agent.service').isConfigured();
              const fallbackRuntime = openRouterCompatibility ? 'openrouter-agent-sdk' : 'agent-loop';
              logger.warn({
                err: agnoError.message,
                code: agnoError.code,
                from: agnoRuntime,
                to: fallbackRuntime,
              }, 'Agno failed before tool execution; using the configured compatibility runtime');
              await onEvent({
                type: 'provider.fallback', step: 0,
                summary: 'The Agno runtime is unavailable, so Ari is continuing on its configured compatibility runtime',
                payload: { from: agnoRuntime, to: fallbackRuntime, code: agnoError.code || 'agno_unavailable' },
              });
            }
          }
        }
      }

      if (!outcome) {
        const openRouterAgent = require('../services/openrouter-agent.service');
        if (!openRouterAgent.isConfigured() && !WebhookController._loggedRuntimeSelection) {
          // Deliberate configuration (Setup B): without an OpenRouter key,
          // turns run on the agent loop backed by the configured LLM provider
          // (Gemini via Vertex). Log it once so the active runtime is never
          // a silent surprise during diagnosis.
          WebhookController._loggedRuntimeSelection = true;
          logger.info(
            { runtime: 'agent-loop', provider: process.env.LLM_PROVIDER || 'gemini' },
            'Agno/OpenRouter compatibility path not configured; agent turns use the configured LLM provider via the agent loop'
          );
        }
        if (openRouterAgent.isConfigured()) {
          await onEvent({
            type: 'run.progress',
            step: 0,
            summary: 'Ari is understanding the request',
            payload: { provider: 'openrouter', runtime: 'openrouter-agent-sdk' },
          });
          try {
            outcome = await openRouterAgent.runOpenRouterAgent({
              userMessage: message.text,
              userPhone: message.from,
              userTimezone: context?.userTimezone || 'Asia/Kolkata',
              tools,
              executeFn,
              contextHints,
              recentMessages,
              backgroundBlock,
              runId: run.runId,
              onEvent,
              signal: message.signal || currentChatSession()?.signal || null,
            });
          } catch (openRouterError) {
            // A transport/config failure is replay-safe only before any tool
            // starts. After that, the outer guard returns an honest partial.
            if (message.signal?.aborted || toolsExecuted > 0) throw openRouterError;
            logger.warn({ err: openRouterError.message }, 'OpenRouter failed before tool execution; using temporary legacy fallback');
            await onEvent({
              type: 'provider.fallback', step: 0,
              summary: 'OpenRouter is unavailable, so Ari is using its temporary compatibility runtime',
              payload: { from: 'openrouter', to: 'ari-legacy', code: openRouterError.code || 'openrouter_unavailable' },
            });
          }
        }
      }

      if (!outcome) {
        outcome = await runAgentLoop({
          userMessage: message.text,
          userPhone: message.from,
          userTimezone: context?.userTimezone || 'Asia/Kolkata',
          tools,
          executeFn,
          contextHints,
          recentMessages,
          backgroundBlock,
          runId: run.runId,
          onEvent,
          signal: message.signal || currentChatSession()?.signal || null,
        });
      }

      if (message.signal?.aborted) {
        const unknownToolOutcome = Array.isArray(outcome.toolResults)
          && outcome.toolResults.some((result) =>
            result?.error?.category === 'unknown_outcome'
            || ['tool_aborted_unknown_outcome', 'tool_timeout_unknown_outcome'].includes(result?.error?.code));
        const hadToolActivity = toolsExecuted > 0
          || (Array.isArray(outcome.toolsUsed) && outcome.toolsUsed.length > 0)
          || (Array.isArray(outcome.toolResults) && outcome.toolResults.length > 0);
        if (unknownToolOutcome) {
          outcome = {
            ...outcome,
            status: 'partial',
            errorCode: 'cancelled_tool_unknown',
            text: outcome.text || 'I stopped the run while an action was in progress, so its outcome may be partial or unknown. I did not replay it.',
          };
        } else if (hadToolActivity) {
          const completed = (outcome.toolResults || [])
            .filter((result) => result?.status === 'success')
            .map((result) => result.user_summary || result.tool)
            .filter(Boolean)
            .map((summary) => String(summary).replace(/[.!?]+$/, ''));
          outcome = {
            ...outcome,
            status: 'partial',
            errorCode: 'cancelled_after_tool',
            text: completed.length > 0
              ? `I stopped after completing: ${completed.join('; ')}. The rest of the request did not finish, and I did not replay anything.`
              : 'I stopped after an Ari action had already started. I did not replay it; check the activity or workspace state before continuing.',
          };
        } else {
          // A clean cancellation means no Ari action ran, so any model text
          // that raced with Stop is discarded and can never be persisted or
          // shown as a completed reply.
          outcome = { ...outcome, status: 'cancelled', errorCode: 'user_cancelled', text: null };
        }
        await onEvent({
          type: outcome.status === 'partial' ? 'run.partial' : 'run.cancelled',
          step: outcome.steps || toolsExecuted || 0,
          summary: outcome.status === 'partial'
            ? String(outcome.text || 'The stopped run has a partial or unknown tool outcome.').slice(0, 500)
            : 'The user cancelled the agent run',
          payload: {
            status: outcome.status,
            code: outcome.errorCode,
            retryable: false,
          },
        });
      }

      await agentRunService.finishRun({
        runId: run.runId,
        status: outcome.status || 'completed',
        steps: outcome.steps,
        model: outcome.finalModel || null,
        outcome: {
          toolsUsed: outcome.toolsUsed,
          toolResults: Array.isArray(outcome.toolResults)
            ? outcome.toolResults.slice(0, 50).map((result) => ({
              status: result?.status || null,
              tool: result?.tool || null,
              user_summary: result?.user_summary || null,
              data: result?.data ?? null,
              error: result?.error || null,
              meta: result?.meta || null,
            }))
            : [],
          latencyMs: outcome.latencyMs,
          usage: outcome.usage || null,
          engine: outcome.engine || null,
          continuation: outcome.meta || null,
        },
        errorCode: outcome.errorCode || null,
      });
      message.agentRunStatus = outcome.status || 'completed';
      message.agentRunErrorCode = outcome.errorCode || null;
      // Live stream terminator: tells connected dashboards to finalize the
      // draft and fetch the persisted reply.
      await onEvent({
        type: 'run.finished', step: outcome.steps || 0,
        summary: outcome.status || 'completed',
        payload: { status: outcome.status || 'completed', errorCode: outcome.errorCode || null },
      });

      logger.info({
        userPhone: message.from,
        steps: outcome.steps,
        toolsUsed: outcome.toolsUsed,
        latencyMs: outcome.latencyMs
      }, 'Agentic turn completed');
      turnTrace.note(message.from, 'agent_loop_outcome', {
        runId: run.runId,
        status: outcome.status || 'completed',
        steps: outcome.steps,
        toolsUsed: outcome.toolsUsed,
        engine: outcome.engine || null,
        producedText: !!outcome.text,
      });

      if (outcome.status === 'cancelled') return null;

      // Track that an agentic turn happened (useful for analytics + context)
      this.lastBotAction.set(message.from, {
        action: 'agentic_turn',
        timestamp: Date.now(),
        toolsUsed: outcome.toolsUsed
      });

      const executedTools = toolsExecuted > 0 || (Array.isArray(outcome.toolsUsed) && outcome.toolsUsed.length > 0);
      if (outcome.text) {
        // The configured agent runtimes have already exhausted their safe
        // provider fallbacks. Returning null here would replay the request
        // through the keyword-only intent router, where "lead list" can be
        // misread as a shopping-list command. Surface the runtime error.
        return outcome.text;
      }
      // Empty text after tool execution: NEVER return null here — the
      // fallback would re-run the whole message and duplicate side effects.
      if (executedTools) {
        return 'I started this request, but the agent stopped before it produced a verified final result. I did not replay any action because that could duplicate it. Check the activity and tell me what to continue.';
      }
      return null;
    } catch (e) {
      logger.error({ err: e.message, userPhone: message.from }, 'Agent loop failed — falling back');
      if (message.signal?.aborted || e.code === 'agent_cancelled') {
        const uncertainTool = toolsExecuted > 0;
        message.agentRunStatus = uncertainTool ? 'partial' : 'cancelled';
        message.agentRunErrorCode = uncertainTool ? 'cancelled_tool_unknown' : 'user_cancelled';
        if (run?.runId) {
          try {
            const { agentRunService } = require('../services/agent-run.service');
            await agentRunService.recordEvent({
              runId: run.runId,
              userPhone: message.from,
              type: uncertainTool ? 'run.partial' : 'run.cancelled',
              summary: uncertainTool
                ? 'The run stopped after an action started; its final outcome is unknown'
                : 'The user cancelled the agent run',
              payload: {
                code: uncertainTool ? 'cancelled_tool_unknown' : 'user_cancelled',
                retryable: false,
              },
            });
            await agentRunService.finishRun({
              runId: run.runId,
              status: uncertainTool ? 'partial' : 'cancelled',
              errorCode: uncertainTool ? 'cancelled_tool_unknown' : 'user_cancelled',
            });
          } catch (_) {}
        }
        return uncertainTool
          ? 'I stopped while an Ari action was in progress, so I cannot safely claim whether it completed. I did not replay it. Check the activity or affected workspace before continuing.'
          : null;
      }
      turnTrace.note(message.from, 'agent_loop_failed', { runId: run?.runId || null, error: e.message, toolsExecuted });
      if (run?.runId) {
        try {
          const { agentRunService } = require('../services/agent-run.service');
          await agentRunService.recordEvent({
            runId: run.runId,
            userPhone: message.from,
            type: 'run.failed',
            summary: 'The agent run stopped unexpectedly',
            payload: { code: 'harness_error', retryable: true },
          });
          await agentRunService.finishRun({
            runId: run.runId,
            status: 'failed',
            errorCode: 'harness_error',
          });
        } catch (_) {}
      }
      // Same invariant as the codex branch: once a tool ran, replaying the
      // message through single-shot would duplicate the action.
      if (toolsExecuted > 0) {
        return 'I started on that but hit an error partway through. I did not retry automatically to avoid doing anything twice — check the result and tell me how to continue.';
      }
      return 'Ari AI could not reach Gemini through Vertex before starting this request. No action was performed. Please try again after checking the Vertex connection.';
    }
  }

  // Get display name + masked phone for a recipient
  async getRecipientDisplay(senderPhone, recipientPhone) {
    try {
      const contacts = await contactService.findByPhone(senderPhone, recipientPhone);
      const masked = contactService.maskPhone(recipientPhone);
      if (contacts.length > 0) {
        return `${contacts[0].name} (${masked})`;
      }
      return masked;
    } catch (e) {
      return contactService.maskPhone(recipientPhone);
    }
  }

  // Get the sender's display name from memories
  // Resolve a person's name as seen by the viewer (from viewer's contacts, then person's own memory)
  async resolveContactName(viewerPhone, personPhone, whatsappProfileName = null) {
    try {
      // 1. Check viewer's contacts for this person
      const contacts = await contactService.findByPhone(viewerPhone, personPhone);
      if (contacts && contacts.length > 0) return contacts[0].name;
      // 2. Fall back to the person's own name
      return await this.getSenderName(personPhone, whatsappProfileName);
    } catch (e) {
      return await this.getSenderName(personPhone, whatsappProfileName);
    }
  }

  /**
   * Resolve a name to an email/phone using the full fallback chain:
   * 1. Local contacts (contactService.resolveNameToPhone)
   * 2. Gmail history search (gmail.readonly — no extra contacts scope needed)
   * 3. Returns { found: false } otherwise.
   *
   * Gmail results are cached per (userPhone, name) for 30 minutes via
   * this.gmailContactCache. On a match, we also auto-save the contact to
   * the local contacts table so the next call is instant.
   *
   * This is the preferred contact-resolution entry point for callers that
   * want Google-backed name lookup without requesting the contacts.readonly
   * scope.
   */
  async resolveNameToPhoneWithGoogle(userPhone, name) {
    if (!name || !String(name).trim()) return { found: false };

    // Step 1: local contacts (instant)
    try {
      const local = await contactService.resolveNameToPhone(userPhone, name);
      if (local && local.found && !local.ambiguous) return local;
      if (local && local.ambiguous) return local; // surface ambiguity
    } catch (_) { /* fall through */ }

    // Step 2: Gmail history search (cached)
    const cacheKey = `${userPhone}:${String(name).toLowerCase().trim()}`;
    const cached = this.gmailContactCache.get(cacheKey);
    if (cached) return cached;

    try {
      const inboxOrganizerService = require('../services/inbox-organizer.service');
      const result = await inboxOrganizerService.findContactInEmails(userPhone, name);
      if (result.success && result.matches && result.matches.length > 0) {
        const top = result.matches[0];
        const resolved = {
          found: true,
          ambiguous: result.matches.length > 1,
          phone: null,
          email: top.email,
          name: top.name || name,
          source: 'gmail'
        };
        this.gmailContactCache.set(cacheKey, resolved);
        // Auto-save to local contacts (store email in the phone field since
        // the contacts table is phone-only; callers that need the email can
        // still read from the resolved object this call returns).
        try {
          await contactService.saveContact(userPhone, resolved.name, top.email);
        } catch (_) { /* best-effort */ }
        return resolved;
      }
    } catch (e) {
      logger.warn('Gmail contact search failed:', e.message);
    }

    // Cache the negative result to avoid repeat failed lookups
    const notFound = { found: false };
    this.gmailContactCache.set(cacheKey, notFound);
    return notFound;
  }

  async getSenderName(senderPhone, whatsappProfileName = null) {
    try {
      // 1. Check memory trunk for saved name
      const trunk = await memoryService.getMemoryTrunk(senderPhone);
      if (trunk && trunk.personal) {
        const nameEntry = trunk.personal.find(m => m.key === 'name');
        if (nameEntry) return nameEntry.value;
      }
      // 2. Check users table (onboarding name)
      try {
        const { query } = require('../config/database');
        const userResult = await query(
          `SELECT name FROM users WHERE phone_number = $1 LIMIT 1`,
          [senderPhone]
        );
        if (userResult.rows[0]?.name) return userResult.rows[0].name;
      } catch (_) {}
      // 3. WhatsApp profile name from webhook payload
      if (whatsappProfileName && whatsappProfileName !== 'User') return whatsappProfileName;
      // 4. Fall back to phone number
      return `+${senderPhone}`;
    } catch (e) {
      return whatsappProfileName || `+${senderPhone}`;
    }
  }

  // ─── Phase 3 helper: parse a free-form follow-up directive ──────────
  // Examples it handles:
  //   "every 4 hours"           → recurring, cadence=240 min
  //   "every 30 min"            → recurring, cadence=30 min
  //   "every day at 9am"        → recurring, cadence=1440 min, anchored to 9am
  //   "at 5pm tomorrow"         → one-time, next_at=tomorrow 17:00 (sender's tz)
  //   "in 2 hours"              → one-time, next_at=now + 2h
  //   "tomorrow"                → one-time, next_at=tomorrow 09:00
  //   "no" / "nope" / "skip"    → returns null (caller should treat as skip)
  // Returns { cadenceMinutes, nextAt, summary } or null if can't parse.
  _parseFollowUpDirective(directive) {
    const t = String(directive || '').trim().toLowerCase();
    if (!t) return null;
    if (/^(no|nope|nah|skip|don'?t|nahi)\b/.test(t)) return null;

    const now = Date.now();
    const oneMin = 60 * 1000;
    const oneHour = 60 * oneMin;
    const oneDay = 24 * oneHour;

    // "every X minutes/hours/days" → recurring cadence
    const everyMatch = t.match(/\bevery\s+(\d+)\s*(min(?:ute)?s?|h(?:ou)?rs?|days?)/);
    if (everyMatch) {
      const n = parseInt(everyMatch[1], 10);
      const unit = everyMatch[2];
      let cadenceMinutes;
      if (unit.startsWith('min')) cadenceMinutes = n;
      else if (unit.startsWith('h')) cadenceMinutes = n * 60;
      else cadenceMinutes = n * 60 * 24;
      return {
        cadenceMinutes,
        nextAt: new Date(now + cadenceMinutes * oneMin),
        summary: `every ${n} ${unit.startsWith('min') ? 'min' : unit.startsWith('h') ? 'hour' + (n === 1 ? '' : 's') : 'day' + (n === 1 ? '' : 's')}`,
      };
    }

    // "every day at HH:MM(am|pm)" → daily recurring at specific time
    const everyDayAt = t.match(/\bevery\s+day\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
    if (everyDayAt) {
      const h = parseInt(everyDayAt[1], 10);
      const m = everyDayAt[2] ? parseInt(everyDayAt[2], 10) : 0;
      const ampm = everyDayAt[3];
      const hours24 = ampm === 'pm' && h !== 12 ? h + 12 : (ampm === 'am' && h === 12 ? 0 : h);
      const target = new Date();
      target.setHours(hours24, m, 0, 0);
      if (target.getTime() <= now) target.setDate(target.getDate() + 1);
      return {
        cadenceMinutes: 24 * 60,
        nextAt: target,
        summary: `every day at ${h}${m ? `:${String(m).padStart(2, '0')}` : ''}${ampm || ''}`,
      };
    }

    // "at HH:MM(am|pm)[ tomorrow|today]" → one-time
    const atTime = t.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s+(tomorrow|today))?/);
    if (atTime) {
      const h = parseInt(atTime[1], 10);
      const m = atTime[2] ? parseInt(atTime[2], 10) : 0;
      const ampm = atTime[3];
      const dayHint = atTime[4];
      const hours24 = ampm === 'pm' && h !== 12 ? h + 12 : (ampm === 'am' && h === 12 ? 0 : h);
      const target = new Date();
      target.setHours(hours24, m, 0, 0);
      if (dayHint === 'tomorrow' || (target.getTime() <= now && dayHint !== 'today')) {
        target.setDate(target.getDate() + 1);
      }
      return {
        cadenceMinutes: null,
        nextAt: target,
        summary: `at ${h}${m ? `:${String(m).padStart(2, '0')}` : ''}${ampm || ''}${dayHint === 'tomorrow' ? ' tomorrow' : ''}`,
      };
    }

    // "in X minutes/hours" → one-time relative
    const inMatch = t.match(/\bin\s+(\d+)\s*(min(?:ute)?s?|h(?:ou)?rs?|days?)/);
    if (inMatch) {
      const n = parseInt(inMatch[1], 10);
      const unit = inMatch[2];
      let mins;
      if (unit.startsWith('min')) mins = n;
      else if (unit.startsWith('h')) mins = n * 60;
      else mins = n * 60 * 24;
      return {
        cadenceMinutes: null,
        nextAt: new Date(now + mins * oneMin),
        summary: `in ${n} ${unit.startsWith('min') ? 'min' : unit.startsWith('h') ? 'hour' + (n === 1 ? '' : 's') : 'day' + (n === 1 ? '' : 's')}`,
      };
    }

    // bare "tomorrow" → one-time at 9am tomorrow
    if (/^tomorrow\b/.test(t)) {
      const target = new Date(now + oneDay);
      target.setHours(9, 0, 0, 0);
      return { cadenceMinutes: null, nextAt: target, summary: 'tomorrow at 9am' };
    }

    // bare "now" or "soon" → 5 min from now (rare but useful)
    if (/^(now|soon|asap)\b/.test(t)) {
      return { cadenceMinutes: null, nextAt: new Date(now + 5 * oneMin), summary: 'in 5 min' };
    }

    return null;
  }

  // Map detected language code to WhatsApp template language code
  getTemplateLangCode(langCode) {
    const map = {
      'en': 'en',
      'hi': 'hi',
      'hi-Latn': 'hi',
      'es': 'es',
      'fr': 'fr',
      'ar': 'ar',
      'pt': 'pt_BR',
      'de': 'de',
      'ja': 'ja',
      'zh': 'zh_CN',
      'ko': 'ko',
      'ru': 'ru',
      'it': 'it',
      'tr': 'tr',
      'bn': 'bn',
      'ta': 'ta',
      'te': 'te',
      'mr': 'mr',
      'gu': 'gu',
      'kn': 'kn',
      'ml': 'ml',
      'pa': 'pa',
      'ur': 'ur',
      'id': 'id',
      'ms': 'ms',
      'th': 'th',
      'vi': 'vi',
      'pl': 'pl',
      'nl': 'nl',
      'sv': 'sv',
      'uk': 'uk',
      'he': 'he',
      'sw': 'sw',
      'fil': 'fil',
      'af': 'af'
    };
    return map[langCode] || 'en';
  }

  formatRecurrencePattern(pattern, days, exceptDays, lang) {
    let text = '';

    if (lang === 'english') {
      switch (pattern) {
        case 'daily': text = 'Every day'; break;
        case 'weekdays': text = 'Weekdays (Mon-Fri)'; break;
        case 'weekends': text = 'Weekends (Sat-Sun)'; break;
        case 'weekly':
        case 'custom':
          if (days && days.length > 0) {
            const dayList = days.map(d => d.charAt(0).toUpperCase() + d.slice(1));
            text = `Every ${dayList.join(', ')}`;
          } else {
            text = 'Weekly';
          }
          break;
        default: text = 'Recurring';
      }

      if (exceptDays && exceptDays.length > 0) {
        const exceptList = exceptDays.map(d => d.charAt(0).toUpperCase() + d.slice(1));
        text += ` (except ${exceptList.join(', ')})`;
      }
    } else {
      switch (pattern) {
        case 'daily': text = 'Har din'; break;
        case 'weekdays': text = 'Weekdays (Mon-Fri)'; break;
        case 'weekends': text = 'Weekends (Sat-Sun)'; break;
        case 'weekly':
        case 'custom':
          if (days && days.length > 0) {
            const dayList = days.map(d => d.charAt(0).toUpperCase() + d.slice(1));
            text = `Har ${dayList.join(', ')}`;
          } else {
            text = 'Weekly';
          }
          break;
        default: text = 'Recurring';
      }

      if (exceptDays && exceptDays.length > 0) {
        const exceptList = exceptDays.map(d => d.charAt(0).toUpperCase() + d.slice(1));
        text += ` (except ${exceptList.join(', ')})`;
      }
    }

    return text;
  }

  formatReminderTime(date, timezone, lang) {
    const d = new Date(date);
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 86400000);

    const clockTime = d.toLocaleString('en-IN', {
      timeZone: timezone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    }).toLowerCase();

    const dayName = d.toLocaleDateString('en-IN', { timeZone: timezone, weekday: 'long' });

    if (d.toDateString() === now.toDateString()) {
      return lang === 'english' ?`Today at ${clockTime}` :`Aaj ${clockTime}`;
    }
    if (d.toDateString() === tomorrow.toDateString()) {
      return lang === 'english' ?`Tomorrow at ${clockTime}` :`Kal ${clockTime}`;
    }

    return `${dayName} at ${clockTime}`;
  }

  // ========== DASHBOARD COMMANDS ==========
  async handleDashboardCommand(message) {
    const text = message.text.toLowerCase().trim();

    if (text === 'dashboard' || text === 'my dashboard') {
      const response = await dashboardService.getDashboard(message.from);
      await this.sendLongMessage(message.from, response);
      return true;
    }

    if (text === 'my reminders' || text === 'show reminders') {
      const response = await dashboardService.getRemindersView(message.from);
      await this.sendLongMessage(message.from, response);
      return true;
    }

    // Show recurring reminders
    if (text === 'my recurring' || text === 'recurring reminders' || text === 'show recurring') {
      const response = await this.getRecurringRemindersView(message.from);
      await this.sendLongMessage(message.from, response);
      return true;
    }

    // Cancel recurring reminder
    const cancelMatch = text.match(/^(cancel|stop)\s+recurring\s+(\d+)$/i);
    if (cancelMatch) {
      const index = parseInt(cancelMatch[2]);
      const response = await this.cancelRecurringByIndex(message.from, index);
      await messagingService.send(message.from, response);
      return true;
    }

    const deleteReminderMatch = text.match(/^delete reminder (\d+)$/i);
    if (deleteReminderMatch) {
      const index = parseInt(deleteReminderMatch[1]);
      // Route through the common cancel handler so we get the confirmation
      // gate + list-cache resolution (instead of silent delete).
      const response = await this.handleReminderCancel({ ...message, text: `cancel reminder ${index}` });
      await messagingService.send(message.from, response);
      return true;
    }

    if (text === 'my memories' || text === 'show memories') {
      const response = await dashboardService.getMemoriesView(message.from);
      await this.sendLongMessage(message.from, response);
      return true;
    }

    if (text === 'my lists' || text === 'show lists') {
      const response = await dashboardService.getListsView(message.from);
      await this.sendLongMessage(message.from, response);
      return true;
    }

    if (text === 'my contacts' || text === 'show contacts') {
      const userTimezone = await timezoneService.getUserTimezone(message.from);
      const contacts = await contactService.getAllContacts(message.from);
      const response = contactService.formatContactsList(contacts, userTimezone);
      await this.sendLongMessage(message.from, response);
      return true;
    }

    if (text === 'my images' || text === 'show images') {
      const response = await dashboardService.getImagesView(message.from);
      this.dashboardImageContext.set(message.from, { timestamp: Date.now() });
      setTimeout(() => this.dashboardImageContext.delete(message.from), 5 * 60 * 1000);
      await this.sendLongMessage(message.from, response);
      return true;
    }

    const deleteImageMatch = text.match(/^delete image (\d+)$/i);
    if (deleteImageMatch) {
      const index = parseInt(deleteImageMatch[1]);
      const response = await dashboardService.deleteImageByIndex(message.from, index);
      await messagingService.send(message.from, response);
      return true;
    }

    // Number selection for images
    const numMatch = text.match(/^(\d+)$/);
    if (numMatch) {
      const dashCtx = this.dashboardImageContext.get(message.from);
      if (dashCtx && (Date.now() - dashCtx.timestamp) < 5 * 60 * 1000) {
        const index = parseInt(numMatch[1]);
        const result = await dashboardService.getImageByIndex(message.from, index);
        if (result.success) {
          try {
            await messagingService.sendImage(message.from, result.url, result.caption);
          } catch (e) {
            await messagingService.send(message.from, `Image: ${result.url}`);
          }
        } else {
          await messagingService.send(message.from, result.message);
        }
        return true;
      }
    }

    return false;
  }

  async getRecurringRemindersView(userPhone) {
    try {
      const reminders = await reminderService.getRecurringReminders(userPhone);

      if (reminders.length === 0) {
        return "No recurring reminders set.\n\nCreate one:\n- \"remind me every day at 9am to exercise\"\n- \"every weekday at 8am remind me to check email\"";
      }

      let response = `*Your Recurring Reminders (${reminders.length})*\n\n`;

      reminders.forEach((r, i) => {
        const patternText = this.formatRecurrencePattern(
          r.recurrence_pattern,
          r.recurrence_days ? r.recurrence_days.split(',') : null,
          r.except_days ? r.except_days.split(',') : null,
          'english'
        );

        const timeStr = this.formatTimeString(r.recurrence_time);
        const nextDate = r.next_occurrence
          ? new Date(r.next_occurrence).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
          : 'N/A';

        response += `${i + 1}. ${r.message}\n`;
        response += ` ${patternText} at ${timeStr}\n`;
        response += ` Next: ${nextDate}\n\n`;
      });

      response += `_"cancel recurring [number]" to stop_`;

      return response;

    } catch (error) {
      logger.error('Error getting recurring reminders:', error);
      return 'Could not load recurring reminders.';
    }
  }

  async cancelRecurringByIndex(userPhone, index) {
    try {
      const reminders = await reminderService.getRecurringReminders(userPhone);

      if (index < 1 || index > reminders.length) {
        return `Invalid number. You have ${reminders.length} recurring reminders.`;
      }

      const reminder = reminders[index - 1];
      await reminderService.cancelRecurringReminder(reminder.id, userPhone);

      return `Cancelled: "${reminder.message}"`;

    } catch (error) {
      return 'Could not cancel reminder.';
    }
  }

  /**
   * Detect a casual phone number + name mention in a message.
   * Works for English and Hindi/Hinglish patterns.
   * Returns { name, phone } or null.
   * Does NOT trigger for explicit save commands (handled by save_contact intent).
   */
  _extractCasualPhoneAndName(text, senderPhone) {
    // Must contain a phone number
    const phoneMatch = text.match(/\+?(\d[\d\s\-]{7,14}\d)/);
    if (!phoneMatch) return null;

    let phone = phoneMatch[1].replace(/[\s\-]/g, '');
    if (phone.length === 10) phone = '91' + phone;
    if (phone.length < 10 || phone.length > 15) return null;

    // Don't trigger if it's the sender's own number
    const senderClean = (senderPhone || '').replace(/\D/g, '');
    if (phone === senderClean || phone.endsWith(senderClean.slice(-10))) return null;

    const lower = text.toLowerCase();

    // Skip if it looks like an explicit save command (those go through save_contact intent)
    if (/\b(save contact|save this|save number|add contact)\b/i.test(text)) return null;

    // English patterns: "Neha's number is ...", "Neha's phone ...", "this is Neha's no"
    const enPatterns = [
      /([a-zA-Z][a-zA-Z\s]{1,20}?)'s?\s+(?:number|phone|mobile|no\.?|contact)\s+(?:is\s+)?/i,
      /(?:number|phone|mobile|no\.?)\s+(?:of\s+|for\s+)?([a-zA-Z][a-zA-Z\s]{1,20}?)\s+is/i,
      /(?:this\s+is\s+)?([a-zA-Z][a-zA-Z\s]{1,20}?)\s+(?:number|phone|mobile|no\.?)/i,
    ];

    // Hindi/Urdu patterns: "neha ka number", "neha ki id", "ye rahul ka no hai"
    const hiPatterns = [
      /([a-zA-Z][a-zA-Z\s]{1,20}?)\s+ka\s+(?:number|phone|mobile|no\.?|contact)/i,
      /([a-zA-Z][a-zA-Z\s]{1,20}?)\s+ki\s+(?:id|number|phone|contact)/i,
      /([a-zA-Z][a-zA-Z\s]{1,20}?)\s+(?:ka|ki|ke)\s+(?:number|phone|no\.?)/i,
    ];

    const skipWords = new Set(['my', 'his', 'her', 'their', 'our', 'mera', 'meri', 'uska', 'uski', 'this', 'the', 'that', 'a', 'an', 'send', 'set', 'new', 'old', 'some', 'any']);

    for (const pattern of [...enPatterns, ...hiPatterns]) {
      const m = text.match(pattern);
      if (m) {
        const name = m[1].trim();
        const nameLower = name.toLowerCase();
        if (name.length >= 2 && !skipWords.has(nameLower) && !/\d/.test(name)) {
          return { name, phone };
        }
      }
    }

    return null;
  }

  /**
   * Parse ordinal/number from short messages like "2nd one", "the 3rd", "stop 3", "#2", "3"
   * Returns 1-based index or null if not an ordinal reference
   */
  _parseReminderOrdinal(text) {
    const lower = text.toLowerCase().trim();
    // Direct number: "3", "#3"
    const directNum = lower.match(/^#?(\d+)$/);
    if (directNum) return parseInt(directNum[1]);
    // "2nd one", "the 3rd", "stop the 2nd", "cancel 3rd", "delete 1st"
    const ordinalMatch = lower.match(/(?:stop|cancel|delete|remove|the|#)?\s*(\d+)(?:st|nd|rd|th)?\s*(?:one|wala|wali)?/i);
    if (ordinalMatch) return parseInt(ordinalMatch[1]);
    // Word ordinals
    const wordMap = { 'first': 1, 'second': 2, 'third': 3, 'fourth': 4, 'fifth': 5,
      'pehla': 1, 'dusra': 2, 'teesra': 3, 'chautha': 4, 'last': -1 };
    for (const [word, num] of Object.entries(wordMap)) {
      if (lower.includes(word)) return num;
    }
    return null;
  }

  /**
   * Update / reschedule / postpone an existing reminder.
   *
   * Canonical calls identify exactly one reminder by stable ID, recent-list
   * position, distinctive text, or an explicit last-created reference. An
   * explicit selector that misses never falls through to another reminder.
   * Legacy text-only calls retain their prior contextual behavior.
   *
   * Time parsing reuses reminder.service.parseReminderTimeAndMessage so
   * "2 hours later" / "tomorrow 9am" / "5pm" all work in any language.
   */
  async handleUpdateReminder(message, intentParams = {}) {
    const { query: dbQuery } = require('../config/database');
    const reminderService = require('../services/reminder.service');
    const timezoneService = require('../services/timezone.service');
    const listCache = require('../utils/list-position-cache');
    const confirmationGate = require('../services/confirmation-gate.service');

    const userTz = await timezoneService.getUserTimezone(message.from);
    const newTimePhrase = String(intentParams.new_time || message.text || '').trim();

    // Parse the new time phrase. parseReminderTimeAndMessage handles Hindi /
    // Spanish / French / tomorrow / "X hours later" / "in N minutes" / etc.
    const parsed = await reminderService.parseReminderTimeAndMessage(
      message.from,
      newTimePhrase,
      userTz
    );
    if (!parsed.success) {
      return `I couldn't parse the new time from "${newTimePhrase}". Try something like "postpone to 5pm" or "move it 2 hours later".`;
    }
    const newTime = parsed.reminderTime;

    // ── Resolve target reminder ──────────────────────────────────
    let targetId = null;
    let targetLabel = null;

    const hasExplicitSelector = this._hasExplicitReminderSelector(intentParams, true);
    if (hasExplicitSelector) {
      const resolved = await this._resolveExplicitReminderSelector(
        message,
        intentParams,
        dbQuery,
        listCache,
        { allowLastCreated: true }
      );
      if (resolved.error) return resolved.error;
      targetId = resolved.target.id;
      targetLabel = resolved.target.label;
    } else {
      // Legacy non-agent behavior: use the most recent reminder reference, or
      // the sole pending reminder when no explicit structured selector exists.
      const last = this.lastEntityRef.get(message.from);
      if (last?.entityType === 'reminder' && last.entityId) {
        targetId = last.entityId;
        targetLabel = last.label;
      }
    }

    if (!targetId && !hasExplicitSelector) {
      const pending = await dbQuery(
        `SELECT id, message FROM reminders WHERE user_phone = $1 AND status = 'pending' ORDER BY reminder_time ASC LIMIT 2`,
        [message.from]
      );
      if (pending.rows.length === 1) {
        targetId = pending.rows[0].id;
        targetLabel = pending.rows[0].message;
      } else if (pending.rows.length === 0) {
        return 'You have no pending reminders to update.';
      } else {
        // Multiple — ask user to pick
        const all = await dbQuery(
          `SELECT id, message FROM reminders WHERE user_phone = $1 AND status = 'pending' ORDER BY reminder_time ASC LIMIT 10`,
          [message.from]
        );
        const items = all.rows.map(r => ({ id: r.id, label: r.message }));
        listCache.remember(message.from, 'reminders', items.map((it, i) => ({ position: i + 1, ...it })));
        let msg = `Which reminder do you want to update?\n\n`;
        all.rows.forEach((r, i) => { msg += `${i + 1}. ${r.message}\n`; });
        msg += `\nReply *"update N to <new time>"* or pick a number.`;
        return msg;
      }
    }

    // ── Confirmation gate: show before/after + ask yes/no ──────────
    const newTimeStr = newTime.toLocaleString('en-IN', {
      timeZone: userTz, weekday: 'short', day: 'numeric', month: 'short',
      hour: 'numeric', minute: '2-digit', hour12: true
    });

    return await confirmationGate.pend(message.from, {
      actionType: 'reminder_update',
      summary: `*Update reminder:* "${targetLabel || '(unknown)'}"\nNew time: *${newTimeStr}*\n\nReply *yes* to update, *no* to cancel.`,
      ctx: { reminderId: targetId, newTime: newTime.toISOString(), label: targetLabel },
      execute: async () => {
        await reminderService.rescheduleReminder(targetId, newTime, message.from);
        // Update lastActionRef so follow-ups resolve correctly
        this.recordLastAction(message.from, {
          action: 'reminder_update',
          entityType: 'reminder',
          entityId: targetId,
          label: targetLabel,
          at: newTime.toISOString()
        });
        return `✓ Reminder updated: "${targetLabel}" → ${newTimeStr}`;
      }
    });
  }

  /**
   * Pending reminders in the same order as getRemindersView() shows them
   * (reminder_time DESC — position 1 = furthest out, last = soonest).
   */
  async _fetchPendingRemindersOrdered(userPhone) {
    const { query: dbQuery } = require('../config/database');
    const result = await dbQuery(
      `SELECT id, message, reminder_time, is_recurring, recurrence_pattern, created_at
       FROM reminders WHERE user_phone = $1 AND status = 'pending'
       ORDER BY reminder_time DESC
       LIMIT 20`,
      [userPhone]
    );
    return result.rows;
  }

  _hasExplicitReminderSelector(intentParams = {}, allowLastCreated = false) {
    return intentParams.reminder_id !== undefined
      || intentParams.position !== undefined
      || Boolean(String(intentParams.query || '').trim())
      || (allowLastCreated && intentParams.use_last_created === true);
  }

  _normalizeReminderSelectorText(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async _resolveExplicitReminderSelector(message, intentParams, dbQuery, listCache, { allowLastCreated = false } = {}) {
    const selectors = [
      intentParams.reminder_id !== undefined && intentParams.reminder_id !== null ? 'reminder_id' : null,
      intentParams.position !== undefined && intentParams.position !== null ? 'position' : null,
      String(intentParams.query || '').trim() ? 'query' : null,
      allowLastCreated && intentParams.use_last_created === true ? 'use_last_created' : null,
    ].filter(Boolean);

    if (selectors.length !== 1) {
      return { error: 'Please identify exactly one reminder by its stable ID, its position in the most recent reminder list, or distinctive reminder text.' };
    }

    const lookupOwnedPending = async (id) => {
      const numericId = Number(id);
      if (!Number.isInteger(numericId) || numericId < 1) return null;
      const result = await dbQuery(
        `SELECT id, message FROM reminders WHERE id = $1 AND user_phone = $2 AND status = 'pending'`,
        [numericId, message.from]
      );
      const row = result.rows[0];
      return row ? { id: row.id, label: row.message } : null;
    };

    if (selectors[0] === 'reminder_id') {
      const target = await lookupOwnedPending(intentParams.reminder_id);
      return target
        ? { target }
        : { error: `I couldn't find a pending reminder with ID #${intentParams.reminder_id}. I did not select a different reminder.` };
    }

    if (selectors[0] === 'position') {
      const position = Number(intentParams.position);
      if (!Number.isInteger(position) || position < 1) {
        return { error: 'Reminder position must be a positive one-based number from the most recent reminder list.' };
      }
      const cached = listCache.pick(message.from, 'reminders', position);
      if (!cached?.id) {
        return { error: 'I cannot resolve that position because there is no matching recent reminder list. Show your reminders, then choose a one-based position.' };
      }
      const target = await lookupOwnedPending(cached.id);
      return target
        ? { target: { ...target, label: cached.label || cached.message || target.label } }
        : { error: `Reminder ${position} from the recent list is no longer pending. I did not select a different reminder.` };
    }

    if (selectors[0] === 'use_last_created') {
      const last = this.lastEntityRef.get(message.from);
      if (last?.entityType !== 'reminder' || !last.entityId) {
        return { error: 'I do not have a recent reminder reference to update. Show your reminders and choose one explicitly.' };
      }
      const target = await lookupOwnedPending(last.entityId);
      return target
        ? { target: { ...target, label: last.label || target.label } }
        : { error: 'The reminder Ari most recently referenced is no longer pending. I did not select a different reminder.' };
    }

    const pending = await this._fetchPendingRemindersOrdered(message.from);
    if (pending.length === 0) return { error: 'You have no pending reminders.' };
    const needle = this._normalizeReminderSelectorText(intentParams.query);
    const exact = pending.filter((item) => this._normalizeReminderSelectorText(item.message) === needle);
    const phrase = exact.length > 0 ? exact : pending.filter((item) =>
      this._normalizeReminderSelectorText(item.message).includes(needle)
    );
    const queryTokens = needle.split(' ').filter((token) => token.length > 1);
    const matches = phrase.length > 0 ? phrase : pending.filter((item) => {
      const label = this._normalizeReminderSelectorText(item.message);
      return queryTokens.length > 0 && queryTokens.every((token) => label.includes(token));
    });

    if (matches.length === 1) {
      return { target: { id: matches[0].id, label: matches[0].message } };
    }
    if (matches.length === 0) {
      return { error: `I couldn't find a pending reminder matching "${intentParams.query}". I did not select a different reminder.` };
    }

    const items = matches.slice(0, 10).map((item, index) => ({
      position: index + 1,
      id: item.id,
      label: item.message,
      status: 'pending',
    }));
    listCache.remember(message.from, 'reminders', items);
    this.reminderListContext.set(message.from, {
      items: items.map((item) => ({ id: item.id, message: item.label })),
      timestamp: Date.now(),
    });
    return {
      error: `I found ${matches.length} pending reminders matching "${intentParams.query}":\n\n${items.map((item) => `${item.position}. ${item.label}`).join('\n')}\n\nChoose a one-based position from this list.`,
    };
  }

  async _cancelLastReminder(message, dbQuery, listCache) {
    const cached = listCache.getItems(message.from, 'reminders');
    if (cached && cached.length > 0) {
      const pendingOnly = cached.filter((i) => i.status !== 'sent');
      const pool = pendingOnly.length > 0 ? pendingOnly : cached;
      const last = pool[pool.length - 1];
      if (last && last.id) {
        await dbQuery(
          `UPDATE reminders SET status = 'cancelled' WHERE id = $1 AND user_phone = $2`,
          [last.id, message.from]
        );
        listCache.forget(message.from, 'reminders');
        this.reminderListContext.delete(message.from);
        const label = last.label || last.message || 'reminder';
        return `Cancelled: "${label}"`;
      }
    }

    const pending = await this._fetchPendingRemindersOrdered(message.from);
    if (pending.length === 0) return 'No pending reminders to cancel.';

    const item = pending[pending.length - 1];
    await dbQuery(
      `UPDATE reminders SET status = 'cancelled' WHERE id = $1 AND user_phone = $2`,
      [item.id, message.from]
    );
    listCache.forget(message.from, 'reminders');
    this.reminderListContext.delete(message.from);
    return `Cancelled: "${item.message}"`;
  }

  /**
   * "I already did that" — marks one pending reminder completed. Distinct from
   * cancellation: completing is not destructive, so it needs no confirmation
   * gate, but it still refuses to guess which reminder the user meant.
   */
  async handleReminderComplete(message, intentParams = {}) {
    const { query: dbQuery } = require('../config/database');
    const listCache = require('../utils/list-position-cache');

    if (!this._hasExplicitReminderSelector(intentParams)) {
      const pending = await this._fetchPendingRemindersOrdered(message.from);
      if (pending.length === 0) return 'You have no pending reminders to complete.';
      if (pending.length === 1) {
        await dbQuery(
          `UPDATE reminders SET status = 'completed' WHERE id = $1 AND user_phone = $2 AND status = 'pending'`,
          [pending[0].id, message.from]
        );
        listCache.forget(message.from, 'reminders');
        this.reminderListContext.delete(message.from);
        return `Marked done: "${pending[0].message}"`;
      }
      return `Which one is done? You have ${pending.length} pending reminders — say "show my reminders" and then pick a number.`;
    }

    const resolved = await this._resolveExplicitReminderSelector(message, intentParams, dbQuery, listCache);
    if (resolved.error) return resolved.error;
    const { id, label } = resolved.target;
    const result = await dbQuery(
      `UPDATE reminders SET status = 'completed' WHERE id = $1 AND user_phone = $2 AND status = 'pending'`,
      [id, message.from]
    );
    if (result.rowCount === 0) {
      return `Reminder "${label}" is no longer pending. I did not complete a different reminder.`;
    }
    listCache.forget(message.from, 'reminders');
    this.reminderListContext.delete(message.from);
    return `Marked done: "${label}"`;
  }

  async handleReminderCancel(message, intentParams = {}, context = {}) {
    const lower = String(message.text || '').toLowerCase().trim();
    const { query: dbQuery } = require('../config/database');
    const listCache = require('../utils/list-position-cache');
    const confirmationGate = require('../services/confirmation-gate.service');

    if (this._hasExplicitReminderSelector(intentParams)) {
      const resolved = await this._resolveExplicitReminderSelector(
        message,
        intentParams,
        dbQuery,
        listCache
      );
      if (resolved.error) return resolved.error;
      const { id, label } = resolved.target;
      const reason = String(intentParams.reason || '').trim();
      const executeCancellation = async () => {
        const result = await dbQuery(
          `UPDATE reminders SET status = 'cancelled' WHERE id = $1 AND user_phone = $2 AND status = 'pending'`,
          [id, message.from]
        );
        if (result.rowCount === 0) {
          return `Reminder "${label}" is no longer pending. I did not cancel a different reminder.`;
        }
        listCache.forget(message.from, 'reminders');
        this.reminderListContext.delete(message.from);
        return `Cancelled: "${label}"`;
      };

      // Agent calls already passed the central destructive-action gate. Keep
      // one confirmation for direct/legacy callers that supply typed fields.
      if (context?.agentExecution?.confirmedByPolicy === true) {
        return await executeCancellation();
      }
      return await confirmationGate.pend(message.from, {
        actionType: 'reminder_cancel',
        summary: `Cancel reminder: "${label}"?${reason ? `\nReason: ${reason}` : ''}\n\nReply *yes* to cancel, *no* to keep.`,
        ctx: { reminderId: id, label, ...(reason ? { reason } : {}) },
        execute: executeCancellation,
      });
    }

    // PRIMARY path: if user just viewed a reminder list and now says
    // "cancel 2" / "delete the 3rd" / "(2)" / "cancel 1 & 2" / "1, 2, 3",
    // resolve the position(s) against THAT exact list they saw.
    //
    // RC #5 fix: parseIndexList handles multi-index input ("1 & 2", "1-3",
    // "first three"). Previously only the first index was caught, silently
    // dropping the rest of the user's batch.
    //
    // The resolution is cached-first (exact match to what the user saw),
    // then we wrap the actual DELETE(s) in a confirmation gate so a misread
    // position number can't silently lose work.
    const { parseIndexList } = require('../utils/parse-index-list');
    const indexParse = parseIndexList(lower);

    // Cancel all pending reminders (incl. typos: "alll", "allll")
    if (indexParse.all || matchesCancelAllReminders(lower)) {
      try {
        const result = await dbQuery(
          `UPDATE reminders SET status = 'cancelled' WHERE user_phone = $1 AND status = 'pending'`,
          [message.from]
        );
        const count = result.rowCount || 0;
        listCache.forget(message.from, 'reminders');
        this.reminderListContext.delete(message.from);
        return count > 0
          ? `Cancelled ${count} reminder${count > 1 ? 's' : ''}.`
          : 'No pending reminders to cancel.';
      } catch (error) {
        logger.error('Cancel all reminders error:', error.message);
        return 'Could not cancel reminders.';
      }
    }

    // "cancel my last reminder" — last item in the list the user saw
    if (indexParse.last || isCancelLastReminderQuery(message.text)) {
      return await this._cancelLastReminder(message, dbQuery, listCache);
    }

    if (indexParse.ids.length > 0) {
      // Resolve every index against the cached list the user saw
      const resolved = [];
      for (const n of indexParse.ids) {
        const cached = listCache.pick(message.from, 'reminders', n);
        if (cached && cached.id) {
          resolved.push({ position: n, id: cached.id });
        }
      }

      if (resolved.length > 0) {
        // Look up labels for the resolved IDs in one round-trip
        const ids = resolved.map(r => r.id);
        const lookup = await dbQuery(
          `SELECT id, message FROM reminders WHERE id = ANY($1::int[]) AND user_phone = $2`,
          [ids, message.from]
        );
        const labelById = new Map(lookup.rows.map(r => [r.id, r.message]));
        const items = resolved
          .map(r => ({ position: r.position, id: r.id, label: labelById.get(r.id) }))
          .filter(r => r.label); // drop already-deleted reminders

        if (items.length === 0) {
          return `Those reminder${resolved.length > 1 ? 's are' : ' is'} already gone.`;
        }

        // Single-item path: existing UX (one confirmation, one cancel)
        if (items.length === 1) {
          const { id, label } = items[0];
          return await confirmationGate.pend(message.from, {
            actionType: 'reminder_cancel',
            summary: `Cancel reminder: "${label}"?\n\nReply *yes* to cancel, *no* to keep.`,
            ctx: { reminderId: id, label },
            execute: async () => {
              // Defensive scope (Batch F6).
              await dbQuery(`UPDATE reminders SET status = 'cancelled' WHERE id = $1 AND user_phone = $2`, [id, message.from]);
              return `Cancelled: "${label}"`;
            }
          });
        }

        // Multi-item path: ONE batch confirmation, ONE batch DELETE
        const summary = `Cancel ${items.length} reminders?\n\n` +
          items.map(it => `${it.position}. "${it.label}"`).join('\n') +
          `\n\nReply *yes* to cancel all, *no* to keep them.`;
        return await confirmationGate.pend(message.from, {
          actionType: 'reminder_cancel_batch',
          summary,
          ctx: { items },
          execute: async () => {
            const targetIds = items.map(it => it.id);
            // Defensive scope (Batch F6).
            await dbQuery(
              `UPDATE reminders SET status = 'cancelled' WHERE id = ANY($1::int[]) AND user_phone = $2`,
              [targetIds, message.from]
            );
            return `Cancelled ${items.length} reminders:\n` +
              items.map(it => `• "${it.label}"`).join('\n');
          }
        });
      }
    }

    // Fetch pending reminders — same ORDER BY as getRemindersView pending section
    const pending = await this._fetchPendingRemindersOrdered(message.from);
    if (pending.length === 0) return 'No pending reminders to cancel.';

    // Try to extract a number from the message: "cancel reminder 3", "delete 2", "stop the 3rd"
    const numMatch = lower.match(/(?:cancel|delete|remove|stop)\s+(?:reminder\s+)?#?(\d+)/i);
    let idx = numMatch ? parseInt(numMatch[1]) : this._parseReminderOrdinal(lower);

    // "last" without cache — last position in display order (soonest upcoming)
    if (idx === -1) {
      return await this._cancelLastReminder(message, dbQuery, listCache);
    }

    if (idx !== null && idx >= 1 && idx <= pending.length) {
      const item = pending[idx - 1];
      // Defensive scope (Batch F6).
      await dbQuery(`UPDATE reminders SET status = 'cancelled' WHERE id = $1 AND user_phone = $2`, [item.id, message.from]);
      listCache.forget(message.from, 'reminders');
      this.reminderListContext.delete(message.from);
      return `Cancelled: "${item.message}"`;
    }

    if (idx !== null && idx > pending.length) {
      return `You only have ${pending.length} pending reminder${pending.length !== 1 ? 's' : ''}.`;
    }

    // ── Keyword fuzzy match — cancel by name without needing a number ──
    // Extract meaningful keywords (strip stop words and command words)
    const keywords = lower
      .replace(/\b(cancel|delete|remove|stop|the|my|a|an|all|reminder|reminders|please|bhai|yaar)\b/gi, ' ')
      .split(/\s+/)
      .map(w => w.trim())
      .filter(w => w.length > 2);

    if (keywords.length > 0) {
      const keywordMatches = pending.filter(r =>
        keywords.some(kw => r.message.toLowerCase().includes(kw))
      );
      if (keywordMatches.length === 1) {
        // Exact single match — cancel directly without bothering the user.
        // Defensive scope (Batch F6).
        await dbQuery(`UPDATE reminders SET status = 'cancelled' WHERE id = $1 AND user_phone = $2`, [keywordMatches[0].id, message.from]);
        listCache.forget(message.from, 'reminders');
        this.reminderListContext.delete(message.from);
        return `Cancelled: "${keywordMatches[0].message}"`;
      }
      if (keywordMatches.length >= 2 && keywordMatches.length <= 3) {
        // Narrow it down — only show matching reminders
        const items = keywordMatches.map(r => ({ id: r.id, message: r.message }));
        this.reminderListContext.set(message.from, { items, timestamp: Date.now() });
        let response = `Found ${keywordMatches.length} matching reminders:\n\n`;
        keywordMatches.forEach((r, i) => { response += `${i + 1}. ${r.message}\n`; });
        response += `\nReply with a number to cancel.`;
        return response;
      }
    }

    // No number given — show list and store context for follow-up
    const cachedItems = pending.map((r, i) => ({
      position: i + 1,
      id: r.id,
      label: r.message,
      status: 'pending',
    }));
    listCache.remember(message.from, 'reminders', cachedItems);
    this.reminderListContext.set(message.from, { items: pending.map(r => ({ id: r.id, message: r.message })), timestamp: Date.now() });

    let response = `*Pending Reminders (${pending.length})*\n\n`;
    pending.forEach((r, i) => {
      const tag = r.is_recurring ? ` _${r.recurrence_pattern}_` : '';
      response += `${i + 1}. ${r.message}${tag}\n`;
    });
    response += `\nReply with a number to cancel it (e.g. "3"), or "cancel all".`;
    return response;
  }

  formatTimeString(timeStr) {
    if (!timeStr) return '';
    const [hours, minutes] = timeStr.split(':').map(Number);
    const period = hours >= 12 ? 'pm' : 'am';
    const displayHours = hours > 12 ? hours - 12 : (hours === 0 ? 12 : hours);
    return `${displayHours}:${minutes.toString().padStart(2, '0')} ${period}`;
  }

  // ========== IMAGE HANDLING ==========
  async handleImage(message) {
    try {
      const caption = message.image.caption || null;
      const lang = caption ? this.detectLanguage(caption) : 'english';
      const templates = this.getTemplates(lang);

      // Check if caption itself is a save command (user sent image with caption "save this")
      const captionIsSave = caption && /^(save|store|keep|remember|yaad rakh)/i.test(caption.trim());

      await messagingService.send(message.from, templates.imageProcessing);
      // Timeout image processing at 30 seconds
      const result = await Promise.race([
        imageService.processImage(message.image.id, caption),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Image processing timed out')), 30000))
      ]);

      if (!result.success) {
        await messagingService.send(message.from, "Couldn't process image. Try again?");
        return;
      }

      // Store analysis context for follow-up save
      const userTimezone = await timezoneService.getUserTimezone(message.from);
      this.imageContext.set(message.from, {
        analysis: result.analysis,
        imageUrl: result.imageUrl,
        title: result.title || result.analysis?.auto_title || null,
        category: result.category || 'Other',
        tags: result.analysis?.tags || [],
        keyDetails: result.keyDetails || {},
        description: result.analysis?.description || '',
        extractedText: result.analysis?.extracted_text || '',
        needsClarification: result.needsClarification,
        userTimezone,
        timestamp: Date.now(),
        lang
      });

      setTimeout(() => this.imageContext.delete(message.from), 10 * 60 * 1000);

      // If caption is a save command, save immediately
      if (captionIsSave) {
        const saveResult = await this.saveImageFromContext(message.from);
        if (saveResult) {
          await messagingService.send(message.from, saveResult);
          return;
        }
      }

      // Otherwise show analysis and ask to save
      await this.sendLongMessage(message.from, result.message);

      // If vision API flagged something unclear, ask one question
      if (result.needsClarification) {
        await messagingService.send(message.from, result.needsClarification);
      }
    } catch (error) {
      logger.error('Image error:', error);
      await messagingService.send(message.from, "Image error. Try again?");
    }
  }

  // Save image from stored context â€” returns confirmation message or null
  async saveImageFromContext(userPhone) {
    const ctx = this.imageContext.get(userPhone);
    if (!ctx || !ctx.imageUrl) return null;

    try {
      const result = await imageService.saveStructuredImage(userPhone, ctx.imageUrl, {
        title: ctx.title,
        autoTitle: ctx.analysis?.auto_title,
        category: ctx.category,
        description: ctx.description,
        extractedText: ctx.extractedText,
        keyDetails: ctx.keyDetails,
        tags: ctx.tags,
        context: ctx.description
      }, ctx.userTimezone || 'Asia/Kolkata');

      this.imageContext.delete(userPhone);

      if (!result.success) return "Couldn't save. Try again?";

      // Build structured confirmation
      const lang = ctx.lang || 'english';
      let confirm = lang === 'english' ? 'Saved' : 'Save ho gaya';
      confirm += `\n\n*${result.title || 'Image'}*`;
      if (result.category && result.category !== 'Other') {
        confirm += ` [${result.category}]`;
      }
      confirm += `\n${result.savedAt}`;

      // Show key details in confirmation
      const details = ctx.keyDetails || {};
      const lines = [];
      if (details.merchant) lines.push(`Merchant: ${details.merchant}`);
      if (details.amount) lines.push(`Amount: ${details.currency || ''} ${details.amount}`.trim());
      if (details.reference) lines.push(`Ref: ${details.reference}`);
      if (details.route) lines.push(`Route: ${details.route}`);
      if (lines.length > 0) {
        confirm += '\n' + lines.join('\n');
      }

      if (ctx.tags && ctx.tags.length > 0) {
        confirm += `\nTags: ${ctx.tags.slice(0, 5).join(', ')}`;
      }

      return confirm;
    } catch (error) {
      logger.error('saveImageFromContext error:', error);
      return "Couldn't save. Try again?";
    }
  }

  // ========== DOCUMENT/PDF HANDLING ==========
  async handleDocument(message) {
    try {
      const saveOnly = message.documentSaveOnly === true;
      const caption = message.document.caption || message.text || '';
      const lang = caption ? this.detectLanguage(caption) : 'english';

      if (!saveOnly) {
        await messagingService.send(message.from, lang === 'english' ? 'Got it - saving your document...' : 'Theek hai - document save kar raha hun...');
      }

      let mimeType = message.document.mime_type || 'application/octet-stream';
      let fileName = message.document.filename || 'document';
      let buffer;
      if (Buffer.isBuffer(message.document.buffer)) {
        buffer = message.document.buffer;
      } else {
        // Download document from WhatsApp Graph API (requires auth header)
        const accessToken = process.env.META_WHATSAPP_TOKEN;
        if (!accessToken) {
          if (saveOnly) {
            throw createDocumentIngestionError(
              'document_download_not_configured',
              'The server is not configured to download this document',
              { fileName }
            );
          }
          await messagingService.send(message.from, 'Missing WhatsApp token on server (META_WHATSAPP_TOKEN).');
          return;
        }
        const mediaId = message.document.id;
        // 30s timeout matches the file-download call below. Without it, a hung
        // Meta Graph response would hold the user's processing lock forever.
        const mediaResponse = await axios.get(
`https://graph.facebook.com/v21.0/${mediaId}`,
          {
            headers: { 'Authorization':`Bearer ${accessToken}` },
            timeout: 30000
          }
        );

        const mediaUrl = mediaResponse.data.url;
        mimeType = message.document.mime_type || mediaResponse.data.mime_type || 'application/octet-stream';
        fileName = message.document.filename || mediaResponse.data.filename || 'document';
        const fileResponse = await axios.get(mediaUrl, {
          headers: { 'Authorization':`Bearer ${accessToken}` },
          responseType: 'arraybuffer',
          timeout: 30000
        });
        buffer = Buffer.from(fileResponse.data);
      }

      // C8-N fix (Batch F3): magic-byte MIME validation. Until May 19
      // 2026 the bot trusted whatever MIME the WhatsApp client claimed,
      // so a malicious upload labelled `.pdf` could reach pdf-parse or
      // a polyglot zip-bomb labelled `.csv` could crash the parser.
      // We now sniff the first 32 bytes of the actual file content and
      // reject mismatches. Falls open (allowUnknown) only for the CSV
      // and plain-text path since "text" magic detection is heuristic.
      try {
        const { validate } = require('../utils/mime-detect');
        const claimedMime = mimeType || 'application/octet-stream';
        // CSV/text needs the lenient mode; anything binary should match exactly.
        const allowUnknown = /^(text\/|application\/csv)/i.test(claimedMime);
        const v = validate(buffer.slice(0, 256), claimedMime, { allowUnknown });
        if (!v.ok) {
          logger.security('document_mime_mismatch', {
            userPhone: message.from,
            claimedMime,
            detected: v.detected || null,
            fileName,
            reason: v.reason
          });
          if (!saveOnly) {
            await messagingService.send(
              message.from,
              "That file doesn't match its claimed type — I won't process it for safety. If this is a real document, save it as PDF or a standard image format and try again."
            );
          }
          if (saveOnly) {
            throw createDocumentIngestionError(
              'document_mime_mismatch',
              `${fileName} does not match its claimed file type`,
              { fileName }
            );
          }
          return;
        }
      } catch (mimeErr) {
        if (saveOnly) {
          if (mimeErr?.name === 'DocumentIngestionError') throw mimeErr;
          throw createDocumentIngestionError(
            'document_mime_validation_failed',
            `Could not safely validate ${fileName}`,
            { fileName, cause: mimeErr }
          );
        }
        // Don't block legit uploads if the detector itself errors.
        logger.warn(`[Document] MIME check skipped: ${mimeErr.message}`);
      }

      // CSV contact import detection
      const isCSV = mimeType === 'text/csv' || mimeType === 'application/csv' ||
        mimeType === 'text/comma-separated-values' ||
        (fileName && /\.csv$/i.test(fileName)) ||
        (mimeType === 'application/vnd.ms-excel' && fileName && /\.csv$/i.test(fileName));

      if (isCSV && !saveOnly) {
        try {
          const parsed = contactService.parseCSV(buffer);
          if (parsed.error) {
            await messagingService.send(message.from, `Could not parse CSV: ${parsed.error}`);
            return;
          }
          if (parsed.contacts.length === 0) {
            await messagingService.send(message.from, 'No contacts found in the CSV. Make sure it has "Name" and "Phone" columns.');
            return;
          }

          // Store parsed contacts for confirmation
          this.csvImportContext.set(message.from, {
            contacts: parsed.contacts,
            fileName,
            timestamp: Date.now()
          });

          // Show preview
          const total = parsed.contacts.length;
          const preview = parsed.contacts.slice(0, 5).map((c, i) => `${i + 1}. ${c.name} — ${c.phone}`).join('\n');
          const existingCount = await contactService.getContactCount(message.from);

          let msg = `*CSV Import Preview*\n\n`;
          msg += `Found *${total}* contacts in _${fileName}_\n\n`;
          msg += `*First ${Math.min(5, total)}:*\n${preview}\n`;
          if (total > 5) msg += `_...and ${total - 5} more_\n`;
          msg += `\nYou currently have *${existingCount}* saved contacts.`;
          msg += `\nDuplicates (same name) will be updated.\n`;
          msg += `\n*Reply "yes" to import all ${total} contacts.*`;

          await messagingService.send(message.from, msg);
          return;
        } catch (csvError) {
          logger.error('CSV parse error:', csvError.message);
          await messagingService.send(message.from, 'Failed to read the CSV file. Make sure it\'s a valid CSV with Name and Phone columns.');
          return;
        }
      }

      // Store + analyze via fileService
      const result = await fileService.saveUploadedBuffer(
        message.from,
        buffer,
        mimeType,
        fileName,
        caption
      );

      if (!result.success) {
        if (saveOnly) {
          throw createDocumentIngestionError(
            'document_save_failed',
            `Could not save ${fileName}: ${result.error || 'unknown error'}`,
            { fileName }
          );
        }
        if (!saveOnly) {
          await messagingService.send(message.from, `Couldn't save document: ${result.error || 'unknown error'}`);
        }
        return;
      }

      const docName = result.analysis?.document_name || fileName;

      // Store one batch-aware document context. Dashboard batches are saved
      // silently first, then the caption is routed once with every file
      // available to analysis and email tools.
      const attachment = {
        buffer,
        mimeType,
        fileName,
        extractedText: result.analysis?.extracted_text || '',
        documentName: docName,
        documentType: result.analysis?.document_type || 'document',
        description: result.analysis?.description || '',
        timestamp: Date.now()
      };
      const previous = message.documentBatchId
        ? this.documentContext.get(message.from)
        : null;
      const previousBatch = previous?.batchId === message.documentBatchId
        ? documentAttachmentsFromContext(previous).map((item, index) => ({
          ...item,
          extractedText: previous.attachments?.[index]?.extractedText || '',
          documentName: previous.attachments?.[index]?.documentName || item.fileName,
          documentType: previous.attachments?.[index]?.documentType || 'document',
          description: previous.attachments?.[index]?.description || '',
        }))
        : [];
      const attachments = [...previousBatch, attachment].slice(-5);
      this.documentContext.set(message.from, {
        ...attachment,
        batchId: message.documentBatchId || null,
        attachments,
        extractedText: documentTextFromContext({ attachments }) || attachment.extractedText,
      });

      // Check if caption contains email intent (e.g. "attach this resume and send email to xxx@gmail.com")
      const emailFlowType = this.getDirectEmailFlowType(caption);

      if (!saveOnly && emailFlowType) {
        // Trigger the right email flow with this document as attachment
        const userTimezone = await timezoneService.getUserTimezone(message.from);
        const context = await this.getContext(message.from, userTimezone);
        const emailMessage = { from: message.from, text: caption, lang };
        const emailResponse = await this.handleSpecialCommand(emailFlowType, emailMessage, context);
        await this.sendLongMessage(message.from, emailResponse);
        return;
      }

      // Apr 30 2026 — Visa Profile Builder resume intercept removed.
      // Visa profile builder feature moved to a separate dedicated bot.

      if (!saveOnly) {
        await messagingService.send(
          message.from,
          lang === 'english'
            ?`Saved: ${docName}\n\nYou can later say: "show me the ${result.analysis?.document_type || 'document'} I sent"`
            :`Save ho gaya: ${docName}\n\nBaad mein bol: "wo ${result.analysis?.document_type || 'document'} bhejo"`
          );
      }
      if (saveOnly) {
        return {
          status: 'success',
          fileId: result.fileId,
          fileName,
          documentName: docName,
        };
      }
      return docName;
    } catch (error) {
      logger.error('Document error:', error);
      if (message.documentSaveOnly === true) {
        if (error?.name === 'DocumentIngestionError') throw error;
        throw createDocumentIngestionError(
          'document_ingestion_failed',
          `Could not ingest ${message.document?.filename || message.document?.fileName || 'the document'}: ${error.message || 'unknown error'}`,
          {
            fileName: message.document?.filename || message.document?.fileName || 'document',
            cause: error,
          }
        );
      }
      await messagingService.send(message.from, "Document error. Try again?");
      return null;
    }
  }

  async handleImageRetrieval(message) {
    const text = message.text.toLowerCase().trim();

    // ===== DELETE IMAGE COMMAND =====
    const deleteMatch = text.match(/^(delete|remove|forget)\s+(that\s+)?(image|photo|picture)/i)
      || text.match(/^(delete|remove|forget)\s+(the\s+)?saved\s+(image|photo)/i);
    if (deleteMatch) {
      const result = await imageService.deleteImageBySearch(message.from, message.text);
      if (result.success) {
        const title = result.deleted.title || result.deleted.document_name || 'Image';
        await messagingService.send(message.from, `Deleted: ${title}`);
        return true;
      }
      if (result.multiple) {
        const list = imageService.formatImagesList(result.matches);
        await messagingService.send(message.from, `Multiple images found. Which one?\n\n${list}`);
        this.imageListContext.set(message.from, { images: result.matches, timestamp: Date.now(), deleteMode: true });
        setTimeout(() => this.imageListContext.delete(message.from), 5 * 60 * 1000);
        return true;
      }
      await messagingService.send(message.from, "No matching image found to delete.");
      return true;
    }

    // ===== "NOT THIS ONE" FOLLOW-UP (after single image was sent) =====
    const listCtx = this.imageListContext.get(message.from);
    const hasRecentImageCtx = listCtx && listCtx.lastSentImage && (Date.now() - listCtx.timestamp) < 5 * 60 * 1000;
    // Only check "not this one" patterns when we recently sent an image
    if (hasRecentImageCtx) {
      const notThisOne = /\b(ye\s+wala\s+nahi|ye\s+nahi|nahi\s+ye|not\s+this(\s+one)?|wrong\s+one|dusra|doosra|koi\s+aur|another\s+one|next\s+one|galat|not\s+the\s+right|different\s+one|nhi\s+ye|ye\s+nhi)\b/i.test(text)
        || /^(nahi|nhi|no|nope|wrong|galat)\s*[.!]?$/i.test(text);
      if (notThisOne) {
        // Re-search with original query, exclude the image we already sent
        const allMatches = await imageService.searchImages(message.from, listCtx.originalQuery);
        const filtered = allMatches.filter(img => img.id !== listCtx.lastSentImage.id);

        if (filtered.length === 0) {
          this.imageListContext.delete(message.from);
          await messagingService.send(message.from, "That's the only matching image I have saved. Can you describe what you're looking for?");
          return true;
        }

        if (filtered.length === 1) {
          const img = filtered[0];
          const summary = imageService.formatImageSummary(img);
          try {
            await messagingService.sendImage(message.from, img.image_url, summary);
          } catch (e) {
            await messagingService.send(message.from, `${summary}\n\nImage: ${img.image_url}`);
          }
          this.imageListContext.set(message.from, {
            lastSentImage: img,
            originalQuery: listCtx.originalQuery,
            timestamp: Date.now()
          });
          setTimeout(() => this.imageListContext.delete(message.from), 5 * 60 * 1000);
          return true;
        }

        // Multiple remaining â€” show list
        const response = imageService.formatImagesList(filtered);
        this.imageListContext.set(message.from, { images: filtered, timestamp: Date.now() });
        setTimeout(() => this.imageListContext.delete(message.from), 5 * 60 * 1000);
        await messagingService.send(message.from, `Here are the other saved images:\n\n${response}`);
        return true;
      }
    }

    // ===== LIST ALL SAVED IMAGES =====
    if (text.match(/^(show|see|view|list|open)\s*(my\s*)?(all\s*)?(saved\s+)?images?$/i)) {
      const images = await imageService.getUserImages(message.from);
      const response = imageService.formatImagesList(images);
      if (images.length > 0) {
        this.imageListContext.set(message.from, { images, timestamp: Date.now() });
        setTimeout(() => this.imageListContext.delete(message.from), 5 * 60 * 1000);
      }
      await messagingService.send(message.from, response);
      return true;
    }

    // ===== EXPLICIT IMAGE RECALL ONLY =====
    // Only trigger on messages that are clearly asking to retrieve/see a previously saved image.
    // Patterns that qualify:
    // "show me that image again"
    // "send the saved ticket image"
    // "do you remember the ticket image I shared? share it"
    // "give me the receipt photo from last week"
    // "open the image I saved about the restaurant bill"
    //
    // Patterns that do NOT qualify (must NOT trigger):
    // "what was the PNR on my ticket?" (asking about info, not the image)
    // "how much was the restaurant bill?" (discussing topic)
    // "I have an invoice to pay" (different context)

    const isExplicitImageRequest = this.isExplicitImageRecallRequest(text);

    if (isExplicitImageRequest) {
      const matches = await imageService.searchImages(message.from, message.text);

      if (matches.length === 1) {
        // Single match â€” send image + structured summary
        const img = matches[0];
        const summary = imageService.formatImageSummary(img);
        try {
          await messagingService.sendImage(message.from, img.image_url, summary);
        } catch (e) {
          await messagingService.send(message.from, `${summary}\n\nImage: ${img.image_url}`);
        }
        // Track sent image so "not this one" can trigger re-search
        this.imageListContext.set(message.from, {
          lastSentImage: img,
          originalQuery: message.text,
          timestamp: Date.now()
        });
        setTimeout(() => this.imageListContext.delete(message.from), 5 * 60 * 1000);
        return true;
      }

      if (matches.length > 1) {
        // Multiple matches â€” show list, ask to choose
        const response = imageService.formatImagesList(matches);
        this.imageListContext.set(message.from, { images: matches, timestamp: Date.now() });
        setTimeout(() => this.imageListContext.delete(message.from), 5 * 60 * 1000);
        await messagingService.send(message.from, `I found multiple saved images:\n\n${response}`);
        return true;
      }

      // No match â€” ask for a clue
      await messagingService.send(message.from,
        "I couldn't find a matching saved image. Can you give me a clue?\n- Approximate date\n- Category (ticket, receipt, bill, etc.)\n- What it contained");
      return true;
    }

    // ===== AMBIGUOUS MESSAGE â€” could be image request or general question =====
    // If text mentions a saved image keyword + recall verb but lacks explicit image request wording,
    // ask for clarification instead of guessing
    const isAmbiguous = this.isAmbiguousImageMention(text);
    if (isAmbiguous) {
      await messagingService.send(message.from,
        "Do you want me to share the saved image, or just summarize the details?");
      // Set a context so we can handle the follow-up
      this.imageListContext.set(message.from, { ambiguousQuery: message.text, timestamp: Date.now() });
      setTimeout(() => this.imageListContext.delete(message.from), 3 * 60 * 1000);
      return true;
    }

    // ===== NUMBER SELECTION (from a previous list) =====
    const numMatch = text.match(/^(\d+)$/);
    if (numMatch) {
      const listCtx = this.imageListContext.get(message.from);
      if (listCtx && listCtx.images && (Date.now() - listCtx.timestamp) < 5 * 60 * 1000) {
        const num = parseInt(numMatch[1]);
        if (num > 0 && num <= listCtx.images.length) {
          const img = listCtx.images[num - 1];

          if (listCtx.deleteMode) {
            await imageService.deleteImage(message.from, img.id);
            this.imageListContext.delete(message.from);
            await messagingService.send(message.from, `Deleted: ${img.title || img.document_name || 'Image'}`);
            return true;
          }

          const summary = imageService.formatImageSummary(img);
          try {
            await messagingService.sendImage(message.from, img.image_url, summary);
          } catch (e) {
            await messagingService.send(message.from, `${summary}\n\nImage: ${img.image_url}`);
          }
          this.imageListContext.delete(message.from);
          return true;
        }
      }
    }

    // ===== FOLLOW-UP TO AMBIGUOUS QUERY =====
    const ambiguousCtx = this.imageListContext.get(message.from);
    if (ambiguousCtx && ambiguousCtx.ambiguousQuery && (Date.now() - ambiguousCtx.timestamp) < 3 * 60 * 1000) {
      const wantsImage = /^(image|photo|share|send|show|yes|haan)/i.test(text);
      const wantsSummary = /^(summary|summarize|details|just|no|nahi)/i.test(text);

      if (wantsImage) {
        // They want the actual image
        const matches = await imageService.searchImages(message.from, ambiguousCtx.ambiguousQuery);
        this.imageListContext.delete(message.from);
        if (matches.length === 1) {
          const img = matches[0];
          const summary = imageService.formatImageSummary(img);
          try {
            await messagingService.sendImage(message.from, img.image_url, summary);
          } catch (e) {
            await messagingService.send(message.from, `${summary}\n\nImage: ${img.image_url}`);
          }
          return true;
        }
        if (matches.length > 1) {
          const response = imageService.formatImagesList(matches);
          this.imageListContext.set(message.from, { images: matches, timestamp: Date.now() });
          await messagingService.send(message.from, response);
          return true;
        }
        await messagingService.send(message.from, "No matching image found.");
        return true;
      }

      if (wantsSummary) {
        // They just want the details â€” let it fall through to general AI chat
        this.imageListContext.delete(message.from);
        return false;
      }
    }

    return false;
  }

  // Returns true ONLY for messages that are clearly requesting to see/retrieve a saved image
  isExplicitImageRecallRequest(text) {
    const verbs = /\b(show|send|re-?send|share|give|open|forward|find|get|fetch|retrieve)\b/i;
    const imageWords = /\b(image|photo|picture|pic|screenshot)\b/i;
    const docWords = /\b(ticket|receipt|bill|invoice|boarding\s*pass|document)\b/i;
    const savedWords = /\b(saved|stored|kept|shared|uploaded)\b/i;
    const againWords = /\b(again|back|earlier|before|previous|last\s+time)\b/i;

    // Pattern 1: verb + "saved/shared" + image/photo
    if (verbs.test(text) && savedWords.test(text) && (imageWords.test(text) || docWords.test(text))) return true;

    // Pattern 2: verb + image/photo + "again/back/earlier"
    if (verbs.test(text) && imageWords.test(text) && againWords.test(text)) return true;

    // Pattern 3: "remember/recall" + image + verb
    if (/\b(remember|recall)\b/i.test(text) && (imageWords.test(text) || docWords.test(text)) && verbs.test(text)) return true;

    // Pattern 4: verb + docType + image ("send the ticket image", "show receipt photo")
    if (verbs.test(text) && docWords.test(text) && imageWords.test(text)) return true;

    // Pattern 5: verb + "me" + "that/the" + image ("send me that image", "show me the photo")
    if (/\b(show|send|re-?send|share|give|forward)\b.*\bme\b.*\b(that|the|my)\b.*\b(image|photo|picture|pic)\b/i.test(text)) return true;

    // Pattern 6: "I need/want" + "that/the/my" + image/doc
    if (/\b(i\s+need|i\s+want|can\s+you)\b.*\b(that|the|my)\b.*\b(image|photo|picture|ticket|receipt|bill|invoice)\b/i.test(text)) return true;

    // Pattern 7: verb + "the image/photo I shared/saved"
    if (verbs.test(text) && /\b(image|photo|picture)\b.*\b(i\s+shared|i\s+saved|i\s+sent|i\s+uploaded)\b/i.test(text)) return true;

    // Pattern 8: "resend/forward that image/photo"
    if (/\b(re-?send|forward)\b.*\b(that|the|this)?\s*(image|photo|picture|pic|ticket|receipt)\b/i.test(text)) return true;

    // Pattern 9: "where is the image/ticket I saved"
    if (/\b(where|where's)\b.*\b(image|photo|ticket|receipt|bill)\b.*\b(saved|shared|uploaded)\b/i.test(text)) return true;

    // Pattern 10: "show/see my saved images" / "my saved photos"
    if (/\b(show|see|view|list)\b.*\bmy\b.*\b(saved\s+)?(images?|photos?|pictures?)\b/i.test(text)) return true;

    return false;
  }

  // Returns true for messages that mention image-related content ambiguously
  // (could be asking about the image or just discussing the topic)
  isAmbiguousImageMention(text) {
    const hasDocKeyword = /\b(ticket|receipt|bill|invoice|boarding|pnr)\b/i.test(text);
    const hasRecallVerb = /\b(remember|recall|find|where)\b/i.test(text);
    const hasImageWord = /\b(image|photo|picture|pic)\b/i.test(text);

    // "do you remember that ticket?" or "where is my receipt?" â€” could be about the image or just info
    if (hasDocKeyword && hasRecallVerb && !hasImageWord) return true;

    // "find the invoice" â€” ambiguous without "image/photo"
    if (hasDocKeyword && /\b(find|where|show)\b/i.test(text) && !hasImageWord && !/\bsaved\b/i.test(text)) return true;

    return false;
  }

  async handleImageFollowUp(message, params = {}) {
    const text = message.text.toLowerCase().trim();
    const imgCtx = this.imageContext.get(message.from);
    const hasRecent = imgCtx && (Date.now() - imgCtx.timestamp) < 10 * 60 * 1000;

    if (!hasRecent) {
      return params.action ? {
        status: 'waiting_input',
        data: { required_context: 'recent_image' },
        user_summary: 'There is no recent image waiting to be saved. Send an image first.',
      } : null;
    }

    if (params.action === 'discard') {
      this.imageContext.delete(message.from);
      return 'Okay, image not saved.';
    }
    if (params.action === 'save_with_title') {
      imgCtx.title = String(params.title || '').trim();
      return await this.saveImageFromContext(message.from);
    }
    if (params.action === 'save') {
      return await this.saveImageFromContext(message.from);
    }

    // Check if user wants to save
    const wantsToSave = /^(save|store|keep|remember|yaad rakh)(\s+(this|it|the|image|photo|picture))*[.!]?$/i.test(text)
      || /^(yes|ok|sure|haan|ha|yep|yeah)/i.test(text);

    // Check if user is providing a custom title for the image
    const titleMatch = text.match(/^(?:save|store|keep|remember)\s+(?:(?:this|it)\s+)?(?:as|with\s+title|named?)\s+["']?(.+?)["']?$/i);

    // Check if user wants to delete/discard
    const wantsDiscard = /^(no|nah|nahi|skip|discard|don'?t save|cancel)/i.test(text);

    if (wantsDiscard) {
      this.imageContext.delete(message.from);
      return 'Okay, image not saved.';
    }

    if (titleMatch) {
      // User provided a custom title
      imgCtx.title = titleMatch[1].trim();
    }

    if (wantsToSave || titleMatch) {
      return await this.saveImageFromContext(message.from);
    }

    return null;
  }

  getImageContext(userPhone) {
    const ctx = this.imageContext.get(userPhone);
    if (!ctx || (Date.now() - ctx.timestamp) >= 10 * 60 * 1000) return null;
    // Return a structured summary for the AI system prompt
    const parts = [];
    if (ctx.title) parts.push(`Title: ${ctx.title}`);
    if (ctx.category) parts.push(`Category: ${ctx.category}`);
    if (ctx.description) parts.push(`Description: ${ctx.description}`);
    const details = ctx.keyDetails || {};
    if (details.merchant) parts.push(`Merchant: ${details.merchant}`);
    if (details.amount) parts.push(`Amount: ${details.amount}`);
    if (details.reference) parts.push(`Ref: ${details.reference}`);
    return parts.join('; ') || ctx.description || null;
  }

  async handleMemoryCommand(userPhone, command) {
    switch (command.action) {
      case 'showTrunk':
      case 'show_all': {
        const trunk = await memoryService.getMemoryTrunk(userPhone);
        if (!trunk || Object.keys(trunk).length === 0) {
          return "I don't have any memories saved for you yet.\n\nTell me things and I'll remember! Just say it naturally.";
        }
        const formatted = memoryService.formatTrunk ? memoryService.formatTrunk(trunk) : null;
        if (formatted) return formatted;
        // Fallback formatting
        let response = '*Everything I remember about you:*\n\n';
        for (const [category, items] of Object.entries(trunk)) {
          response += `*${category.charAt(0).toUpperCase() + category.slice(1)}*\n`;
          items.forEach(m => {
            const val = m.value.length > 80 ? m.value.slice(0, 80) + '...' : m.value;
            response += `- ${m.key}: ${val}\n`;
          });
          response += '\n';
        }
        response += '_"forget [key]" to delete_';
        return response;
      }
      case 'show_category': {
        const trunk2 = await memoryService.getMemoryTrunk(userPhone);
        const catItems = trunk2[command.category];
        if (!catItems || catItems.length === 0) return `No memories in "${command.category}" category.`;
        let resp = `*${command.category.charAt(0).toUpperCase() + command.category.slice(1)} Memories*\n\n`;
        catItems.forEach(m => { resp += `- ${m.key}: ${m.value}\n`; });
        return resp;
      }
      case 'forget': {
        const deleted = await memoryService.deleteMemory(userPhone, command.key);
        return deleted ?`Forgot "${command.key}"` :`Couldn't find "${command.key}"`;
      }
      case 'clearAll':
      case 'clear_all':
        await memoryService.clearAllMemories(userPhone);
        return "All cleared";
      default:
        return "Try: 'show memory trunk'";
    }
  }

  async handleTimezoneQuery(userPhone, userTimezone) {
    const currentTime = timezoneService.getCurrentTimeInTimezone(userTimezone);
    return `Timezone: ${timezoneService.getFriendlyTimezoneName(userTimezone)}\nTime: ${currentTime}`;
  }

  async handleSetTimezone(userPhone, timezoneInput) {
    const result = await timezoneService.setUserTimezone(userPhone, timezoneInput);
    if (!result.success) return `Couldn't recognize "${timezoneInput}"`;
    return `Timezone updated: ${result.currentTime}`;
  }

  async sendLongMessage(to, text) {
    await messagingService.sendLong(to, text);
  }

  async getContext(userPhone, userTimezone) {
    // Cached wrapper: 60s TTL + stale-while-revalidate.
    // getContext fires 7-10 DB/API calls — the cache eliminates ~60% of them for
    // rapid-fire users. All write paths (reminder create, list add, memory save,
    // contact add, note save, calendar event create) must call contextCache.bust(userPhone)
    // to invalidate. See src/utils/context-cache.js for details.
    // Note: imageContext is pulled FRESH on every call (not cached) because it
    // reflects in-memory state that changes during a turn.
    try {
      const contextCache = require('../utils/context-cache');
      const cached = await contextCache.getOrBuild(userPhone, () =>
        this._buildContextUncached(userPhone, userTimezone)
      );
      if (!cached) return { userTimezone };
      // Refresh volatile fields every call (not cached).
      return {
        ...cached,
        imageContext: this.getImageContext(userPhone),
        userTimezone // caller-provided timezone wins (may differ from cache time)
      };
    } catch (error) {
      logger.warn('Context cache error, falling back to uncached:', error.message);
      return this._buildContextUncached(userPhone, userTimezone);
    }
  }

  async _buildContextUncached(userPhone, userTimezone) {
    try {
      // Fetch all context in parallel for speed
      const [trunk, pendingReminders, lists, contacts, googleConnected] = await Promise.all([
        memoryService.getMemoryTrunk(userPhone),
        reminderService.getPendingReminders(userPhone).catch(() => []),
        listService.getUserLists(userPhone).catch(() => []),
        contactService.getAllContacts(userPhone).catch(() => []),
        googleAuthService.isConnected(userPhone).catch(() => false)
      ]);

      // Build rich user info from ALL memory categories
      let userInfo = '';
      if (trunk && Object.keys(trunk).length > 0) {
        const memoryParts = [];
        for (const [category, memories] of Object.entries(trunk)) {
          memories.slice(0, 8).forEach(m => {
            memoryParts.push(`${m.key}: ${m.value}`);
          });
        }
        userInfo = memoryParts.join('; ');
      }

      // Build reminders summary
      let remindersInfo = '';
      if (pendingReminders.length > 0) {
        remindersInfo = pendingReminders.slice(0, 5).map(r => {
          const time = new Date(r.reminder_time).toLocaleString('en-IN', {
            timeZone: userTimezone, hour: 'numeric', minute: '2-digit', hour12: true,
            day: 'numeric', month: 'short'
          });
          return `"${r.message}" at ${time}`;
        }).join('; ');
      }

      // Build lists summary
      let listsInfo = '';
      if (lists.length > 0) {
        listsInfo = lists.map(l =>
`${l.list_name} (${l.item_count || 0} items)`
        ).join(', ');
      }

      // Build contacts summary (names only, never phones)
      let contactsInfo = '';
      if (contacts.length > 0) {
        contactsInfo = contacts.map(c => c.name).join(', ');
      }

      // Build calendar info if connected
      let calendarInfo = null;
      if (googleConnected) {
        try {
          const upcoming = await calendarService.getUpcomingEvents(userPhone, 12);
          if (upcoming.length > 0) {
            calendarInfo = upcoming.slice(0, 5).map(e => {
              const start = new Date(e.start?.dateTime || e.start?.date);
              const timeStr = start.toLocaleString('en-IN', {
                timeZone: userTimezone, hour: 'numeric', minute: '2-digit', hour12: true
              });
              return `"${e.summary || 'No title'}" at ${timeStr}`;
            }).join('; ');
          }
        } catch (e) { /* calendar info is optional */ }
      }

      // Build tasks summary
      let tasksInfo = '';
      try {
        const taskDigest = await taskService.getTaskDigest(userPhone);
        if (taskDigest) tasksInfo = taskDigest;
      } catch (e) { /* tasks info is optional */ }

      // Build notes summary
      let notesInfo = '';
      try {
        const topics = await memoryService.getAllNoteTopics(userPhone);
        if (topics.length > 0) {
          notesInfo = topics.map(t => `${t.topic} (${t.count})`).join(', ');
        }
      } catch (e) { /* notes info is optional */ }

      // Last saved contact (for contextual references)
      const lastContact = this.lastSavedContact.get(userPhone);
      const recentContactInfo = lastContact && (Date.now() - lastContact.timestamp) < 30 * 60 * 1000
        ?`Recently saved: ${lastContact.name}` : null;

      // Sales leads summary
      let salesInfo = '';
      try {
        const summary = await salesService.getPipelineSummary(userPhone);
        if (summary.stages.length > 0) {
          const total = summary.stages.reduce((sum, s) => sum + parseInt(s.count), 0);
          salesInfo = `${total} leads in pipeline`;
          if (summary.followupsDue > 0) salesInfo += `, ${summary.followupsDue} follow-ups due`;
        }
      } catch (e) { /* sales info is optional */ }

      return {
        userTimezone,
        userInfo: userInfo || null,
        remindersInfo: remindersInfo || null,
        listsInfo: listsInfo || null,
        contactsInfo: contactsInfo || null,
        recentContactInfo,
        tasksInfo: tasksInfo || null,
        notesInfo: notesInfo || null,
        salesInfo: salesInfo || null,
        imageContext: this.getImageContext(userPhone),
        googleConnected,
        calendarInfo
      };
    } catch (error) {
      logger.warn('Context error:', error.message);
      return { userTimezone };
    }
  }

  // ========== UNIFIED INTENT EXECUTOR (Tool Calling) ==========
  // Routes tool-calling intents to existing handlers.
  // New intent types from tool-definitions.js are mapped here,
  // while legacy intent types fall through to handleSpecialCommand.
  async executeIntent(type, params, message, context) {

    if (DISABLED_GOOGLE_INTENTS.has(type)) {
      return disabledGoogleFeatureMessage();
    }

    switch (type) {

      // === Clarification (request_clarification tool) ===
      // The intent LLM decided the message is actionable but ambiguous, and
      // asking one short question beats guessing a side-effectful tool. The
      // user's answer flows back through detectIntent with this question in
      // conversation history, which is what resolves the follow-up.
      case 'clarify': {
        const question = String(params.question || '').trim()
          || 'Just to confirm — what exactly would you like me to do?';
        const options = Array.isArray(params.options)
          ? params.options.filter(o => typeof o === 'string' && o.trim()).slice(0, 4)
          : [];

        // Remember what we asked so the NEXT message resolves against it via
        // context hints (deterministic round-trip, independent of history).
        this.lastClarificationContext.set(message.from, {
          question,
          options,
          originalText: String(params.full_text || message.text || ''),
          timestamp: Date.now(),
        });

        // Telemetry: clarification frequency + the message that triggered it
        // is a direct map of where tool descriptions still overlap. Grep for
        // [ClarifyAsked] to analyze.
        logger.info(`[ClarifyAsked] msg="${String(message.text || '').slice(0, 120)}" question="${question.slice(0, 120)}" options=${options.length}`);

        if (options.length >= 2) {
          const optionLines = options.map((o, i) => `${i + 1}. ${o.trim()}`).join('\n');
          return `${question}\n\n${optionLines}\n\n_Reply with a number or just tell me._`;
        }
        return question;
      }

      // === Dashboard (previously keyword-matched) ===
      case 'dashboard': {
        const section = params.section || 'overview';
        switch (section) {
          case 'overview': return await dashboardService.getDashboard(message.from);
          case 'reminders': return await dashboardService.getRemindersView(message.from);
          case 'recurring_reminders': return await this.getRecurringRemindersView(message.from);
          case 'memories': return await dashboardService.getMemoriesView(message.from);
          case 'lists': return await dashboardService.getListsView(message.from);
          case 'contacts': {
            const tz = await timezoneService.getUserTimezone(message.from);
            const contacts = await contactService.getAllContacts(message.from);
            return contactService.formatContactsList(contacts, tz);
          }
          case 'images': {
            this.dashboardImageContext.set(message.from, { timestamp: Date.now() });
            return await dashboardService.getImagesView(message.from);
          }
          default: return await dashboardService.getDashboard(message.from);
        }
      }

      case 'dashboard_delete': {
        const { item_type, index } = params;
        if (item_type === 'reminder') return await dashboardService.deleteReminderByIndex(message.from, index);
        if (item_type === 'image') return await dashboardService.deleteImageByIndex(message.from, index);
        if (item_type === 'recurring') return await this.cancelRecurringByIndex(message.from, index);
        return 'Could not determine what to delete.';
      }

      // === Images (previously 10+ regex patterns) ===
      case 'image_manage': {
        const action = params.action || 'search';
        if (action === 'list') {
          const images = await imageService.getUserImages(message.from);
          if (!images || images.length === 0) return 'No saved images found.';
          this.imageListContext.set(message.from, { images, timestamp: Date.now() });
          return images.map((img, i) => `${i + 1}. ${img.title || img.description || 'Image'} (${new Date(img.created_at).toLocaleDateString()})`).join('\n');
        }
        if (action === 'select_number') {
          const imgListCtx = this.imageListContext.get(message.from);
          const dashCtx = this.dashboardImageContext.get(message.from);
          if (dashCtx && (Date.now() - dashCtx.timestamp) < 5 * 60 * 1000) {
            const result = await dashboardService.getImageByIndex(message.from, params.number);
            if (result.success) {
              try { await messagingService.sendImage(message.from, result.url, result.caption); } catch (e) { await messagingService.send(message.from, `Image: ${result.url}`); }
              return null; // Already sent
            }
            return result.message;
          }
          if (imgListCtx && (Date.now() - imgListCtx.timestamp) < 5 * 60 * 1000) {
            const idx = params.number - 1;
            if (idx >= 0 && idx < imgListCtx.images.length) {
              const img = imgListCtx.images[idx];
              try { await messagingService.sendImage(message.from, img.url, img.title || 'Saved image'); } catch (e) { await messagingService.send(message.from, `Image: ${img.url}`); }
              return null;
            }
            return 'Invalid number. Try again.';
          }
          return 'No image list active. Say "my images" first.';
        }
        if (action === 'delete') {
          const { extractQuery: extractImgQuery } = require('../utils/query-extractor');
          const imgExtracted = await extractImgQuery(params.search_query || message.text, 'image');
          const searchQuery = imgExtracted.query || params.search_query || message.text;
          return await imageService.deleteImageBySearch(message.from, searchQuery);
        }
        const typedSearchQuery = String(params.search_query || '').trim();
        if (typedSearchQuery) {
          const matches = await imageService.searchImages(message.from, typedSearchQuery);
          if (matches.length === 1) {
            const img = matches[0];
            const summary = imageService.formatImageSummary(img);
            try {
              await messagingService.sendImage(message.from, img.image_url, summary);
            } catch (error) {
              await messagingService.send(message.from, `${summary}\n\nImage: ${img.image_url}`);
            }
            this.imageListContext.set(message.from, {
              lastSentImage: img,
              originalQuery: typedSearchQuery,
              timestamp: Date.now(),
            });
            return true;
          }
          if (matches.length > 1) {
            const response = imageService.formatImagesList(matches);
            this.imageListContext.set(message.from, { images: matches, timestamp: Date.now() });
            await messagingService.send(message.from, `I found multiple saved images:\n\n${response}`);
            return true;
          }
          await messagingService.send(message.from,
            "I couldn't find a matching saved image. Can you give me a clue?\n- Approximate date\n- Category (ticket, receipt, bill, etc.)\n- What it contained");
          return true;
        }
        // Default: search
        return await this.handleImageRetrieval(message);
      }

      case 'image_save': {
        return await this.handleImageFollowUp(message, params || {});
      }

      // === Contacts (previously 11 regex patterns) ===
      case 'contact_save': {
        const genericNamePattern = /^(unknown|unnamed|n\/a|na|none|no name|contact|person|someone)$/i;
        const isValidName = params.name && params.name.trim().length >= 2 && !genericNamePattern.test(params.name.trim());
        if (isValidName && params.phone) {
          return await this.handleContactCommand(message.from, { action: 'save', name: params.name.trim(), phone: params.phone }, context.userTimezone);
        }
        // Phone found but no valid name — ask the user
        if (params.phone && !isValidName) {
          const masked = contactService.maskPhone((params.phone || '').replace(/[\s\-\+]/g, ''));
          return `What name should I save *${masked}* as?`;
        }
        // Fall back to existing handler to try parsing
        const cmd = contactService.parseContactCommand(message.text);
        if (cmd && cmd.action === 'save') {
          return await this.handleContactCommand(message.from, cmd, context.userTimezone);
        }
        return await aiService.chat(message.from, message.text, context);
      }

      case 'contact_bulk_save': {
        const contactsList = params.contacts;
        if (!contactsList || !Array.isArray(contactsList) || contactsList.length === 0) {
          return 'No contacts found in your message. Send contacts like:\n"save contacts: Rahul 9876543210, Priya 8765432109"';
        }
        const result = await contactService.bulkSaveContacts(message.from, contactsList);
        let response = '';
        if (result.saved.length > 0) {
          response += `*Saved ${result.saved.length} contact${result.saved.length > 1 ? 's' : ''}*\n`;
          result.saved.slice(0, 10).forEach(c => { response += `- ${c.name} — ${contactService.maskPhone(c.phone)}\n`; });
          if (result.saved.length > 10) response += `_...and ${result.saved.length - 10} more_\n`;
        }
        if (result.updated.length > 0) {
          response += `\n*Updated ${result.updated.length} contact${result.updated.length > 1 ? 's' : ''}*\n`;
          result.updated.slice(0, 5).forEach(c => { response += `- ${c.name}\n`; });
        }
        if (result.failed.length > 0) {
          response += `\n*${result.failed.length} failed:*\n`;
          result.failed.slice(0, 5).forEach(c => { response += `- ${c.name}: ${c.reason}\n`; });
        }
        if (!response) response = 'No contacts were saved. Please check the format.';
        return response.trim();
      }

      case 'contact_manage': {
        if (params.action === 'list') {
          const tz = await timezoneService.getUserTimezone(message.from);
          const contacts = await contactService.getAllContacts(message.from);
          return contactService.formatContactsList(contacts, tz);
        }
        if (params.action === 'get' && params.name) {
          return await this.handleContactCommand(message.from, { action: 'get', name: params.name }, context.userTimezone);
        }
        if (params.action === 'delete' && params.name) {
          return await this.handleContactCommand(message.from, { action: 'delete', name: params.name }, context.userTimezone);
        }
        if (params.action === 'update' && params.name && params.phone) {
          return await this.handleContactCommand(message.from, { action: 'update', name: params.name, phone: params.phone }, context.userTimezone);
        }
        // Fall back to existing parser
        const cmd = contactService.parseContactCommand(message.text);
        if (cmd) return await this.handleContactCommand(message.from, cmd, context.userTimezone);
        return await aiService.chat(message.from, message.text, context);
      }

      // === Timezone (previously 3 regex patterns) ===
      case 'timezone_set': {
        const input = params.timezone_input || message.text;
        return await this.handleSetTimezone(message.from, input);
      }

      case 'timezone_view': {
        const tz = await timezoneService.getUserTimezone(message.from);
        return await this.handleTimezoneQuery(message.from, tz);
      }

      // === Memory (previously regex patterns) ===
      case 'memory_recall': {
        const action = params.action || 'recall';
        const versionedMemory = require('../services/versioned-memory.service');
        if (action === 'forget') {
          const result = await versionedMemory.forgetCurrentFact({
            userPhone: message.from,
            key: params.key,
            subject: params.subject || 'user',
          });
          if (!result.success) {
            return {
              status: 'failure', user_summary: result.error.message,
              error: { ...result.error, category: 'execution', retryable: false },
            };
          }
          return result.forgotten > 0 ? `Forgot "${params.key}".` : `No current memory matched "${params.key}".`;
        }
        if (action === 'clear_all') {
          const result = await versionedMemory.clearCurrentFacts({ userPhone: message.from });
          if (!result.success) {
            return {
              status: 'failure', user_summary: result.error.message,
              error: { ...result.error, category: 'execution', retryable: false },
            };
          }
          return `Cleared ${result.cleared} current memor${result.cleared === 1 ? 'y' : 'ies'}.`;
        }
        const recalled = await versionedMemory.recallCurrentFacts({
          userPhone: message.from,
          query: action === 'recall' ? params.query : '',
          category: action === 'show_category' ? params.category : null,
          limit: action === 'recall' ? 10 : 100,
        });
        if (!recalled.success) {
          return {
            status: 'failure', user_summary: recalled.error.message,
            error: { ...recalled.error, category: 'execution', retryable: true },
          };
        }
        if (recalled.facts.length === 0) {
          return action === 'recall'
            ? `I don't have a current memory matching "${params.query}".`
            : 'I do not have any current memories in that scope.';
        }
        const lines = recalled.facts.map((fact) => {
          const owner = fact.subject && fact.subject !== 'user' ? `${fact.subject}/` : '';
          return `- ${owner}${fact.key_name}: ${fact.value}`;
        });
        return `*Current memories*\n\n${lines.join('\n')}`;
      }

      // === Delegation with params from LLM tool calling ===
      case 'delegate': return await this.handleDelegate(message, params);

      // === Workflow confirmations (previously short-circuited by BoundedMap checks) ===
      case 'calendar_confirm': {
        const calConfirm = this.calendarConfirmContext.get(message.from);
        if (calConfirm && (Date.now() - calConfirm.timestamp) < this.workflowContextTtls.calendarConfirm) {
          return await this.handleCalendarConfirmation(message, calConfirm);
        }
        return null; // No active context
      }

      case 'email_confirm': {
        // Try scheduled email, then bulk email, then draft confirmation
        const schedCtx = this.scheduledEmailContext.get(message.from);
        if (schedCtx && (Date.now() - schedCtx.timestamp) < this.workflowContextTtls.scheduledEmail) {
          return await this.handleScheduledEmailConfirm(message);
        }
        const bulkCtx = this.bulkEmailContext.get(message.from);
        if (bulkCtx && (Date.now() - bulkCtx.timestamp) < this.workflowContextTtls.bulkEmail) {
          return await this.handleBulkEmailConfirm(message);
        }
        return null;
      }

      case 'email_reuse': {
        const tz = await timezoneService.getUserTimezone(message.from);
        return await this.handleRecentEmailReuse(message, tz, params || {});
      }

      case 'sales_email_confirm': {
        const salesCtx = this.salesEmailContext.get(message.from);
        if (salesCtx && (Date.now() - salesCtx.timestamp) < this.workflowContextTtls.salesEmail) {
          return await this.handleSalesEmailConfirm(message);
        }
        return null;
      }

      case 'leave_approval': {
        const leaveCtx = this.leaveConfirmContext.get(message.from);
        if (leaveCtx && (Date.now() - leaveCtx.timestamp) < this.workflowContextTtls.leaveConfirm) {
          return await this.handleLeaveApproval(message, leaveCtx);
        }
        // This tool is a context-bound confirmation reply and is deliberately
        // exempt from a second gate. Never reinterpret a bare "approve" as a
        // fresh manage_leave operation: the old fallback selected the newest
        // pending request and mutated it without an active preview.
        return {
          status: 'waiting_input',
          data: { pending: false },
          user_summary: 'There is no active leave request awaiting your approval. Name the employee or provide the leave request ID.',
        };
      }

      case 'standup_setup': {
        const setupCtx = this.standupSetupContext.get(message.from);
        if (setupCtx && (Date.now() - setupCtx.timestamp) < this.workflowContextTtls.standupSetup) {
          return await this.handleStandupSetup(message, setupCtx);
        }
        return {
          status: 'waiting_input',
          data: { pending: false },
          user_summary: 'There is no active standup setup. Start one by asking Ari to set up a smart standup.',
        };
      }

      case 'standup_response': {
        const standupCtx = this.standupResponseContext.get(message.from);
        if (standupCtx && (Date.now() - standupCtx.timestamp) < this.workflowContextTtls.standupResponse) {
          return await this.handleStandupResponse(message, standupCtx);
        }
        return null;
      }

      case 'poll_vote': {
        const pollCtx = this.pollVoteContext.get(message.from);
        if (pollCtx && (Date.now() - pollCtx.timestamp) < this.workflowContextTtls.pollVote) {
          return await this.handlePollVote(message, pollCtx);
        }
        return null;
      }

      // === All other intents — delegate to existing handleSpecialCommand ===
      default:
        return await this.handleSpecialCommand(type, message, context, params);
    }
  }

  async handleSpecialCommand(type, message, context, intentParams = null) {
    switch (type) {
      case 'reminder': {
        // Check for batch reminders first
        if (batchReminderService.isBatchReminder(message.text)) {
          return await this.handleBatchReminder(message, context.userTimezone);
        }
        return await this.handleReminder(message, context.userTimezone, intentParams);
      }
      case 'batch_reminder': return await this.handleBatchReminder(message, context.userTimezone);
      case 'reminder_view': {
        const response = await dashboardService.getRemindersView(message.from);
        return response;
      }
      case 'reminder_cancel': {
        return await this.handleReminderCancel(message, intentParams || {}, context);
      }
      case 'reminder_complete': {
        return await this.handleReminderComplete(message, intentParams || {});
      }
      case 'memory_save': return await this.handleMemorySave(message, intentParams || {});
      case 'memory_recall': return await this.handleMemoryRecall(message);
      case 'contact_save': {
        const cmd = contactService.parseContactCommand(message.text, intentParams);
        if (cmd && cmd.action === 'save') {
          return await this.handleContactCommand(message.from, cmd, context.userTimezone);
        }
        // If AI detected contact_save but regex didn't parse it, try AI chat
        return await aiService.chat(message.from, message.text, context);
      }
      case 'contact_manage': {
        const cmd = contactService.parseContactCommand(message.text, intentParams);
        if (cmd) {
          return await this.handleContactCommand(message.from, cmd, context.userTimezone);
        }
        return await aiService.chat(message.from, message.text, context);
      }
      case 'google_connect': return await this.handleGoogleConnect(message);
      case 'google_disconnect': return await this.handleGoogleDisconnect(message);
      case 'calendar_create': return await this.handleCalendarCreate(message, context, intentParams || {});
      case 'calendar_cancel': return await this.handleCalendarCancel(message, context, intentParams || {});
      case 'calendar_reschedule': return await this.handleCalendarReschedule(message, context, intentParams || {});
      case 'calendar_view': return await this.handleCalendarView(message, context, intentParams || {});
      case 'calendar_email': return await this.handleCalendarEmail(message, context, intentParams || {});
      case 'email_send': return await this.handleEmailSend(message, context, intentParams || {});
      case 'calendar_remind_all': return await this.handleCalendarRemindAll(message);
      case 'delegate': return await this.handleDelegate(message, intentParams || {});
      case 'task_done': return await this.handleTaskDone(message);
      case 'list': return await this.handleList(message, intentParams);
      case 'briefing': return await this.handleBriefing(message);
      case 'task_manage': {
        try {
          return await this.handleTaskManage(message, { ...context, intentParams });
        } catch (taskErr) {
          logger.error('task_manage CRASH:', {
            msg: taskErr?.message,
            name: taskErr?.name,
            str: String(taskErr),
            stack: taskErr?.stack?.split('\n').slice(0, 8).join(' | '),
            json: JSON.stringify(taskErr)
          });
          return 'Task error. Please try again.';
        }
      }
      case 'team_manage': return await this.handleTeamManage(message, context, intentParams || {});
      case 'leave_manage': return await this.handleLeaveManage(message, context, intentParams || {});
      case 'standup_manage': return await this.handleStandupManage(message, context, intentParams || {});
      case 'poll_manage': return await this.handlePollManage(message, context, intentParams || {});


      case 'scheduled_message': return await this.handleScheduledMessage(message, context, intentParams || {});
      case 'note_manage': return await this.handleNoteManage(message, context, intentParams);
      case 'thread_summary': return await this.handleThreadSummary(message, context, intentParams || {});
      case 'team_availability': return await this.handleTeamAvailability(message, context, intentParams || {});
      case 'inbox_check': {
        // LLM params-first: handle read action directly
        if (intentParams?.action === 'read') {
          const scopeCheck = await this._checkScopeOrPrompt(message.from, 'inbox', 'Inbox access');
          if (scopeCheck) return scopeCheck;
          const emailIndex = intentParams.email_index || 1;
          return this._readEmailByIndex(message.from, emailIndex);
        }
        const wantsOutlook = /\b(outlook|microsoft|hotmail)\b/i.test(message.text);
        const hasSearchIntent = /\b(from|about|regarding|by)\s+\w+/i.test(message.text)
          || /\b(did\s+i\s+receive|did\s+\w+\s+send|any\s+(mail|email)\s+from)\b/i.test(message.text);
        if (wantsOutlook) {
          if (hasSearchIntent) return await this.handleOutlookInboxSearch(message);
          return await this.handleOutlookInboxCheck(message);
        }
        if (hasSearchIntent) return await this.handleInboxSearch(message);
        return await this.handleInboxCheck(message);
      }
      case 'inbox_search': {
        const wantsOutlookSearch = /\b(outlook|microsoft|hotmail)\b/i.test(message.text);
        if (wantsOutlookSearch) return await this.handleOutlookInboxSearch(message);
        return await this.handleInboxSearch(message, intentParams);
      }
      case 'email_query': return await this.handleEmailQuery(message);
      case 'drive_search': return await this.handleDriveSearch(message, intentParams || {});
      case 'drive_create_folder': return await this.handleDriveCreateFolder(message, intentParams);
      case 'drive_share_file': return await this.handleDriveShareFile(message, intentParams);
      case 'drive_upload': return await this.handleDriveUpload(message, intentParams || {});
      case 'docs_manage': return await this.handleDocsManage(message, intentParams || {});
      case 'sheets_manage': return await this.handleSheetsManage(message, intentParams || {});
      case 'slides_manage': return await this.handleSlidesManage(message, intentParams || {});
      case 'labels_manage': return await this.handleLabelsManage(message, intentParams);
      case 'email_automation': return await this.handleEmailAutomation(message, intentParams);
      case 'reply_track': return await this.handleReplyTrack(message, intentParams);
      case 'google_tasks': return await this.handleGoogleTasksManage(message, intentParams);
      case 'google_contacts_search': return await this.handleGoogleContactsSearch(message, intentParams);
      case 'outlook_connect': return await this.handleOutlookConnect(message);
      case 'outlook_disconnect': return await this.handleOutlookDisconnect(message);
      case 'calendar_list': return await this.handleCalendarList(message);
      case 'apple_connect': return await this.handleAppleConnect(message);
      case 'apple_disconnect': return await this.handleAppleDisconnect(message);
      case 'sales_manage': return await this.handleSalesManage(message, context, intentParams);
      case 'campaigns_manage': return await this.handleCampaignsManage(message, intentParams || {});
      case 'meeting_recordings': return await this.handleMeetingRecordings(message, intentParams || {});
      case 'email_schedule': return await this.handleEmailSchedule(message, context, intentParams || {});
      // Apr 30 2026 — visa intent dispatch cases removed (visa_find,
      // visa_apply, visa_status, visa_packet, visa_resume, visa_dismiss,
      // visa_batch_send). Visa feature moved to a separate dedicated bot.
      case 'news_deep_dive': return await this.handleNewsDeepDive(message, intentParams);
      case 'briefing_toggle': return await this.handleBriefingToggle(message, intentParams);
      case 'update_reminder': return await this.handleUpdateReminder(message, intentParams);

      case 'email_followup': return await this.handleFollowUpEmail(message, context, intentParams);
      case 'email_bulk': return await this.handleEmailBulk(message, context, intentParams || {});
      case 'account_link': return await this.handleAccountLink(message, intentParams || {});
      case 'web_search': {
        return await this.handleWebSearch(message, context, intentParams);
      }
      case 'version_info': return this.handleVersionInfo();
      case 'translate_text': return await this.handleTranslate(message, intentParams || {});
      case 'export_data': return await this.handleExportData(message);
      case 'help': return this.getHelpMessage(message.lang);
      case 'clear_history':
        // M1 fix: until May 19 2026 the reply was just "Chat cleared",
        // which made users assume their memories/contacts were wiped too.
        // (They aren't — only the conversation history used for LLM
        // context is cleared.) Spell out the boundary so the UX matches
        // the implementation, and point at the actual delete commands.
        if (!await aiService.clearHistory(message.from, {
          deferAgentState: context?.agentExecution?.runtime === 'openrouter-agent-sdk'
            || String(context?.agentExecution?.runtime || '').startsWith('agno-'),
        })) {
          return "I couldn't fully clear the chat history. Nothing else was deleted; please try again.";
        }
        return "Chat history cleared. 🧹\n\nYour memories, contacts, reminders, and tasks are still safe.\n\nIf you want to delete those too:\n- _\"forget everything about me\"_ — wipes saved memories\n- _\"export my data\"_ — get a copy first";
      default:
        // Check handler registry for new features (Phase 1+)
        if (handlerRegistry.has(type)) {
          // Enrich context with userPhone, userTimezone, and LLM-extracted params for handlers.
          // BUG FIX (Apr 2026): variable was `params` (undefined here — caller's
          // local), causing ReferenceError → silent failure for expense/habit/
          // focus/sprint/etc. handlers. Use the function parameter `intentParams`.
          context.userPhone = message.from;
          context.intentParams = intentParams || {};
          return await handlerRegistry.handle(type, message, context);
        }
        return await aiService.chat(message.from, message.text, context);
    }
  }

  // ========== CONTACT COMMANDS ==========
  async handleContactCommand(userPhone, command, userTimezone = 'Asia/Kolkata') {
    switch (command.action) {
      case 'save': {
        const result = await contactService.saveContact(userPhone, command.name, command.phone, command.notes || null);
        if (!result.success) {
          return `Couldn't save: ${result.error}`;
        }
        // Track last saved contact for contextual references like "remind the person I just saved"
        this.lastSavedContact.set(userPhone, {
          name: result.contact.name,
          phone: result.contact.phone,
          timestamp: Date.now()
        });
        // (Apr 29 2026) Removed redundant setTimeout — `lastSavedContact` is
        // a BoundedMap declared with a 30-min TTL at the top of this class
        // (line 85), so manual cleanup duplicates the BoundedMap's own
        // expiry sweep AND leaks an un-unref'd timer that pinned the event
        // loop until expiry. BoundedMap.get() returns null after TTL.
        const savedDate = new Date().toLocaleString('en-IN', {
          timeZone: userTimezone,
          day: 'numeric', month: 'short', year: 'numeric',
          hour: 'numeric', minute: '2-digit', hour12: true
        });
        const masked = contactService.maskPhone(result.contact.phone);
        return `${result.isUpdate ? 'Updated' : 'Saved'}: *${result.contact.name}* | ${masked}\nSaved on ${savedDate}`;
      }

      case 'delete': {
        const result = await contactService.deleteContact(userPhone, command.name);
        if (!result.success) {
          if (result.error === 'multiple') {
            const names = result.matches.map((m, i) => `${i + 1}. ${m.name}`).join('\n');
            return `Multiple contacts match "${command.name}":\n${names}\n\nBe more specific.`;
          }
          return result.error === 'Contact not found'
            ?`No contact named "${command.name}" found.`
            :`Couldn't delete: ${result.error}`;
        }
        return `Deleted contact: *${result.deleted.name}*`;
      }

      case 'update': {
        const result = await contactService.updateContact(userPhone, command.name, { phone: command.phone });
        if (!result.success) {
          if (result.error === 'multiple') {
            const names = result.matches.map((m, i) => `${i + 1}. ${m.name}`).join('\n');
            return `Multiple contacts match "${command.name}":\n${names}\n\nBe more specific.`;
          }
          return result.error === 'Contact not found'
            ?`No contact named "${command.name}" found.`
            :`Couldn't update: ${result.error}`;
        }
        const masked = contactService.maskPhone(result.contact.phone);
        return `Updated: *${result.contact.name}* â†’ ${masked}`;
      }

      case 'get': {
        if (!command.name) return 'Whose contact do you want to look up?';
        // Step 1: check contacts table
        const matches = await contactService.findByName(userPhone, command.name);
        if (matches.length === 1) {
          const c = matches[0];
          return `*${c.name}*\n${c.phone}${c.notes ? `\n${c.notes}` : ''}`;
        }
        if (matches.length > 1) {
          let response = `Found ${matches.length} contacts matching "${command.name}":\n\n`;
          matches.forEach((c, i) => { response += `${i + 1}. *${c.name}* — ${c.phone}\n`; });
          return response;
        }
        // Step 2: memory_trunk fallback (phone saved via memory, not explicit contact)
        const memPhone = await memoryService.findPhoneForName(userPhone, command.name);
        if (memPhone) {
          return `*${command.name}*\n${memPhone}\n_From your saved memories. Say "save contact ${command.name}: ${memPhone}" to add to contacts._`;
        }
        return `No contact or number found for "${command.name}".\n\nSave one: "save contact ${command.name}: +91XXXXXXXXXX"`;
      }

      case 'list': {
        const contacts = await contactService.getAllContacts(userPhone);
        return contactService.formatContactsList(contacts, userTimezone);
      }

      default:
        return "Try: \"save contact Emily: +91XXXXXXXXXX\"";
    }
  }

  async handleWithSearch(message, context) {
    try {
      const results = await searchService.search(message.text, message.from, { enrichTopN: 1 });
      if (results?.length > 0) {
        return await aiService.chatWithSearch(message.from, message.text, results, context);
      }
      return await aiService.chat(message.from, message.text, context);
    } catch (error) {
      return await aiService.chat(message.from, message.text, context);
    }
  }

  async handleWebSearch(message, context, params = {}) {
    const query = String(params.query || params.search_query || params.full_text || message.text || '').trim();
    const searchText = query || message.text;
    const results = await searchService.search(searchText, message.from, { enrichTopN: 1 });
    const answer = (results && results.length > 0)
      ? await aiService.chatWithSearch(message.from, message.text, results, context)
      : await aiService.chat(message.from, message.text, context);

    return answer;
  }

  async handleMemorySave(message, params = {}) {
    if (params.fact) {
      const versionedMemory = require('../services/versioned-memory.service');
      const result = await versionedMemory.saveExplicitFact({
        userPhone: message.from,
        fact: params.fact,
        category: params.category,
        subject: params.subject,
        key: params.key,
        supersedes: params.supersedes,
        validUntil: params.valid_until,
        source: 'agent_tool',
        sourceRef: [message.agentRunId, message.agentToolCallId].filter(Boolean).join(':') || null,
      });
      if (!result.success) {
        if (result.error?.code === 'sensitive_memory_rejected') {
          return "I won't store passwords, API keys, payment-card data, PINs, OTPs, or other secrets in memory.";
        }
        return `I couldn't save that memory safely (${result.error?.code || 'memory_write_failed'}). Please try again.`;
      }
      const saved = String(result.fact?.value || params.fact);
      const truncated = saved.length > 100 ? `${saved.slice(0, 100)}...` : saved;
      return result.supersededId
        ? `Updated — I'll use the latest value: "${truncated}"`
        : `Got it, I'll remember that: "${truncated}"`;
    }

    const result = await memoryService.parseAndSaveMemory(message.from, message.text);
    if (!result.success) return "Couldn't save. Try: \"Remember my wifi is abc123\"";
    // Echo what was saved so the user knows exactly what was remembered
    const saved = result.content || message.text;
    const truncated = saved.length > 100 ? saved.slice(0, 100) + '...' : saved;
    return `Got it, I'll remember that: "${truncated}"`;
  }

  async handleMemoryRecall(message) {
    // Look in BOTH stores in parallel — memory_trunk (facts the user told us)
    // and user_files (documents/images they uploaded). Previously we only
    // checked the former, so "do you have my resume?" would return
    // "I don't have any memory" even though the PDF was sitting in user_files.
    const [memories, files] = await Promise.all([
      memoryService.searchMemories(message.from, message.text).catch(() => []),
      fileService.searchFiles(message.from, message.text).catch(() => [])
    ]);

    const hasMemories = Array.isArray(memories) && memories.length > 0;
    const hasFiles = Array.isArray(files) && files.length > 0;

    // Neither — keep existing "don't have memory" message.
    if (!hasMemories && !hasFiles) {
      return memoryService.formatMemoryResponse([], message.text);
    }

    // Files found — the user is asking about something we saved as a document.
    // Offer to share it and cache the file list for the yes/no reply.
    if (hasFiles) {
      // Keep the top 3 matches so we can share all of them if the user says yes.
      const topFiles = files.slice(0, 3);
      this.pendingFileShareContext.set(message.from, {
        files: topFiles,
        timestamp: Date.now()
      });

      // Compose a natural reply.
      let reply;
      if (topFiles.length === 1) {
        const f = topFiles[0];
        const name = f.document_name || f.file_name || 'your saved file';
        const kind = f.file_type === 'image' ? 'image' : (f.document_type || 'document');
        reply = `Yes — I have *${name}* (${kind}) saved for you.\n\nWant me to share it here?`;
      } else {
        reply = `Yes — I have ${topFiles.length} files that match:\n`;
        topFiles.forEach((f, i) => {
          const name = f.document_name || f.file_name || `File #${i + 1}`;
          const kind = f.file_type === 'image' ? 'image' : (f.document_type || 'document');
          reply += `  ${i + 1}. ${name} (${kind})\n`;
        });
        reply += `\nWant me to share ${topFiles.length === 2 ? 'both' : 'all of them'} here?`;
      }

      // If we ALSO have memories, append them briefly so the user sees everything.
      if (hasMemories) {
        reply += `\n\n_I also remember:_\n`;
        memories.slice(0, 3).forEach(m => { reply += `  • ${m.key_name}: ${m.value}\n`; });
      }
      return reply;
    }

    // Memories only — existing behavior.
    return memoryService.formatMemoryResponse(memories, message.text);
  }

  async handleDelegate(message, params = {}) {
    const parsed = taskService.parseTaskFromMessage(message.text);
    const confirmationGate = require('../services/confirmation-gate.service');

    // Check if this is a team broadcast (user said "tell the team", "message the team", etc.)
    const targetName = (params.target_name || '').toLowerCase().trim();
    const isTeamBroadcast = targetName === 'team' || /\bteam\b/i.test(message.text);

    if (isTeamBroadcast) {
      // Extract specific team name if mentioned ("tell the stitch boat team...")
      const teamName = taskService.resolveTeamNameFromText(message.text)
        || (targetName !== 'team' ? targetName : null);

      const members = await taskService.getTeamMembers(message.from, teamName);
      if (!members || members.length === 0) {
        if (teamName) {
          const allTeams = await taskService.getTeamNames(message.from);
          const teamList = allTeams.length
            ? allTeams.map(t => `- ${t.team_name} (${t.member_count} members)`).join('\n')
            : 'No teams yet.';
          return `No team named *"${teamName}"* found.\n\nYour teams:\n${teamList}`;
        }
        return "You don't have any team members yet.\n\nAdd members first:\n\"add Rahul +919876543210 to stitch boat team\"";
      }

      const msgContent = params.message_content || parsed.taskDescription
        || message.text.replace(/.*?\b(?:[a-zA-Z\s]+?\s+)?team\b\s*/i, '').trim();
      if (!msgContent || msgContent.length < 2) return "What message should I send to the team?";

      const senderName = await this.getSenderName(message.from, message.name);
      const broadcastMsg = `*Message from ${senderName}:*\n\n${msgContent}`;

      // Deduplicate phones (person in multiple teams only gets one message)
      const uniqueMembers = [];
      const seenPhones = new Set();
      for (const m of members) {
        if (!seenPhones.has(m.member_phone)) { seenPhones.add(m.member_phone); uniqueMembers.push(m); }
      }

      // SAFETY GATE — require explicit confirmation before broadcasting to team.
      const label = teamName ? `${teamName} team` : 'team';
      const memberList = uniqueMembers
        .slice(0, 10)
        .map(m => `  • ${m.member_name} (${contactService.maskPhone(m.member_phone)})`)
        .join('\n')
        + (uniqueMembers.length > 10 ? `\n  ...and ${uniqueMembers.length - 10} more` : '');

      const summary = `📣 Broadcast to *${label}* (${uniqueMembers.length} people)\n\n${memberList}\n\n💬 Message:\n"${msgContent}"`;

      return await confirmationGate.pend(message.from, {
        actionType: 'message_to_contact',
        summary,
        ctx: { teamName, recipientCount: uniqueMembers.length },
        execute: async () => {
          // Route through teamCommsService so a broadcast started from chat is
          // recorded exactly like one sent from the dashboard composer: it
          // shows up under Team → Broadcasts with per-recipient read receipts.
          const teamCommsService = require('../services/team-comms.service');
          const result = await teamCommsService.sendBroadcast({
            adminPhone: message.from,
            teamName: teamName ? String(teamName).toLowerCase() : null,
            messageText: broadcastMsg,
            members: uniqueMembers,
            send: (phone, text) => this._sendWithTimeout(phone, text),
            pauseMs: uniqueMembers.length > 5 ? 100 : 0,
          });
          let summaryText = `✓ Sent to ${result.sent}/${result.total} in ${label}`;
          if (result.failed > 0) summaryText += ` (${result.failed} failed)`;
          return summaryText;
        }
      });
    }

    // Try to resolve by name from contacts/team if no phone number found
    if (parsed.phone) {
      parsed.phone = parsed.phone.replace(/\D/g, '');
      if (parsed.phone.length === 10) parsed.phone = '91' + parsed.phone;
    }

    if ((!parsed.phone || parsed.phone.length < 11) && targetName) {
      // Try resolving from team members
      const resolved = await taskService.resolveTeamMemberPhone(message.from, targetName);
      if (resolved?.found) {
        parsed.phone = resolved.phone;
      } else {
        // Try resolving from contacts
        const contact = await contactService.resolveNameToPhone(message.from, targetName);
        if (contact?.found && !contact.ambiguous && contact.phone) {
          parsed.phone = contact.phone.replace(/\D/g, '');
        }
      }
    }

    if (!parsed.phone || parsed.phone.length < 11) return "Need phone number or a saved contact/team member name.\n\nExample: \"Tell 9876543210 call me\" or \"Tell Rahul about the meeting\"";

    const msgContent = params.message_content || parsed.taskDescription;
    if (!msgContent || msgContent.length < 3) return "What message?";

    // SAFETY GATE — require explicit confirmation before sending to another person.
    const recipientLabel = targetName || contactService.maskPhone(parsed.phone);
    const summary = `📱 Send WhatsApp to *${recipientLabel}* (${contactService.maskPhone(parsed.phone)})\n\n💬 Message:\n"${msgContent}"`;

    return await confirmationGate.pend(message.from, {
      actionType: 'message_to_contact',
      summary,
      ctx: { recipient: parsed.phone, recipientName: recipientLabel },
      execute: async () => {
        try {
          await messagingService.send(parsed.phone, msgContent);
          return `✓ Sent to ${recipientLabel}.`;
        } catch (error) {
          return "Couldn't send. Check number or contact name.";
        }
      }
    });
  }

  async handleTaskDone(message) {
    const reminders = await reminderService.getPendingReminders(message.from);
    if (reminders.length > 0) {
      await reminderService.markAsCompleted(reminders[0].id, message.from);
      return `"${reminders[0].message}" done`;
    }
    return "No pending tasks!";
  }

  async handleList(message, intentParams = null) {
    try {
      const parsed = listService.parseListCommand(message.text, intentParams);
      if (!parsed) return "Try: \"Add milk to shopping list\"";

      switch (parsed.action) {
        case 'create':
          await listService.createList(message.from, parsed.listName);
          return `List *${parsed.listName}* created!\n\nAdd items: "add milk to ${parsed.listName} list"`;
        case 'add':
          await listService.addMultipleItems(message.from, parsed.listName, parsed.items);
          return `Added: ${parsed.items.join(', ')}`;
        case 'show':
          return listService.formatList(await listService.getListItems(message.from, parsed.listName));
        case 'showAll':
          return listService.formatAllLists(await listService.getUserLists(message.from));
        case 'done': {
          const done = await listService.markItemDone(message.from, parsed.listName, parsed.item);
          return done ? `Done: "${parsed.item}"` : `Couldn't find "${parsed.item}" in ${parsed.listName} list`;
        }
        case 'remove': {
          const removed = await listService.removeItem(message.from, parsed.listName, parsed.item);
          return removed ? `Removed: "${parsed.item}"` : `Couldn't find "${parsed.item}" in ${parsed.listName} list`;
        }
        case 'clear': {
          const cleared = await listService.clearListItems(message.from, parsed.listName);
          if (!cleared.found) return `List "${parsed.listName}" not found.`;
          return cleared.count > 0
            ? `Cleared all ${cleared.count} item${cleared.count === 1 ? '' : 's'} from ${parsed.listName} list`
            : `${parsed.listName} list is already empty`;
        }
        case 'clearCompleted': {
          const cleared = await listService.clearCompleted(message.from, parsed.listName);
          return cleared > 0 ? `Cleared ${cleared} completed item${cleared > 1 ? 's' : ''} from ${parsed.listName} list` : `No completed items in ${parsed.listName} list`;
        }
        default:
          return "Try \"show my lists\"";
      }
    } catch (error) {
      return "List error";
    }
  }

  async handleBriefing(message) {
    try {
      // On-demand "what do I have today" → simple task list format.
      // The fancy v2 format with streak / surprise / ritual is reserved
      // for the 8am automated morning briefing (cron path only).
      //
      // Detect intent: if user asks for the full fancy "daily briefing"
      // explicitly, use v2; otherwise use the plain agenda list.
      const text = String(message.text || '').toLowerCase();
      const wantsFancyBrief = /\b(daily\s+briefing|morning\s+brief|morning\s+briefing|send\s+me\s+(the\s+)?briefing)\b/i.test(text);

      if (wantsFancyBrief) {
        // Keep v2 fancy brief + news split (same cron pattern)
        const brief = await briefingService.generateDailyBriefing(message.from, { includeNews: false });
        if (!brief) return "Couldn't generate briefing";
        await messagingService.send(message.from, brief);
        await new Promise(r => setTimeout(r, 2500));
        const news = await briefingService.generateNewsBriefing(message.from);
        if (news) await messagingService.send(message.from, news);
        return null;
      }

      // DEFAULT: simple task-list agenda for "what do I have today", "what's on my plate", etc.
      const agenda = await briefingService.generateTodayAgenda(message.from);
      return agenda || "Couldn't fetch your agenda.";
    } catch (error) {
      logger.error(`handleBriefing failed: ${error.message}`);
      return "Briefing error";
    }
  }

  /**
   * Toggle auto morning briefing on/off. Also accepts an optional hour override.
   * intentParams: { action: 'enable'|'disable'|'status', hour?: number }
   */
  async handleBriefingToggle(message, intentParams = {}) {
    const { query } = require('../config/database');
    const text = String(message.text || '').toLowerCase();

    // Infer action from text if intent didn't label it clearly
    let action = (intentParams.action || '').toLowerCase();
    if (!action) {
      if (/\b(enable|turn on|start|activate|set up|setup|schedule|yes)\b/.test(text)) action = 'enable';
      else if (/\b(disable|turn off|stop|cancel|off|no)\b/.test(text)) action = 'disable';
      else if (/\b(status|current|when)\b/.test(text)) action = 'status';
      else action = 'enable';
    }

    // Optional hour override: "enable morning briefing at 7 am" / "at 9"
    let hour = Number(intentParams.hour);
    if (!Number.isFinite(hour)) {
      const hourMatch = text.match(/\bat\s+(\d{1,2})\s*(am|pm)?/);
      if (hourMatch) {
        let h = parseInt(hourMatch[1], 10);
        const meridiem = hourMatch[2];
        if (meridiem === 'pm' && h < 12) h += 12;
        if (meridiem === 'am' && h === 12) h = 0;
        if (h >= 0 && h <= 23) hour = h;
      }
    }

    // Make sure the row exists (getUserTimezone will upsert)
    const timezoneService = require('../services/timezone.service');
    await timezoneService.getUserTimezone(message.from);

    if (action === 'status') {
      const r = await query(
        `SELECT briefing_enabled, briefing_hour, timezone FROM user_settings WHERE user_phone = $1`,
        [message.from]
      );
      const row = r.rows[0] || {};
      if (row.briefing_enabled) {
        return `✅ Morning briefing is *on* — you'll get your tasks + top 10 news every day at *${row.briefing_hour}:00 ${row.timezone || 'local time'}*.\n\nReply *"turn off morning briefing"* to stop.`;
      }
      return `Morning briefing is *off*. Reply *"turn on morning briefing"* to get your tasks + top 10 news auto-delivered every day at 8am.`;
    }

    if (action === 'disable') {
      // Stamp briefing_user_set_at so auto-enable (on new subscriptions etc.)
      // respects this explicit opt-out and doesn't silently flip it back on.
      await query(
        `UPDATE user_settings
         SET briefing_enabled = FALSE,
             briefing_user_set_at = NOW(),
             updated_at = NOW()
         WHERE user_phone = $1`,
        [message.from]
      );
      return `🔕 Morning briefing turned off. Reply *"turn on morning briefing"* anytime to re-enable.`;
    }

    // enable (optionally with custom hour). Explicit opt-in also stamps
    // briefing_user_set_at so this is treated as a deliberate user choice.
    const setHour = Number.isFinite(hour) ? hour : 8;
    await query(
      `UPDATE user_settings
       SET briefing_enabled = TRUE,
           briefing_hour = $2,
           briefing_last_sent_date = NULL,
           briefing_user_set_at = NOW(),
           updated_at = NOW()
       WHERE user_phone = $1`,
      [message.from, setHour]
    );
    const tzResult = await query(`SELECT timezone FROM user_settings WHERE user_phone = $1`, [message.from]);
    const tz = tzResult.rows[0]?.timezone || 'your local timezone';
    return `✅ *Morning briefing turned on!*\n\nEvery day at *${setHour}:00 ${tz}*, I'll send:\n  1️⃣  Your pending tasks, meetings & reminders for the day\n  2️⃣  Top 10 world news from the last 24h (with one-liners)\n\nReply *"know more about 1"* on any news item for the full story.\n\n_Change the time: "morning briefing at 7am". Turn off: "disable morning briefing"._`;
  }

  /**
   * Deep-dive on a news item shown in a recent briefing.
   * intentParams.position is the 1-based index from that briefing list.
   */
  async handleNewsDeepDive(message, intentParams = {}) {
    // Parse a position from the intent params OR extract from message text
    const text = String(intentParams.position || message.text || '');
    const numMatch = text.match(/\b(\d+)\b/);
    const position = numMatch ? parseInt(numMatch[1], 10) : null;

    if (!position || position < 1 || position > 20) {
      return 'Which news? Reply with a position number like *"know more about 3"* — based on the top news list from your briefing.';
    }

    const item = briefingService.getCachedNewsItem(message.from, position);
    if (!item) {
      return `I don't have that news cached anymore. Say *"daily briefing"* to get a fresh top-10 list, then I can expand any of them.`;
    }

    const newsService = require('../services/news.service');

    // Let user know this takes a moment
    try {
      await messagingService.send(message.from, `📖 Pulling the full story for #${position}...`);
    } catch (_) { /* non-fatal */ }

    const dd = await newsService.deepDive(item);
    if (!dd.ok) return dd.error || 'Could not open that article.';

    let reply = `📰 *${item.title}*\n`;
    if (item.source) reply += `_${item.source}${item.publishedAt ? ` · ${new Date(item.publishedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : ''}_\n\n`;
    if (dd.summary) reply += `${dd.summary}\n`;
    if (Array.isArray(dd.keyPoints) && dd.keyPoints.length > 0) {
      reply += `\n*Key points:*\n`;
      dd.keyPoints.forEach(p => { reply += `• ${p}\n`; });
    }
    reply += `\n🔗 ${item.url}`;
    return reply;
  }

  // ========== GOOGLE CALENDAR HANDLERS ==========

  async handleGoogleConnect(message) {
    const alreadyConnected = await googleAuthService.isConnected(message.from);
    if (alreadyConnected) {
      // Verify tokens are actually usable (decryption may fail if ENCRYPTION_KEY changed)
      const client = await googleAuthService.getAuthClient(message.from);
      if (!client) {
        // Tokens exist but can't be decrypted — wipe and re-auth
        await googleAuthService.revokeTokens(message.from);
      } else {
        const email = await googleAuthService.getGoogleEmail(message.from);
        return `Already connected to Google (${email}).\n\nSay "disconnect google" to unlink.`;
      }
    }

    if (!googleAuthService.useComposio() && (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET)) {
      return 'Google integration is not configured on this server.';
    }

    const authUrl = await googleAuthService.generateAuthUrl(message.from);
    return `Connect your Google account:\n\n${authUrl}\n\nClick the link above to authorize Calendar & Gmail access.`;
  }

  async handleGoogleDisconnect(message) {
    const wasConnected = await googleAuthService.revokeTokens(message.from);
    if (!wasConnected) {
      return 'Google account is not connected.';
    }
    return 'Google disconnected. Your tokens have been revoked and deleted.';
  }

  async _getTypedCalendarEventById(userPhone, eventId, calendarId) {
    try {
      const authClient = await googleAuthService.getAuthClient(userPhone);
      if (!authClient) return null;
      const { google } = require('googleapis');
      const calendar = google.calendar({ version: 'v3', auth: authClient });
      const result = await calendar.events.get({
        calendarId: calendarId || await calendarService.getDefaultCalendarId(userPhone),
        eventId,
      });
      return result.data || null;
    } catch (error) {
      const status = Number(error?.response?.status || error?.code || 0);
      if (status !== 404 && status !== 410) {
        logger.warn(`[AgentCalendar] Exact event lookup failed: ${error.message}`);
      }
      return null;
    }
  }

  async _resolveTypedCalendarEvent(userPhone, selector, options = {}) {
    const value = String(selector || '').trim();
    if (!value) {
      return { success: false, result: this._typedWaitingInput('Which calendar event do you mean? Provide its event ID or exact title.') };
    }
    // Google Calendar's events.list `q` field searches event text, not IDs.
    // Try events.get first so a stable ID binds to exactly one event.
    const eventById = await this._getTypedCalendarEventById(userPhone, value, options.calendarId);
    if (eventById) return { success: true, event: eventById };

    const now = new Date();
    const events = await calendarService.findEvents(userPhone, {
      timeMin: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      timeMax: new Date(now.getTime() + 366 * 24 * 60 * 60 * 1000),
      queryStr: value,
      calendarId: options.calendarId || undefined,
    });
    const lower = value.toLowerCase();
    const matches = events.filter((event) => String(event.summary || '').trim().toLowerCase() === lower);
    if (matches.length === 0) {
      return {
        success: false,
        result: this._typedWaitingInput(`I could not find an upcoming event matching "${value}". View the calendar first and use its stable event ID.`),
      };
    }
    if (matches.length > 1) {
      return {
        success: false,
        result: this._typedWaitingInput(`More than one event is titled "${value}". Choose one by stable event ID.`, {
          events: matches.slice(0, 10).map((event) => ({ id: event.id, title: event.summary || 'Untitled' })),
        }),
      };
    }
    return { success: true, event: matches[0] };
  }

  async _handleTypedCalendarCreate(message, context, params = {}) {
    const timezone = this._validatedTimezone(params.timezone, context?.userTimezone || 'Asia/Kolkata');
    if (!timezone) return this._typedWaitingInput(`I don't recognize the timezone "${params.timezone}".`);
    const start = this._parseTypedDateTime(params.start_time, timezone);
    if (!start) return this._typedWaitingInput('I could not understand the event start time.');
    const suppliedEnd = params.end_time !== undefined && params.end_time !== null;
    let end = suppliedEnd ? this._parseTypedDateTime(params.end_time, timezone, start) : null;
    if (suppliedEnd && !end) {
      return this._typedWaitingInput('I could not understand the event end time. Please provide a valid end_time.');
    }
    if (!end) {
      const duration = Number.isInteger(params.duration_minutes) ? params.duration_minutes : 30;
      end = new Date(start.getTime() + duration * 60 * 1000);
    }
    if (end <= start) return this._typedWaitingInput('The event end time must be after its start time.');

    let attendees = [];
    if (Array.isArray(params.attendees) && params.attendees.length > 0) {
      const resolved = await this._resolveTypedEmailRecipients(message.from, params.attendees);
      if (!resolved.success) return resolved.result;
      attendees = resolved.recipients.map((email) => ({ email }));
    }
    const eventData = {
      title: String(params.title),
      start,
      end,
      attendees,
      location: params.location ? String(params.location) : null,
      description: params.description ? String(params.description) : null,
      timezone,
      calendarId: params.calendar_id ? String(params.calendar_id) : undefined,
    };
    return this._showBookingConfirmation(message.from, eventData, timezone);
  }

  async handleCalendarCreate(message, context, intentParams = {}) {
    if (!await googleAuthService.isConnected(message.from)) {
      return 'Google not connected. Say "connect google" first.';
    }

    if (isAgentToolMessage(message)) {
      return this._handleTypedCalendarCreate(message, context, intentParams);
    }

    const recentMessages = await aiService.getRecentContext(message.from, 10);
    const parsed = await calendarNLPService.parseEventRequest(message.text, context.userTimezone, recentMessages);
    if (!parsed.success) {
      return `${parsed.error}\n\nTry: "Book a meeting tomorrow 3pm-3:30pm with test@email.com about demo"`;
    }

    // Always show confirmation before booking
    return this._showBookingConfirmation(message.from, parsed, context.userTimezone);
  }

  _showBookingConfirmation(userPhone, eventData, timezone) {
    // Future-datetime guard: if the parsed start time is already in the past,
    // stop and ask the user instead of showing a past-dated confirmation.
    try {
      const { mustBeFuture } = require('../utils/tool-validation');
      const startCheck = mustBeFuture(eventData.start, { context: 'meeting', graceMs: 120000 });
      if (!startCheck.ok) {
        const startStr = new Date(eventData.start).toLocaleString('en-IN', {
          timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short',
          hour: 'numeric', minute: '2-digit', hour12: true
        });

        // N5 fix (Apr 2026): Stash the failed-but-otherwise-valid event so a
        // next-turn time correction ("actually move it to thursday at 5pm")
        // can reuse title/attendees/duration WITHOUT routing to reschedule
        // (which previously picked the nearest unrelated entity, e.g. a
        // Spanish "call papá" reminder).
        if (!this.failedCalendarTimeContext) {
          const BoundedMap = require('../utils/bounded-map');
          this.failedCalendarTimeContext = new BoundedMap(5000, 5 * 60 * 1000);
        }
        this.failedCalendarTimeContext.set(userPhone, {
          eventData,
          timezone,
          timestamp: Date.now()
        });
        logger.info(`[NewIntentOverride] Stashed failed-past-time meeting for ${userPhone.slice(0,6)}* — next time-correction will reuse title="${eventData.title || 'Meeting'}"`);

        return `⚠️ That meeting time (*${startStr}*) is already in the past. Did you mean a future date/time?\n\nTry: "book meeting tomorrow at 3pm" or specify the exact date.`;
      }
    } catch (e) {
      logger.debug(`meeting future-check skipped: ${e.message}`);
    }

    const startStr = new Date(eventData.start).toLocaleString('en-IN', {
      timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short',
      hour: 'numeric', minute: '2-digit', hour12: true
    });
    const endStr = new Date(eventData.end).toLocaleTimeString('en-IN', {
      timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true
    });

    let preview = `*Confirm Meeting:*\n\n`;
    preview += `*Title:* ${eventData.title || 'Meeting'}\n`;
    preview += `*Time:* ${startStr} - ${endStr}\n`;
    if (eventData.attendees?.length > 0) {
      preview += `*Attendees:* ${eventData.attendees.map(a => a.email || a).join(', ')}\n`;
    }
    if (eventData.location) preview += `*Location:* ${eventData.location}\n`;
    if (eventData.description) preview += `*Description:* ${eventData.description}\n`;
    if (eventData.recurrence) {
      const recLabel = eventData.recurrence === 'weekdays' ? 'Every weekday (Mon–Fri)'
        : eventData.recurrence === 'daily' ? 'Every day'
        : eventData.recurrence === 'weekly' ? 'Every week'
        : eventData.recurrence === 'monthly' ? 'Every month'
        : eventData.recurrence.startsWith('weekly_') ? `Every ${eventData.recurrence.slice(7).replace(/^./, c => c.toUpperCase())}`
        : eventData.recurrence;
      preview += `*Repeats:* ${recLabel}\n`;
    }

    preview += `\n_Reply:_\n`;
    preview += `- *yes* to confirm\n`;
    preview += `- *no* to cancel\n`;
    preview += `- Change name: _"name: Team Standup"_\n`;
    preview += `- Change time: _"time: 4pm-5pm"_\n`;
    preview += `- Add description: _"description: Weekly sync call"_\n`;
    preview += `- Change attendees: _send an email address_`;

    this.calendarConfirmContext.set(userPhone, {
      type: 'booking_confirm',
      eventData,
      timezone,
      timestamp: Date.now()
    });
    // Also persist to long-lived fallback so "book anyway" can always recover
    this.lastBookingEventData.set(userPhone, { eventData, timezone, timestamp: Date.now() });

    return preview;
  }

  async executeCalendarCreate(userPhone, eventData, timezone) {
    const result = await calendarService.createEvent(userPhone, eventData);

    if (!result.success) {
      if (result.conflict) {
        let response = `Time conflict with "${result.busyWith}"`;
        if (result.alternatives && result.alternatives.length > 0) {
          response += `\n\nFree slots nearby:`;
          result.alternatives.forEach((alt, i) => {
            const start = alt.start.toLocaleTimeString('en-IN', {
              timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true
            });
            const end = alt.end.toLocaleTimeString('en-IN', {
              timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true
            });
            response += `\n${i + 1}. ${start} - ${end}`;
          });

          // Store conflict context
          this.calendarConfirmContext.set(userPhone, {
            type: 'conflict_resolution',
            eventData,
            alternatives: result.alternatives,
            timestamp: Date.now()
          });
          // Persist to long-lived fallback so "book anyway" survives reminder/task interjections
          this.lastBookingEventData.set(userPhone, { eventData, timezone, timestamp: Date.now() });

          response += `\n\nPick a number, or say "book anyway" to force.`;
        }
        return response;
      }
      return result.error;
    }

    const startStr = result.start.toLocaleString('en-IN', {
      timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short',
      hour: 'numeric', minute: '2-digit', hour12: true
    });
    const endStr = result.end.toLocaleTimeString('en-IN', {
      timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true
    });

    let response = `Meeting booked!\n\n*${result.title}*\n${startStr} - ${endStr}`;
    if (result.attendees?.length > 0) {
      response += `\n${result.attendees.length} attendee${result.attendees.length > 1 ? 's' : ''} invited`;
    }

    // Structured pointer to the just-created meeting so follow-ups like
    // "change the time", "cancel it", "add a note" resolve unambiguously.
    this.recordLastAction(userPhone, {
      action: 'meeting_create',
      entityType: 'meeting',
      entityId: result.id || result.eventId || result.event?.id || null,
      label: result.title || 'Meeting',
      at: result.start ? new Date(result.start).toISOString() : null,
      attendeeCount: result.attendees?.length || 0
    });

    return response;
  }

  async handleCalendarCancel(message, context, intentParams = {}) {
    if (!await googleAuthService.isConnected(message.from)) {
      return 'Google not connected. Say "connect google" first.';
    }

    if (isAgentToolMessage(message)) {
      const resolved = await this._resolveTypedCalendarEvent(message.from, intentParams.event);
      if (!resolved.success) return resolved.result;
      const event = resolved.event;
      const timezone = this._validatedTimezone(context?.userTimezone, 'Asia/Kolkata') || 'Asia/Kolkata';
      const start = new Date(event.start?.dateTime || event.start?.date);
      const startStr = Number.isFinite(start.getTime()) ? start.toLocaleString('en-IN', {
        timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short',
        hour: 'numeric', minute: '2-digit', hour12: true,
      }) : 'the selected time';
      this.calendarConfirmContext.set(message.from, {
        type: 'cancel_confirm',
        eventId: event.id,
        eventTitle: event.summary,
        attendees: event.attendees,
        reason: intentParams.reason ? String(intentParams.reason) : null,
        timestamp: Date.now(),
      });
      const reason = intentParams.reason ? `\n*Reason:* ${intentParams.reason}` : '';
      return `Cancel "*${event.summary || 'Untitled'}*" on ${startStr}?${reason}\n\nSay "yes" to confirm or "no" to keep it.`;
    }

    const recentMessages = await aiService.getRecentContext(message.from, 10);
    const parsed = await calendarNLPService.parseCancelRequest(message.text, context.userTimezone, recentMessages);

    // Find matching events
    const now = new Date();
    const searchEnd = parsed.targetDate
      ? new Date(new Date(parsed.targetDate).setHours(23, 59, 59, 999))
      : new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Try with title first, then broaden search if nothing found
    let events = await calendarService.findEvents(message.from, {
      timeMin: now,
      timeMax: searchEnd,
      queryStr: parsed.title || undefined
    });

    // If no results with title filter, try without it to show all upcoming events
    if (events.length === 0 && parsed.title) {
      events = await calendarService.findEvents(message.from, {
        timeMin: now,
        timeMax: searchEnd
      });
    }

    if (events.length === 0) {
      return 'No upcoming events found. Check your calendar with "my meetings".';
    }

    if (events.length === 1) {
      const event = events[0];
      const startStr = new Date(event.start.dateTime || event.start.date).toLocaleString('en-IN', {
        timeZone: context.userTimezone, weekday: 'short', day: 'numeric', month: 'short',
        hour: 'numeric', minute: '2-digit', hour12: true
      });

      this.calendarConfirmContext.set(message.from, {
        type: 'cancel_confirm',
        eventId: event.id,
        eventTitle: event.summary,
        attendees: event.attendees,
        timestamp: Date.now()
      });

      return `Cancel "*${event.summary || 'Untitled'}*" on ${startStr}?\n\nSay "yes" to confirm or "no" to keep it.`;
    }

    // Multiple matches - ask which one
    let response = 'Multiple events found:\n\n';
    events.slice(0, 5).forEach((e, i) => {
      const startStr = new Date(e.start.dateTime || e.start.date).toLocaleString('en-IN', {
        timeZone: context.userTimezone, day: 'numeric', month: 'short',
        hour: 'numeric', minute: '2-digit', hour12: true
      });
      response += `${i + 1}. ${e.summary || 'Untitled'} - ${startStr}\n`;
    });

    this.calendarConfirmContext.set(message.from, {
      type: 'cancel_select',
      events: events.slice(0, 5),
      timestamp: Date.now()
    });

    response += '\nWhich one to cancel? (number)';
    return response;
  }

  async handleCalendarReschedule(message, context, intentParams = {}) {
    if (!await googleAuthService.isConnected(message.from)) {
      return 'Google not connected. Say "connect google" first.';
    }

    if (isAgentToolMessage(message)) {
      const timezone = this._validatedTimezone(intentParams.timezone, context?.userTimezone || 'Asia/Kolkata');
      if (!timezone) return this._typedWaitingInput(`I don't recognize the timezone "${intentParams.timezone}".`);
      const resolved = await this._resolveTypedCalendarEvent(message.from, intentParams.event);
      if (!resolved.success) return resolved.result;
      const event = resolved.event;
      const oldStart = new Date(event.start?.dateTime || event.start?.date);
      const oldEnd = new Date(event.end?.dateTime || event.end?.date);
      const newStart = this._parseTypedDateTime(intentParams.new_start_time, timezone);
      if (!newStart) return this._typedWaitingInput('I could not understand the new event start time.');
      if (newStart.getTime() <= Date.now()) {
        return this._typedWaitingInput('The new event start time must be in the future.');
      }
      const suppliedNewEnd = intentParams.new_end_time !== undefined && intentParams.new_end_time !== null;
      let newEnd = suppliedNewEnd
        ? this._parseTypedDateTime(intentParams.new_end_time, timezone, newStart)
        : null;
      if (suppliedNewEnd && !newEnd) {
        return this._typedWaitingInput('I could not understand the new event end time. Please provide a valid new_end_time.');
      }
      if (!newEnd && Number.isInteger(intentParams.duration_minutes)) {
        newEnd = new Date(newStart.getTime() + intentParams.duration_minutes * 60 * 1000);
      }
      if (!newEnd) {
        const existingDuration = oldEnd.getTime() - oldStart.getTime();
        newEnd = new Date(newStart.getTime() + (existingDuration > 0 ? existingDuration : 30 * 60 * 1000));
      }
      if (newEnd <= newStart) return this._typedWaitingInput('The new event end time must be after its start time.');
      const durationMinutes = Math.round((newEnd - newStart) / 60000);
      this.calendarConfirmContext.set(message.from, {
        type: 'reschedule_confirm',
        eventId: event.id,
        eventTitle: event.summary,
        oldStart: oldStart.toISOString(),
        newStart: newStart.toISOString(),
        newEnd: newEnd.toISOString(),
        attendees: event.attendees,
        durationMinutes,
        timezone,
        timestamp: Date.now(),
      });
      const oldStr = oldStart.toLocaleString('en-IN', {
        timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short',
        hour: 'numeric', minute: '2-digit', hour12: true,
      });
      const newStr = newStart.toLocaleString('en-IN', {
        timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short',
        hour: 'numeric', minute: '2-digit', hour12: true,
      });
      return `*Reschedule "${event.summary || 'Untitled'}"?*\n\n*From:* ${oldStr}\n*To:* ${newStr} (${durationMinutes} min)\n\nSay "yes" to confirm or "no" to cancel.`;
    }

    const recentMessages = await aiService.getRecentContext(message.from, 10);
    const parsed = await calendarNLPService.parseRescheduleRequest(message.text, context.userTimezone, recentMessages);

    if (!parsed.success || !parsed.newTime) {
      return 'Could not understand the new time. Try: "reschedule Team Sync to tomorrow at 4pm"';
    }

    // Find matching events by original title
    const now = new Date();
    const searchEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days ahead
    let events = await calendarService.findEvents(message.from, {
      timeMin: now,
      timeMax: searchEnd,
      queryStr: parsed.originalTitle || undefined
    });

    if (events.length === 0 && parsed.originalTitle) {
      events = await calendarService.findEvents(message.from, { timeMin: now, timeMax: searchEnd });
    }

    if (events.length === 0) {
      return 'No upcoming events found to reschedule.';
    }

    const formatEvent = (e) => {
      const start = new Date(e.start.dateTime || e.start.date);
      const end = new Date(e.end.dateTime || e.end.date);
      const durationMs = end - start;
      return { event: e, start, end, durationMs };
    };

    const selectEvent = (event) => {
      const { start, end, durationMs } = formatEvent(event);
      const newStart = parsed.newTime;
      const newEnd = new Date(newStart.getTime() + durationMs); // preserve original duration

      const oldStr = start.toLocaleString('en-IN', {
        timeZone: context.userTimezone, weekday: 'short', day: 'numeric', month: 'short',
        hour: 'numeric', minute: '2-digit', hour12: true
      });
      const newStr = newStart.toLocaleString('en-IN', {
        timeZone: context.userTimezone, weekday: 'short', day: 'numeric', month: 'short',
        hour: 'numeric', minute: '2-digit', hour12: true
      });
      const newEndStr = newEnd.toLocaleTimeString('en-IN', {
        timeZone: context.userTimezone, hour: 'numeric', minute: '2-digit', hour12: true
      });
      const durationMins = Math.round(durationMs / 60000);

      this.calendarConfirmContext.set(message.from, {
        type: 'reschedule_confirm',
        eventId: event.id,
        eventTitle: event.summary,
        oldStart: start.toISOString(),
        newStart: newStart.toISOString(),
        newEnd: newEnd.toISOString(),
        attendees: event.attendees,
        durationMinutes: durationMins,
        timezone: context.userTimezone,
        timestamp: Date.now()
      });

      return `*Reschedule "${event.summary || 'Untitled'}"?*\n\n*From:* ${oldStr}\n*To:* ${newStr} - ${newEndStr} (${durationMins} min)\n\nSay "yes" to confirm or "no" to cancel.`;
    };

    if (events.length === 1) {
      return selectEvent(events[0]);
    }

    // Multiple matches - ask which one
    let response = 'Multiple events found. Which one to reschedule?\n\n';
    events.slice(0, 5).forEach((e, i) => {
      const startStr = new Date(e.start.dateTime || e.start.date).toLocaleString('en-IN', {
        timeZone: context.userTimezone, day: 'numeric', month: 'short',
        hour: 'numeric', minute: '2-digit', hour12: true
      });
      response += `${i + 1}. ${e.summary || 'Untitled'} - ${startStr}\n`;
    });

    this.calendarConfirmContext.set(message.from, {
      type: 'reschedule_select',
      events: events.slice(0, 5),
      newTime: parsed.newTime.toISOString(),
      timezone: context.userTimezone,
      timestamp: Date.now()
    });

    response += '\nReply with the number.';
    return response;
  }

  async handleCalendarView(message, context, intentParams = {}) {
    if (!await googleAuthService.isConnected(message.from)) {
      return 'Google not connected. Say "connect google" first.';
    }

    if (isAgentToolMessage(message)) {
      const timezone = this._validatedTimezone(intentParams.timezone, context?.userTimezone || 'Asia/Kolkata');
      if (!timezone) return this._typedWaitingInput(`I don't recognize the timezone "${intentParams.timezone}".`);
      const now = new Date();
      const timeMin = intentParams.start_time
        ? this._parseTypedDateTime(intentParams.start_time, timezone)
        : now;
      const timeMax = intentParams.end_time
        ? this._parseTypedDateTime(intentParams.end_time, timezone, timeMin || now)
        : new Date((timeMin || now).getTime() + 7 * 24 * 60 * 60 * 1000);
      if (!timeMin || !timeMax) return this._typedWaitingInput('I could not understand the requested calendar range.');
      if (timeMax <= timeMin) return this._typedWaitingInput('The calendar range end must be after its start.');
      const events = await calendarService.findEvents(message.from, {
        timeMin,
        timeMax,
        queryStr: intentParams.query || undefined,
        calendarId: intentParams.calendar_id || undefined,
      });
      const limit = Math.min(Number.isInteger(intentParams.limit) ? intentParams.limit : 10, 10);
      const dataEvents = events.slice(0, limit).map((event) => ({
        id: event.id,
        title: event.summary || 'Untitled',
        start: event.start?.dateTime || event.start?.date || null,
        end: event.end?.dateTime || event.end?.date || null,
        location: event.location || null,
        attendees: (event.attendees || []).slice(0, 100).map((attendee) => attendee.email || attendee).filter(Boolean),
        calendar_id: intentParams.calendar_id || null,
      }));
      const lines = dataEvents.map((event) => `- ${event.title} (${event.start || 'time unavailable'}) [ID: ${event.id}]`);
      return {
        status: 'success',
        data: {
          events: dataEvents,
          range: { start: timeMin.toISOString(), end: timeMax.toISOString(), timezone },
          complete: events.length < limit,
        },
        evidence: dataEvents.map((event) => ({ type: 'calendar_event', id: event.id })),
        user_summary: dataEvents.length > 0
          ? `Found ${dataEvents.length} calendar event${dataEvents.length === 1 ? '' : 's'}.\n${lines.join('\n')}`
          : 'No matching calendar events were found in that range.',
      };
    }

    const parsed = await calendarNLPService.parseAvailabilityRequest(message.text, context.userTimezone);

    if (parsed.rangeType === 'week') {
      return calendarService.getWeekView(message.from, parsed.targetDate, context.userTimezone);
    } else if (parsed.rangeType === 'month') {
      return calendarService.getMonthView(message.from, parsed.targetDate, context.userTimezone);
    }
    return calendarService.getViewAvailability(message.from, parsed.targetDate, context.userTimezone);
  }

  async handleCalendarEmail(message, context, intentParams = {}) {
    if (!await googleAuthService.isConnected(message.from)) {
      return 'Google not connected. Say "connect google" first.';
    }

    if (isAgentToolMessage(message)) {
      const resolved = await this._resolveTypedCalendarEvent(message.from, intentParams.event);
      if (!resolved.success) return resolved.result;
      const event = resolved.event;
      const attendeeEmails = [...new Set((event.attendees || [])
        .filter((attendee) => !attendee.self)
        .map((attendee) => String(attendee.email || attendee).trim().toLowerCase())
        .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))];
      if (attendeeEmails.length === 0) {
        return this._typedWaitingInput(`"${event.summary || 'Meeting'}" has no other attendees with email addresses.`);
      }
      const subject = intentParams.subject === undefined
        ? `Update: ${event.summary || 'Meeting'}`
        : String(intentParams.subject);
      const body = String(intentParams.body || '');
      this.calendarConfirmContext.set(message.from, {
        type: 'calendar_attendee_email_confirm',
        eventId: event.id,
        eventTitle: event.summary || 'Meeting',
        recipients: attendeeEmails,
        subject,
        body,
        timestamp: Date.now(),
      });
      return `*Email calendar attendees?*\n\n*Event:* ${event.summary || 'Meeting'}\n*To:* ${attendeeEmails.join(', ')}\n*Subject:* ${subject || '(no subject)'}\n\n${body}\n\nSay "yes" to send or "no" to cancel.`;
    }

    const recentMessages = await aiService.getRecentContext(message.from, 10);
    const parsed = await calendarNLPService.parseEmailRequest(message.text, recentMessages);

    // Find the relevant event
    const now = new Date();
    const searchEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const events = await calendarService.findEvents(message.from, {
      timeMin: now,
      timeMax: searchEnd,
      queryStr: parsed.eventTitle || undefined
    });

    if (events.length === 0) {
      return 'No upcoming events found to email about.';
    }

    const event = events[0];
    if (!event.attendees || event.attendees.length === 0) {
      return `"${event.summary || 'Meeting'}" has no attendees to email.`;
    }

    const attendeeEmails = event.attendees
      .filter(a => !a.self)
      .map(a => a.email);

    if (attendeeEmails.length === 0) {
      return 'No other attendees to email (only you).';
    }

    let result;
    switch (parsed.action) {
      case 'cancellation':
        result = await gmailService.sendCancellationNotice(message.from, event, attendeeEmails, parsed.customMessage);
        break;
      case 'reschedule':
        result = await gmailService.sendRescheduleRequest(message.from, event, event.start.dateTime, attendeeEmails);
        break;
      default:
        result = await gmailService.sendMeetingConfirmation(message.from, event, attendeeEmails);
    }

    if (!result.success) return result.error;
    return `Email sent to ${attendeeEmails.length} attendee${attendeeEmails.length > 1 ? 's' : ''} for "${event.summary || 'Meeting'}"`;
  }

  // Detect if message is asking to edit/revise a previous draft (not write a new one)
  _isEmailEditRequest(text) {
    const lower = text.toLowerCase();
    const isEdit = (
      /\b(make|edit|revise|rewrite|change|update|modify|rephrase)\b.*\b(email|draft|it|this|tone|subject)\b/.test(lower) ||
      /\b(more\s+(?:aggressive|formal|casual|polite|assertive|professional|friendly|harsh|direct|stern|soft|gentle|brief|detailed))\b/.test(lower) ||
      /\b(too\s+(?:long|short|formal|casual|harsh|soft|weak|strong))\b/.test(lower) ||
      /\b(add\s+(?:that|a|the)|shorter|longer|less formal|more formal)\b/.test(lower)
    );
    // Exclude: "send to email@x.com" with an address (that's a new send, not an edit)
    const hasAddress = /[\w.+\-]+@[\w\-]+\.[a-zA-Z]{2,}/.test(text);
    return isEdit && !hasAddress;
  }

  _typedWaitingInput(summary, data = {}) {
    return {
      status: 'waiting_input',
      data: { pending: false, ...data },
      user_summary: summary,
    };
  }

  _validatedTimezone(value, fallback = 'Asia/Kolkata') {
    const timezone = String(value || fallback || 'Asia/Kolkata').trim();
    try {
      Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
      return timezone;
    } catch (_) {
      return null;
    }
  }

  _parseTypedDateTime(value, timezone, reference = new Date()) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    // ISO timestamps that carry an explicit UTC offset are absolute instants.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(raw)) {
      const exact = new Date(raw);
      return Number.isFinite(exact.getTime()) ? exact : null;
    }
    // A timezone-less ISO value is a wall-clock time in the declared IANA
    // timezone, never in the server's local timezone.
    const wall = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/);
    if (wall) {
      try {
        const parts = {
          year: Number(wall[1]), month: Number(wall[2]), day: Number(wall[3]),
          hour: Number(wall[4]), minute: Number(wall[5]), second: Number(wall[6] || 0),
        };
        const exact = reminderService.zonedWallTimeToUtcDate(parts, timezone);
        const roundTrip = reminderService.getZonedParts(exact, timezone);
        return Object.keys(parts).every((key) => parts[key] === roundTrip[key]) ? exact : null;
      } catch (_) {
        return null;
      }
    }
    try {
      const chrono = require('chrono-node');
      const offset = calendarNLPService.getTimezoneOffsetMinutes(timezone);
      const parsed = chrono.parse(raw, { instant: reference, timezone: offset }, { forwardDate: true });
      return parsed[0]?.start?.date?.() || null;
    } catch (_) {
      return null;
    }
  }

  _typedEmailSchedule(params = {}, fallbackTimezone = 'Asia/Kolkata') {
    const timezone = this._validatedTimezone(params.timezone, fallbackTimezone);
    if (!timezone) {
      return { success: false, error: `I don't recognize the timezone "${params.timezone}". Use an IANA timezone such as Asia/Kolkata or UTC.` };
    }
    const sendAt = this._parseTypedDateTime(params.send_at, timezone);
    if (!sendAt || !Number.isFinite(sendAt.getTime())) {
      return { success: false, error: 'I could not understand the requested email delivery time.' };
    }
    if (sendAt <= new Date()) {
      return { success: false, error: 'The scheduled time is in the past. Please specify a future time.' };
    }
    return {
      success: true,
      sendAt,
      timezone,
      isRecurring: false,
      recurrencePattern: null,
      recurrenceDays: null,
      recurrenceTime: null,
      recurrenceLabel: null,
    };
  }

  async _resolveTypedEmailRecipients(userPhone, values) {
    const requested = Array.isArray(values)
      ? values.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
    if (requested.length === 0) {
      return { success: false, result: this._typedWaitingInput('Who should receive the email? Provide an email address or an unambiguous saved CRM name.') };
    }

    const emailPattern = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
    const names = [...new Set(requested.filter((value) => !emailPattern.test(value)))];
    let identities = { contacts: [], leads: [] };
    if (names.length > 0) {
      identities = await entityContextService.resolveIdentities(userPhone, { names });
    }

    const resolved = [];
    const entries = [];
    for (const value of requested) {
      if (emailPattern.test(value)) {
        const email = value.toLowerCase();
        resolved.push(email);
        entries.push({ requested: value, email, name: null });
        continue;
      }
      const normalizedName = value.toLowerCase();
      const candidates = [...(identities.contacts || []), ...(identities.leads || [])]
        .filter((row) => String(row.name || '').trim().toLowerCase() === normalizedName)
        .map((row) => String(row.email || '').trim().toLowerCase())
        .filter((email) => emailPattern.test(email));
      const unique = [...new Set(candidates)];
      if (unique.length === 0) {
        return {
          success: false,
          result: this._typedWaitingInput(`I could not find a saved email address for "${value}". Provide the complete email address.`),
        };
      }
      if (unique.length > 1) {
        return {
          success: false,
          result: this._typedWaitingInput(`I found more than one email address for "${value}". Which one should I use?`, {
            recipient: value,
            choices: unique,
          }),
        };
      }
      resolved.push(unique[0]);
      entries.push({ requested: value, email: unique[0], name: value });
    }

    const uniqueEmails = [];
    const uniqueEntries = [];
    for (let index = 0; index < resolved.length; index++) {
      if (uniqueEmails.includes(resolved[index])) continue;
      uniqueEmails.push(resolved[index]);
      uniqueEntries.push(entries[index]);
    }
    return { success: true, recipients: uniqueEmails, entries: uniqueEntries };
  }

  _typedEmailDraft(recipients, params = {}) {
    const body = String(params.body || '');
    return {
      success: true,
      to: recipients.length === 1 ? recipients[0] : recipients.join(', '),
      subject: params.subject === undefined ? '' : String(params.subject),
      body,
      htmlBody: gmailService.bodyToHtml(body),
    };
  }

  async _resolveAgentEmailAttachments(message, intentParams = {}) {
    if (!isAgentToolMessage(message)) return { isAgentTool: false, attachments: null };
    const artifactIds = Array.isArray(intentParams.attachment_ids)
      ? intentParams.attachment_ids
      : [];
    if (artifactIds.length === 0) return { isAgentTool: true, attachments: null };

    try {
      const artifacts = await fileArtifactService.loadOwnedArtifacts(message.from, artifactIds);
      const attachments = artifacts.map((artifact) => ({
        buffer: artifact.buffer,
        mimeType: artifact.mimeType || 'application/octet-stream',
        fileName: artifact.fileName || 'attachment',
      }));
      const totalBytes = attachments.reduce((sum, item) => sum + item.buffer.length, 0);
      if (totalBytes > 25 * 1024 * 1024) {
        return {
          isAgentTool: true,
          error: 'Unable to attach the selected files because their combined size exceeds Gmail\'s 25 MB limit.',
          attachments: null,
        };
      }
      return { isAgentTool: true, attachments };
    } catch (error) {
      logger.warn({ code: error?.code || 'artifact_unavailable' }, 'Agent email artifact resolution failed');
      return { isAgentTool: true, error: unavailableAgentArtifactMessage(), attachments: null };
    }
  }

  async handleEmailSend(message, context, intentParams = {}) {
    if (isAgentToolMessage(message)) {
      const resolved = await this._resolveTypedEmailRecipients(message.from, intentParams.recipients);
      if (!resolved.success) return resolved.result;
      if (resolved.recipients.length > 1) {
        return this.handleEmailBulk(message, context, {
          ...intentParams,
          recipients: resolved.recipients,
          personalize: false,
        });
      }
      if (!await googleAuthService.isConnected(message.from)) {
        return 'Google not connected. Say "connect google" to link your Gmail first.';
      }
      const agentAttachments = await this._resolveAgentEmailAttachments(message, intentParams);
      if (agentAttachments.error) return agentAttachments.error;
      const draft = this._typedEmailDraft(resolved.recipients, intentParams);
      const draftId = `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      this.calendarConfirmContext.set(message.from, {
        type: 'email_send_confirm',
        draft,
        draftId,
        attachments: agentAttachments.attachments,
        timestamp: Date.now(),
      });
      this.storeRecentEmailContext(message.from, {
        type: 'single', referenceDraft: draft, attachments: agentAttachments.attachments,
      });
      const attachNote = agentAttachments.attachments?.length
        ? `\n*Attachment${agentAttachments.attachments.length === 1 ? '' : 's'}:* ${agentAttachments.attachments.map((item) => item.fileName).join(', ')}`
        : '';
      return `*Email Preview* _(#${draftId.slice(-6)})_\n\n*To:* ${draft.to}\n*Subject:* ${draft.subject}${attachNote}\n\n${gmailService.previewBody(draft.body)}\n\n_Send this email? Reply yes or no_`;
    }

    const directFlowType = this.getDirectEmailFlowType(message.text);
    if (directFlowType === 'email_bulk') {
      logger.info('Redirecting email_send -> email_bulk based on recipient count');
      return await this.handleEmailBulk(message, context, intentParams);
    }
    if (directFlowType === 'email_schedule') {
      logger.info('Redirecting email_send -> email_schedule based on schedule intent');
      return await this.handleEmailSchedule(message, context, intentParams);
    }

    const agentAttachments = await this._resolveAgentEmailAttachments(message, intentParams);
    if (agentAttachments.error) return agentAttachments.error;

    // ── Edit/revise a previous draft (no Gmail needed) ────────────────────
    const recentEmail = this.recentEmailContext.get(message.from);
    if (!agentAttachments.isAgentTool && recentEmail?.referenceDraft && this._isEmailEditRequest(message.text)) {
      const revised = await gmailService.reviseEmailWithAI(recentEmail.referenceDraft, message.text);
      if (!revised.success) return `${revised.error}`;
      // Update stored context with revised draft
      this.storeRecentEmailContext(message.from, {
        type: recentEmail.type,
        referenceDraft: revised,
        attachments: recentEmail.attachments
      });
      if (recentEmail.type === 'draft_only') {
        return `*Email Draft (Revised)*\n\n*Subject:* ${revised.subject}\n\n${revised.body}\n\n_Keep editing, or say "send to email@example.com" to send._`;
      }
      // Gmail-connected flow: update confirm context
      this.calendarConfirmContext.set(message.from, {
        type: 'email_send_confirm',
        draft: revised,
        attachments: recentEmail.attachments,
        timestamp: Date.now()
      });
      const preview = gmailService.previewBody(revised.body);
      return `*Email Preview (Revised)*\n\n*To:* ${revised.to}\n*Subject:* ${revised.subject}\n\n${preview}\n\n_Send this email? Reply yes or no_`;
    }

    // ── Draft-only mode: no email address, no Gmail needed ────────────────
    const hasEmailAddress = /[\w.+\-]+@[\w\-]+\.[a-zA-Z]{2,}/.test(message.text);
    if (!hasEmailAddress) {
      const docCtx = this.documentContext.get(message.from);
      const hasDoc = !agentAttachments.isAgentTool
        && docCtx && (Date.now() - docCtx.timestamp) < this.workflowContextTtls.document;
      const draft = await gmailService.draftEmailContent(
        message.text,
        hasDoc ? documentTextFromContext(docCtx) : null
      );
      if (!draft.success) return `${draft.error}`;
      // Store for follow-up edits
      this.recentEmailContext.set(message.from, {
        type: 'draft_only',
        referenceDraft: { to: '', subject: draft.subject, body: draft.body, htmlBody: draft.htmlBody },
        timestamp: Date.now()
      });
      return `*Email Draft*\n\n*Subject:* ${draft.subject}\n\n${draft.body}\n\n_Say "make it more aggressive" to edit, or share an email address to send._`;
    }

    if (!await googleAuthService.isConnected(message.from)) {
      return 'Google not connected. Say "connect google" to link your Gmail first.';
    }

    // Check for recent document context (attachment)
    const docCtx = this.documentContext.get(message.from);
    const hasDoc = !agentAttachments.isAgentTool
      && docCtx && (Date.now() - docCtx.timestamp) < this.workflowContextTtls.document;

    const draft = await gmailService.draftEmailWithAI(
      message.text,
      hasDoc ? documentTextFromContext(docCtx) : null
    );
    if (!draft.success) return draft.error;
    const signerName = await this.getUserNameForSignature(message.from);
    draft.body = this.addDefaultSignature(draft.body, signerName);
    draft.htmlBody = gmailService.bodyToHtml(draft.body);

    // Attach document if available
    const attachments = agentAttachments.isAgentTool
      ? agentAttachments.attachments
      : (hasDoc ? documentAttachmentsFromContext(docCtx) : null);

    // Store draft for confirmation with unique draftId for stale-send protection
    const draftId = `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    this.calendarConfirmContext.set(message.from, {
      type: 'email_send_confirm',
      draft,
      draftId,
      attachments,
      timestamp: Date.now()
    });
    this.storeRecentEmailContext(message.from, {
      type: 'single',
      referenceDraft: draft,
      attachments
    });

    // Show preview (clean markdown links for WhatsApp display)
    const attachNote = attachments?.length
      ? `\n*Attachment${attachments.length === 1 ? '' : 's'}:* ${attachments.map((item) => item.fileName).join(', ')}`
      : '';
    const preview = gmailService.previewBody(draft.body);
    return `*Email Preview* _(#${draftId.slice(-6)})_\n\n*To:* ${draft.to}\n*Subject:* ${draft.subject}${attachNote}\n\n${preview}\n\n_Send this email? Reply yes or no_`;
  }

  // ========== FOLLOW-UP EMAIL ==========
  async handleFollowUpEmail(message, context, intentParams = {}) {
    // Need Gmail read scope for searching sent folder
    const scopeCheck = await this._checkScopeOrPrompt(message.from, 'inbox', 'Email follow-up');
    if (scopeCheck) return scopeCheck;

    if (!await googleAuthService.isConnected(message.from)) {
      return 'Google not connected. Say "connect google" to link your Gmail first.';
    }

    // Step 1: Resolve recipient — try email from params, then name lookup via contacts
    let recipientEmail = intentParams?.recipient_email || null;
    const recipientName = intentParams?.recipient_name || null;

    // Try to extract email from message text if not in params
    if (!recipientEmail) {
      const emailMatch = message.text.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i);
      if (emailMatch) recipientEmail = emailMatch[0];
    }

    // If we have a name but no email, try contacts
    if (!recipientEmail && recipientName) {
      try {
        const contactService = require('../services/contact.service');
        const contacts = await contactService.searchContacts(message.from, recipientName);
        if (contacts && contacts.length > 0 && contacts[0].email) {
          recipientEmail = contacts[0].email;
        }
      } catch (e) {
        logger.warn('Contact lookup for follow-up failed:', e.message);
      }
    }

    if (!recipientEmail) {
      return `I need an email address to find the previous conversation. Try:\n- "followup to john@company.com"\n- Or share the email address of the person you want to follow up with.`;
    }

    // Step 2: Search sent folder for emails to this recipient
    const sentResult = await inboxOrganizerService.searchSentEmails(message.from, recipientEmail, 5);
    if (!sentResult.success) return sentResult.error;

    if (sentResult.emails.length === 0) {
      // No sent emails found — fall back to drafting a fresh email
      return `I couldn't find any sent emails to ${recipientEmail}. Would you like me to draft a new email instead? Just say "send email to ${recipientEmail}" with your message.`;
    }

    // Step 3: Smart hybrid — auto-use if 1, show list if multiple
    if (sentResult.emails.length === 1) {
      // Auto-fetch the thread and draft follow-up
      return await this._draftFollowUpFromEmail(message, recipientEmail, sentResult.emails[0]);
    }

    // Multiple emails found — show list and ask user to pick
    let listMsg = `Found *${sentResult.emails.length} emails* sent to ${recipientEmail}:\n\n`;
    sentResult.emails.forEach((e, i) => {
      const date = e.date ? new Date(e.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '';
      listMsg += `${i + 1}. *${e.subject || '(no subject)'}* | ${date}\n`;
    });
    listMsg += '\n_Reply with the number (e.g. "1") to follow up on that email._';

    // Store context for follow-up selection
    this._followUpContext.set(message.from, {
      recipientEmail,
      emails: sentResult.emails,
      userMessage: message.text,
      timestamp: Date.now()
    });

    return listMsg;
  }

  async _draftFollowUpFromEmail(message, recipientEmail, sentEmail) {
    // Fetch the full thread
    const threadResult = await inboxOrganizerService.getEmailThread(message.from, sentEmail.id);
    if (!threadResult.success) {
      return `Found your email but couldn't load the thread. ${threadResult.error}`;
    }

    // Draft the follow-up using AI with thread context
    const draft = await gmailService.draftFollowUpWithAI(
      threadResult.messages,
      message.text,
      recipientEmail
    );
    if (!draft.success) return draft.error;

    // Add signature
    const signerName = await this.getUserNameForSignature(message.from);
    draft.body = this.addDefaultSignature(draft.body, signerName);
    draft.htmlBody = gmailService.bodyToHtml(draft.body);

    // Store for confirmation (reuse existing email_send_confirm flow)
    this.calendarConfirmContext.set(message.from, {
      type: 'email_send_confirm',
      draft: { ...draft, threadId: threadResult.threadId },
      threadId: threadResult.threadId,
      timestamp: Date.now()
    });
    this.storeRecentEmailContext(message.from, {
      type: 'single',
      referenceDraft: draft
    });

    const preview = gmailService.previewBody(draft.body);
    const origSubject = sentEmail.subject || '(no subject)';
    return `*Follow-up Email Preview*\n_(replying to: "${origSubject}")_\n\n*To:* ${draft.to}\n*Subject:* ${draft.subject}\n\n${preview}\n\n_Send this email? Reply yes or no (or ask for changes)_`;
  }

  async handleCalendarRemindAll(message) {
    if (!await googleAuthService.isConnected(message.from)) {
      return 'Google not connected. Say "connect google" first.';
    }

    const lower = message.text.toLowerCase();
    if (/\b(disable|turn off|stop)\b/i.test(lower)) {
      await calendarReminderJob.disableRemindAll(message.from);
      return 'Meeting reminders disabled. You\'ll only get reminders for bot-created events.';
    }

    await calendarReminderJob.enableRemindAll(message.from);
    return 'Meeting reminders enabled!\n\nI\'ll remind you 15 minutes before ALL your Google Calendar meetings.';
  }

  async handleCalendarConfirmation(message, ctx) {
    const text = message.text.toLowerCase().trim();

    switch (ctx.type) {
      case 'conflict_resolution': {
        // User picked an alternative slot or wants to force
        if (/^(book anyway|force|override)/i.test(text)) {
          this.calendarConfirmContext.delete(message.from);
          this.lastBookingEventData.delete(message.from);
          // Force create by skipping free/busy
          const eventData = { ...ctx.eventData, force: true };
          const result = await calendarService.createEvent(message.from, eventData);
          if (!result.success) return result.error;

          const startStr = result.start.toLocaleString('en-IN', {
            timeZone: eventData.timezone, weekday: 'short', day: 'numeric', month: 'short',
            hour: 'numeric', minute: '2-digit', hour12: true
          });
          return `Meeting booked (conflict override)!\n\n*${result.title}*\n${startStr}`;
        }

        const numMatch = text.match(/^(\d+)$/);
        if (numMatch) {
          const idx = parseInt(numMatch[1]) - 1;
          if (idx >= 0 && idx < ctx.alternatives.length) {
            this.calendarConfirmContext.delete(message.from);
            const alt = ctx.alternatives[idx];
            const eventData = { ...ctx.eventData, start: alt.start, end: alt.end };
            return this.executeCalendarCreate(message.from, eventData, eventData.timezone);
          }
        }

        if (/^(no|cancel|nahi|nope)/i.test(text)) {
          this.calendarConfirmContext.delete(message.from);
          return 'Meeting cancelled.';
        }
        return null; // Let it fall through to normal handling
      }

      case 'cancel_confirm': {
        const classification = classifySensitiveConfirmation(text);
        if (classification.decision === 'confirm') {
          this.calendarConfirmContext.delete(message.from);
          const result = await calendarService.cancelEvent(message.from, ctx.eventId, true);
          if (!result.success) return result.error;
          return `Cancelled: "${ctx.eventTitle}"`;
        }
        if (classification.decision === 'cancel') {
          this.calendarConfirmContext.delete(message.from);
          return 'Okay, keeping the meeting.';
        }
        return null;
      }

      case 'cancel_select': {
        const numMatch = text.match(/^(\d+)$/);
        if (numMatch) {
          const idx = parseInt(numMatch[1]) - 1;
          if (idx >= 0 && idx < ctx.events.length) {
            const event = ctx.events[idx];
            this.calendarConfirmContext.set(message.from, {
              type: 'cancel_confirm',
              eventId: event.id,
              eventTitle: event.summary,
              attendees: event.attendees,
              timestamp: Date.now()
            });
            return `Cancel "*${event.summary || 'Untitled'}*"?\n\nSay "yes" to confirm.`;
          }
        }
        if (/^(no|cancel|nahi|never\s*mind)/i.test(text)) {
          this.calendarConfirmContext.delete(message.from);
          return 'Okay, nothing cancelled.';
        }
        return null;
      }

      case 'reschedule_confirm': {
        const classification = classifySensitiveConfirmation(text);
        if (classification.decision === 'confirm') {
          this.calendarConfirmContext.delete(message.from);
          const tz = ctx.timezone || 'Asia/Kolkata';
          const result = await calendarService.rescheduleEvent(
            message.from, ctx.eventId, ctx.newStart, ctx.newEnd, tz
          );
          if (!result.success) return result.error;
          const newStr = new Date(ctx.newStart).toLocaleString('en-IN', {
            timeZone: tz, weekday: 'short', day: 'numeric', month: 'short',
            hour: 'numeric', minute: '2-digit', hour12: true
          });
          return `Meeting rescheduled! "${ctx.eventTitle}" moved to ${newStr} (${ctx.durationMinutes} min).`;
        }
        if (classification.decision === 'cancel') {
          this.calendarConfirmContext.delete(message.from);
          return 'Okay, keeping the original time.';
        }
        return null;
      }

      case 'reschedule_select': {
        const numMatch = text.match(/^(\d+)$/);
        if (numMatch) {
          const idx = parseInt(numMatch[1]) - 1;
          if (idx >= 0 && idx < ctx.events.length) {
            const event = ctx.events[idx];
            const start = new Date(event.start.dateTime || event.start.date);
            const end = new Date(event.end.dateTime || event.end.date);
            const durationMs = end - start;
            const newStart = new Date(ctx.newTime);
            const newEnd = new Date(newStart.getTime() + durationMs);
            const durationMins = Math.round(durationMs / 60000);
            const tz = ctx.timezone || 'Asia/Kolkata';

            const oldStr = start.toLocaleString('en-IN', {
              timeZone: tz, weekday: 'short', day: 'numeric', month: 'short',
              hour: 'numeric', minute: '2-digit', hour12: true
            });
            const newStr = newStart.toLocaleString('en-IN', {
              timeZone: tz, weekday: 'short', day: 'numeric', month: 'short',
              hour: 'numeric', minute: '2-digit', hour12: true
            });
            const newEndStr = newEnd.toLocaleTimeString('en-IN', {
              timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true
            });

            this.calendarConfirmContext.set(message.from, {
              type: 'reschedule_confirm',
              eventId: event.id,
              eventTitle: event.summary,
              oldStart: start.toISOString(),
              newStart: newStart.toISOString(),
              newEnd: newEnd.toISOString(),
              attendees: event.attendees,
              durationMinutes: durationMins,
              timezone: tz,
              timestamp: Date.now()
            });

            return `*Reschedule "${event.summary || 'Untitled'}"?*\n\n*From:* ${oldStr}\n*To:* ${newStr} - ${newEndStr} (${durationMins} min)\n\nSay "yes" to confirm.`;
          }
        }
        if (/^(no|cancel|nahi|never\s*mind)/i.test(text)) {
          this.calendarConfirmContext.delete(message.from);
          return 'Okay, nothing rescheduled.';
        }
        return null;
      }

      case 'booking_confirm': {
        const classification = classifySensitiveConfirmation(text);

        // Confirm booking
        if (classification.decision === 'confirm') {
          this.calendarConfirmContext.delete(message.from);

          // Check for external attendees before booking
          if (ctx.eventData.attendees?.length > 0) {
            const userEmail = await googleAuthService.getGoogleEmail(message.from);
            const { external, hasExternal } = gmailService.confirmExternalRecipients(ctx.eventData.attendees, userEmail);
            if (hasExternal) {
              this.calendarConfirmContext.set(message.from, {
                type: 'external_email_confirm',
                eventData: ctx.eventData,
                externalEmails: external,
                timestamp: Date.now()
              });
                      return `This will send invites to external email${external.length > 1 ? 's' : ''}:\n${external.join('\n')}\n\nProceed? (yes/no)`;
            }
          }

          return this.executeCalendarCreate(message.from, ctx.eventData, ctx.timezone);
        }

        // Cancel booking
        if (classification.decision === 'cancel') {
          this.calendarConfirmContext.delete(message.from);
          return 'Meeting cancelled.';
        }

        // Change title/name
        const nameMatch = text.match(/^(?:name|title|rename|call it)[:\s]+(.+)/i);
        if (nameMatch) {
          ctx.eventData.title = nameMatch[1].trim();
          this.calendarConfirmContext.set(message.from, { ...ctx, timestamp: Date.now() });
          return this._showBookingConfirmation(message.from, ctx.eventData, ctx.timezone);
        }

        // Change time
        const timeMatch = text.match(/^(?:time|reschedule|move to|change time)[:\s]+(.+)/i);
        if (timeMatch) {
          const chrono = require('chrono-node');
          const tzOffsetMinutes = calendarNLPService.getTimezoneOffsetMinutes(ctx.timezone);
          const chronoResults = chrono.parse(timeMatch[1], { instant: new Date(), timezone: tzOffsetMinutes });
          if (chronoResults.length > 0) {
            const parsed = chronoResults[0];
            ctx.eventData.start = parsed.start.date();
            if (parsed.end) {
              ctx.eventData.end = parsed.end.date();
            } else {
              // Keep same duration
              const duration = new Date(ctx.eventData.end).getTime() - new Date(ctx.eventData.start).getTime();
              ctx.eventData.end = new Date(ctx.eventData.start.getTime() + (duration || 30 * 60 * 1000));
            }
            this.calendarConfirmContext.set(message.from, { ...ctx, timestamp: Date.now() });
            return this._showBookingConfirmation(message.from, ctx.eventData, ctx.timezone);
          }
          return 'Could not understand that time. Try: "time: tomorrow 4pm-5pm"';
        }

        // Change/add description
        const descMatch = text.match(/^(?:description|desc|about|details|note)[:\s]+(.+)/i);
        if (descMatch) {
          ctx.eventData.description = descMatch[1].trim();
          this.calendarConfirmContext.set(message.from, { ...ctx, timestamp: Date.now() });
          return this._showBookingConfirmation(message.from, ctx.eventData, ctx.timezone);
        }

        // Change/add location
        const locMatch = text.match(/^(?:location|place|venue|where)[:\s]+(.+)/i);
        if (locMatch) {
          ctx.eventData.location = locMatch[1].trim();
          this.calendarConfirmContext.set(message.from, { ...ctx, timestamp: Date.now() });
          return this._showBookingConfirmation(message.from, ctx.eventData, ctx.timezone);
        }

        // Email address â€” update/add attendee
        const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        if (emailMatch) {
          const newEmail = emailMatch[0].toLowerCase();
          if (!ctx.eventData.attendees) ctx.eventData.attendees = [];
          if (!ctx.eventData.attendees.some(a => (a.email || a).toLowerCase() === newEmail)) {
            ctx.eventData.attendees.push({ email: newEmail });
          }
          this.calendarConfirmContext.set(message.from, { ...ctx, timestamp: Date.now() });
          return this._showBookingConfirmation(message.from, ctx.eventData, ctx.timezone);
        }

        return null;
      }

      case 'external_email_confirm': {
        const classification = classifySensitiveConfirmation(text);
        if (classification.decision === 'confirm') {
          this.calendarConfirmContext.delete(message.from);
          return this.executeCalendarCreate(message.from, ctx.eventData, ctx.eventData.timezone);
        }
        if (classification.decision === 'cancel') {
          this.calendarConfirmContext.delete(message.from);
          return 'Meeting cancelled.';
        }

        // User might be correcting/adding an email address
        const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        if (emailMatch) {
          const correctedEmail = emailMatch[0].toLowerCase();
          // Replace attendees with the corrected email
          const updatedAttendees = ctx.eventData.attendees.map(a => {
            const existingEmail = (a.email || a).toLowerCase();
            // If only one attendee or the old external email matches, replace it
            if (ctx.externalEmails.some(ext => ext.toLowerCase() === existingEmail)) {
              return { email: correctedEmail };
            }
            return a;
          });

          // If no replacement happened (new email entirely), add it
          if (!updatedAttendees.some(a => (a.email || a).toLowerCase() === correctedEmail)) {
            updatedAttendees.push({ email: correctedEmail });
          }

          ctx.eventData.attendees = updatedAttendees;
          const userEmail = await googleAuthService.getGoogleEmail(message.from);
          const { external, hasExternal } = gmailService.confirmExternalRecipients(updatedAttendees, userEmail);

          if (hasExternal) {
            this.calendarConfirmContext.set(message.from, {
              type: 'external_email_confirm',
              eventData: ctx.eventData,
              externalEmails: external,
              timestamp: Date.now()
            });
                  return `Updated attendee to: ${correctedEmail}\n\nThis will send invite to external email${external.length > 1 ? 's' : ''}:\n${external.join('\n')}\n\nProceed? (yes/no)`;
          }

          // No external emails after correction, proceed directly
          this.calendarConfirmContext.delete(message.from);
          return this.executeCalendarCreate(message.from, ctx.eventData, ctx.eventData.timezone);
        }

        return null;
      }

      case 'calendar_attendee_email_confirm': {
        const classification = classifySensitiveConfirmation(text);
        if (classification.decision === 'confirm') {
          this.calendarConfirmContext.delete(message.from);
          const result = await gmailService.sendEmail(message.from, {
            to: ctx.recipients,
            subject: ctx.subject,
            htmlBody: gmailService.bodyToHtml(ctx.body),
          });
          if (!result.success) return result.error;
          return `Email sent to ${ctx.recipients.join(', ')} for "${ctx.eventTitle}".`;
        }
        if (classification.decision === 'cancel') {
          this.calendarConfirmContext.delete(message.from);
          return 'Calendar attendee email cancelled.';
        }
        return null;
      }

      case 'email_send_confirm': {
        // Stale-send guard: if the context TTL has expired, refuse and clear
        const emailTtl = this.workflowContextTtls.emailConfirm;
        if ((Date.now() - ctx.timestamp) >= emailTtl) {
          this.calendarConfirmContext.delete(message.from);
          return 'That draft expired. Please draft a new one.';
        }
        const classification = classifySensitiveConfirmation(text);

        if (classification.decision === 'confirm') {
          this.calendarConfirmContext.delete(message.from);
          // Regenerate HTML from body at send time to ensure links are converted
          const finalHtmlBody = gmailService.bodyToHtml(ctx.draft.body);
          logger.info(`Email HTML preview: ${finalHtmlBody.slice(0, 500)}`);

          // Use thread-aware sending if threadId is present (follow-up emails)
          let result;
          if (ctx.threadId || ctx.draft.threadId) {
            result = await gmailService.sendEmailInThread(message.from, {
              to: ctx.draft.to,
              subject: ctx.draft.subject,
              htmlBody: finalHtmlBody,
              threadId: ctx.threadId || ctx.draft.threadId,
              attachments: ctx.attachments || null
            });
          } else {
            result = await gmailService.sendEmail(message.from, {
              to: ctx.draft.to,
              subject: ctx.draft.subject,
              htmlBody: finalHtmlBody,
              attachments: ctx.attachments || null
            });
          }
          if (!result.success) return result.error;
          const attMsg = ctx.attachments ?` (with ${ctx.attachments[0].fileName} attached)` : '';
          const threadMsg = (ctx.threadId || ctx.draft.threadId) ? ' (threaded reply)' : '';
          return `Email sent to ${ctx.draft.to}${attMsg}${threadMsg}!`;
        }
        if (classification.decision === 'cancel') {
          this.calendarConfirmContext.delete(message.from);
          return 'Email cancelled.';
        }

        const recentEmail = this.recentEmailContext.get(message.from);
        const scheduleRequest = this.resolveScheduleFromRecentEmailContext(
          message.text,
          await timezoneService.getUserTimezone(message.from),
          recentEmail
        );
        if (scheduleRequest.error) return scheduleRequest.error;
        if (scheduleRequest.success && scheduleRequest.schedule) {
          const mentionedRecipients = this.parseBulkEmailAddresses(message.text).valid;
          const scheduledDraft = mentionedRecipients.length === 1
            ? this.cloneDraftForRecipient(ctx.draft, mentionedRecipients[0])
            : ctx.draft;
          this.calendarConfirmContext.delete(message.from);
          const schedCtx = this.setScheduledEmailDraftContext(message.from, scheduledDraft, scheduleRequest.schedule, ctx.attachments || null);
          return this.buildScheduledEmailPreview(scheduledDraft, schedCtx, ctx.attachments || null);
        }

        // Only treat as revision if the user explicitly asked for changes.
        // This prevents topic shifts ("what time is it?") from being rewritten as email edits.
        const isExplicitRevisionReq = /\b(make it|change|add|remove|rewrite|revise|edit|more |less |shorter|longer|formal|casual|professional|friendly|subject|body|tone|replace|include|mention|append|prepend)\b/i.test(message.text);
        if (!isExplicitRevisionReq) {
          // Ambiguous — don't assume revision, don't send. Ask.
          return `Not sure if you want to send, cancel, or change the draft. Reply *yes*, *no*, or say what to change (e.g. "make it formal").`;
        }
        const revised = await gmailService.reviseEmailWithAI(ctx.draft, message.text);
        if (!revised.success) return revised.error;
        const signerName = await this.getUserNameForSignature(message.from);
        revised.body = this.addDefaultSignature(revised.body, signerName);
        revised.htmlBody = gmailService.bodyToHtml(revised.body);
        // New draftId for the revised version so stale "yes" on the old draft can't fire
        const newDraftId = `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        // Update stored draft, keep attachments, refresh timestamp + draftId
        this.calendarConfirmContext.set(message.from, {
          type: 'email_send_confirm',
          draft: revised,
          draftId: newDraftId,
          attachments: ctx.attachments || null,
          timestamp: Date.now()
        });
          this.storeRecentEmailContext(message.from, {
          type: 'single',
          referenceDraft: revised,
          attachments: ctx.attachments || null
        });
        const attNote = ctx.attachments ?`\n*Attachment:* ${ctx.attachments[0].fileName}` : '';
        const revPreview = gmailService.previewBody(revised.body);
        return `*Updated Email Preview* _(#${newDraftId.slice(-6)})_\n\n*To:* ${revised.to}\n*Subject:* ${revised.subject}${attNote}\n\n${revPreview}\n\n_Send this email? Reply yes or no (or ask for more changes)_`;
      }

      default:
        return null;
    }
  }

  // ========== SCOPE CHECK HELPER ==========
  async _checkScopeOrPrompt(userPhone, scopeBundle, featureName) {
    if (!await googleAuthService.isConnected(userPhone)) {
      return 'Google not connected. Say "connect google" first.';
    }

    const hasScope = await googleAuthService.hasScope(userPhone, scopeBundle);
    if (!hasScope) {
      const authUrl = await googleAuthService.generateScopeUpgradeUrl(userPhone, scopeBundle);
      if (!authUrl) return 'This feature is not configured.';

      const scopeDescriptions = {
        inbox: 'read your emails',
        drive: 'access your Google Drive files',
        drive_full: 'see and manage all your Google Drive files',
        docs: 'read and edit your Google Docs',
        sheets: 'read and edit your Google Sheets',
        slides: 'read and edit your Google Slides',
        tasks: 'sync with your Google Tasks list'
      };

      return `*${featureName}* requires permission to ${scopeDescriptions[scopeBundle] || scopeBundle}.\n\nYour data stays private — I only read what you ask for.\n\nAuthorize here:\n${authUrl}`;
    }

    return null; // scope OK
  }

  // Restricted Gmail history/modification handlers remain below for
  // compatibility with older data, but are disabled from active routing.
  _featureUnavailable(featureLabel) {
    return disabledGoogleFeatureMessage(featureLabel);
  }

  // ========== INBOX ORGANIZER ==========
  async handleInboxCheck(message) {
    return this._featureUnavailable('Gmail inbox view');
    /* eslint-disable no-unreachable */
    const scopeCheck = await this._checkScopeOrPrompt(message.from, 'inbox', 'Inbox access');
    if (scopeCheck) return scopeCheck;

    const lower = message.text.toLowerCase();

    // “read email 1”, “read email 2”, or just “read email” (defaults to 1)
    const readMatch = lower.match(/read\s+(?:email|mail)\s*(\d+)?/i);
    if (readMatch) {
      const index = readMatch[1] ? parseInt(readMatch[1]) : 1;
      return this._readEmailByIndex(message.from, index);
    }

    // If user asks about today's emails specifically
    if (lower.match(/\b(today|aaj)\b/) || lower.match(/\b(did i|have i|any)\b.*\b(receive|get|got)\b/)) {
      const result = await inboxOrganizerService.getTodaysEmails(message.from);
      if (!result.success) return result.error;
      // Store email list for "read email N"
      if (result.emails.length > 0) {
        this._storeEmailContext(message.from, result.emails);
      }
      return result.summary;
    }

    // Default: unread inbox summary
    const result = await inboxOrganizerService.getInboxSummary(message.from);
    if (!result.success) return result.error;

    // Flatten categorized emails for "read email N" context
    if (result.emails) {
      const allEmails = [
        ...(result.emails.urgent || []),
        ...(result.emails.action_needed || []),
        ...(result.emails.fyi || []),
        ...(result.emails.newsletters || []),
        ...(result.emails.promotions || [])
      ];
      if (allEmails.length > 0) {
        this._storeEmailContext(message.from, allEmails);
      }
    }
    return result.summary;
  }

  async handleInboxSearch(message, intentParams = {}) {
    return this._featureUnavailable('Gmail email search');
    /* eslint-disable no-unreachable */
    const scopeCheck = await this._checkScopeOrPrompt(message.from, 'inbox', 'Email search');
    if (scopeCheck) return scopeCheck;

    // Determine folder from intent params or message text
    let folder = intentParams?.folder || 'inbox';
    if (folder === 'inbox' && /\b(sent|i\s+sent|my\s+sent|outbox)\b/i.test(message.text)) {
      folder = 'sent';
    }

    // Use LLM to extract actual search intent from natural language
    const { extractQuery } = require('../utils/query-extractor');
    const extracted = await extractQuery(message.text, 'email');
    let searchQuery = extracted.query;

    // Build Gmail search query from LLM-extracted filters
    if (extracted.filters.from && !searchQuery.toLowerCase().includes(`from:${extracted.filters.from.toLowerCase()}`)) {
      searchQuery = `from:${extracted.filters.from} ${searchQuery}`.trim();
    }

    // Add date filter for Gmail API
    if (extracted.filters.timeframe) {
      const tf = extracted.filters.timeframe.toLowerCase();
      const now = new Date();
      if (tf.includes('today')) {
        const dateStr = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
        searchQuery += ` after:${dateStr}`;
      } else if (tf.includes('yesterday')) {
        const yday = new Date(now.getTime() - 86400000);
        const dateStr = `${yday.getFullYear()}/${String(yday.getMonth() + 1).padStart(2, '0')}/${String(yday.getDate()).padStart(2, '0')}`;
        const todayStr = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
        searchQuery += ` after:${dateStr} before:${todayStr}`;
      } else if (tf.includes('last week') || tf.includes('this week')) {
        const weekAgo = new Date(now.getTime() - 7 * 86400000);
        const dateStr = `${weekAgo.getFullYear()}/${String(weekAgo.getMonth() + 1).padStart(2, '0')}/${String(weekAgo.getDate()).padStart(2, '0')}`;
        searchQuery += ` after:${dateStr}`;
      } else if (tf.includes('last month') || tf.includes('this month')) {
        const monthAgo = new Date(now.getTime() - 30 * 86400000);
        const dateStr = `${monthAgo.getFullYear()}/${String(monthAgo.getMonth() + 1).padStart(2, '0')}/${String(monthAgo.getDate()).padStart(2, '0')}`;
        searchQuery += ` after:${dateStr}`;
      }
    }

    if (!searchQuery) return 'What should I search for?\n\nTry:\n- "find email from John"\n- "search email for invoice"\n- "check sent emails to John"';

    const result = await inboxOrganizerService.searchInbox(message.from, searchQuery, 10, folder);
    if (!result.success) return result.error;

    // Store for "read email N"
    if (result.emails?.length > 0) {
      this._storeEmailContext(message.from, result.emails);
    }
    return result.summary;
  }

  _storeEmailContext(userPhone, emails) {
    this._emailListContext.set(userPhone, {
      emails,
      timestamp: Date.now()
    });
  }

  async _readEmailByIndex(userPhone, index) {
    const ctx = this._emailListContext.get(userPhone);

    if (!ctx || (Date.now() - ctx.timestamp) > 10 * 60 * 1000) {
      return 'No recent email list. Say "check my inbox" or "search email for [keyword]" first.';
    }

    const idx = index - 1;
    if (idx < 0 || idx >= ctx.emails.length) {
      return `Invalid number. Choose between 1 and ${ctx.emails.length}.`;
    }

    const email = ctx.emails[idx];
    // Detect if this is an Outlook email (Outlook IDs are long base64, Gmail IDs are hex)
    const isOutlookEmail = email.id && email.id.length > 50;
    let result;
    if (isOutlookEmail) {
      const outlookInboxService = require('../services/outlook-inbox.service');
      result = await outlookInboxService.getEmailDetails(userPhone, email.id);
    } else {
      result = await inboxOrganizerService.getEmailDetails(userPhone, email.id);
    }
    if (!result.success) return result.error;

    const e = result.email;
    const from = e.from.replace(/<[^>]+>/, '').trim();
    let response = `*${e.subject || '(no subject)'}*\n\n`;
    response += `*From:* ${from}\n`;
    response += `*To:* ${e.to || 'me'}\n`;
    response += `*Date:* ${e.date}\n\n`;
    response += e.body.slice(0, 2500);
    if (e.body.length > 2500) response += '\n\n_...message truncated_';
    return response;
  }

  // ========== OUTLOOK INBOX ==========

  async handleOutlookInboxCheck(message) {
    const outlookInboxService = require('../services/outlook-inbox.service');
    if (!await outlookInboxService.isConnected(message.from)) {
      return 'Outlook not connected. Say "connect outlook" to link your Microsoft account.';
    }

    const lower = message.text.toLowerCase();
    const wantsToday = /\b(today|aaj|आज)\b/i.test(lower);

    if (wantsToday) {
      const result = await outlookInboxService.getTodaysEmails(message.from);
      if (!result.success) return result.error;
      if (result.emails?.length > 0) this._storeEmailContext(message.from, result.emails);
      return result.summary;
    }

    const result = await outlookInboxService.getInboxSummary(message.from);
    if (!result.success) return result.error;
    if (result.emails?.length > 0) this._storeEmailContext(message.from, result.emails);
    return result.summary;
  }

  async handleOutlookInboxSearch(message) {
    const outlookInboxService = require('../services/outlook-inbox.service');
    if (!await outlookInboxService.isConnected(message.from)) {
      return 'Outlook not connected. Say "connect outlook" to link your Microsoft account.';
    }

    const { extractQuery } = require('../utils/query-extractor');
    const extracted = await extractQuery(message.text, 'email');
    let searchQuery = extracted.query;

    if (extracted.filters.from && !searchQuery.toLowerCase().includes(extracted.filters.from.toLowerCase())) {
      searchQuery = `from:${extracted.filters.from} ${searchQuery}`.trim();
    }

    if (!searchQuery) return 'What should I search for in Outlook?\n\nTry: "find outlook email from John"';

    const result = await outlookInboxService.searchInbox(message.from, searchQuery);
    if (!result.success) return result.error;
    if (result.emails?.length > 0) this._storeEmailContext(message.from, result.emails);
    return result.summary;
  }

  // ========== SMART EMAIL QUERY ==========
  async handleEmailQuery(message) {
    return this._featureUnavailable('Smart email queries');
    /* eslint-disable no-unreachable */
    const scopeCheck = await this._checkScopeOrPrompt(message.from, 'inbox', 'Email search');
    if (scopeCheck) return scopeCheck;

    try {
      // Step 1: Use AI to extract search keywords from natural question
      const extractResponse = await aiService.quickAI(
`The user is asking a question about their emails. Extract Gmail search keywords from their question.
Return ONLY a JSON object with: {"keywords": "gmail search query", "question": "what they want to know"}

Examples:
- "did anyone send me the invoice?" â†’ {"keywords": "invoice", "question": "did anyone send an invoice"}
- "has Rahul replied about the project?" â†’ {"keywords": "from:Rahul project", "question": "did Rahul reply about the project"}
- "is there any email about the budget report?" â†’ {"keywords": "budget report", "question": "is there an email about budget report"}
- "did I get a mail from Amazon?" â†’ {"keywords": "from:Amazon", "question": "did I receive email from Amazon"}
- "any email mentioning the deadline?" â†’ {"keywords": "deadline", "question": "any email mentioning deadline"}

User message: "${message.text}"`,
        { maxTokens: 100 }
      );

      const jsonMatch = extractResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return 'Could not understand your email question. Try: "is there any mail about [topic]?"';
      }

      // Defensive parse — LLM in JSON mode usually returns valid JSON, but
      // truncation, code fences, or escape-character issues can still produce
      // malformed payloads. Don't let that crash the whole handler.
      let keywords;
      let question;
      try {
        ({ keywords, question } = JSON.parse(jsonMatch[0]));
      } catch (parseErr) {
        const preview = jsonMatch[0].slice(0, 200).replace(/\s+/g, ' ');
        logger.warn(`[EmailSearch] LLM keyword extraction returned invalid JSON: ${parseErr.message}; preview="${preview}"`);
        return 'Could not parse your email question. Try: "is there any mail about [topic]?"';
      }
      if (!keywords) {
        return 'Could not understand what to search for. Try being more specific.';
      }

      // Step 2: Search Gmail with extracted keywords
      const searchResult = await inboxOrganizerService.searchInbox(message.from, keywords, 5);
      if (!searchResult.success) return searchResult.error;

      if (!searchResult.emails || searchResult.emails.length === 0) {
        return `No emails found matching your question.\n\nI searched for: _"${keywords}"_\n\nTry rephrasing or use "search email for [keyword]" for a direct search.`;
      }

      // Step 3: Read the top emails to get their content
      const emailDetails = [];
      for (const email of searchResult.emails.slice(0, 3)) {
        const detail = await inboxOrganizerService.getEmailDetails(message.from, email.id);
        if (detail.success) {
          emailDetails.push(detail.email);
        }
      }

      if (emailDetails.length === 0) {
        return `Found ${searchResult.emails.length} email(s) matching "${keywords}" but couldn't read them.`;
      }

      // Step 4: Use AI to answer the user's question based on the email content
      const emailContext = emailDetails.map((e, i) =>
`Email ${i + 1}:\nFrom: ${e.from}\nSubject: ${e.subject}\nDate: ${e.date}\nBody: ${e.body.slice(0, 1000)}`
      ).join('\n\n---\n\n');

      const answer = await aiService.quickAI(
`Based on these emails, answer the user's question concisely.

User's question: "${question || message.text}"

${emailContext}

Rules:
- Answer the question directly (yes/no first if applicable)
- Include relevant details (who sent it, when, key info)
- Keep it short and clear
- If the emails don't answer the question, say so`,
        { maxTokens: 400, model: aiService.model }
      );

      // Store emails for "read email N"
      this._storeEmailContext(message.from, searchResult.emails);

      let response = answer;
      if (searchResult.emails.length > 0) {
        response += `\n\n_Found ${searchResult.emails.length} related email(s). Say "read email 1" to see full content._`;
      }
      return response;

    } catch (error) {
      logger.error('Email query error:', error.message);
      return 'Something went wrong while searching your emails. Try "search email for [keyword]" instead.';
    }
  }

  // ========== GOOGLE DRIVE ==========
  async handleDriveSearch(message, params = {}) {
    const scopeCheck = await this._checkScopeOrPrompt(message.from, 'drive', 'Google Drive');
    if (scopeCheck) return scopeCheck;

    let searchQuery = String(params.query || '').trim();
    if (!searchQuery) {
      const { extractQuery } = require('../utils/query-extractor');
      const extracted = await extractQuery(message.text, 'drive');
      searchQuery = extracted.query;
    }
    if (searchQuery === '*') searchQuery = '';

    const result = await googleDriveService.listFiles(message.from, searchQuery, params.limit || 10);
    if (!result.success) return result.error;

    if (result.files.length === 0) {
      return searchQuery
        ?`No files found for "${searchQuery}".`
        : 'No files found in your Drive.';
    }

    let response = searchQuery
      ?`*Drive results for "${searchQuery}":*\n\n`
      : '*Recent files in your Drive:*\n\n';
    response += googleDriveService.formatFileList(result.files);
    return response;
  }

  async handleDriveCreateFolder(message, params = {}) {
    if (!await googleAuthService.isConnected(message.from)) {
      return 'Google not connected. Say "connect google" first.';
    }

    // Extract folder name from params (LLM-supplied) or fall back to a regex
    // on the user's text — covers "create a drive folder called X" and
    // "new google drive folder X" without an extra LLM call.
    let folderName = (params.folder_name || '').trim();
    if (!folderName) {
      const m = message.text.match(/(?:folder|directory)\s+(?:called|named|titled)?\s*["']?([^"']+?)["']?$/i);
      if (m) folderName = m[1].trim();
    }
    if (!folderName) {
      return 'What should I name the folder?\n\nExample: "create a drive folder called Q3 Reports"';
    }

    const result = await googleDriveService.createFolder(message.from, folderName);
    if (!result.success) return result.error || 'Failed to create folder.';
    return `Created folder: *${result.folder.name}*\n\n${result.folder.webViewLink}`;
  }

  async handleDriveShareFile(message, params = {}) {
    if (!await googleAuthService.isConnected(message.from)) {
      return 'Google not connected. Say "connect google" first.';
    }

    const recipientEmail = (params.recipient_email || '').trim();
    const fileQuery = (params.file_query || '').trim();

    if (!recipientEmail || !/.+@.+\..+/.test(recipientEmail)) {
      return 'I need an email address to share with.\n\nExample: "share my proposal in drive with alice@acme.com"';
    }
    if (!fileQuery) {
      return 'Which file or folder should I share? Tell me the name.\n\nExample: "share the Acme Corp folder with alice@acme.com so she can add docs"';
    }

    // Resolve role: explicit param wins, else infer from message wording.
    // Triggers a writer share for collaboration verbs ("edit", "add", "upload",
    // "collaborate", "contribute", "drop files"). Defaults to reader.
    let role = ['reader', 'commenter', 'writer'].includes(params.role) ? params.role : null;
    if (!role) {
      const txt = String(message.text || '').toLowerCase();
      if (/\b(edit|add|upload|collaborat|contribut|drop\s+(file|doc|pdf)|so\s+(they|she|he|we)\s+can\s+(add|upload|edit|put))\b/.test(txt)) {
        role = 'writer';
      } else if (/\b(comment|feedback|review)\b/.test(txt)) {
        role = 'commenter';
      } else {
        role = 'reader';
      }
    }

    // Find the file by name first (uses drive.file — only sees files this app
    // created or the user has explicitly opened with this app).
    const lookup = await googleDriveService.listFiles(message.from, fileQuery);
    if (!lookup.success) return lookup.error;
    if (!lookup.files || lookup.files.length === 0) {
      return `No Drive file or folder matching "${fileQuery}" found. (drive.file scope only shows items this app created or you opened with it.)`;
    }
    if (lookup.files.length > 1) {
      let m = `Multiple items match "${fileQuery}":\n\n`;
      lookup.files.slice(0, 5).forEach((f, i) => {
        const isFolder = f.mimeType === 'application/vnd.google-apps.folder';
        m += `${i + 1}. ${isFolder ? '📁' : '📄'} *${f.name}*\n`;
      });
      m += `\nReply with the exact name to share.`;
      return m;
    }

    const file = lookup.files[0];
    const share = await googleDriveService.shareFile(
      message.from,
      file.id,
      recipientEmail,
      { role, message: params.message }
    );
    if (!share.success) return share.error || 'Failed to share.';

    const accessLabel = {
      reader: 'view-only access',
      commenter: 'view + comment access',
      writer: 'edit access (can upload + add files)'
    }[share.role];
    const itemLabel = share.isFolder ? '📁 folder' : '📄 file';

    return `Shared ${itemLabel} *${share.name}* with ${recipientEmail} (${accessLabel}).\n\n${share.link}\n\n_Google sent them an email notification with the link._`;
  }

  // ========== GOOGLE DOCS ==========
  async handleDocsManage(message, params = {}) {
    const scopeCheck = await this._checkScopeOrPrompt(message.from, 'docs', 'Google Docs');
    if (scopeCheck) return scopeCheck;

    const text = message.text.toLowerCase();
    const action = String(params.action || '').toLowerCase();

    // Summarize a doc
    if (action === 'summarize' || (!action && text.match(/summarize/i))) {
      const supplied = String(params.document_id || message.text);
      const docId = googleDocsService.extractDocId(supplied) || (params.document_id ? supplied : null);
      if (!docId) return 'Please include a Google Docs link or ID.\n\nExample: "summarize doc https://docs.google.com/document/d/..."';

      const result = await googleDocsService.summarizeDoc(message.from, docId);
      if (!result.success) return result.error;
      return `*${result.title}*\n\n${result.summary}`;
    }

    // Read a doc
    if (action === 'read' || (!action && text.match(/read|open/i))) {
      const supplied = String(params.document_id || message.text);
      const docId = googleDocsService.extractDocId(supplied) || (params.document_id ? supplied : null);
      if (!docId) return 'Please include a Google Docs link or ID.';

      const result = await googleDocsService.getDocContent(message.from, docId);
      if (!result.success) return result.error;

      let response = `*${result.title}*\n\n${result.content.slice(0, 2000)}`;
      if (result.fullLength > 2000) {
        response += `\n\n_...${result.fullLength - 2000} more characters. Say "summarize doc" for a summary._`;
      }
      return response;
    }

    // Create a doc
    if (action === 'create' || (!action && text.match(/create/i))) {
      const titleMatch = message.text.match(/(?:create\s+(?:a\s+)?(?:google\s+)?doc(?:ument)?\s+)(?:called|named|titled)?\s*["']?(.+?)["']?$/i);
      const title = String(params.title || (titleMatch ? titleMatch[1].trim() : 'Untitled Document'));
      const result = await googleDocsService.createDoc(message.from, title);
      if (!result.success) return result.error;
      return `Created: *${result.title}*\n\n${result.link}`;
    }

    // Search docs
    let query = String(params.query || '').trim();
    if (!query) {
      const { extractQuery: extractDocsQuery } = require('../utils/query-extractor');
      const docsExtracted = await extractDocsQuery(message.text, 'docs');
      query = docsExtracted.query;
    }
    if (query) {
      const result = await googleDocsService.searchDocs(message.from, query);
      if (!result.success) return result.error;
      if (result.docs.length === 0) return `No documents found for "${query}".`;

      let response = `*Documents matching "${query}":*\n\n`;
      result.docs.forEach((d, i) => {
        const date = new Date(d.modifiedTime).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
        response += `${i + 1}. *${d.name}* (${date})\n ${d.webViewLink}\n`;
      });
      return response;
    }

    return 'Try:\n- "summarize doc [link]"\n- "read doc [link]"\n- "create doc called Meeting Notes"\n- "search docs budget"';
  }

  // ========== GOOGLE SHEETS ==========
  async handleSheetsManage(message, params = {}) {
    const scopeCheck = await this._checkScopeOrPrompt(message.from, 'sheets', 'Google Sheets');
    if (scopeCheck) return scopeCheck;

    const text = message.text.toLowerCase();
    const action = String(params.action || '').toLowerCase();

    // Summarize a sheet
    if (action === 'summarize' || (!action && text.match(/summarize/i))) {
      const supplied = String(params.spreadsheet_id || message.text);
      const sheetId = googleSheetsService.extractSpreadsheetId(supplied) || (params.spreadsheet_id ? supplied : null);
      if (!sheetId) return 'Please include a Google Sheets link or ID.\n\nExample: "summarize sheet https://docs.google.com/spreadsheets/d/..."';

      const result = await googleSheetsService.summarizeSheet(message.from, sheetId);
      if (!result.success) return result.error;
      return `*${result.title}* (${result.rowCount} rows)\n\n${result.summary}`;
    }

    // Read a sheet
    if (action === 'read' || (!action && text.match(/read|open/i))) {
      const supplied = String(params.spreadsheet_id || message.text);
      const sheetId = googleSheetsService.extractSpreadsheetId(supplied) || (params.spreadsheet_id ? supplied : null);
      if (!sheetId) return 'Please include a Google Sheets link or ID.';

      const result = await googleSheetsService.getSheetData(message.from, sheetId);
      if (!result.success) return result.error;
      return `*${result.title}*\nSheets: ${result.sheetNames.join(', ')}\n\n${googleSheetsService.formatSheetPreview(result.rows)}`;
    }

    // Create a sheet
    if (action === 'create' || (!action && text.match(/create|make|new/i))) {
      const titleMatch = message.text.match(/(?:create|make|new)\s+(?:a\s+)?(?:google\s+)?(?:spread)?sheet\s+(?:called|named|titled)?\s*["']?(.+?)["']?$/i);
      const title = String(params.title || (titleMatch ? titleMatch[1].trim() : 'Untitled Spreadsheet'));
      const result = await googleSheetsService.createSpreadsheet(message.from, title);
      if (!result.success) return result.error;
      return `Created: *${result.title}*\n\n${result.link}`;
    }

    // Search sheets
    let query = String(params.query || '').trim();
    if (!query) {
      const { extractQuery: extractSheetsQuery } = require('../utils/query-extractor');
      const sheetsExtracted = await extractSheetsQuery(message.text, 'sheets');
      query = sheetsExtracted.query;
    }
    if (query) {
      const result = await googleSheetsService.searchSheets(message.from, query);
      if (!result.success) return result.error;
      if (result.sheets.length === 0) return `No spreadsheets found for "${query}".`;

      let response = `*Spreadsheets matching "${query}":*\n\n`;
      result.sheets.forEach((s, i) => {
        const date = new Date(s.modifiedTime).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
        response += `${i + 1}. *${s.name}* (${date})\n ${s.webViewLink}\n`;
      });
      return response;
    }

    return 'Try:\n- "summarize sheet [link]"\n- "read sheet [link]"\n- "create sheet called Q3 Numbers"\n- "search sheets budget"';
  }

  // ========== GOOGLE SLIDES ==========
  async handleSlidesManage(message, params = {}) {
    const scopeCheck = await this._checkScopeOrPrompt(message.from, 'slides', 'Google Slides');
    if (scopeCheck) return scopeCheck;

    const text = message.text.toLowerCase();
    const action = String(params.action || '').toLowerCase();

    // Summarize a presentation
    if (action === 'summarize' || (!action && text.match(/summarize/i))) {
      const supplied = String(params.presentation_id || message.text);
      const presentationId = googleSlidesService.extractPresentationId(supplied) || (params.presentation_id ? supplied : null);
      if (!presentationId) return 'Please include a Google Slides link or ID.\n\nExample: "summarize slides https://docs.google.com/presentation/d/..."';

      const result = await googleSlidesService.summarizePresentation(message.from, presentationId);
      if (!result.success) return result.error;
      return `*${result.title}* (${result.slideCount} slides)\n\n${result.summary}`;
    }

    // Read a presentation
    if (action === 'read' || (!action && text.match(/read|open/i))) {
      const supplied = String(params.presentation_id || message.text);
      const presentationId = googleSlidesService.extractPresentationId(supplied) || (params.presentation_id ? supplied : null);
      if (!presentationId) return 'Please include a Google Slides link or ID.';

      const result = await googleSlidesService.getPresentationContent(message.from, presentationId);
      if (!result.success) return result.error;

      let response = `*${result.title}* (${result.slideCount} slides)\n\n${result.content.slice(0, 2000)}`;
      if (result.fullLength > 2000) {
        response += `\n\n_...${result.fullLength - 2000} more characters. Say "summarize slides" for a summary._`;
      }
      return response;
    }

    // Create a presentation
    if (action === 'create' || (!action && text.match(/create|make|new/i))) {
      const titleMatch = message.text.match(/(?:create|make|new)\s+(?:a\s+)?(?:google\s+)?(?:slides|slide|presentation|deck)\s+(?:called|named|titled)?\s*["']?(.+?)["']?$/i);
      const title = String(params.title || (titleMatch ? titleMatch[1].trim() : 'Untitled Presentation'));
      const result = await googleSlidesService.createPresentation(message.from, title);
      if (!result.success) return result.error;
      return `Created: *${result.title}*\n\n${result.link}`;
    }

    // Search presentations
    let query = String(params.query || '').trim();
    if (!query) {
      const { extractQuery: extractSlidesQuery } = require('../utils/query-extractor');
      const slidesExtracted = await extractSlidesQuery(message.text, 'slides');
      query = slidesExtracted.query;
    }
    if (query) {
      const result = await googleSlidesService.searchPresentations(message.from, query);
      if (!result.success) return result.error;
      if (result.presentations.length === 0) return `No presentations found for "${query}".`;

      let response = `*Presentations matching "${query}":*\n\n`;
      result.presentations.forEach((p, i) => {
        const date = new Date(p.modifiedTime).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
        response += `${i + 1}. *${p.name}* (${date})\n ${p.webViewLink}\n`;
      });
      return response;
    }

    return 'Try:\n- "summarize slides [link]"\n- "read slides [link]"\n- "create slides called Q3 Roadmap"\n- "search slides launch"';
  }

  // ========== UPLOAD ARBITRARY FILE TO DRIVE ==========
  async handleDriveUpload(message, intentParams = {}) {
    if (!await googleAuthService.isConnected(message.from)) {
      return 'Google not connected. Say "connect google" first.';
    }

    if (isAgentToolMessage(message)) {
      const artifactIds = Array.isArray(intentParams.artifact_ids) ? intentParams.artifact_ids : [];
      if (artifactIds.length === 0) return unavailableAgentArtifactMessage();

      let artifacts;
      try {
        // Resolve every ID before the first Drive write. A foreign/unknown ID
        // therefore cannot cause a partial upload of the preceding artifacts.
        artifacts = await fileArtifactService.loadOwnedArtifacts(message.from, artifactIds);
      } catch (error) {
        logger.warn({ code: error?.code || 'artifact_unavailable' }, 'Agent Drive artifact resolution failed');
        return unavailableAgentArtifactMessage();
      }

      const uploaded = [];
      const failed = [];
      for (let index = 0; index < artifacts.length; index++) {
        const artifact = artifacts[index];
        const requestedName = artifacts.length === 1 && intentParams.rename_to
          ? intentParams.rename_to
          : artifact.fileName;
        const result = await googleDriveService.uploadFile(message.from, {
          name: sanitizeFilename(requestedName || 'upload'),
          content: artifact.buffer,
          mimeType: artifact.mimeType,
        });
        if (result.success) uploaded.push(result.file);
        else failed.push(artifact.fileName || `artifact ${index + 1}`);
      }

      if (failed.length > 0) {
        if (uploaded.length === 0) return 'Failed to upload the selected artifact to Drive.';
        return {
          status: 'partial',
          data: { uploaded: uploaded.map((file) => ({ id: file.id, name: file.name, webViewLink: file.webViewLink })) },
          error: {
            code: 'drive_upload_partial', category: 'external_write', retryable: true,
            message: `Drive accepted ${uploaded.length} of ${artifacts.length} selected artifacts.`,
          },
          user_summary: `Uploaded ${uploaded.length}/${artifacts.length} selected artifacts to Drive. ${failed.length} failed.`,
        };
      }

      if (uploaded.length === 1) {
        return `Uploaded to Drive: *${uploaded[0].name}*\n\n${uploaded[0].webViewLink}`;
      }
      return `Uploaded ${uploaded.length} selected artifacts to Drive:\n${uploaded
        .map((file) => `- ${file.name}: ${file.webViewLink}`)
        .join('\n')}`;
    }

    // We need a recently-uploaded document attached in conversation context.
    const docCtx = this.documentContext?.get?.(message.from);
    if (!docCtx || !docCtx.buffer) {
      return 'Send the file (PDF, image, doc) on WhatsApp first, then say "save this to drive".';
    }
    const ageMs = Date.now() - (docCtx.timestamp || 0);
    const ttl = this.workflowContextTtls?.document || (10 * 60 * 1000);
    if (ageMs > ttl) {
      return 'I don\'t see a recent file in our conversation. Re-send the file on WhatsApp, then say "save this to drive".';
    }

    const result = await googleDriveService.uploadFile(message.from, {
      name: docCtx.fileName || docCtx.documentName || 'upload',
      content: docCtx.buffer,
      mimeType: docCtx.mimeType
    });
    if (!result.success) return result.error || 'Failed to upload to Drive.';
    return `Uploaded to Drive: *${result.file.name}*\n\n${result.file.webViewLink}`;
  }

  // ========== GMAIL LABELS / ARCHIVE ==========
  // ── Email Automation Handlers ─────────────────────────────────────

  async handleEmailAutomation(message, params = {}) {
    return this._featureUnavailable('Gmail automation');
    /* eslint-disable no-unreachable */
    const emailPreferencesService = require('../services/email-preferences.service');
    const googleAuthService = require('../services/google-auth.service');
    const action = params.action;

    switch (action) {
      case 'enable_auto_label': {
        const connected = await googleAuthService.isConnected(message.from);
        if (!connected) return 'Connect Google first. Say "connect google".';
        await emailPreferencesService.setAutoLabel(message.from, true);
        return '*Auto-labeling enabled!* ✅\n\nI\'ll categorize your unread emails every 15 minutes into:\n• Urgent\n• Action Needed\n• FYI\n• Newsletter\n• Promotion\n\n_Say "disable auto labeling" to turn off._';
      }
      case 'disable_auto_label': {
        await emailPreferencesService.setAutoLabel(message.from, false);
        return 'Auto-labeling disabled. Your existing labels will remain.';
      }
      case 'enable_reply_tracking': {
        const connected = await googleAuthService.isConnected(message.from);
        if (!connected) return 'Connect Google first. Say "connect google".';
        const hours = params.hours || 24;
        await emailPreferencesService.setReplyTracking(message.from, true, hours);
        return `*Reply tracking enabled!* ✅\n\nI'll notify you on WhatsApp if no reply within ${hours} hours after sending an email.\n\n_Say "set reply tracking to X hours" to change, or "disable reply tracking" to turn off._`;
      }
      case 'disable_reply_tracking': {
        await emailPreferencesService.setReplyTracking(message.from, false);
        return 'Reply tracking disabled. Existing tracked emails will stop being monitored.';
      }
      case 'set_reply_hours': {
        const hours = params.hours || 24;
        if (hours < 1 || hours > 168) return 'Please set between 1 and 168 hours (1 week).';
        await emailPreferencesService.setReplyTracking(message.from, true, hours);
        return `Reply tracking window set to *${hours} hours*.`;
      }
      case 'view_settings': {
        const prefs = await emailPreferencesService.getPreferences(message.from);
        return `*Email Automation Settings*\n\n` +
          `📬 Auto-labeling: ${prefs.auto_label_enabled ? '✅ Enabled' : '❌ Disabled'}\n` +
          `📩 Reply tracking: ${prefs.reply_tracking_enabled ? '✅ Enabled' : '❌ Disabled'}\n` +
          `⏱️ Reply wait time: ${prefs.reply_tracking_hours || 24} hours\n\n` +
          `_Say "enable auto labeling" or "disable reply tracking" to change._`;
      }
      default:
        return 'Try "enable auto labeling", "enable reply tracking", or "email settings".';
    }
  }

  async handleReplyTrack(message, params = {}) {
    return this._featureUnavailable('Email reply tracking');
    /* eslint-disable no-unreachable */
    const replyTrackerService = require('../services/reply-tracker.service');
    const gmailService = require('../services/gmail.service');
    const inboxOrganizerService = require('../services/inbox-organizer.service');
    const action = params.action;

    switch (action) {
      case 'track': {
        const recipientQuery = params.recipient;
        if (!recipientQuery) return 'Who should I track? Say "track reply from [name or email]".';

        // Search sent emails for this recipient
        const searchResult = await inboxOrganizerService.searchSentEmails(message.from, recipientQuery, 1);
        if (!searchResult?.success || !searchResult.emails?.length) {
          // Try sent email log
          const logs = await gmailService.getSentEmailLog(message.from, recipientQuery);
          if (!logs || logs.length === 0) {
            return `No sent emails found for "${recipientQuery}". Send an email first.`;
          }
          const latest = logs[0];
          const hours = params.hours || 24;
          await replyTrackerService.trackEmail(message.from, {
            messageId: latest.gmail_message_id,
            threadId: latest.gmail_thread_id,
            recipientEmail: latest.recipient_email || recipientQuery,
            recipientName: null,
            subject: latest.subject,
            sentAt: new Date(latest.sent_at),
            waitHours: hours,
          });
          return `📩 Tracking "${latest.subject}" to ${latest.recipient_email || recipientQuery}.\n\nI'll notify you if no reply in *${hours} hours*.`;
        }

        const email = searchResult.emails[0];
        const hours = params.hours || 24;
        await replyTrackerService.trackEmail(message.from, {
          messageId: email.id,
          threadId: email.threadId || email.id,
          recipientEmail: recipientQuery,
          recipientName: null,
          subject: email.subject,
          sentAt: new Date(email.date),
          waitHours: hours,
        });
        return `📩 Tracking "${email.subject}" to ${recipientQuery}.\n\nI'll notify you if no reply in *${hours} hours*.`;
      }
      case 'list': {
        const tracked = await replyTrackerService.getUserTrackedEmails(message.from);
        if (!tracked || tracked.length === 0) return 'No emails being tracked right now.';

        const lines = tracked.map((t, i) => {
          const ago = Math.round((Date.now() - new Date(t.sent_at).getTime()) / 3600000);
          const status = t.status === 'notified' ? '⚠️ Notified' : '🔍 Tracking';
          return `${i + 1}. ${status} "${t.subject}"\n   To: ${t.recipient_email} | Sent ${ago}h ago | Wait: ${t.wait_hours}h`;
        });
        return `*Tracked Emails* (${tracked.length})\n\n${lines.join('\n\n')}\n\n_Say "stop tracking [number]" to cancel._`;
      }
      case 'cancel': {
        const idx = params.tracking_index;
        if (!idx) return 'Which tracked email? Say "stop tracking 1" (use the number from "show tracked emails").';

        const tracked = await replyTrackerService.getUserTrackedEmails(message.from);
        if (!tracked || idx > tracked.length || idx < 1) return 'Invalid number. Say "show tracked emails" first.';

        await replyTrackerService.cancelTracking(tracked[idx - 1].id, message.from);
        return `Stopped tracking "${tracked[idx - 1].subject}". ✅`;
      }
      default:
        return 'Try "track reply from [name]", "show tracked emails", or "stop tracking [number]".';
    }
  }

  async handleLabelsManage(message, params = {}) {
    return this._featureUnavailable('Gmail labels and archive actions');
    /* eslint-disable no-unreachable */
    const inboxOrganizerService = require('../services/inbox-organizer.service');
    const action = params.action;
    const messageRef = params.message_ref;
    const labelName = params.label_name;

    if (!action) {
      return 'Tell me what to do: archive, mark as read/unread, apply label, remove label, or list labels.';
    }

    // List labels does not need a message reference
    if (action === 'list_labels') {
      const result = await inboxOrganizerService.listLabels(message.from);
      if (!result.success) return result.error || 'Could not fetch labels.';
      const userLabels = result.labels.filter(l => l.type === 'user').map(l => `• ${l.name}`);
      if (userLabels.length === 0) return 'You have no custom Gmail labels yet.';
      return `*Your Gmail labels:*\n\n${userLabels.join('\n')}`;
    }

    // Resolve the email reference to a Gmail message ID
    const resolvedId = await this.resolveEmailRef(message.from, messageRef);
    if (!resolvedId) {
      return `Could not find email "${messageRef}". Try "show my latest emails" first, then reference by number.`;
    }

    let result;
    switch (action) {
      case 'archive':
        result = await inboxOrganizerService.archiveEmail(message.from, resolvedId);
        if (!result.success) return result.error || 'Could not archive email.';
        return 'Email archived.';

      case 'mark_read':
        result = await inboxOrganizerService.markAsRead(message.from, resolvedId);
        if (!result.success) return result.error || 'Could not mark as read.';
        return 'Email marked as read.';

      case 'mark_unread':
        result = await inboxOrganizerService.markAsUnread(message.from, resolvedId);
        if (!result.success) return result.error || 'Could not mark as unread.';
        return 'Email marked as unread.';

      case 'apply_label':
        if (!labelName) return 'Which label should I apply?';
        result = await inboxOrganizerService.applyLabel(message.from, resolvedId, labelName);
        if (!result.success) return result.error || `Could not apply label ${labelName}.`;
        return `Applied label "${labelName}" to the email.`;

      case 'remove_label':
        if (!labelName) return 'Which label should I remove?';
        result = await inboxOrganizerService.removeLabel(message.from, resolvedId, labelName);
        if (!result.success) return result.error || `Could not remove label ${labelName}.`;
        return `Removed label "${labelName}" from the email.`;

      default:
        return `Unknown action: ${action}`;
    }
  }

  // Resolve "1", "first", a subject, or a raw Gmail ID to a Gmail message ID.
  // Checks both _emailListContext (populated by inbox check/search) and
  // recentEmailContext (populated by individual email reads) for the list.
  async resolveEmailRef(userPhone, ref) {
    if (!ref) return null;
    const trimmed = String(ref).trim();
    const lower = trimmed.toLowerCase();

    // Looks like a Gmail message ID already (long alphanumeric, not purely numeric)
    if (/^[a-zA-Z0-9_-]{12,}$/.test(trimmed) && !/^\d+$/.test(trimmed)) {
      return trimmed;
    }

    // Source 1: _emailListContext (set by inbox check, search, today's emails)
    // Format: { emails: [{ id, subject, from, ... }], timestamp }
    const listCtx = this._emailListContext && this._emailListContext.get(userPhone);
    if (listCtx && Array.isArray(listCtx.emails) && listCtx.emails.length > 0) {
      const found = this._matchEmailInList(listCtx.emails, trimmed, lower);
      if (found) return found;
    }

    // Source 2: recentEmailContext (set by other flows, uses `items` key)
    const recentList = this.recentEmailContext && this.recentEmailContext.get(userPhone);
    if (recentList && Array.isArray(recentList.items) && recentList.items.length > 0) {
      const found = this._matchEmailInList(recentList.items, trimmed, lower);
      if (found) return found;
    }

    return null;
  }

  // Helper — matches "1", "first", subject substring, or sender substring
  _matchEmailInList(list, trimmed, lower) {
    // Numeric: "1", "2"
    const num = parseInt(trimmed, 10);
    if (!isNaN(num) && num >= 1 && num <= list.length) {
      return list[num - 1].id;
    }
    // Ordinals
    const ordinals = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, last: list.length };
    if (ordinals[lower]) {
      return list[ordinals[lower] - 1].id;
    }
    // Subject / sender substring match
    const match = list.find(e =>
      (e.subject && e.subject.toLowerCase().includes(lower)) ||
      (e.from && e.from.toLowerCase().includes(lower))
    );
    return match ? match.id : null;
  }

  // ========== GOOGLE TASKS ==========
  async handleGoogleTasksManage(message, params = {}) {
    const scopeCheck = await this._checkScopeOrPrompt(message.from, 'tasks', 'Google Tasks');
    if (scopeCheck) return scopeCheck;

    const googleTasksService = require('../services/google-tasks.service');
    const listPositionCache = require('../utils/list-position-cache');
    const action = params.action || 'list';

    switch (action) {
      case 'list': {
        const result = await googleTasksService.listTasks(message.from);
        if (!result.success) return result.error || 'Could not fetch Google Tasks.';
        if (!result.tasks || result.tasks.length === 0) return 'No Google Tasks in your default list.';
        // Stamp the exact order shown so "complete google task 2" later
        // resolves against THIS list, not a re-queried ordering.
        listPositionCache.remember(message.from, 'google_tasks', result.tasks.map((t) => ({
          id: t.id, title: t.title, status: t.status,
        })));
        let response = '*Google Tasks:*\n\n';
        result.tasks.forEach((t, i) => {
          const status = t.status === 'completed' ? '✓' : '○';
          response += `${i + 1}. ${status} ${t.title}\n`;
        });
        return response;
      }
      case 'create': {
        if (!params.title) return 'What task should I add?';
        const result = await googleTasksService.createTask(message.from, { title: params.title });
        if (!result.success) return result.error || 'Could not create Google Task.';
        return `Added to Google Tasks: "${params.title}"`;
      }
      case 'complete': {
        const position = Number(params.task_position || params.position || 0);
        let target = position > 0 ? listPositionCache.pick(message.from, 'google_tasks', position) : null;
        if (!target) {
          const result = await googleTasksService.listTasks(message.from);
          if (!result.success) return result.error || 'Could not fetch Google Tasks.';
          const tasks = result.tasks || [];
          if (tasks.length === 0) return 'No Google Tasks in your default list.';
          const titleQuery = String(params.title || '').trim().toLowerCase();
          if (position > 0) {
            target = tasks[position - 1] || null;
          } else if (titleQuery) {
            const matches = tasks.filter((t) => String(t.title || '').toLowerCase().includes(titleQuery));
            if (matches.length > 1) {
              return `Found ${matches.length} Google Tasks matching "${params.title}". Say "show my google tasks" and tell me the number.`;
            }
            target = matches[0] || null;
          }
        }
        if (!target?.id) {
          return 'Which Google Task should I complete? Say "show my google tasks" and give me its number or title.';
        }
        if (target.status === 'completed') return `"${target.title}" is already completed.`;
        const result = await googleTasksService.completeTask(message.from, target.id);
        if (!result.success) return result.error || 'Could not complete that Google Task.';
        listPositionCache.forget(message.from, 'google_tasks');
        return `Completed Google Task: "${target.title}" ✓`;
      }
      default:
        return 'Google Tasks actions: list, create, complete';
    }
  }

  // ========== GMAIL CONTACT SEARCH ==========
  // Searches Gmail history for people matching a name — needs gmail.readonly.
  async handleGoogleContactsSearch(message, params = {}) {
    return this._featureUnavailable('Gmail-history contact search');
    /* eslint-disable no-unreachable */
    const inboxOrganizerService = require('../services/inbox-organizer.service');
    const query = params.query || params.name || params.full_text || message.text;

    const result = await inboxOrganizerService.findContactInEmails(message.from, query);
    if (!result.success) return result.error || 'Could not search your Gmail history.';
    if (!result.matches || result.matches.length === 0) {
      return `No one matching "${query}" found in your recent emails.`;
    }

    let response = `*Matches for "${query}" from your Gmail history:*\n\n`;
    result.matches.slice(0, 10).forEach((c, i) => {
      response += `${i + 1}. *${c.name}*\n`;
      response += `   Email: ${c.email}\n`;
      response += `   Emails exchanged: ${c.frequency}\n\n`;
    });
    return response;
  }

  // ========== OUTLOOK/MICROSOFT ==========
  async handleOutlookConnect(message) {
    const alreadyConnected = await microsoftAuthService.isConnected(message.from);
    if (alreadyConnected) {
      const email = await microsoftAuthService.getMicrosoftEmail(message.from);
      return `Already connected to Outlook (${email}).\n\nSay "disconnect outlook" to unlink.`;
    }

    if (!process.env.MICROSOFT_CLIENT_ID || !process.env.MICROSOFT_CLIENT_SECRET) {
      return 'Microsoft/Outlook integration is not configured on this server.';
    }

    const authUrl = microsoftAuthService.generateAuthUrl(message.from);
    if (!authUrl) return 'Microsoft integration is not configured.';
    return `Connect your Microsoft account:\n\n${authUrl}\n\nClick the link above to authorize Outlook Calendar access.`;
  }

  async handleOutlookDisconnect(message) {
    const wasConnected = await microsoftAuthService.revokeTokens(message.from);
    if (!wasConnected) {
      return 'Microsoft/Outlook account is not connected.';
    }
    return 'Outlook disconnected. Your tokens have been deleted.';
  }

  // ========== MULTI-CALENDAR ==========
  async handleCalendarList(message) {
    const calendars = await unifiedCalendarService.listAllCalendars(message.from);
    return unifiedCalendarService.formatCalendarList(calendars);
  }

  // ========== TASK MANAGEMENT ==========
  async handleTaskManage(message, context) {
    // Prefer LLM-extracted params over regex parsing
    const intentParams = context.intentParams || {};
    let cmd;
    if (intentParams.action) {
      cmd = {
        action: intentParams.action,
        target: intentParams.assignee_name || null,
        description: intentParams.task_title || intentParams.full_text || message.text,
        stableId: context?.agentExecution ? (intentParams.task_id || null) : null,
        index: intentParams.task_position || (!context?.agentExecution ? (intentParams.task_id || null) : null),
        titleQuery: intentParams.task_title || null
      };
    } else {
      cmd = taskService.parseEnhancedTaskCommand(message.text);
    }
    if (!cmd) return await aiService.chat(message.from, message.text, context);

    switch (cmd.action) {
      case 'list': {
        const tasks = await taskService.getAllMyTasks(message.from);
        // Stamp the shown order so a bare "2" follow-up resolves against
        // THIS list (positional-resolver + task_position selectors).
        if (Array.isArray(tasks) && tasks.length > 0) {
          require('../utils/list-position-cache').remember(message.from, 'tasks', tasks.map((t) => ({
            id: t.id, title: t.description || t.title || null,
          })));
        }
        return await taskService.formatTasksList(tasks, message.from);
      }
      case 'add': {
        // CONTEXT-BLEED GUARD — make sure the description the LLM produced
        // is actually sourced from the user's current message. If not, the
        // LLM may have lifted stale text from conversation history (as we
        // saw with reminders); fall back to asking for clarification.
        if (cmd.description && message.text) {
          try {
            const { checkTextFromUser } = require('../utils/llm-output-validator');
            const check = checkTextFromUser(cmd.description, message.text);
            if (check.suspicious) {
              logger.warn({
                userPhone: message.from,
                llmDesc: cmd.description,
                userText: String(message.text).slice(0, 120),
                overlap: check.overlap
              }, 'LLM task description failed user-text overlap check');
              return `What task should I add? Please say it again — I want to make sure I get it right.`;
            }
          } catch (_) { /* skip validator on any error */ }
        }

        // Parse priority from description
        let priority = intentParams.priority === 'normal'
          ? 'medium'
          : (intentParams.priority || 'medium');
        let description = cmd.description;
        if (!intentParams.priority && /\b(urgent|high priority|important)\b/i.test(description)) {
          priority = 'high';
          description = description.replace(/\b(urgent|high priority|important)\b/gi, '').trim();
        }
        if (!intentParams.priority && /\b(low priority|whenever|no rush)\b/i.test(description)) {
          priority = 'low';
          description = description.replace(/\b(low priority|whenever|no rush)\b/gi, '').trim();
        }

        // Parse due date
        let dueDate = null;
        if (intentParams.due_time) {
          const chrono = require('chrono-node');
          const timezone = context.userTimezone || process.env.DEFAULT_TIMEZONE || 'Asia/Kolkata';
          const timezoneOffset = calendarNLPService.getTimezoneOffsetMinutes(timezone);
          dueDate = chrono.parseDate(intentParams.due_time, { instant: new Date(), timezone: timezoneOffset }, { forwardDate: true });
          if (!dueDate) {
            return { status: 'waiting_input', user_summary: `I couldn't understand the task due time "${intentParams.due_time}". Please give a date and time.`, data: { field: 'due_time' } };
          }
        }
        const byMatch = !dueDate && description.match(/\bby\s+(tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}[\/\-]\d{1,2})/i);
        if (byMatch) {
          const dayStr = byMatch[1].toLowerCase();
          if (dayStr === 'tomorrow') {
            dueDate = new Date();
            dueDate.setDate(dueDate.getDate() + 1);
          } else if (dayStr === 'today') {
            dueDate = new Date();
          } else {
            const dayMap = { 'sunday': 0, 'monday': 1, 'tuesday': 2, 'wednesday': 3, 'thursday': 4, 'friday': 5, 'saturday': 6 };
            if (dayMap[dayStr] !== undefined) {
              dueDate = new Date();
              const currentDay = dueDate.getDay();
              let daysAhead = dayMap[dayStr] - currentDay;
              if (daysAhead <= 0) daysAhead += 7;
              dueDate.setDate(dueDate.getDate() + daysAhead);
            }
          }
          description = description.replace(/\bby\s+\S+/i, '').trim();
        }

        const result = await taskService.createPersonalTask(message.from, description, priority, dueDate);
        if (!result.success) return 'Could not create task. Try again?';

        // Best-effort sync to Google Tasks — only if the tasks scope is granted.
        // We silently skip when not granted so users don't see scope prompts on
        // every task add; they only see it when they explicitly ask to manage
        // Google Tasks via handleGoogleTasksManage.
        let googleSynced = false;
        try {
          const hasTasksScope = await googleAuthService.hasScope(message.from, 'tasks');
          if (hasTasksScope) {
            const googleTasksService = require('../services/google-tasks.service');
            const syncResult = await googleTasksService.createTask(message.from, {
              title: description,
              notes: priority !== 'medium' ? `Priority: ${priority}` : undefined,
              due: dueDate ? dueDate.toISOString() : undefined
            });
            if (syncResult && syncResult.success) {
              googleSynced = true;
            }
          }
        } catch (e) {
          // Non-critical — local task already created
        }

        let response = `Task added: "${description}" (ID: ${result.task?.id})`;
        if (priority !== 'medium') response += ` [${priority}]`;
        if (dueDate) response += `\nDue: ${dueDate.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}`;
        if (googleSynced) response += `\n(Synced to Google Tasks)`;

        // Structured pointer — "the task I just added" follow-ups resolve here.
        this.recordLastAction(message.from, {
          action: 'task_create',
          entityType: 'task',
          entityId: result.task?.id || result.taskId || result.id || null,
          label: description,
          at: dueDate ? dueDate.toISOString() : null,
          priority
        });

        return response;
      }
      case 'edit': {
        // Resolve the target task the same way complete does: stable ID first,
        // then displayed-list position, then a distinctive title.
        let taskId = cmd.stableId || null;
        if (!taskId && cmd.index) {
          const cached = require('../utils/list-position-cache').pick(message.from, 'tasks', Number(cmd.index));
          if (cached?.id) taskId = cached.id;
          else {
            const all = await taskService.getAllMyTasks(message.from);
            taskId = all[Number(cmd.index) - 1]?.id || null;
          }
        }
        if (!taskId && cmd.titleQuery) {
          const all = await taskService.getAllMyTasks(message.from);
          const matches = all.filter((t) => String(t.description || t.title || '')
            .toLowerCase().includes(String(cmd.titleQuery).toLowerCase()));
          if (matches.length > 1) {
            return `Found ${matches.length} tasks matching "${cmd.titleQuery}". Say "my tasks" and tell me the number to edit.`;
          }
          taskId = matches[0]?.id || null;
        }
        if (!taskId) return 'Which task should I edit? Say "my tasks" and give me its number, ID, or a distinctive title.';
        let editDueDate;
        if (intentParams.due_time) {
          const chrono = require('chrono-node');
          const timezone = context.userTimezone || process.env.DEFAULT_TIMEZONE || 'Asia/Kolkata';
          const timezoneOffset = calendarNLPService.getTimezoneOffsetMinutes(timezone);
          editDueDate = chrono.parseDate(intentParams.due_time, { instant: new Date(), timezone: timezoneOffset }, { forwardDate: true });
          if (!editDueDate) {
            return { status: 'waiting_input', user_summary: `I couldn't understand the due time "${intentParams.due_time}". Please give a date and time.`, data: { field: 'due_time' } };
          }
        }
        require('../utils/abort').throwIfAborted(message.signal, 'The task edit');
        const result = await taskService.editTaskByIdForUser(message.from, taskId, {
          description: intentParams.new_title || undefined,
          priority: intentParams.priority || undefined,
          dueDate: editDueDate,
        });
        if (!result.success) return result.error;
        let response = `Task updated: "${taskService._taskText(result.task)}"`;
        if (intentParams.priority) response += ` [${intentParams.priority}]`;
        if (editDueDate) response += `\nDue: ${editDueDate.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}`;
        return response;
      }
      case 'reopen': {
        let result;
        if (cmd.stableId) {
          result = await taskService.reopenTaskByIdForUser(message.from, cmd.stableId);
        } else if (cmd.titleQuery) {
          result = await taskService.reopenTaskByTitleForUser(message.from, cmd.titleQuery);
        } else {
          return 'Which completed task should I reopen? Give me its ID or a distinctive title.';
        }
        if (!result.success) return result.error;
        return `Reopened: "${taskService._taskText(result.task)}" — it's back in your pending tasks.`;
      }
      case 'complete': {
        let result;
        if (cmd.stableId) {
          result = await taskService.completeTaskByIdForUser(message.from, cmd.stableId);
        } else if (cmd.index) {
          result = await taskService.completeTaskByIndex(message.from, cmd.index);
        } else if (cmd.titleQuery) {
          result = await taskService.completeTaskByTitle(message.from, cmd.titleQuery);
        } else {
          const titleHint = intentParams.task_title || intentParams.full_text;
          if (titleHint && titleHint !== message.text) {
            result = await taskService.completeTaskByTitle(message.from, titleHint);
          } else {
            result = { success: false, error: 'Which task? Say "done task 1" or "mark [name] as done".' };
          }
        }
        if (!result.success) return result.error;

        let response = `Done: "${taskService._taskText(result.task)}"`;

        // If task was assigned by someone else, notify them
        if (result.task.assigned_by && result.task.assigned_by !== message.from) {
          try {
            const completeName = await this.resolveContactName(result.task.assigned_by, message.from, message.name);
            await messagingService.send(
              result.task.assigned_by,
              `${completeName} completed the task: "${result.task.description}"`
            );
            response += '\nAssigner notified.';
          } catch (e) {
            // Notification failed, that's okay — but log it. The prior silent
            // catch made it impossible to debug template/24h-window issues.
            logger.warn(`[Tasks] Could not notify assigner ${result.task.assigned_by}: ${e.message}`);
          }
        }
        return response;
      }
      case 'assign': {
        // ─── DETECT MISSING TASK DESCRIPTION ───────────────────────────
        // The LLM extracts assignee_name reliably from "assign task to ammi"
        // but task_title is often empty when the user only specified WHO,
        // not WHAT. Detect this by checking: did the LLM populate task_title
        // explicitly, OR is `cmd.description` just the original "assign task
        // to <name>" command leaking through full_text fallback?
        const rawIntentParams = context.intentParams || {};
        const llmTitle = String(rawIntentParams.task_title || '').trim();
        const userMsgLower = String(message.text || '').trim().toLowerCase();
        const looksLikeBareAssignCmd = /^(assign|delegate|give|sthe?ndar?)\s+(a?\s*task|kaam|kaa?m)?\s+(to|for|ko)\s+/i.test(userMsgLower)
          || /^(\w+\s*(ko|to|for))\s*$/i.test(userMsgLower);
        const titleIsMissing = !llmTitle || (looksLikeBareAssignCmd && llmTitle.length < 5);

        if (titleIsMissing) {
          // Set pending clarification — the user's NEXT message will be
          // treated as the task description and re-routed back to this case.
          this.pendingClarificationContext.set(message.from, {
            tool: 'task_manage',
            action: 'assign',
            params: { action: 'assign', assignee_name: cmd.target },
            awaitingField: 'task_title',
            askedAt: Date.now(),
            prompt: 'task description for assignment',
          });
          logger.info(`[TaskAssign] task_title missing — set pending clarification for ${message.from}, target=${cmd.target}`);
          return `Got it — what task should I assign to ${cmd.target || 'them'}?`;
        }

        // Resolve target from team members, contacts, then memories as fallback
        const teamResult = await taskService.resolveTeamMemberPhone(message.from, cmd.target);
        let targetPhone, targetName;

        if (teamResult.found) {
          targetPhone = teamResult.phone;
          targetName = teamResult.name;
        } else {
          const contactResult = await contactService.resolveNameToPhone(message.from, cmd.target);
          if (contactResult.found && !contactResult.ambiguous) {
            targetPhone = contactResult.phone;
            targetName = contactResult.name;
          } else {
            // Fallback A: Gmail history search (needs an email recipient, but
            // task assignment needs a phone — so this rarely helps for tasks.
            // We still try it and accept emails if the local contact is missing.)
            try {
              const inboxOrganizerService = require('../services/inbox-organizer.service');
              const gmailResult = await inboxOrganizerService.findContactInEmails(message.from, cmd.target);
              if (gmailResult.success && gmailResult.matches && gmailResult.matches.length > 0) {
                // Gmail search only returns emails, not phones — log the hit
                // but don't set targetPhone (task assign requires a phone).
                logger.info(`Gmail match found for "${cmd.target}" but task assign needs a phone, falling through to memory.`);
              }
            } catch (e) {
              logger.warn('Gmail contact search for task assign failed:', e.message);
            }

            // Fallback B: search memories for phone number
            if (!targetPhone) try {
              const memories = await memoryService.getAllMemoriesFlat(message.from);
              const targetLower = cmd.target.toLowerCase();
              const memMatch = memories.find(m => {
                const keyLower = (m.key_name || '').toLowerCase();
                const valLower = (m.value || '').toLowerCase();
                return (keyLower.includes(targetLower) || valLower.includes(targetLower)) &&
                  /\d{10,}/.test(m.value);
              });
              if (memMatch) {
                const phoneMatch = memMatch.value.match(/(\+?\d{10,13})/);
                if (phoneMatch) {
                  targetPhone = phoneMatch[1].replace(/^\+/, '');
                  targetName = cmd.target;
                  // Auto-save to contacts so it works next time
                  await contactService.saveContact(message.from, targetName, targetPhone);
                  logger.info(`Auto-saved contact from memory: ${targetName} -> ${targetPhone}`);
                }
              }
            } catch (e) {
              logger.warn('Memory fallback for task assign failed:', e.message);
            }

            if (!targetPhone) {
              return `Could not find "${cmd.target}" in your team, contacts, or memories.\n\nAdd them first: "save contact ${cmd.target} +91XXXXXXXXXX"`;
            }
          }
        }

        let assignmentPriority = intentParams.priority === 'normal'
          ? 'medium'
          : (intentParams.priority || 'medium');
        let assignmentDue = null;
        if (intentParams.due_time) {
          const chrono = require('chrono-node');
          const timezone = context.userTimezone || process.env.DEFAULT_TIMEZONE || 'Asia/Kolkata';
          const timezoneOffset = calendarNLPService.getTimezoneOffsetMinutes(timezone);
          assignmentDue = chrono.parseDate(intentParams.due_time, { instant: new Date(), timezone: timezoneOffset }, { forwardDate: true });
          if (!assignmentDue) {
            return { status: 'waiting_input', user_summary: `I couldn't understand the task due time "${intentParams.due_time}". Please give a date and time.`, data: { field: 'due_time' } };
          }
        }
        const result = await taskService.assignTask(
          message.from,
          targetPhone,
          cmd.description,
          assignmentPriority,
          assignmentDue,
        );
        if (!result.success) return 'Could not assign task. Try again?';

        // Notify assignee — pick free-form vs template UPFRONT based on 24h window.
        //
        // Why: Meta's API returns 200 OK on free-form attempts even when the
        // recipient is outside the 24h conversation window, then asynchronously
        // reports failure (error 131047) via the status webhook 1-2s later.
        // The synchronous catch below NEVER fires for that case → template
        // fallback was never reached → assignee got nothing. Now we check the
        // window first and route directly to whichever path will actually
        // deliver. The async fail still gets logged for diagnostics but no
        // longer drops the notification.
        try {
          const senderName = await this.getSenderName(message.from, message.name);
          logger.info(`[TaskAssign] senderName="${senderName}" from="${message.from}" message.name="${message.name}"`);

          // Probe conversation_history for an inbound message in the last 24h.
          // Same logic the reminder job uses — duplicated here as a one-liner
          // so we don't have to load the whole reminder.job module.
          let inWindow = false;
          try {
            const { query } = require('../config/database');
            const r = await query(
              `SELECT 1 FROM conversation_history
                WHERE user_phone = $1 AND role = 'user'
                  AND created_at >= NOW() - INTERVAL '24 hours'
                LIMIT 1`,
              [targetPhone]
            );
            inWindow = r.rows.length > 0;
          } catch (probeErr) {
            // If the probe fails, default to attempting free-form (legacy behavior).
            logger.warn(`[TaskAssign] 24h-window probe failed: ${probeErr.message} — defaulting to free-form`);
            inWindow = true;
          }
          logger.info(`[TaskAssign] target=${targetPhone} inWindow=${inWindow}`);

          if (inWindow) {
            // Free-form is allowed — use it for the richer message format.
            try {
              await messagingService.send(
                targetPhone,
                `*New task from ${senderName}:*\n\n"${cmd.description}"\n\n_I'll send you a reminder with options to mark it done._`
              );
            } catch (freeFormErr) {
              // Belt-and-suspenders: even when in-window, free-form can fail for
              // other reasons (number unreachable, etc.). Try the template if
              // Meta says it's a re-engagement issue.
              const errCode = freeFormErr.response?.data?.error?.code;
              if (errCode === 131047 || errCode === 131026) {
                // Use TASK_REMINDER (task_reminder_3) — it's the approved
                // template. The literal 'task_assigned' was never approved on
                // Meta (verified via Graph API on 2026-04-26).
                await messagingService.sendTemplate(
                  targetPhone, TEMPLATES.TASK_REMINDER.name, TEMPLATES.TASK_REMINDER.lang,
                  [senderName, cmd.description]
                );
                logger.info(`[TaskAssign] free-form failed (${errCode}) → template sent (${TEMPLATES.TASK_REMINDER.name}) to ${targetPhone}`);
              } else {
                throw freeFormErr;
              }
            }
          } else {
            // Outside the 24h window — go straight to the existing
            // task_assigned template. Same call site, same params, just
            // routed proactively instead of via catch.
            const assigneeLang = languageService.getUserLanguage(targetPhone);
            const langCode = this.getTemplateLangCode(assigneeLang?.code);
            // Was 'task_assigned' (NOT approved on Meta — Graph API confirms it
            // doesn't exist in our WABA). Switched to TASK_REMINDER (template
            // name `task_reminder_3`, status APPROVED, 2 params).
            // Same 2-param shape [senderName, taskText] so no caller change.
            await messagingService.sendTemplate(
              targetPhone, TEMPLATES.TASK_REMINDER.name, TEMPLATES.TASK_REMINDER.lang,
              [senderName, cmd.description]
            );
            logger.info(`[TaskAssign] outside 24h window → template sent (${langCode}) to ${targetPhone}`);
          }
        } catch (e) {
          logger.warn(`Task notify failed for ${targetPhone}:`, e.message);
          // Don't leak "message the bot first" to users — that's WhatsApp 24h-window
          // mechanics they shouldn't need to know about.
          return `Task created, but I couldn't deliver the notification to ${targetName}. Please let them know directly.`;
        }

        // ─── PHASE 3: ASK ABOUT FOLLOW-UP (instead of hardcoded 24h) ───
        // After successful assignment, ask the user how often they want
        // Ari to follow up with the assignee. Their reply is parsed by
        // parseFollowUpDirective() and updates the task with cadence/next_at.
        // If they say "no", no follow-up is scheduled.
        // If the user provided a directive in the original message (e.g.
        // "assign task and follow up every 4 hours"), parseFollowUpDirective
        // will already have caught it and rawIntentParams.follow_up_directive
        // is set — skip the ask in that case.
        const inlineDirective = String(rawIntentParams.follow_up_directive || '').trim();
        if (inlineDirective) {
          const parsed = this._parseFollowUpDirective(inlineDirective);
          if (parsed) {
            await taskService.setTaskFollowUp(result.task.id, parsed, message.from);
            logger.info(`[TaskAssign] follow-up set inline: task=${result.task.id} ${JSON.stringify(parsed)}`);
            return `Task assigned to ${targetName}: "${cmd.description}"\n_Follow-up: ${parsed.summary}_`;
          }
        }

        // No inline directive — ask. Use pending-context so reply gets routed
        // back to a small follow-up handler (case 'set_task_followup' below).
        this.pendingClarificationContext.set(message.from, {
          tool: 'task_manage',
          action: 'set_task_followup',
          params: { action: 'set_task_followup', task_id: result.task.id, task_label: cmd.description },
          awaitingField: 'follow_up_directive',
          askedAt: Date.now(),
          prompt: 'follow-up cadence',
        });
        return `Task assigned to ${targetName}: "${cmd.description}"\n\n*Want me to follow up?* Tell me how often, like:\n• "every 4 hours"\n• "at 5pm tomorrow"\n• "every day at 9am"\n• "no" (skip follow-up)`;
      }

      // ─── PHASE 3: handle the user's follow-up cadence reply ──────────
      case 'set_task_followup': {
        const taskId = intentParams.task_id;
        const directive = String(intentParams.follow_up_directive || intentParams.full_text || message.text || '').trim();
        if (!taskId) return 'Could not find which task to set the follow-up for. Try again?';
        if (/^(no|nope|nah|skip|don'?t|nahi)\b/i.test(directive)) {
          logger.info(`[TaskFollowUp] task=${taskId} skipped (user said no)`);
          return `OK, no follow-up. Task is still pending — I'll keep it in your assigned list.`;
        }
        const parsed = this._parseFollowUpDirective(directive);
        if (!parsed) {
          // Couldn't parse → set pending again so the next message can retry
          this.pendingClarificationContext.set(message.from, {
            tool: 'task_manage',
            action: 'set_task_followup',
            params: { action: 'set_task_followup', task_id: taskId, task_label: intentParams.task_label || '' },
            awaitingField: 'follow_up_directive',
            askedAt: Date.now(),
            prompt: 'follow-up cadence (retry)',
          });
          return `Sorry, didn't catch that. Try one of:\n• "every 4 hours"\n• "at 5pm tomorrow"\n• "every day at 9am"\n• "no"`;
        }
        const updated = await taskService.setTaskFollowUp(taskId, parsed, message.from);
        if (!updated) return 'That task was not found or you are not allowed to change its follow-up.';
        logger.info(`[TaskFollowUp] task=${taskId} ${JSON.stringify(parsed)}`);
        return `Got it — I'll follow up ${parsed.summary}. Reply "stop follow-up" any time to cancel.`;
      }

      case 'list_assigned_to_me': {
        const tasks = await taskService.getAssignedToMeTasks(message.from);
        if (tasks.length === 0) return 'No tasks assigned to you right now.';
        let response = '*Tasks assigned to you:*\n\n';
        for (let i = 0; i < tasks.length; i++) {
          const t = tasks[i];
          const assignerName = await this.resolveContactName(message.from, t.assigned_by);
          const priority = t.priority === 'high' ? ' [HIGH]' : '';
          response += `${i + 1}. ${t.description}${priority}\n   _From: ${assignerName}_\n\n`;
        }
        response += `_Type a number and "done" to complete it (e.g., "1 done")_`;
        // Store context for number-based completion
        this.taskListContext.set(message.from, {
          type: 'assigned_to_me',
          tasks: tasks.map(t => ({ id: t.id, description: t.description, assigned_by: t.assigned_by })),
          timestamp: Date.now()
        });
        require('../utils/list-position-cache').remember(message.from, 'tasks',
          tasks.map((t) => ({ id: t.id, title: t.description })));
        return response;
      }

      case 'list_assigned_by_me': {
        const tasks = await taskService.getAssignedByMeTasks(message.from);
        if (tasks.length === 0) return 'You haven\'t assigned any tasks to others.';
        let response = '*Tasks you assigned:*\n\n';
        for (let i = 0; i < tasks.length; i++) {
          const t = tasks[i];
          const assigneeName = await this.resolveContactName(message.from, t.assigned_to);
          const status = t.status === 'completed' ? 'Done' : 'Pending';
          response += `${i + 1}. ${t.description}\n   _To: ${assigneeName} | Status: ${status}_\n\n`;
        }
        response += `_Type a number and "done" to complete it (e.g., "3 done")_`;
        // Store context for number-based completion
        this.taskListContext.set(message.from, {
          type: 'assigned_by_me',
          tasks: tasks.map(t => ({ id: t.id, description: t.description, assigned_to: t.assigned_to })),
          timestamp: Date.now()
        });
        require('../utils/list-position-cache').remember(message.from, 'tasks',
          tasks.map((t) => ({ id: t.id, title: t.description })));
        return response;
      }

      case 'delete': {
        const result = cmd.stableId
          ? await taskService.deleteTaskById(message.from, cmd.stableId)
          : await taskService.deleteTask(message.from, {
            index: cmd.index || null,
            titleQuery: cmd.titleQuery || null,
          });
        if (!result.success) {
          if (context?.agentExecution) {
            return {
              status: 'failure',
              user_summary: result.error,
              error: { code: 'task_delete_failed', category: 'business_rule', retryable: true, message: result.error },
            };
          }
          return result.error;
        }
        return `Deleted task: "${taskService._taskText(result.task)}"`;
      }

      default:
        if (context?.agentExecution) {
          // A chat reply here would masquerade as a successful tool result.
          return {
            status: 'failure',
            user_summary: `manage_tasks does not support action "${cmd.action}".`,
            data: { supported_actions: ['add', 'list', 'complete', 'assign', 'delete', 'list_assigned_to_me', 'list_assigned_by_me', 'set_task_followup'] },
            error: { code: 'task_action_unsupported', category: 'business_rule', retryable: true, message: `Unsupported manage_tasks action "${cmd.action}". Re-call with a supported action.` },
          };
        }
        return await aiService.chat(message.from, message.text, context);
    }
  }

  // ========== TASK BUTTON REPLY HANDLER ==========
  /**
   * If the sender has a pending delegated task (someone else assigned it to
   * them) and the message is a short status-reply phrase like "done" /
   * "not done" / "completed", mark the most recent such task and notify the
   * assigner. Returns true if handled (caller must return early), else false.
   *
   * NO QUOTA, NO GATE — the sender might be a free-tier user, and they
   * should always be able to acknowledge a task assigned to them.
   */
  /**
   * True when the user is mid-flow in ANY conversation that expects their
   * next (short) reply: a pending confirmation gate, a clarification the bot
   * asked, an active confirm/draft context, a standup answer, etc. Short-reply
   * intercepts (delegated-task "done", briefing CTAs) must yield to these —
   * "nope" while the bot is asking "Should I save Neha's number?" is an
   * answer to THAT question, not a delegated-task status.
   */
  _hasActiveConversationFlow(userPhone) {
    try {
      // Short-TTL contexts: mere presence means the bot is waiting on a reply.
      const flowMaps = [
        this.pendingClarificationContext,
        this.calendarConfirmContext,
        this.leaveConfirmContext,
        this.standupSetupContext,
        this.pendingPollContext,
        this.taskAssignConfirmContext,
        this.contactSaveContext,
        this.scheduledEmailContext,
        this.bulkEmailContext,
        this.salesEmailContext,
      ];
      for (const map of flowMaps) {
        if (map && typeof map.has === 'function' && map.has(userPhone)) return true;
      }

      // Long-TTL broadcast contexts (poll votes live 24h, standup responses
      // 6h — set for EVERY recipient, not just active conversations). Treat
      // them as "actively waiting" only briefly after they were set; a poll
      // the user ignored this morning must not suppress their "done" task
      // reply this afternoon.
      const FRESH_MS = 30 * 60 * 1000;
      for (const map of [this.pollVoteContext, this.standupResponseContext]) {
        const entry = map && typeof map.get === 'function' ? map.get(userPhone) : null;
        if (entry && (!entry.timestamp || (Date.now() - entry.timestamp) < FRESH_MS)) return true;
      }

      const confirmationGate = require('../services/confirmation-gate.service');
      if (confirmationGate.hasPending(userPhone)) return true;
    } catch (e) {
      logger.warn(`_hasActiveConversationFlow check failed: ${e.message}`);
    }
    return false;
  }

  async _tryDelegatedTaskTextReply(message) {
    const txt = String(message.text || '').trim().toLowerCase();
    if (!txt || txt.length > 25) return false;   // only short responses (tightened from 40 — Apr 27 Fix #1)

    // Yield to any flow that is actively waiting for this user's reply —
    // their "done"/"nope" answers THAT question, not an old delegated task.
    if (this._hasActiveConversationFlow(message.from)) return false;

    // FIX #1 (Apr 27 2026 — Bucket B gate hijacking):
    // Reject compound / multi-clause messages. A pure status reply is a single
    // short phrase like "done" or "not done yet". Anything with a comma,
    // semicolon, or conjunction is a fresh request, NOT an acknowledgement.
    // This prevents "no deadline, save as is" or "no but assign it anyway"
    // from being captured as a delegated-task not-done reply.
    if (/[,;:]/.test(txt)) return false;
    if (/\b(and|but|or|because|then|so|also|plus|with)\b/i.test(txt)) return false;

    // Status-response detector — English, Hindi, Hinglish, Spanish, French.
    // STRICT MATCHING (Apr 2026 — RC #N6 fix for B01 gate hijacking):
    // The regexes must match the whole message (or include tiny tail like
    // "yet"/"!"/"."/"emoji"). Without `$`-anchored matching, "no deadline,
    // save as is" was being captured by `^no\b`, hijacking new-task
    // confirmation replies into the delegated-task not-done gate.
    const doneRe = /^(done|completed|complete|finished|yep done|yes done|kar li|kar diya|ho gaya|ho gayi|hogaya|hecho|terminé|fait)[\s.!]*$/i;
    const notDoneRe = /^(not done(\s+yet)?|notdone|nope|no thanks|pending|still working|in progress|in-progress|kar raha\s+hu+n?|kar rahi\s+hu+n?|abhi nahi|nahi hua|no hecho|pas fait|skip it?|won['’]t do)[\s.!]*$/i;
    const isDone = doneRe.test(txt);
    const isNotDone = !isDone && notDoneRe.test(txt);
    if (!isDone && !isNotDone) return false;

    // Only handle if there's a pending task assigned TO this user BY someone else
    const taskService = require('../services/task.service');
    let pending;
    try {
      pending = await taskService.getAssignedToMeTasks(message.from);
    } catch (_) {
      return false;
    }
    if (!Array.isArray(pending) || pending.length === 0) return false;

    // Take the most recent pending task
    const task = pending[0];

    if (isDone) {
      const result = await taskService.completeTaskById(task.id);
      if (!result?.success) {
        await messagingService.send(message.from, result?.error || 'Could not mark the task complete.');
        return true;
      }
      await messagingService.send(message.from, `✓ Marked as done: "${result.task.description}"`);
      // Notify the assigner
      if (result.task.assigned_by && result.task.assigned_by !== message.from) {
        try {
          const name = await this.resolveContactName(result.task.assigned_by, message.from, message.name);
          await messagingService.send(
            result.task.assigned_by,
            `${name} completed the task: "${result.task.description}"`
          );
        } catch (_) { /* non-fatal */ }
      }
      logger.info({ userPhone: message.from, taskId: task.id }, 'Delegated task marked done via text reply (no gate)');
      return true;
    }

    // Not-done path: acknowledge without marking, remind in 24h
    await messagingService.send(
      message.from,
      `Got it — "${task.description.slice(0, 60)}" is still in progress. I'll check back in 24 hours.`
    );
    logger.info({ userPhone: message.from, taskId: task.id }, 'Delegated task acknowledged as pending via text reply');
    return true;
  }

  // ========== BRIEFING-REPLY INTERCEPT ==========
  /**
   * Handle short reply CTAs from the morning briefing. These are intentionally
   * single-word keywords to train a reliable reply ritual (per Hook Model +
   * WhatsApp research — reply prompts drive engagement and keep the 24h
   * messaging window open).
   *
   * Keywords: plan · more · skip · done · status · delegations
   *
   * Gate: must be an exact single-word match (case-insensitive, trailing
   * punctuation stripped) and ≤20 chars. `done` additionally requires a
   * cached brief context (so we know WHICH task to complete). Anything
   * else falls through to the normal LLM flow unchanged.
   *
   * Returns true if handled (caller must return early).
   */
  async _tryBriefingReply(message) {
    const raw = String(message.text || '').trim();
    if (!raw || raw.length > 20) return false;

    const keyword = raw.toLowerCase().replace(/[!.?,\s]+$/, '');
    const known = new Set(['plan', 'more', 'skip', 'done', 'status', 'delegations']);
    if (!known.has(keyword)) return false;

    const briefingService = require('../services/briefing.service');

    // Only intercept when a briefing was ACTUALLY sent recently. Without this
    // guard, common one-word replies in unrelated conversations were hijacked
    // all day: "skip" while answering standup questions paused briefings,
    // "status" asking about a leave request returned the delegation report,
    // "more" after any list returned briefing details. The reply-ritual CTAs
    // only make sense in the window after the morning brief.
    const briefCtx = briefingService.getLastBriefContext(message.from);
    const replyWindowMs = parseInt(process.env.BRIEFING_REPLY_WINDOW_MS || String(3 * 3600 * 1000), 10);
    if (!briefCtx || !briefCtx.generatedAt || (Date.now() - briefCtx.generatedAt) > replyWindowMs) {
      return false;
    }

    // A short reply while ANOTHER flow is waiting for input belongs to that
    // flow (confirmation, clarification, standup answer) — never steal it.
    if (this._hasActiveConversationFlow(message.from)) return false;

    switch (keyword) {
      case 'skip': {
        const untilStr = await briefingService.pauseBriefingForOneDay(message.from);
        await messagingService.send(
          message.from,
          untilStr
            ? `🔕 Briefings paused until ${untilStr}. Back to normal after that.\n\n_Change your mind: say "turn off morning briefing" to pause longer._`
            : `Couldn't pause briefings. Try "disable morning briefing" for a hard off.`
        );
        return true;
      }

      case 'more': {
        const extended = await briefingService.generateExtendedBriefing(message.from);
        await messagingService.send(message.from, extended || "No extra details to add right now.");
        return true;
      }

      case 'plan': {
        const planMsg = await this._handleBriefingPlanReply(message.from);
        await messagingService.send(message.from, planMsg);
        return true;
      }

      case 'status':
      case 'delegations': {
        const statusMsg = await this._handleBriefingStatusReply(message.from);
        await messagingService.send(message.from, statusMsg);
        return true;
      }

      case 'done': {
        // Only handle `done` when we have a cached brief context with a top task.
        // Without it, `done` is ambiguous — let the LLM handle it.
        const ctx = briefingService.getLastBriefContext(message.from);
        if (!ctx || !ctx.topTaskId) return false;

        const taskService = require('../services/task.service');
        const result = await taskService.completeTaskById(ctx.topTaskId);
        if (result?.success) {
          await messagingService.send(
            message.from,
            `✓ Done: "${(result.task.description || '').slice(0, 80)}".\n\nNext one? Reply \`plan\` for what's ahead.`
          );
        } else {
          await messagingService.send(message.from, result?.error || "Couldn't mark that task done.");
        }
        return true;
      }
    }
    return false;
  }

  /**
   * Build a simple time-ordered plan for the rest of the day.
   * Pool: upcoming reminders (future only) + calendar events (today) + open tasks.
   */
  async _handleBriefingPlanReply(userPhone) {
    const briefingService = require('../services/briefing.service');
    const taskService = require('../services/task.service');
    const timezoneService = require('../services/timezone.service');
    const googleAuthService = require('../services/google-auth.service');
    const microsoftAuthService = require('../services/microsoft-auth.service');
    const calendarService = require('../services/calendar.service');
    const outlookCalendarService = require('../services/outlook-calendar.service');

    try {
      const tz = await timezoneService.getUserTimezone(userPhone);
      const now = new Date();

      const [reminders, googleEvents, outlookEvents, tasks] = await Promise.all([
        briefingService.getTodaysReminders(userPhone, tz).catch(() => []),
        (async () => {
          try {
            if (await googleAuthService.isConnected(userPhone)) {
              return await calendarService.getUpcomingEvents(userPhone, 16);
            }
          } catch (_) {}
          return [];
        })(),
        (async () => {
          try {
            if (await microsoftAuthService.isConnected(userPhone)) {
              return await outlookCalendarService.getUpcomingEvents(userPhone, 16);
            }
          } catch (_) {}
          return [];
        })(),
        taskService.getAllMyTasks(userPhone).catch(() => ({ personal: [], assignedToMe: [], assignedByMe: [] }))
      ]);

      const items = [];
      for (const r of reminders) {
        items.push({ time: new Date(r.reminder_time), type: 'reminder', title: r.message });
      }
      for (const e of [...googleEvents, ...outlookEvents]) {
        const start = new Date(e.start?.dateTime || e.start?.date);
        if (!isNaN(start.getTime()) && start > now) {
          items.push({ time: start, type: 'meeting', title: e.summary || 'No title' });
        }
      }
      items.sort((a, b) => a.time.getTime() - b.time.getTime());

      const fmtTime = (d) => d.toLocaleTimeString('en-IN', {
        timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true
      }).replace(/\s/g, '').toLowerCase();

      let out = `*Your plan for today* 🗓️\n\n`;
      if (items.length === 0) {
        out += `_No timed items ahead today._\n\n`;
      } else {
        items.slice(0, 10).forEach(it => {
          const emoji = it.type === 'meeting' ? '📅' : '⏰';
          const title = (it.title || '').replace(/\s+/g, ' ').slice(0, 56);
          out += `${emoji} ${fmtTime(it.time)} — ${title}\n`;
        });
        out += '\n';
      }

      const openTasks = [...(tasks.personal || []), ...(tasks.assignedToMe || [])].slice(0, 5);
      if (openTasks.length > 0) {
        out += `*Top tasks to slot in:*\n`;
        openTasks.forEach((t, i) => {
          out += `${i + 1}. ${(t.description || '').slice(0, 56)}\n`;
        });
        out += '\n';
      }

      out += `_Reply \`done\` after you finish the first one._`;
      return out.trim();
    } catch (e) {
      logger.error(`_handleBriefingPlanReply failed: ${e.message}`);
      return "Couldn't build your plan right now. Try again in a moment.";
    }
  }

  /**
   * Status of delegations — what has Ari handed off, to whom, how long ago.
   */
  async _handleBriefingStatusReply(userPhone) {
    const taskService = require('../services/task.service');
    try {
      const all = await taskService.getAllMyTasks(userPhone);
      const delegated = all.assignedByMe || [];
      if (delegated.length === 0) {
        return `No delegations awaiting anyone right now.\n\n_Delegate something: "ask Emily to review the deck"._`;
      }

      let out = `*Your delegations* 💬\n\n`;
      delegated.slice(0, 8).forEach((t, i) => {
        const ageDays = Math.floor((Date.now() - new Date(t.created_at).getTime()) / (24 * 3600 * 1000));
        const ageStr = ageDays === 0 ? 'today' : ageDays === 1 ? '1d ago' : `${ageDays}d ago`;
        const desc = (t.description || '').replace(/\s+/g, ' ').slice(0, 56);
        out += `${i + 1}. ${desc}\n    → ${t.assigned_to} · ${ageStr}\n`;
      });
      if (delegated.length > 8) {
        out += `\n_…and ${delegated.length - 8} more._`;
      }
      return out.trim();
    } catch (e) {
      logger.error(`_handleBriefingStatusReply failed: ${e.message}`);
      return `Couldn't fetch delegations right now.`;
    }
  }

  async handleTaskButtonReply(message) {
    const isDone = message.text.startsWith('task_done_');
    const taskId = parseInt(message.text.replace(/^task_(done|notdone)_/, ''), 10);

    if (isNaN(taskId)) {
      await messagingService.send(message.from, 'Invalid task reference.');
      return;
    }

    if (isDone) {
      const result = await taskService.completeTaskById(taskId);
      if (!result.success) {
        await messagingService.send(message.from, result.error || 'Could not complete task.');
        return;
      }

      await messagingService.send(message.from, `Task marked as done: "${result.task.description}"`);

      // Notify the assigner — resolve name from assigner's contacts
      if (result.task.assigned_by && result.task.assigned_by !== message.from) {
        try {
          const completeName = await this.resolveContactName(result.task.assigned_by, message.from, message.name);
          await messagingService.send(
            result.task.assigned_by,
            `${completeName} completed the task: "${result.task.description}"`
          );
        } catch (e) {
          // Notification failed, that's okay
        }
      }
    } else {
      await messagingService.send(message.from, 'Got it, task is still in progress. I\'ll remind you again in 24 hours.');
    }
  }

  // ========== TEAM MANAGEMENT ==========
  // Agent runtimes may pass structured params (action/team_name/members)
  // instead of relying on the strict full_text regexes. Convert them into the
  // same command shapes parseTeamCommand produces.
  teamCommandFromParams(params = {}) {
    const action = String(params.action || '').toLowerCase().trim();
    if (!action) return null;
    const teamName = params.team_name ? String(params.team_name).toLowerCase().trim() : null;
    const members = (Array.isArray(params.members) ? params.members : [])
      .map(m => ({
        name: String(m?.name || '').trim(),
        phone: String(m?.phone || '').replace(/\D/g, ''),
      }))
      .filter(m => m.name || m.phone)
      .slice(0, 50);
    switch (action) {
      case 'create':
        return teamName ? { action: 'create', teamName, members } : null;
      case 'delete':
      case 'delete_team':
        return teamName ? { action: 'delete_team', teamName } : null;
      case 'list':
        return { action: 'list', teamName };
      case 'list_teams':
        return { action: 'list_teams' };
      case 'add': {
        if (!teamName || members.length === 0) return null;
        const withPhone = members.filter(m => m.phone && m.name);
        const namesOnly = members.filter(m => !m.phone && m.name).map(m => m.name);
        if (withPhone.length === 1 && namesOnly.length === 0) {
          return { action: 'add', teamName, phone: withPhone[0].phone, name: withPhone[0].name };
        }
        if (withPhone.length === 0 && namesOnly.length > 0) {
          return { action: 'add_by_name', teamName, names: namesOnly };
        }
        return { action: 'add_many', teamName, withPhone, names: namesOnly };
      }
      case 'remove': {
        const target = members[0];
        if (!target) return null;
        return { action: 'remove', teamName, identifier: target.name || target.phone };
      }
      default:
        return null;
    }
  }

  async handleTeamManage(message, context, params = {}) {
    const agentRun = Boolean(context?.agentExecution);
    const cmd = this.teamCommandFromParams(params) || taskService.parseTeamCommand(message.text);
    if (!cmd) {
      if (agentRun) {
        // Inside an agent run a chat reply here would be returned as a "tool
        // result" and classified as success even though nothing executed.
        // Return a typed failure the runtime can correct instead.
        return {
          status: 'failure',
          user_summary: 'manage_team could not understand this request.',
          data: { supported_actions: ['create', 'add', 'remove', 'list', 'list_teams', 'delete_team'] },
          error: {
            code: 'team_command_not_understood',
            category: 'business_rule',
            retryable: true,
            message: 'Re-call manage_team with structured params: action (create|add|remove|list|list_teams|delete_team), team_name, and members [{name, phone}].',
          },
        };
      }
      return await aiService.chat(message.from, message.text, context);
    }

    switch (cmd.action) {

      case 'list_teams': {
        const teams = await taskService.getTeamNames(message.from);
        if (teams.length === 0) {
          return "No teams yet.\n\nCreate one:\n\"add Rahul +919876543210 to stitch boat team\"";
        }
        let response = `*Your Teams (${teams.length})*\n\n`;
        teams.forEach((t, i) => {
          response += `${i + 1}. *${t.team_name}* — ${t.member_count} member${t.member_count !== '1' ? 's' : ''}\n`;
        });
        response += `\nSay "my [team name] team" to see members.`;
        return response.trim();
      }

      case 'list': {
        const members = await taskService.getTeamMembers(message.from, cmd.teamName);
        if (members.length === 0) {
          if (cmd.teamName) {
            const teams = await taskService.getTeamNames(message.from);
            const list = teams.length
              ? teams.map(t => `- ${t.team_name} (${t.member_count} members)`).join('\n')
              : 'No teams yet.';
            return `No team named *"${cmd.teamName}"*.\n\nYour teams:\n${list}`;
          }
          return "No team members yet.\n\nAdd one:\n\"add Rahul +919876543210 to stitch boat team\"";
        }
        const title = cmd.teamName ?`*${cmd.teamName} team* (${members.length})` :`*All Members (${members.length})*`;
        let response = `${title}\n\n`;
        // Group by team_name if showing all
        if (!cmd.teamName) {
          const grouped = {};
          members.forEach(m => { (grouped[m.team_name] = grouped[m.team_name] || []).push(m); });
          Object.entries(grouped).forEach(([tn, mems]) => {
            response += `_${tn}_\n`;
            mems.forEach((m, i) => { response += ` ${i + 1}. *${m.member_name}* (${contactService.maskPhone(m.member_phone)})\n`; });
            response += '\n';
          });
        } else {
          members.forEach((m, i) => {
            response += `${i + 1}. *${m.member_name}* (${contactService.maskPhone(m.member_phone)}) - ${m.role}\n`;
          });
        }
        return response.trim();
      }

      case 'create': {
        // Create is a real write: the creator becomes the team's admin row
        // (same convention as the dashboard), verified via RETURNING.
        const created = await taskService.createTeam(message.from, cmd.teamName);
        if (!created.success) {
          if (created.already) {
            return `You already have a *${cmd.teamName} team*. Add members with:\n"add Rahul +919876543210 to ${cmd.teamName} team"`;
          }
          if (agentRun) {
            return {
              status: 'failure',
              user_summary: `Could not create the ${cmd.teamName} team: ${created.error || 'unknown error'}`,
              error: { code: 'team_create_failed', category: 'execution', retryable: true, message: created.error || 'insert failed' },
            };
          }
          return `Could not create the *${cmd.teamName}* team: ${created.error || 'unknown error'}`;
        }
        const pendingMembers = Array.isArray(cmd.members) ? cmd.members.filter(m => m.name && m.phone) : [];
        const addedNames = [];
        for (const member of pendingMembers) {
          const addResult = await taskService.addTeamMember(message.from, member.phone, member.name, 'member', cmd.teamName);
          if (addResult.success) addedNames.push(member.name);
        }
        const summary = addedNames.length > 0
          ? `Created *${cmd.teamName} team* with ${addedNames.length + 1} members: you (admin), *${addedNames.join('*, *')}*`
          : `Created *${cmd.teamName} team*. You're the admin.\n\nAdd members with:\n"add Rahul +919876543210 to ${cmd.teamName} team"`;
        if (agentRun) {
          return {
            status: 'success',
            user_summary: summary,
            data: {
              team_name: cmd.teamName,
              member_count: addedNames.length + 1,
              members_added: addedNames,
              verified: true,
            },
          };
        }
        return summary;
      }

      case 'add_many': {
        // Structured multi-member add from agent params: direct adds for
        // members with phones, contact resolution for names only.
        const addedMembers = [];
        const failedMembers = [];
        for (const member of cmd.withPhone || []) {
          const addResult = await taskService.addTeamMember(message.from, member.phone, member.name, 'member', cmd.teamName);
          if (addResult.success) addedMembers.push(member.name);
          else failedMembers.push(member.name);
        }
        for (const name of cmd.names || []) {
          const resolved = await contactService.resolveNameToPhone(message.from, name);
          if (resolved.found && !resolved.ambiguous) {
            const addResult = await taskService.addTeamMember(message.from, resolved.phone, resolved.name, 'member', cmd.teamName);
            if (addResult.success) addedMembers.push(resolved.name);
            else failedMembers.push(name);
          } else {
            failedMembers.push(name);
          }
        }
        const parts = [];
        if (addedMembers.length) parts.push(`Added to *${cmd.teamName} team*: *${addedMembers.join('*, *')}*`);
        if (failedMembers.length) parts.push(`Could not add: *${failedMembers.join('*, *')}* (no saved number)`);
        const summary = parts.join('\n') || `No members could be added to *${cmd.teamName} team*.`;
        if (agentRun) {
          return {
            status: addedMembers.length === 0 ? 'failure' : (failedMembers.length ? 'partial' : 'success'),
            user_summary: summary,
            data: { team_name: cmd.teamName, added: addedMembers, failed: failedMembers },
            error: failedMembers.length ? {
              code: 'team_members_unresolved',
              category: 'business_rule',
              retryable: true,
              message: `Missing phone numbers for: ${failedMembers.join(', ')}. Re-call with their phones.`,
            } : undefined,
          };
        }
        return summary;
      }

      case 'add': {
        const result = await taskService.addTeamMember(message.from, cmd.phone, cmd.name, 'member', cmd.teamName);
        if (!result.success) return `Could not add member: ${result.error}`;
        const tn = cmd.teamName || 'default';
        return `Added *${cmd.name}* to *${tn} team*\n(${contactService.maskPhone(cmd.phone)})`;
      }

      case 'add_by_name': {
        // Resolve pronoun references like "both of them", "them", "her", "him"
        // by extracting actual names mentioned in recent conversation
        const pronounPatterns = /^(both of them|all of them|them|they|these people|those people|everyone|her|him|both|all|the same people)$/i;
        let resolvedNames = cmd.names;
        const hasPronouns = cmd.names.some(n => pronounPatterns.test(n.trim()));
        if (hasPronouns) {
          try {
            const history = await aiService.getHistory(message.from);
            const recentTexts = history.slice(-10).map(m => String(m.content || '')).join('\n');
            // Extract names that appeared in contact lookup responses (e.g. "neha's number: +91...")
            const nameMatches = recentTexts.match(/\b([a-zA-Z]+)'s\s+number:\s+\+?\d/gi) || [];
            const extractedNames = nameMatches.map(m => m.match(/^([a-zA-Z]+)'s/i)?.[1]).filter(Boolean);
            // Also check for names from "Not found in contacts:" lines
            const notFoundMatches = recentTexts.match(/Not found in contacts:\s*([a-zA-Z, ]+)/gi) || [];
            for (const nfm of notFoundMatches) {
              const namesPart = nfm.replace(/Not found in contacts:\s*/i, '');
              namesPart.split(/[,&]/).map(n => n.trim()).filter(n => n.length > 1).forEach(n => extractedNames.push(n));
            }
            // Also check for "add X and Y" patterns from user's own messages
            const addPatterns = recentTexts.match(/add\s+([a-zA-Z]+(?:\s+and\s+[a-zA-Z]+)*)\s+(?:to|in)\s+/gi) || [];
            for (const ap of addPatterns) {
              const namesPart = ap.replace(/^add\s+/i, '').replace(/\s+(?:to|in)\s+$/i, '');
              namesPart.split(/\s+and\s+/i).map(n => n.trim()).filter(n => n.length > 1 && !pronounPatterns.test(n)).forEach(n => {
                if (!extractedNames.includes(n)) extractedNames.push(n);
              });
            }
            if (extractedNames.length > 0) {
              // Deduplicate
              resolvedNames = [...new Set(extractedNames.map(n => n.toLowerCase()))];
              logger.info(`Team add: resolved pronouns to names: ${resolvedNames.join(', ')}`);
            }
          } catch (e) {
            logger.warn(`Team add: pronoun resolution failed: ${e.message}`);
          }
        }

        // Look up each name — same two-step strategy as reminder service:
        // Step 1: contacts table, Step 2: memory_trunk fallback
        const added = [], notFound = [];
        for (const name of resolvedNames) {
          let phone = null;
          let canonicalName = name;

          // Step 1: saved contacts
          const resolved = await contactService.resolveNameToPhone(message.from, name);
          if (resolved.found && !resolved.ambiguous) {
            phone = resolved.phone;
            canonicalName = resolved.name;
          } else if (resolved.found && resolved.ambiguous) {
            const matchList = resolved.matches.map(m => `- ${m.name}`).join('\n');
            notFound.push(`${name} (multiple matches — be more specific:\n${matchList})`);
            continue;
          } else {
            logger.info(`Team add: "${name}" not found in contacts for user ${message.from}`);
          }

          // Step 2: memory_trunk fallback (phone stored via bot memory, not explicit contact save)
          if (!phone) {
            phone = await memoryService.findPhoneForName(message.from, name);
            if (phone) logger.info(`Team add: resolved "${name}" from memory → ${phone}`);
          }

          // Step 3: check lastSavedContact cache (recently saved in this session)
          if (!phone) {
            const lastSaved = this.lastSavedContact.get(message.from);
            if (lastSaved && lastSaved.name && lastSaved.name.toLowerCase() === name.toLowerCase()) {
              phone = lastSaved.phone;
              canonicalName = lastSaved.name;
              logger.info(`Team add: resolved "${name}" from lastSavedContact cache → ${phone}`);
            }
          }

          if (phone) {
            const addResult = await taskService.addTeamMember(message.from, phone, canonicalName, 'member', cmd.teamName);
            if (addResult.success) added.push(canonicalName);
            else notFound.push(name);
          } else {
            notFound.push(name);
          }
        }

        let response = '';
        if (added.length > 0) {
          response += `Added to *${cmd.teamName} team*: *${added.join('*, *')}*\n`;
        }
        if (notFound.length > 0) {
          // Filter out ambiguous entries (they already have detailed messages)
          const simpleNotFound = notFound.filter(n => !n.includes('multiple matches'));
          if (simpleNotFound.length === 1 && added.length === 0) {
            // Single person not found — ask for their number
            this.teamAddContext.set(message.from, {
              name: simpleNotFound[0],
              teamName: cmd.teamName,
              timestamp: Date.now()
            });
            return `I don't have *${simpleNotFound[0]}*'s number saved.\n\nSend me their phone number and I'll add them to *${cmd.teamName} team*.`;
          }
          if (simpleNotFound.length >= 1) {
            // Multiple not found — ask for first one's number, queue the rest
            const firstName = simpleNotFound[0];
            const remaining = simpleNotFound.slice(1);
            this.teamAddContext.set(message.from, {
              name: firstName,
              teamName: cmd.teamName,
              pendingNames: remaining,
              timestamp: Date.now()
            });
            response += `\nNot found in contacts: *${simpleNotFound.join('*, *')}*\n\nSend me *${firstName}*'s phone number to add them.`;
          }
          // Include ambiguous entries info
          const ambiguous = notFound.filter(n => n.includes('multiple matches'));
          if (ambiguous.length > 0) {
            response += '\n' + ambiguous.join('\n');
          }
        }
        return response.trim();
      }

      case 'remove': {
        const result = await taskService.removeTeamMember(message.from, cmd.identifier, cmd.teamName);
        if (!result.success) return result.error === 'Member not found'
          ?`Couldn't find *${cmd.identifier}*${cmd.teamName ?` in ${cmd.teamName} team` : ''}.`
          : result.error;
        const tn = result.removed.team_name;
        return `Removed *${result.removed.member_name}* from *${tn} team*`;
      }

      case 'delete_team': {
        const result = await taskService.deleteTeam(message.from, cmd.teamName);
        if (!result.success) return `No team named *"${cmd.teamName}"* found.`;
        // Close any active polls for this team so members aren't left with dangling poll contexts
        const activePoll = await pollService.getLatestTeamPoll(message.from, cmd.teamName);
        if (activePoll) {
          await pollService.closeExpiredPoll(activePoll.id).catch(() => {});
        }
        return `*${cmd.teamName} team* deleted (${result.count} members removed)`;
      }

      default:
        return await aiService.chat(message.from, message.text, context);
    }
  }

  // ========== LEAVE MANAGEMENT ==========
  async handleLeaveManage(message, context, params = {}) {
    const typedAction = String(params.action || '').toLowerCase();
    const cmd = typedAction
      ? {
        action: typedAction === 'list' ? 'status' : typedAction,
        leaveType: params.leave_type || 'casual',
        details: [
          params.start_date && params.end_date
            ? `from ${params.start_date} to ${params.end_date}` : '',
          params.reason || '',
        ].filter(Boolean).join(' '),
        requestId: params.request_id || null,
        employee: params.employee || null,
        reason: params.reason || null,
      }
      : leaveService.parseLeaveCommand(message.text);
    if (!cmd) return await aiService.chat(message.from, message.text, context);

    switch (cmd.action) {
      case 'balance': {
        const balances = await leaveService.getLeaveBalance(message.from);
        return leaveService.formatLeaveBalance(balances);
      }
      case 'status': {
        const requests = await leaveService.getMyLeaveRequests(message.from);
        if (requests.length === 0) return 'No leave requests found.';

        let response = '*Your Leave Requests*\n\n';
        requests.forEach((r, i) => {
          const start = new Date(r.start_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
          const end = new Date(r.end_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
          const status = r.status === 'approved' ? 'Approved' : r.status === 'rejected' ? 'Rejected' : 'Pending';
          response += `${i + 1}. ${r.leave_type} leave: ${start} - ${end} [${status}]\n ${r.reason}\n\n`;
        });
        return response.trim();
      }
      case 'team_status': {
        const teamLeaves = await leaveService.getTeamLeaveStatus(message.from);
        if (teamLeaves.length === 0) return 'No team members on leave.';

        let response = '*Team Leave Status*\n\n';
        teamLeaves.forEach(l => {
          const start = new Date(l.start_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
          const end = new Date(l.end_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
          response += `*${l.member_name}:* ${l.leave_type} leave (${start} - ${end})\n`;
        });
        return response.trim();
      }
      case 'approve':
      case 'reject': {
        // Check for pending requests from team members
        const pending = await leaveService.getPendingRequestsForManager(message.from);
        if (pending.length === 0) return 'No pending leave requests to review.';

        const request = cmd.requestId
          ? pending.find((entry) => String(entry.id) === String(cmd.requestId))
          : cmd.employee
            ? pending.find((entry) => String(entry.employee_name || entry.member_name || '')
              .toLowerCase().includes(String(cmd.employee).toLowerCase()))
            : pending[0];
        if (!request) {
          return {
            status: 'failure',
            user_summary: 'That pending leave request was not found.',
            error: {
              code: 'leave_request_not_found', category: 'business_rule', retryable: true,
              message: 'Use a request_id or employee that appears in the pending leave list.',
            },
          };
        }
        if (cmd.action === 'approve') {
          const result = await leaveService.approveLeave(request.id, message.from);
          if (!result.success) return result.error;

          // Notify employee
          try {
            await messagingService.send(
              request.employee_phone,
`Your ${request.leave_type} leave (${new Date(request.start_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} - ${new Date(request.end_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}) has been *approved*!`
            );
          } catch (e) { /* notification failed */ }

          // Block calendar for the employee on leave
          try {
            const googleAuth = require('../services/google-auth.service');
            const calendarService = require('../services/calendar.service');
            const tokens = await googleAuth.getTokens(request.employee_phone);
            if (tokens) {
              await calendarService.createEvent(request.employee_phone, {
                title: 'On Leave',
                start: request.start_date,
                end: request.end_date,
                description: `${request.leave_type} leave - ${request.reason || 'Personal'}`,
                allDay: true
              });
            }
          } catch (e) {
            logger.warn('Could not create calendar event for leave:', e.message);
          }

          return `Leave approved for +${request.employee_phone} (${result.days} day${result.days > 1 ? 's' : ''})`;
        } else {
          const result = await leaveService.rejectLeave(request.id, cmd.reason, message.from);
          if (!result.success) return result.error;

          try {
            await messagingService.send(
              request.employee_phone,
`Your ${request.leave_type} leave (${new Date(request.start_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} - ${new Date(request.end_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}) has been *rejected*.`
            );
          } catch (e) { /* notification failed */ }

          return `Leave rejected for +${request.employee_phone}`;
        }
      }
      case 'apply': {
        let startDate;
        let endDate;
        let reason;
        if (params.start_date && params.end_date) {
          const dateAtLocalMidnight = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value))
            ? new Date(`${value}T00:00:00`)
            : new Date(value);
          startDate = dateAtLocalMidnight(params.start_date);
          endDate = dateAtLocalMidnight(params.end_date);
          reason = params.reason || 'Personal';
          if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime())) {
            return {
              status: 'failure',
              user_summary: 'The leave dates were not valid.',
              error: {
                code: 'invalid_leave_dates', category: 'validation', retryable: true,
                message: 'Use valid YYYY-MM-DD start_date and end_date values.',
              },
            };
          }
        } else {
          ({ startDate, endDate, reason } = leaveService.parseLeaveDates(cmd.details));
        }

        // Find manager (first manager in teams)
        const managers = await taskService.getMyManagers(message.from);
        const managerPhone = managers.length > 0 ? managers[0] : null;

        const result = await leaveService.applyForLeave(
          message.from, managerPhone, cmd.leaveType, startDate, endDate, reason
        );

        if (!result.success) return result.error;

        const startStr = startDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
        const endStr = endDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

        let response = `Leave request submitted!\n\n*${cmd.leaveType}* leave: ${startStr} - ${endStr} (${result.days} day${result.days > 1 ? 's' : ''})\nReason: ${reason}`;

        // Notify manager
        if (managerPhone) {
          try {
            const employeeName = await this.getSenderName(message.from);
            await messagingService.send(
              managerPhone,
`*Leave Request from ${employeeName}*\n\n${cmd.leaveType} leave: ${startStr} - ${endStr} (${result.days} day${result.days > 1 ? 's' : ''})\nReason: ${reason}\n\nReply "approve" or "reject"`
            );

            this.leaveConfirmContext.set(managerPhone, {
              leaveId: result.request.id,
              timestamp: Date.now()
            });

            response += '\nManager notified.';
          } catch (e) {
            response += '\nCould not notify manager.';
          }
        } else {
          response += '\n\n_No manager found. Ask your manager to add you as a team member._';
        }

        return response;
      }
      default:
        return await aiService.chat(message.from, message.text, context);
    }
  }

  async handleLeaveApproval(message, ctx) {
    const lower = message.text.toLowerCase().trim();

    if (/^approve(\s+leave)?$/i.test(lower)) {
      this.leaveConfirmContext.delete(message.from);
      const result = await leaveService.approveLeave(ctx.leaveId, message.from);
      if (!result.success) return result.error;

      try {
        await messagingService.send(
          result.leave.employee_phone,
`Your ${result.leave.leave_type} leave has been *approved*!`
        );
      } catch (e) { /* */ }

      // Block calendar for the employee on leave
      try {
        const googleAuth = require('../services/google-auth.service');
        const calendarService = require('../services/calendar.service');
        const tokens = await googleAuth.getTokens(result.leave.employee_phone);
        if (tokens) {
          await calendarService.createEvent(result.leave.employee_phone, {
            title: 'On Leave',
            start: result.leave.start_date,
            end: result.leave.end_date,
            description: `${result.leave.leave_type} leave - ${result.leave.reason || 'Personal'}`,
            allDay: true
          });
        }
      } catch (e) {
        logger.warn('Could not create calendar event for leave:', e.message);
      }

      return `Leave approved (${result.days} day${result.days > 1 ? 's' : ''}).`;
    }

    if (/^reject(\s+leave)?$/i.test(lower)) {
      this.leaveConfirmContext.delete(message.from);
      const result = await leaveService.rejectLeave(ctx.leaveId, null, message.from);
      if (!result.success) return result.error;

      try {
        await messagingService.send(
          result.leave.employee_phone,
`Your ${result.leave.leave_type} leave has been *rejected*.`
        );
      } catch (e) { /* */ }

      return 'Leave rejected.';
    }

    return null;
  }

  // ========== STANDUP MANAGEMENT ==========
  async handleStandupManage(message, context, params = {}) {
    const lower = message.text.toLowerCase().trim();
    const action = String(params.action || '').toLowerCase();
    const timezone = String(params.timezone || context.userTimezone || process.env.DEFAULT_TIMEZONE || 'Asia/Kolkata');

    if (action === 'setup') {
      const teamName = String(params.team_name || '').trim() || null;
      const morningTime = params.check_in_time ? this._parseStandupTime(params.check_in_time) : null;
      const eveningTime = params.wrap_up_time ? this._parseStandupTime(params.wrap_up_time) : null;
      if (params.check_in_time && !morningTime) {
        return { status: 'waiting_input', data: { field: 'check_in_time' }, user_summary: 'What time should the daily check-in run? Try “9:30am”.' };
      }
      if (params.wrap_up_time && !eveningTime) {
        return { status: 'waiting_input', data: { field: 'wrap_up_time' }, user_summary: 'What time should the daily wrap-up run? Try “6pm”.' };
      }
      if (!morningTime || !eveningTime) {
        const name = teamName ? `${teamName} Standup` : 'Daily Standup';
        this.standupSetupContext.set(message.from, {
          step: !morningTime ? 'morning_time' : 'evening_time',
          name,
          teamName,
          morningTime,
          timezone,
          timestamp: Date.now(),
        });
        return !morningTime
          ? `What time should the morning check-in for *${name}* go out? (for example “9:30am”)`
          : `What time should the evening wrap-up for *${name}* go out? (for example “6pm”)`;
      }
      const teamMembers = await taskService.getTeamMembers(message.from, teamName);
      const members = teamMembers.map((member) => ({ phone: member.member_phone, name: member.member_name }));
      if (members.length === 0) {
        return { status: 'waiting_input', data: { field: 'team_name' }, user_summary: teamName ? `No members were found in the “${teamName}” team.` : 'Add at least one team member before creating a standup.' };
      }
      const name = teamName ? `${teamName} Standup` : 'Daily Standup';
      const result = await standupService.createSmartStandup(
        message.from, name, members, morningTime, eveningTime,
        'mon,tue,wed,thu,fri', teamName, [], timezone,
      );
      if (!result.success) return `Could not create standup: ${result.error}`;
      return `Smart standup created for *${teamName || 'all members'}*: check-in ${morningTime}, wrap-up ${eveningTime} (${timezone}).`;
    }

    if (['status', 'results', 'disable'].includes(action)) {
      const standups = await standupService.getStandupsByAdmin(message.from);
      const selector = String(params.team_name || '').trim().toLowerCase();
      const matching = selector
        ? standups.filter((item) => [item.team_name, item.name]
          .some((value) => String(value || '').toLowerCase().includes(selector)))
        : standups;
      if (matching.length === 0) return selector ? `No active standup matched “${params.team_name}”.` : 'No active standups.';
      if (action === 'status') {
        return matching.map((item) => `- ${item.name}: ${item.schedule_time} (${item.timezone || 'UTC'})`).join('\n');
      }
      if (matching.length > 1 && !selector) {
        return { status: 'waiting_input', data: { choices: matching.map((item) => item.name) }, user_summary: `Which standup should I ${action === 'disable' ? 'disable' : 'summarize'}?` };
      }
      if (action === 'results') {
        return await standupService.getStandupResults(message.from, matching[0].id) || 'No standup results found.';
      }
      await standupService.deactivateStandup(matching[0].id, message.from);
      return `Standup “${matching[0].name}” stopped.`;
    }

    if (/^create\s+standup/i.test(lower)) {
      // Start multi-step setup
      this.standupSetupContext.set(message.from, {
        step: 'name',
        timezone,
        timestamp: Date.now()
      });

      return "Let's set up a standup!\n\nWhat should it be called? (e.g., \"Daily Standup\")";
    }

    if (/^(my |show |view )?standups?$/i.test(lower)) {
      const standups = await standupService.getStandupsByAdmin(message.from);
      if (standups.length === 0) return 'No active standups.\n\nCreate one: "create standup"';

      let response = '*Your Standups*\n\n';
      standups.forEach((s, i) => {
        const members = s.members;
        response += `${i + 1}. *${s.name}*\n ${members.length} members | ${s.schedule_time} | ${s.schedule_days}\n\n`;
      });
      return response.trim();
    }

    if (/^standup\s+(results?|summary)/i.test(lower)) {
      const digest = await standupService.getStandupResults(message.from);
      return digest || 'No standup results found.';
    }

    if (/^(stop|delete|cancel)\s+standup/i.test(lower)) {
      const standups = await standupService.getStandupsByAdmin(message.from);
      if (standups.length === 0) return 'No active standups.';
      await standupService.deactivateStandup(standups[0].id, message.from);
      return `Standup "${standups[0].name}" stopped.`;
    }

    return await aiService.chat(message.from, message.text, context);
  }

  // Parse time strings like "9am", "9:30am", "09:00", "6pm", "18:00"
  _parseStandupTime(text) {
    const match = text.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (!match) return null;
    let hours = parseInt(match[1]);
    const minutes = match[2] ? parseInt(match[2]) : 0;
    const ampm = match[3]?.toLowerCase();
    if (ampm === 'pm' && hours !== 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  async handleStandupSetup(message, ctx) {
    const text = message.text.trim();

    switch (ctx.step) {
      case 'name': {
        this.standupSetupContext.set(message.from, { ...ctx, name: text, step: 'morning_time', timestamp: Date.now() });
        return `Got it — *${text}*.\n\nWhat time should the morning check-in go out?\n(e.g. "9:30am", "09:00")`;
      }

      case 'morning_time': {
        const morningTime = this._parseStandupTime(text);
        if (!morningTime) return 'Could not parse that time. Try "9:30am" or "09:00".';
        this.standupSetupContext.set(message.from, { ...ctx, morningTime, step: 'evening_time', timestamp: Date.now() });
        return `Morning check-in set for *${morningTime}*.\n\nWhat time should the evening wrap-up go out?\n(e.g. "6pm", "18:00")`;
      }

      case 'evening_time': {
        const eveningTime = this._parseStandupTime(text);
        if (!eveningTime) return 'Could not parse that time. Try "6pm" or "18:00".';
        this.standupSetupContext.set(message.from, { ...ctx, eveningTime, step: 'team', timestamp: Date.now() });

        const teams = await taskService.getTeamNames(message.from);
        if (teams.length === 0) {
          return `Evening wrap-up set for *${eveningTime}*.\n\nYou don't have any teams yet. Add team members first:\n"add Danish +919999999999 to design team"`;
        }
        let teamList = `Evening wrap-up set for *${eveningTime}*.\n\nWhich team is this for?\n`;
        teams.forEach((t, i) => { teamList += `${i + 1}. ${t.team_name} (${t.member_count} members)\n`; });
        teamList += `${teams.length + 1}. All members`;
        return teamList;
      }

      case 'team': {
        const teams = await taskService.getTeamNames(message.from);
        let selectedTeam = null;

        const numMatch = text.match(/^(\d+)$/);
        if (numMatch) {
          const idx = parseInt(numMatch[1]) - 1;
          if (idx >= 0 && idx < teams.length) selectedTeam = teams[idx].team_name;
          if (idx === teams.length) selectedTeam = null; // "All members"
        } else if (/^all\b/i.test(text)) {
          selectedTeam = null;
        } else {
          selectedTeam = text.toLowerCase().replace(/\s*team\s*$/i, '');
        }

        const teamMembers = await taskService.getTeamMembers(message.from, selectedTeam);
        const members = teamMembers.map(m => ({ phone: m.member_phone, name: m.member_name }));

        if (members.length === 0) {
          return `No members found${selectedTeam ? ` in "${selectedTeam}" team` : ''}. Add members first.`;
        }

        this.standupSetupContext.set(message.from, { ...ctx, teamName: selectedTeam, members, step: 'admins', timestamp: Date.now() });
        return `Team: *${selectedTeam || 'all'}* (${members.length} member${members.length === 1 ? '' : 's'})\n\nWho else should receive standup reports? Send their phone numbers or names, or say *"just me"*.`;
      }

      case 'admins': {
        let additionalAdmins = [];
        if (!/^(just me|only me|no one|none|skip)$/i.test(text)) {
          const phones = text.match(/\+?\d[\d\s-]{9,17}/g) || [];
          for (const raw of phones) {
            let phone = raw.replace(/\D/g, '');
            if (phone.length === 10) phone = '91' + phone;
            additionalAdmins.push(phone);
          }
          if (additionalAdmins.length === 0) {
            const names = text.split(/[,&]/).map(n => n.trim()).filter(n => n.length > 1);
            for (const name of names) {
              const resolved = await taskService.resolveTeamMemberPhone(message.from, name);
              if (resolved.found) additionalAdmins.push(resolved.phone);
            }
          }
        }

        const result = await standupService.createSmartStandup(
          message.from, ctx.name, ctx.members, ctx.morningTime, ctx.eveningTime,
          'mon,tue,wed,thu,fri', ctx.teamName, additionalAdmins, ctx.timezone || 'UTC'
        );

        this.standupSetupContext.delete(message.from);
        if (!result.success) return `Could not create standup: ${result.error}`;

        const adminList = additionalAdmins.length > 0
          ? `\n👤 Admins: You, ${additionalAdmins.map(p => contactService.maskPhone(p)).join(', ')}`
          : '';

        return `Smart Standup created! ✅\n\n📋 *${ctx.name}*\n☀️ Morning check-in: ${ctx.morningTime}\n🌙 Evening wrap-up: ${ctx.eveningTime}\n👥 Team: ${ctx.teamName || 'all'} (${ctx.members.length} member${ctx.members.length === 1 ? '' : 's'})${adminList}\n📊 AI analysis: enabled\n\nMembers will get:\n• Morning: "What are you planning to work on today?"\n• Evening: "What did you actually work on today?"\n\nYou'll get a real-time alert after each evening response + a full team digest at night.`;
      }

      default:
        this.standupSetupContext.delete(message.from);
        return null;
    }
  }

  async handleStandupResponse(message, ctx) {
    // ctx: { configId, questionIndex, timestamp }
    const answer = message.text.trim();

    await standupService.recordResponse(ctx.configId, message.from, ctx.questionIndex, answer);

    const next = await standupService.getNextQuestion(ctx.configId, message.from);

    if (!next || next.done) {
      this.standupResponseContext.delete(message.from);

      // Check if this was an EVENING checkpoint → trigger AI analysis
      const config = await standupService.getStandupById(ctx.configId);
      if (config && config.checkpoint_type === 'evening' && config.standup_group_id) {
        this._runStandupAnalysis(config, message.from, answer).catch(e =>
          logger.warn(`Standup analysis failed: ${e.message}`)
        );
        return "Got it! Thanks for the update — your manager will get the alignment report shortly. 👍";
      }

      if (config && config.checkpoint_type === 'morning' && config.standup_group_id) {
        return "Got it! I'll check back this evening for your wrap-up. 👍";
      }

      return "Thanks! All questions answered. Your responses have been recorded.";
    }

    // Update context for next question
    this.standupResponseContext.set(message.from, {
      configId: ctx.configId,
      questionIndex: next.questionIndex,
      timestamp: Date.now()
    });

    return `Question ${next.questionIndex + 1}/${next.totalQuestions}:\n*${next.question}*`;
  }

  // Runs AI alignment analysis after an evening standup response, then notifies all admins.
  async _runStandupAnalysis(config, memberPhone, eveningResponse) {
    const groupId = config.standup_group_id;
    const today = new Date().toISOString().split('T')[0];

    // Get morning plan
    const morningPlan = await standupService.getMorningPlan(groupId, memberPhone);

    // Run AI analysis
    const analysis = await aiService.analyzeStandupAlignment(morningPlan, eveningResponse);

    // Store analysis
    await standupService.storeAnalysis(groupId, memberPhone, today, morningPlan, eveningResponse, analysis);

    // Resolve member name
    const members = Array.isArray(config.members) ? config.members : JSON.parse(config.members || '[]');
    const member = members.find(m => m.phone === memberPhone);
    const memberName = member?.name || contactService.maskPhone(memberPhone);

    // Format real-time alert
    const completedList = analysis.completed.length > 0
      ? `✅ Completed (${analysis.completed.length}):\n${analysis.completed.map(c => `• ${c}`).join('\n')}`
      : '✅ Completed: none';
    const missedList = analysis.missed.length > 0
      ? `❌ Missed (${analysis.missed.length}):\n${analysis.missed.map(m => `• ${m}`).join('\n')}`
      : '';
    const unplannedList = analysis.unplanned.length > 0
      ? `🆕 Unplanned (${analysis.unplanned.length}):\n${analysis.unplanned.map(u => `• ${u}`).join('\n')}`
      : '';

    let alert = `*${config.name}* — ${memberName}'s evening update\n\n`;
    alert += `${completedList}\n`;
    if (missedList) alert += `\n${missedList}\n`;
    if (unplannedList) alert += `\n${unplannedList}\n`;
    alert += `\n📊 Alignment: ${analysis.alignment_score}%`;
    if (analysis.summary) alert += `\n💡 ${analysis.summary}`;

    // Send to all admins
    const admins = await standupService.getGroupAdmins(groupId);
    for (const adminPhone of admins) {
      try {
        const completedStr = analysis.completed.length > 0 ? analysis.completed.join(', ') : 'none';
        const missedStr = analysis.missed.length > 0 ? analysis.missed.join(', ') : 'none';
        await sendWithTemplateFallback(adminPhone, alert, TEMPLATES.STANDUP_ALERT, [memberName, completedStr, missedStr]);
      } catch (e) {
        logger.warn(`Could not send standup alert to admin ${adminPhone}: ${e.message}`);
      }
    }
  }

  // Sends a results summary to the poll creator once every recipient has voted.
  async _notifyPollCreatorAllVoted(creatorPhone, pollId) {
    try {
      const data = await pollService.getPollResults(pollId);
      if (!data) return;
      // Build phone -> name map from the stored recipients so voter names show in non-anonymous results
      const phoneToName = {};
      const recipients = Array.isArray(data.poll.recipients) ? data.poll.recipients : [];
      for (const r of recipients) {
        if (r && r.phone) phoneToName[r.phone] = r.name || r.phone;
      }
      const formatted = pollService.formatPollResults(data, phoneToName);
      const header = `All team members have voted on your poll!\n\n`;
      const fullMsg = header + formatted;
      await sendWithTemplateFallback(creatorPhone, fullMsg, TEMPLATES.POLL_RESULTS, [data.poll.question, formatted.slice(0, 500)]);
    } catch (e) {
      logger.warn(`Could not notify poll creator ${creatorPhone}: ${e.message}`);
    }
  }

  // Build phoneToName map for a poll's results (for on-demand "poll results" queries)
  _buildPollPhoneToName(poll) {
    const map = {};
    const recipients = Array.isArray(poll.recipients) ? poll.recipients : [];
    for (const r of recipients) {
      if (r && r.phone) map[r.phone] = r.name || r.phone;
    }
    return map;
  }

  // ========== POLL MANAGEMENT ==========
  async handlePollManage(message, context, params = {}) {
    const typedAction = String(params.action || '').toLowerCase();
    const cmd = typedAction
      ? {
        action: typedAction,
        question: params.question,
        options: params.options,
        teamName: params.team_name || null,
        pollId: params.poll_id || null,
        toTeam: Boolean(params.team_name),
        recipientNames: [],
        isAnonymous: params.is_anonymous === true,
      }
      : pollService.parsePollCommand(message.text);
    if (!cmd) return await aiService.chat(message.from, message.text, context);

    switch (cmd.action) {
      case 'create': {
        // Resolve recipient names to phones
        const recipients = [];
        const targetTeamName = cmd.teamName || null;
        // If toTeam flag is set, or no recipient names given, default to ALL team members in the target team
        if (cmd.toTeam || !cmd.recipientNames || cmd.recipientNames.length === 0) {
          const teamMembers = await taskService.getTeamMembers(message.from, targetTeamName);
          for (const m of teamMembers) {
            recipients.push({ phone: m.phone || m.member_phone, name: m.name || m.member_name });
          }
        } else {
          for (const name of cmd.recipientNames) {
            // Try team first
            const teamResult = await taskService.resolveTeamMemberPhone(message.from, name);
            if (teamResult.found) {
              recipients.push({ phone: teamResult.phone, name: teamResult.name });
              continue;
            }
            // Try contacts
            const contactResult = await contactService.resolveNameToPhone(message.from, name);
            if (contactResult.found && !contactResult.ambiguous) {
              recipients.push({ phone: contactResult.phone, name: contactResult.name });
            }
          }
        }

        if (recipients.length === 0) {
          if (targetTeamName) {
            return `No members found in team "${targetTeamName}". Add members first: "add team member <name> <phone> to ${targetTeamName} team"`;
          }
          return `Could not find any recipients. Add team members first: "add team member <name> <phone>"`;
        }

        // PENDING: show preview and wait for confirmation before broadcasting
        this.pendingPollContext = this.pendingPollContext || new BoundedMap(5000, 10 * 60 * 1000);
        this.pendingPollContext.set(message.from, {
          question: cmd.question,
          options: cmd.options,
          recipients,
          isAnonymous: cmd.isAnonymous === true,
          teamName: targetTeamName,
          timestamp: Date.now()
        });

        const anonTag = cmd.isAnonymous ? ' *(anonymous)*' : '';
        const teamTag = targetTeamName ? ` in *${targetTeamName}* team` : '';
        const recipientList = recipients.map(r => `• ${r.name}`).join('\n');
        const optionList = cmd.options.map((o, i) => `${i + 1}. ${o}`).join('\n');
        return `*Poll Preview*${anonTag}\n\n*Q:* ${cmd.question}\n\n${optionList}\n\n*Will send to ${recipients.length} member${recipients.length === 1 ? '' : 's'}${teamTag}:*\n${recipientList}\n\n_Reply *yes* to send, *no* to cancel._`;
      }
      case 'results': {
        const polls = await pollService.getActivePollsForUser(message.from);
        if (polls.length === 0) return 'No active polls.';
        const selected = cmd.pollId
          ? polls.find((poll) => String(poll.id) === String(cmd.pollId))
          : polls[0];
        if (!selected) return 'That active poll was not found.';
        const data = await pollService.getPollResults(selected.id);
        const phoneToName = this._buildPollPhoneToName(data.poll);
        return pollService.formatPollResults(data, phoneToName);
      }
      case 'close': {
        const polls = await pollService.getActivePollsForUser(message.from);
        if (polls.length === 0) return 'No active polls to close.';
        const selected = cmd.pollId
          ? polls.find((poll) => String(poll.id) === String(cmd.pollId))
          : polls[0];
        if (!selected) return 'That active poll was not found.';
        await pollService.closePoll(selected.id, message.from);
        const data = await pollService.getPollResults(selected.id);
        const phoneToName = this._buildPollPhoneToName(data.poll);
        return `Poll closed!\n\n${pollService.formatPollResults(data, phoneToName)}`;
      }
      case 'list': {
        const polls = await pollService.getActivePollsForUser(message.from);
        if (polls.length === 0) return 'No active polls.';

        let response = '*Your Active Polls*\n\n';
        polls.forEach((p, i) => {
          response += `${i + 1}. ${p.question} (${p.recipients.length} recipients)\n`;
        });
        return response.trim();
      }
      default:
        return await aiService.chat(message.from, message.text, context);
    }
  }

  async handlePollVote(message, ctx) {
    const text = message.text.trim();
    const numMatch = text.match(/^(\d+)$/);

    if (numMatch) {
      const selectedOption = parseInt(numMatch[1]) - 1;
      const result = await pollService.recordVote(ctx.pollId, message.from, selectedOption);
      if (result.success) {
        this.pollVoteContext.delete(message.from);
        // Fire-and-forget: notify creator if everyone has voted
        if (result.allVoted && result.creatorPhone) {
          this._notifyPollCreatorAllVoted(result.creatorPhone, result.pollId).catch(() => {});
        }
        return `Vote recorded: *${result.option}*\n\nThanks!`;
      }
      // If poll is closed (stale context), clear it so subsequent messages route normally
      if (result.error && result.error.includes('closed')) {
        this.pollVoteContext.delete(message.from);
        return null;
      }
      return result.error;
    }

    // Try text-based vote (yes/no/maybe, or option text matching)
    const textResult = await pollService.recordTextVote(ctx.pollId, message.from, text);
    if (textResult.success) {
      this.pollVoteContext.delete(message.from);
      if (textResult.allVoted && textResult.creatorPhone) {
        this._notifyPollCreatorAllVoted(textResult.creatorPhone, textResult.pollId).catch(() => {});
      }
      return `Recorded: *${textResult.option}*\n\nThanks!`;
    }
    // Poll was closed (stale context) — clear so next messages work normally
    if (textResult.error && textResult.error.includes('closed')) {
      this.pollVoteContext.delete(message.from);
      return null;
    }
    if (textResult.noMatch) return null; // Not a vote — fall through to intent detection

    return null;
  }

  /**
   * Sends a message with a hard timeout to prevent team broadcast loops from hanging
   * indefinitely on a single slow or unresponsive recipient.
   * @returns {Promise<string|null>} wamid if available (WhatsApp), null for other platforms
   */
  async _sendWithTimeout(phone, msg, timeoutMs = 15000) {
    return Promise.race([
      messagingService.send(phone, msg),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('send timeout')), timeoutMs)
      )
    ]);
  }

  // Typed adapter used by every agent runtime. The legacy parser below stays
  // available for old command routes, but model-selected fields are never
  // reparsed from synthetic prose.
  async handleStructuredScheduledMessage(message, context, params) {
    const timezone = params.timezone || context.userTimezone || 'Asia/Kolkata';
    const resolvedRecipients = [];
    const unresolved = [];
    for (const input of params.recipients) {
      const raw = String(input || '').trim();
      if (!raw) continue;
      const digits = raw.replace(/\D/g, '');
      if (digits.length >= 10) {
        resolvedRecipients.push({
          phone: digits.length === 10 ? `91${digits}` : digits,
          name: raw,
        });
        continue;
      }
      const team = await taskService.resolveTeamMemberPhone(message.from, raw);
      if (team?.found) {
        resolvedRecipients.push({ phone: team.phone, name: team.name });
        continue;
      }
      const contact = await contactService.resolveNameToPhone(message.from, raw);
      if (contact?.found && !contact.ambiguous) {
        resolvedRecipients.push({ phone: contact.phone, name: contact.name });
      } else {
        unresolved.push(raw);
      }
    }
    const recipients = [...new Map(
      resolvedRecipients.map((entry) => [String(entry.phone), entry]),
    ).values()];
    if (unresolved.length || recipients.length === 0) {
      return {
        status: 'failure',
        user_summary: unresolved.length
          ? `Could not resolve: ${unresolved.join(', ')}.`
          : 'No scheduled-message recipients were resolved.',
        data: { unresolved },
        error: {
          code: 'scheduled_message_recipient_unresolved',
          category: 'business_rule',
          retryable: true,
          message: 'Use saved contact names or complete phone numbers.',
        },
      };
    }

    let sendTime = null;
    const sendAt = String(params.send_at || '').trim();
    const isoCandidate = new Date(sendAt);
    if (Number.isFinite(isoCandidate.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(sendAt)) {
      sendTime = isoCandidate;
    } else {
      const time = sendAt.match(/\d{1,2}(?::\d{2})?\s*(?:am|pm)?/i)?.[0];
      const day = sendAt.match(/\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i)?.[1];
      if (time) sendTime = reminderService.parseScheduledTime(time, day || null, timezone);
    }
    if (!sendTime || sendTime.getTime() <= Date.now()) {
      return {
        status: 'failure',
        user_summary: "Couldn't understand a future send time.",
        error: {
          code: 'invalid_scheduled_message_time',
          category: 'validation',
          retryable: true,
          message: 'Use a future ISO-8601 send_at or a phrase such as tomorrow at 9am.',
        },
      };
    }

    const displayTime = sendTime.toLocaleString('en-IN', {
      timeZone: timezone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    const recipientLines = recipients
      .map((entry) => `- ${entry.name} (${contactService.maskPhone(entry.phone)})`)
      .join('\n');
    const summary = `Schedule message to ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}\n${recipientLines}\n\nWhen: ${displayTime}\nMessage:\n"${params.message}"`;
    const confirmationGate = require('../services/confirmation-gate.service');
    return confirmationGate.pend(message.from, {
      actionType: 'message_to_contact',
      summary,
      ctx: {
        scheduled: true,
        recipients: recipients.map((entry) => entry.phone),
        when: sendTime.toISOString(),
      },
      execute: async () => {
        const completed = [];
        const failed = [];
        for (const recipient of recipients) {
          const scheduled = await reminderService.createScheduledMessage(
            message.from,
            recipient.phone,
            params.message,
            sendTime,
          );
          (scheduled ? completed : failed).push(recipient.name);
        }
        if (completed.length === 0) return 'Could not schedule the message. Nothing was queued.';
        return `Scheduled for ${completed.join(', ')} at ${displayTime}${failed.length ? `. Failed: ${failed.join(', ')}` : ''}.`;
      },
    });
  }

  // ========== SCHEDULED MESSAGES ==========
  async handleScheduledMessage(message, context, params = {}) {
    if (Array.isArray(params.recipients) && params.recipients.length > 0) {
      return this.handleStructuredScheduledMessage(message, context, params);
    }
    const parsed = reminderService.parseScheduledMessageCommand(message.text);
    if (!parsed) return await aiService.chat(message.from, message.text, context);

    const userTimezone = context.userTimezone || 'Asia/Kolkata';

    // Resolve recipient
    let targetPhone;
    let targetName = parsed.recipientName;

    const teamResult = await taskService.resolveTeamMemberPhone(message.from, parsed.recipientName);
    if (teamResult.found) {
      targetPhone = teamResult.phone;
      targetName = teamResult.name;
    } else {
      const contactResult = await contactService.resolveNameToPhone(message.from, parsed.recipientName);
      if (contactResult.found && !contactResult.ambiguous) {
        targetPhone = contactResult.phone;
        targetName = contactResult.name;
      } else {
        return `Could not find "${parsed.recipientName}" in your team or contacts.`;
      }
    }

    // Parse time
    const sendTime = reminderService.parseScheduledTime(parsed.timeStr, parsed.dayStr, userTimezone);
    if (!sendTime) return "Couldn't understand the time. Try: \"send message to Emily at 9am tomorrow: your text\"";

    const timeStr = sendTime.toLocaleString('en-IN', {
      timeZone: userTimezone, weekday: 'short', day: 'numeric', month: 'short',
      hour: 'numeric', minute: '2-digit', hour12: true
    });

    // SAFETY GATE — this message will auto-send to someone else at a future time.
    // Require explicit confirmation before scheduling the DB row.
    const confirmationGate = require('../services/confirmation-gate.service');
    const maskedPhone = contactService.maskPhone(targetPhone);
    const summary = `⏰ Schedule message to *${targetName}* (${maskedPhone})\n\n📅 When: ${timeStr}\n💬 Message:\n"${parsed.message}"`;

    return await confirmationGate.pend(message.from, {
      actionType: 'message_to_contact',
      summary,
      ctx: { scheduled: true, recipient: targetPhone, recipientName: targetName, when: sendTime.toISOString() },
      execute: async () => {
        const scheduled = await reminderService.createScheduledMessage(
          message.from, targetPhone, parsed.message, sendTime
        );
        if (!scheduled) return 'Could not schedule message. Try again?';
        return `✓ Scheduled!\n\nTo: ${targetName}\nWhen: ${timeStr}`;
      }
    });
  }

  // ========== NOTE MANAGEMENT ==========
  // Structured params from the manage_notes tool schema → the command shapes
  // parseNoteCommand produces. Before this, LLM-extracted params were
  // discarded and notes only worked for exact regex phrasing.
  noteCommandFromParams(params = {}) {
    const action = String(params.action || '').toLowerCase().trim();
    if (!action) return null;
    const topic = params.topic ? String(params.topic).trim() : null;
    switch (action) {
      case 'save': {
        const content = String(params.note_content || '').trim();
        if (!content) return null;
        return { action: 'save', topic: topic || 'general', content };
      }
      case 'list':
        return { action: 'listTopics' };
      case 'list_topic':
      case 'view':
        return topic ? { action: 'showTopic', topic } : { action: 'listTopics' };
      case 'search': {
        const term = String(params.search_query || '').trim();
        return term ? { action: 'search', term } : null;
      }
      case 'delete_note': {
        const id = Number(params.note_id);
        return Number.isInteger(id) && id > 0 ? { action: 'delete', noteId: id } : null;
      }
      case 'delete_topic':
        return topic ? { action: 'deleteTopic', topic } : null;
      default:
        return null;
    }
  }

  async handleNoteManage(message, context, intentParams = null) {
    const cmd = this.noteCommandFromParams(intentParams || {})
      || memoryService.parseNoteCommand(message.text);
    if (!cmd) {
      if (context?.agentExecution) {
        return {
          status: 'failure',
          user_summary: 'manage_notes could not understand this request.',
          data: { supported_actions: ['save', 'list', 'list_topic', 'search', 'delete_note', 'delete_topic', 'view'] },
          error: {
            code: 'note_command_not_understood',
            category: 'business_rule',
            retryable: true,
            message: 'Re-call manage_notes with structured params: action, plus note_content/topic/note_id/search_query as required.',
          },
        };
      }
      return await aiService.chat(message.from, message.text, context);
    }

    switch (cmd.action) {
      case 'listTopics': {
        const topics = await memoryService.getAllNoteTopics(message.from);
        return memoryService.formatNoteTopics(topics);
      }
      case 'showTopic': {
        const notes = await memoryService.getNotesByTopic(message.from, cmd.topic);
        return memoryService.formatNotes(notes, cmd.topic);
      }
      case 'save': {
        const result = await memoryService.saveNote(message.from, cmd.topic, cmd.content);
        if (!result.success) return 'Could not save note. Try again?';
        return `Note saved under *${cmd.topic}*: "${cmd.content}"`;
      }
      case 'delete': {
        const deleted = await memoryService.deleteNote(message.from, cmd.noteId);
        return deleted ? 'Note deleted.' : 'Note not found.';
      }
      case 'deleteTopic': {
        const count = await memoryService.deleteNotesByTopic(message.from, cmd.topic);
        return count > 0 ?`Deleted ${count} note${count > 1 ? 's' : ''} from "${cmd.topic}".` :`No notes found under "${cmd.topic}".`;
      }
      case 'search': {
        const notes = await memoryService.searchNotes(message.from, cmd.term);
        if (notes.length === 0) return `No notes matching "${cmd.term}".`;

        let response = `*Notes matching "${cmd.term}":*\n\n`;
        notes.forEach((n, i) => {
          response += `${i + 1}. [${n.topic}] ${n.content}\n`;
        });
        return response.trim();
      }
      default:
        if (context?.agentExecution) {
          return {
            status: 'failure',
            user_summary: `manage_notes does not support action "${cmd.action}".`,
            error: { code: 'note_action_unsupported', category: 'business_rule', retryable: true, message: `Unsupported manage_notes action "${cmd.action}".` },
          };
        }
        return await aiService.chat(message.from, message.text, context);
    }
  }

  // ========== THREAD SUMMARY ==========
  async handleThreadSummary(message, context, params = {}) {
    if (params.message_count || params.focus) {
      const count = Math.max(2, Math.min(Number(params.message_count || 20), 200));
      return await aiService.summarizeRecentMessages(message.from, count, params.focus || '');
    }
    const text = message.text.toLowerCase();

    // "summarize last 20 messages"
    const countMatch = text.match(/summarize\s+(?:last\s+)?(\d+)\s+(?:messages?|msgs?)/i);
    if (countMatch) {
      const count = Math.min(parseInt(countMatch[1]), 100);
      return await aiService.summarizeRecentMessages(message.from, count);
    }

    // "what did we discuss today?" / "summarize today"
    const timeframeMatch = text.match(/(?:summarize|summary|recap|what did we (?:discuss|talk))\s*(?:about\s+)?(today|yesterday|this week)/i);
    if (timeframeMatch) {
      return await aiService.summarizeByTimeframe(message.from, timeframeMatch[1]);
    }

    // Default: summarize last 20
    return await aiService.summarizeRecentMessages(message.from, 20);
  }

  // ========== TEAM AVAILABILITY ==========
  async handleTeamAvailability(message, context, params = {}) {
    if (!await googleAuthService.isConnected(message.from)) {
      return 'Google not connected. Say "connect google" first.';
    }

    const text = message.text.toLowerCase();
    const timezone = String(params.timezone || context.userTimezone || 'Asia/Kolkata');
    let targetDate = new Date();

    if (params.date) {
      const chrono = require('chrono-node');
      const timezoneOffset = calendarNLPService.getTimezoneOffsetMinutes(timezone);
      const parsed = chrono.parseDate(params.date, { instant: new Date(), timezone: timezoneOffset }, { forwardDate: true });
      if (!parsed) {
        return { status: 'waiting_input', data: { field: 'date' }, user_summary: `I couldn't understand the availability date “${params.date}”.` };
      }
      targetDate = parsed;
    }

    if (!params.date && /tomorrow/i.test(text)) {
      targetDate.setDate(targetDate.getDate() + 1);
    } else if (!params.date && /next week/i.test(text)) {
      const currentDay = targetDate.getDay();
      targetDate.setDate(targetDate.getDate() + ((1 + 7 - currentDay) % 7 || 7));
    }

    // Check specific day name
    const dayMatch = !params.date && text.match(/(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i);
    if (dayMatch) {
      const dayMap = { 'sunday': 0, 'monday': 1, 'tuesday': 2, 'wednesday': 3, 'thursday': 4, 'friday': 5, 'saturday': 6 };
      const dayNum = dayMap[dayMatch[1].toLowerCase()];
      const currentDay = targetDate.getDay();
      let daysAhead = dayNum - currentDay;
      if (daysAhead <= 0) daysAhead += 7;
      targetDate = new Date();
      targetDate.setDate(targetDate.getDate() + daysAhead);
    }

    return await calendarService.getTeamAvailability(message.from, targetDate, timezone, {
      people: params.people || null,
    });
  }

  // ========== UPDATED HELP ==========
  getHelpMessage(_lang = 'english') {
    // The lang param is kept for API compatibility but ignored — the message
    // names many languages explicitly, so a single English-language scaffold
    // works for all users. Auto-translation downstream handles localization
    // for non-English speakers if needed.
    return `Hi! I'm Ari 👋

I'm an AI assistant that lives on WhatsApp. Talk to me in pretty much any language (English, Hindi, Spanish, French, German, Arabic, Chinese, Japanese) and send text, voice notes, photos, or PDFs. Whatever's easiest.

Here's the kind of stuff I handle:

📅 *Meetings & calendar*
View connected calendars across Google, Outlook, and Apple. Creating, cancelling, and rescheduling calendar events currently uses Google Calendar. For recording, open Meetings in Ari Desktop and click Record Meeting; I will transcribe it and prepare the summary, decisions, action items, task suggestions, and full report.

⏰ *Reminders*
Just say "remind me to call mom at 7pm" and it's done. Recurring ones too. I can remind your teammates as well.

📧 *Email*
Compose, schedule, send, and bulk-send emails. Inbox reading and email-history automation are not available in this version.

✅ *Productivity*
Tasks, habits, notes, expenses, time tracking, focus mode. I can remember non-sensitive preferences and dates, such as your favorite report format or when your passport expires. I never store passwords, API keys, OTPs, or other credentials.

🌅 *Daily briefing*
Each morning I can give you a rundown of meetings, tasks, and news that matters to you.

🔍 *Search & research*
Live web search for prices, weather, anything current. I read PDFs and documents too.

🤝 *Team*
Standups, polls, leave requests, sales leads, sending messages on your behalf.

✨ *Other*
Save and analyze images or documents you send, transcribe voice, translate text, and open your linked Ari web dashboard. Messaging is available here on WhatsApp.

Some easy ways to start:
• "Remind me to grab coffee at 9 tomorrow"
• "What's on my plate today?"
• "Schedule a meeting with John at 3pm Friday"
• "Brief me on tomorrow"

Just text me whatever you need.`;
  }

  // ========== BATCH REMINDERS ==========
  async handleBatchReminder(message, userTimezone = 'Asia/Kolkata') {
    const result = await batchReminderService.parseAndCreateBatch(
      message.from, message.text, userTimezone
    );
    return batchReminderService.formatBatchResponse(result, userTimezone);
  }

  // ========== APPLE CALENDAR ==========
  async handleAppleConnect(message) {
    const text = message.text;

    // Check if credentials are provided
    const credsMatch = text.match(/apple\s*id[:\s]+([^\s,]+)\s*(?:,|password[:\s]+)\s*(.+)/i)
      || text.match(/connect\s+apple.*?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+)\s+(.+)/i);

    if (!credsMatch) {
      return `*Connect Apple Calendar*\n\n` +
`To connect your Apple Calendar (iCloud), you need:\n` +
`1. Your Apple ID (email)\n` +
`2. An App-Specific Password\n\n` +
`*Generate App-Specific Password:*\n` +
`Go to appleid.apple.com -> Sign-In & Security -> App-Specific Passwords -> Generate\n\n` +
`Then say:\n` +
`"connect apple calendar apple id: your@email.com, password: xxxx-xxxx-xxxx-xxxx"`;
    }

    const appleId = credsMatch[1].trim();
    const password = credsMatch[2].trim();

    const result = await appleCalendarService.saveCredentials(message.from, appleId, password);

    if (result.success) {
      const calNames = result.calendars.map(c => c.name).join(', ') || 'Default';
      return `Apple Calendar connected!\n\nCalendars found: ${calNames}\n\nYour events will now appear in "my calendar"`;
    }

    return `Could not connect Apple Calendar: ${result.error}`;
  }

  async handleAppleDisconnect(message) {
    const result = await appleCalendarService.disconnect(message.from);
    return result.success ? 'Apple Calendar disconnected.' : 'Could not disconnect Apple Calendar.';
  }

  isValidEmail(email) {
    return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test((email || '').trim());
  }

  parseBulkEmailAddresses(text) {
    const raw = (text.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+/gi) || [])
      .map(e => e.replace(/[>,;.)]+$/g, '').trim().toLowerCase());

    const valid = [];
    const invalid = [];
    const duplicates = [];
    const seen = new Set();

    for (const email of raw) {
      if (!this.isValidEmail(email)) {
        if (!invalid.includes(email)) invalid.push(email);
        continue;
      }
      if (seen.has(email)) {
        duplicates.push(email);
        continue;
      }
      seen.add(email);
      valid.push(email);
    }

    return {
      valid,
      invalid,
      duplicateCount: duplicates.length,
      uniqueDuplicateEmails: [...new Set(duplicates)]
    };
  }

  getBulkEmailMode(text) {
    const lower = text.toLowerCase();
    if (/\b(personalize|personalise|unique|each\s+recipient|individual|customized?)\b/.test(lower)) {
      return 'personalized';
    }
    if (/\b(one|single|same|common)\s+(email|draft|message)\b|\bsame\s+for\s+all\b|\bone\s+email\s+for\s+all\b/.test(lower)) {
      return 'shared';
    }
    return 'personalized';
  }

  getDirectEmailFlowType(text) {
    const normalized = String(text || '');
    const hasEmailIntent = /\b(send|email|mail|bhej)\b/i.test(normalized);
    if (!hasEmailIntent) return null;

    const parsedEmails = this.parseBulkEmailAddresses(normalized);
    if (parsedEmails.valid.length === 0) return null;
    if (parsedEmails.valid.length >= 2) return 'email_bulk';
    return this.isScheduleIntentText(normalized) ? 'email_schedule' : 'email_send';
  }

  // Pre-LLM gate: should this message bypass the intent classifier and go
  // straight to handleEmailBulk? Returns null (no) or { reason, recipientCount }.
  //
  // Conservative — only fires when:
  //   - 2+ valid email addresses are present
  //   - the message has an email/send keyword (so we're not confusing a
  //     contact list with someone who just pasted addresses for reference)
  //   - AND one of these strong shape signals is true:
  //       * a [First Name] / {first_name} placeholder, OR
  //       * a "Hi/Hello/Dear" greeting line, OR
  //       * 3+ recipients (volume strongly implies bulk)
  shouldFastPathBulkEmail(text) {
    const normalized = String(text || '');
    if (normalized.length < 30) return null;

    const hasEmailVerb = /\b(send|email|emails?|mail|bhej|broadcast|forward to|message all)\b/i.test(normalized);
    if (!hasEmailVerb) return null;

    // Cheap reject: too few @-signs to be a bulk email.
    const atSigns = (normalized.match(/@/g) || []).length;
    if (atSigns < 2) return null;

    const parsed = this.parseBulkEmailAddresses(normalized);
    if (parsed.valid.length < 2) return null;

    const hasPlaceholder = /\[\s*first[\s_-]?name\s*\]|\{\s*first[\s_-]?name\s*\}/i.test(normalized);
    const hasGreetingLine = /(^|\n)\s*(hi|hello|hey|dear|namaste|greetings)\b[^\n]{0,40}[,:]/i.test(normalized);
    const isHighVolume = parsed.valid.length >= 3;

    if (!hasPlaceholder && !hasGreetingLine && !isHighVolume) return null;

    let reason;
    if (hasPlaceholder) reason = 'has [First Name] placeholder';
    else if (hasGreetingLine) reason = 'has greeting line';
    else reason = `${parsed.valid.length} recipients`;

    return { reason, recipientCount: parsed.valid.length };
  }

  isScheduleStatusRequest(text) {
    const lower = (text || '').toLowerCase();
    return /\b(what|when|tell|show|confirm|check)\b/.test(lower)
      && /\b(schedule|scheedule|scheudle|shcedule|scheduled|send)\b/.test(lower)
      && /\b(time|timing|when|at)\b/.test(lower);
  }

  isScheduleAdjustmentRequest(text) {
    const lower = (text || '').toLowerCase();
    const hasTimeValue = /\b\d{1,2}(?::\d{2})?\s*(am|pm)?\b/.test(lower);

    return (
      /\b(change|update|move|reschedule|correct|fix|set)\b/.test(lower)
        && (/\b(time|timing|schedule|scheedule|scheudle|shcedule|scheduled|send)\b/.test(lower) || hasTimeValue)
    )
      || /\bnot\s+(am|pm)\b/.test(lower)
      || (/\b(schedule|scheedule|scheudle|shcedule|reschedule)\b/.test(lower) && hasTimeValue);
  }

  isScheduledEmailListRequest(text) {
    const normalized = (text || '').toLowerCase().trim().replace(/\s+/g, ' ');
    return /^(?:(?:show|view|list|check)(?: me)?|my)?\s*(?:the\s+)?(?:scheduled|schedule|scheedule|scheudle|shcedule)\s+(?:emails?|mails?)$/.test(normalized);
  }

  formatScheduledEmailList(emails, title = '*Scheduled Emails*') {
    if (!Array.isArray(emails) || emails.length === 0) return 'No scheduled emails pending.';

    let resp = `${title} (${emails.length})\n\n`;
    emails.forEach((email, index) => {
      const sendAt = new Date(email.send_at).toLocaleString('en-IN', {
        day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true
      });
      const recurring = email.is_recurring
        ?` | Repeats: ${email.recurrence_pattern}${email.recurrence_days ?` (${email.recurrence_days})` : ''}`
        : '';
      const timezone = email.timezone ?` | TZ: ${email.timezone}` : '';
      resp += `${index + 1}. *${email.subject}*\n To: ${email.recipients.join(', ')}\n Sends: ${sendAt}${timezone}${recurring} (ID: ${email.id})\n\n`;
    });
    resp += '_"cancel scheduled email #ID" to cancel_';
    return resp;
  }

  async handleRecentScheduledEmailManagement(message, userTimezone) {
    const recentEmail = this.recentEmailContext.get(message.from);
    const scheduledIds = [...new Set(
      (Array.isArray(recentEmail?.scheduledIds) ? recentEmail.scheduledIds : [])
        .map(id => Number.parseInt(id, 10))
        .filter(Number.isInteger)
    )];

    if (scheduledIds.length === 0) return null;

    if (this.isScheduledEmailListRequest(message.text) || this.isScheduleStatusRequest(message.text)) {
      const pendingEmails = await scheduledEmailJob.getScheduledEmails(message.from);
      if (pendingEmails.length === 0) return 'No scheduled emails pending.';

      const matchingEmails = pendingEmails.filter(email => scheduledIds.includes(email.id));
      recentEmail.timestamp = Date.now();
      this.recentEmailContext.set(message.from, recentEmail);

      if (matchingEmails.length > 0) {
        return this.formatScheduledEmailList(matchingEmails);
      }

      return this.formatScheduledEmailList(pendingEmails);
    }

    if (!this.isScheduleAdjustmentRequest(message.text)) return null;

    const nextSchedule = this.parseEmailScheduleDetails(message.text, recentEmail.timezone || userTimezone);
    if (!nextSchedule.success) {
      const currentSendAt = new Date(recentEmail.sendAt);
      const hasCurrentSchedule = Number.isFinite(currentSendAt.getTime());
      const currentScheduleLine = hasCurrentSchedule
        ?`\n\n*Current schedule:* ${currentSendAt.toLocaleString('en-IN', {
          weekday: 'short', day: 'numeric', month: 'short',
          hour: 'numeric', minute: '2-digit', hour12: true
        })}\n*Timezone:* ${recentEmail.timezone || userTimezone}`
        : '';
      return `${nextSchedule.error}${currentScheduleLine}\n\nReply with something like "change the time to 7:55 pm today".`;
    }

    const result = await scheduledEmailJob.updateScheduledEmailsByIds(message.from, scheduledIds, {
      sendAt: nextSchedule.sendAt,
      timezone: nextSchedule.timezone,
      isRecurring: nextSchedule.isRecurring,
      recurrencePattern: nextSchedule.recurrencePattern,
      recurrenceDays: nextSchedule.recurrenceDays,
      recurrenceTime: nextSchedule.recurrenceTime
    });

    if (!result.success) {
      return `Couldn't update the scheduled email: ${result.error}`;
    }

    const scopedDrafts = Array.isArray(recentEmail.drafts) && recentEmail.drafts.length > 0
      ? recentEmail.drafts.map(d => ({ to: d.to, subject: d.subject, body: d.body, htmlBody: d.htmlBody }))
      : (recentEmail.referenceDraft ? [{
        to: recentEmail.referenceDraft.to,
        subject: recentEmail.referenceDraft.subject,
        body: recentEmail.referenceDraft.body,
        htmlBody: recentEmail.referenceDraft.htmlBody
      }] : []);

    this.storeRecentEmailContext(message.from, {
      type: recentEmail.type || (scopedDrafts.length > 1 ? 'bulk' : 'single'),
      referenceDraft: recentEmail.referenceDraft || scopedDrafts[0],
      drafts: scopedDrafts.length > 0 ? scopedDrafts : null,
      mode: recentEmail.mode || null,
      attachments: recentEmail.attachments || null,
      sendAt: nextSchedule.sendAt,
      timezone: nextSchedule.timezone,
      isRecurring: nextSchedule.isRecurring,
      recurrencePattern: nextSchedule.recurrencePattern,
      recurrenceDays: nextSchedule.recurrenceDays,
      recurrenceTime: nextSchedule.recurrenceTime,
      recurrenceLabel: nextSchedule.recurrenceLabel,
      scheduledIds: result.emails.map(email => email.id)
    });

    const sendAtStr = nextSchedule.sendAt.toLocaleString('en-IN', {
      weekday: 'short', day: 'numeric', month: 'short',
      hour: 'numeric', minute: '2-digit', hour12: true
    });
    const recurrenceLine = nextSchedule.isRecurring
      ?`\n*Repeats:* ${nextSchedule.recurrenceLabel || nextSchedule.recurrencePattern}${nextSchedule.recurrenceDays ?` (${nextSchedule.recurrenceDays})` : ''}`
      : '';

    if (result.emails.length > 1 || scopedDrafts.length > 1) {
      const recipients = scopedDrafts.length > 0
        ? scopedDrafts.map(draft => draft.to)
        : result.emails.flatMap(email => Array.isArray(email.recipients) ? email.recipients : []);
      return `Updated ${result.emails.length} scheduled emails!\n\n*Sends at:* ${sendAtStr}\n*Timezone:* ${nextSchedule.timezone || 'local'}${recurrenceLine}\n*Recipients:* ${recipients.join(', ')}\n\n_"scheduled emails" to view | "cancel scheduled email #ID" to cancel_`;
    }

    const draft = scopedDrafts[0] || recentEmail.referenceDraft || null;
    const recipient = draft?.to || result.emails[0]?.recipients?.[0] || 'recipient';
    const subject = draft?.subject || result.emails[0]?.subject || 'No Subject';
    return `Scheduled email updated!\n\n*To:* ${recipient}\n*Subject:* ${subject}\n*Sends:* ${sendAtStr}\n*Timezone:* ${nextSchedule.timezone || 'local'}${recurrenceLine}\n\n_"scheduled emails" to view | "cancel scheduled email #${result.emails[0]?.id || 'ID'}" to cancel_`;
  }

  storeRecentEmailContext(userPhone, data = {}) {
    const referenceDraft = data.referenceDraft || data.draft || (Array.isArray(data.drafts) ? data.drafts[0] : null);
    if (!referenceDraft) return;

    this.recentEmailContext.set(userPhone, {
      type: data.type || 'single',
      referenceDraft: {
        to: referenceDraft.to,
        subject: referenceDraft.subject,
        body: referenceDraft.body,
        htmlBody: referenceDraft.htmlBody
      },
      drafts: Array.isArray(data.drafts)
        ? data.drafts.map(d => ({ to: d.to, subject: d.subject, body: d.body, htmlBody: d.htmlBody }))
        : null,
      mode: data.mode || null,
      attachments: data.attachments || null,
      sendAt: data.sendAt || null,
      timezone: data.timezone || null,
      isRecurring: Boolean(data.isRecurring),
      recurrencePattern: data.recurrencePattern || null,
      recurrenceDays: data.recurrenceDays || null,
      recurrenceTime: data.recurrenceTime || null,
      recurrenceLabel: data.recurrenceLabel || null,
      scheduledIds: Array.isArray(data.scheduledIds)
        ? [...new Set(data.scheduledIds.map(id => Number.parseInt(id, 10)).filter(Number.isInteger))]
        : null,
      timestamp: Date.now()
    });
  }

  isExplicitEmailScheduleInstruction(text) {
    const lower = (text || '').toLowerCase();
    return /\b(schedule|scheedule|scheudle|shcedule|sched|send later|delay|queue)\b/.test(lower)
      || /\b(send|mail|email)\s+(it|this|that|the email)\b/.test(lower);
  }

  isLikelyPreviousEmailReuseRequest(text) {
    const lower = (text || '').toLowerCase();
    return /\b(same email|same draft|same message|same one|the same|previous email|earlier email|other email|this email|that email|send it|mail it|send this|like before)\b/.test(lower)
      || /\b(schedule|scheudle|shcedule|sched)\s+(it|this|the email)\b/.test(lower)
      || /\balso\s+(schedule|scheudle|shcedule|sched|send)\b/.test(lower);
  }

  isImplicitScheduleFollowUpForRecentEmail(text, recentEmail = null) {
    if (!recentEmail) return false;

    const lower = (text || '').toLowerCase().trim();
    if (!lower) return false;
    if (this.parseBulkEmailAddresses(text).valid.length > 0) return false;
    if (!this.isScheduleIntentText(lower)) return false;
    if (/\b(meeting|meet|calendar|event|invite|invitation|attendee|call|zoom|gmeet|google meet|standup)\b/.test(lower)) {
      return false;
    }

    return /\b(schedule|scheedule|scheudle|shcedule|send|today|tomorrow|tonight|morning|afternoon|evening|am|pm|next)\b/.test(lower)
      || /\b\d{1,2}(?::\d{2})?\b/.test(lower);
  }

  cloneDraftForRecipient(draft, recipient) {
    if (!draft) return null;
    let body = draft.body || '';
    body = body.replace(/^(hi|hello|dear)\s+[^,\n]+,/i, '$1,');
    return {
      to: recipient,
      subject: draft.subject || 'No Subject',
      body,
      htmlBody: gmailService.bodyToHtml(body)
    };
  }

  resolveScheduleFromRecentEmailContext(text, userTimezone, recentEmail = null) {
    if (!this.isExplicitEmailScheduleInstruction(text)) {
      return { success: false, schedule: null, error: null };
    }

    const parsed = this.parseEmailScheduleDetails(text, userTimezone);
    if (parsed.success) {
      return { success: true, schedule: parsed, error: null };
    }

    if (recentEmail && recentEmail.sendAt) {
      const inheritedSendAt = new Date(recentEmail.sendAt);
      if (Number.isFinite(inheritedSendAt.getTime()) && inheritedSendAt > new Date()) {
        return {
          success: true,
          schedule: {
            sendAt: inheritedSendAt,
            timezone: recentEmail.timezone || userTimezone,
            isRecurring: Boolean(recentEmail.isRecurring),
            recurrencePattern: recentEmail.recurrencePattern || null,
            recurrenceDays: recentEmail.recurrenceDays || null,
            recurrenceTime: recentEmail.recurrenceTime || null,
            recurrenceLabel: recentEmail.recurrenceLabel || null
          },
          error: null
        };
      }
    }

    return { success: false, schedule: null, error: parsed.error };
  }

  setScheduledEmailDraftContext(userPhone, draft, schedule, attachments = null, recipients = null) {
    const ctx = {
      draft,
      recipients: Array.isArray(recipients) && recipients.length > 0 ? [...recipients] : null,
      sendAt: schedule.sendAt,
      timezone: schedule.timezone,
      isRecurring: Boolean(schedule.isRecurring),
      recurrencePattern: schedule.recurrencePattern || null,
      recurrenceDays: schedule.recurrenceDays || null,
      recurrenceTime: schedule.recurrenceTime || null,
      recurrenceLabel: schedule.recurrenceLabel || null,
      attachments,
      timestamp: Date.now()
    };
    this.scheduledEmailContext.set(userPhone, ctx);
    this.storeRecentEmailContext(userPhone, { type: 'single', referenceDraft: draft, attachments, ...ctx });
    return ctx;
  }

  buildScheduledEmailPreview(draft, schedule, attachments = null, intro = '*Scheduled Email Preview*') {
    const sendAtStr = schedule.sendAt.toLocaleString('en-IN', {
      weekday: 'short', day: 'numeric', month: 'short',
      hour: 'numeric', minute: '2-digit', hour12: true
    });
    const preview = gmailService.previewBody(draft.body || '');
    const recurrenceLine = schedule.isRecurring
      ?`\n*Repeats:* ${schedule.recurrenceLabel || schedule.recurrencePattern}`
      : '';
    const tzLine = `\n*Timezone:* ${schedule.timezone}`;
    const attachLine = attachments ?`\n*Attachment:* ${attachments[0].fileName}` : '';
    return `${intro}\n\n*To:* ${draft.to}\n*Subject:* ${draft.subject}\n*Sends at:* ${sendAtStr}${tzLine}${recurrenceLine}${attachLine}\n\n${preview}\n\n_Schedule this? Reply *yes* | Edit? Tell me what to change | *no* to cancel_`;
  }

  buildBulkEmailPreview(ctx, options = {}) {
    const drafts = Array.isArray(options.drafts) ? options.drafts : (ctx.drafts || []);
    const title = options.title || '*Bulk Email Preview*';
    const footer = options.footer || '\n\n_Send all? Reply *yes* | Edit? Tell me what to change | *no* to cancel_';
    const mode = options.mode || ctx.mode || 'personalized';
    const attachments = options.attachments !== undefined ? options.attachments : (ctx.attachments || null);
    const updatedIndices = new Set(options.updatedIndices || []);
    const extraLines = [];

    if (attachments && attachments.length > 0) {
      extraLines.push(`*Attachment:* ${attachments[0].fileName}`);
    }

    if (ctx.sendAt) {
      const sendAtStr = ctx.sendAt.toLocaleString('en-IN', {
        weekday: 'short', day: 'numeric', month: 'short',
        hour: 'numeric', minute: '2-digit', hour12: true
      });
      extraLines.push(`*Scheduled for:* ${sendAtStr}`);
      extraLines.push(`*Timezone:* ${ctx.timezone || 'local'}`);
      if (ctx.isRecurring) {
        extraLines.push(`*Repeats:* ${ctx.recurrenceLabel || ctx.recurrencePattern}`);
      }
    }

    if (options.dedupeCount > 0) {
      extraLines.push(`*Removed duplicates:* ${options.dedupeCount}`);
    }

    if (Array.isArray(options.invalidEmails) && options.invalidEmails.length > 0) {
      extraLines.push(`*Invalid ignored:* ${options.invalidEmails.join(', ')}`);
    }

    let preview = `${title} (${drafts.length} recipients)\n*Mode:* ${mode === 'shared' ? 'one common email' : 'personalized per recipient'}`;
    if (extraLines.length > 0) {
      preview += `\n${extraLines.join('\n')}`;
    }
    preview += '\n';

    if (mode === 'shared' && drafts[0]) {
      const body = gmailService.previewBody(drafts[0].body || '');
      preview += `\n*Subject:* ${drafts[0].subject}\n${body}`;
    } else {
      drafts.forEach((draft, index) => {
        const tag = updatedIndices.has(index) ? ' _(updated)_' : '';
        const body = gmailService.previewBody(draft.body || '');
        preview += `\n--- *${index + 1}. ${draft.to}*${tag} ---\n*Subject:* ${draft.subject}\n${body}\n`;
      });
    }

    preview += footer;
    return preview;
  }

  async _handleTypedRecentEmailReuse(message, userTimezone, params = {}) {
    const recentEmail = this.recentEmailContext.get(message.from);
    if (!recentEmail) {
      return this._typedWaitingInput('There is no recent email draft to reuse. Draft an email first.');
    }
    if (!await googleAuthService.isConnected(message.from)) {
      return 'Google not connected. Say "connect google" to link your Gmail first.';
    }

    let drafts = Array.isArray(recentEmail.drafts) && recentEmail.drafts.length > 0
      ? recentEmail.drafts.map((draft) => ({
        ...draft,
        htmlBody: draft.htmlBody || gmailService.bodyToHtml(draft.body || ''),
      }))
      : recentEmail.referenceDraft ? [{
        ...recentEmail.referenceDraft,
        htmlBody: recentEmail.referenceDraft.htmlBody
          || gmailService.bodyToHtml(recentEmail.referenceDraft.body || ''),
      }] : [];
    if (drafts.length === 0) {
      return this._typedWaitingInput('The recent email no longer has a reusable draft. Draft it again.');
    }

    if (params.recipients?.length) {
      const resolved = await this._resolveTypedEmailRecipients(message.from, params.recipients);
      if (!resolved.success) return resolved.result;
      const base = drafts[0];
      drafts = resolved.recipients.map((recipient) => this.cloneDraftForRecipient(base, recipient));
    }

    if (params.action === 'edit') {
      const instruction = String(params.requested_change || '').trim();
      if (!instruction) return this._typedWaitingInput('What should I change in the recent email?');
      const revised = await gmailService.reviseEmailWithAI(drafts[0], instruction);
      if (!revised.success) return revised.error;
      drafts = drafts.map((draft) => ({
        ...draft,
        subject: revised.subject,
        body: revised.body,
        htmlBody: revised.htmlBody || gmailService.bodyToHtml(revised.body || ''),
      }));
    }

    let schedule = null;
    if (params.action === 'schedule') {
      schedule = this._typedEmailSchedule(params, userTimezone);
      if (!schedule.success) return this._typedWaitingInput(schedule.error);
    }

    const replacedRecipients = Array.isArray(params.recipients) && params.recipients.length > 0;
    if (drafts.length > 1 || (recentEmail.type === 'bulk' && !replacedRecipients)) {
      const bulkCtx = {
        drafts,
        previousDrafts: this.cloneDrafts(drafts),
        allRecipients: drafts.map((draft) => draft.to),
        mode: recentEmail.mode || 'shared',
        attachments: recentEmail.attachments || null,
        sendAt: schedule?.sendAt || null,
        timezone: schedule?.timezone || null,
        isRecurring: false,
        recurrencePattern: null,
        recurrenceDays: null,
        recurrenceTime: null,
        recurrenceLabel: null,
        timestamp: Date.now(),
      };
      this.bulkEmailContext.set(message.from, bulkCtx);
      this.storeRecentEmailContext(message.from, {
        type: 'bulk', drafts, referenceDraft: drafts[0], mode: bulkCtx.mode,
        attachments: bulkCtx.attachments, sendAt: bulkCtx.sendAt, timezone: bulkCtx.timezone,
      });
      return this.buildBulkEmailPreview(bulkCtx);
    }

    const draft = drafts[0];
    if (schedule) {
      const ctx = this.setScheduledEmailDraftContext(
        message.from, draft, schedule, recentEmail.attachments || null, [draft.to],
      );
      return this.buildScheduledEmailPreview(
        draft, ctx, recentEmail.attachments || null, '*Scheduled Email Preview (using previous draft)*',
      );
    }

    this.calendarConfirmContext.set(message.from, {
      type: 'email_send_confirm',
      draft,
      attachments: recentEmail.attachments || null,
      timestamp: Date.now(),
    });
    this.storeRecentEmailContext(message.from, {
      type: 'single', referenceDraft: draft, attachments: recentEmail.attachments || null,
    });
    return `*Email Preview (using previous draft)*\n\n*To:* ${draft.to}\n*Subject:* ${draft.subject}\n\n${gmailService.previewBody(draft.body || '')}\n\n_Send this email? Reply yes or no_`;
  }

  async handleRecentEmailReuse(message, userTimezone, params = {}) {
    if (isAgentToolMessage(message) && params.action) {
      return this._handleTypedRecentEmailReuse(message, userTimezone, params);
    }
    const recentEmail = this.recentEmailContext.get(message.from);
    const shouldReuseRecentEmail = recentEmail && (
      this.isLikelyPreviousEmailReuseRequest(message.text)
      || this.isImplicitScheduleFollowUpForRecentEmail(message.text, recentEmail)
    );
    if (!shouldReuseRecentEmail) return null;
    if (!await googleAuthService.isConnected(message.from)) {
      return 'Google not connected. Say "connect google" to link your Gmail first.';
    }

    const recipients = this.parseBulkEmailAddresses(message.text).valid;
    const recentDrafts = Array.isArray(recentEmail.drafts) && recentEmail.drafts.length > 0
      ? recentEmail.drafts.map(d => ({
        to: d.to,
        subject: d.subject,
        body: d.body,
        htmlBody: d.htmlBody || gmailService.bodyToHtml(d.body || '')
      }))
      : null;
    const baseDraft = recentEmail.referenceDraft || recentDrafts?.[0] || null;

    const scheduleResult = this.resolveScheduleFromRecentEmailContext(message.text, userTimezone, recentEmail);
    if (scheduleResult.error) return scheduleResult.error;

    if (recentEmail.type === 'bulk' && recipients.length === 0 && recentDrafts?.length) {
      if (!scheduleResult.success || !scheduleResult.schedule) return null;

      const bulkCtx = {
        drafts: recentDrafts,
        allRecipients: recentDrafts.map(d => d.to),
        mode: recentEmail.mode || 'personalized',
        attachments: recentEmail.attachments || null,
        sendAt: scheduleResult.schedule.sendAt,
        timezone: scheduleResult.schedule.timezone,
        isRecurring: Boolean(scheduleResult.schedule.isRecurring),
        recurrencePattern: scheduleResult.schedule.recurrencePattern || null,
        recurrenceDays: scheduleResult.schedule.recurrenceDays || null,
        recurrenceTime: scheduleResult.schedule.recurrenceTime || null,
        recurrenceLabel: scheduleResult.schedule.recurrenceLabel || null,
        timestamp: Date.now()
      };

      this.bulkEmailContext.set(message.from, bulkCtx);
      this.storeRecentEmailContext(message.from, {
        type: 'bulk',
        drafts: recentDrafts,
        referenceDraft: recentDrafts[0],
        mode: bulkCtx.mode,
        attachments: bulkCtx.attachments,
        sendAt: bulkCtx.sendAt,
        timezone: bulkCtx.timezone,
        isRecurring: bulkCtx.isRecurring,
        recurrencePattern: bulkCtx.recurrencePattern,
        recurrenceDays: bulkCtx.recurrenceDays,
        recurrenceTime: bulkCtx.recurrenceTime,
        recurrenceLabel: bulkCtx.recurrenceLabel
      });

      return this.buildBulkEmailPreview(bulkCtx, { drafts: recentDrafts });
    }

    if (recipients.length > 1 || !baseDraft) return null;

    const draft = recipients.length === 1
      ? this.cloneDraftForRecipient(baseDraft, recipients[0])
      : {
        to: baseDraft.to,
        subject: baseDraft.subject || 'No Subject',
        body: baseDraft.body || '',
        htmlBody: baseDraft.htmlBody || gmailService.bodyToHtml(baseDraft.body || '')
      };
    if (!draft?.to) return null;

    if (scheduleResult.success && scheduleResult.schedule) {
      const ctx = this.setScheduledEmailDraftContext(message.from, draft, scheduleResult.schedule, recentEmail.attachments || null);
      return this.buildScheduledEmailPreview(draft, ctx, recentEmail.attachments || null, '*Scheduled Email Preview (using previous draft)*');
    }

    this.calendarConfirmContext.set(message.from, {
      type: 'email_send_confirm',
      draft,
      attachments: recentEmail.attachments || null,
      timestamp: Date.now()
    });
    this.storeRecentEmailContext(message.from, {
      type: 'single',
      referenceDraft: draft,
      attachments: recentEmail.attachments || null,
      sendAt: recentEmail.sendAt || null,
      timezone: recentEmail.timezone || null,
      isRecurring: recentEmail.isRecurring || false,
      recurrencePattern: recentEmail.recurrencePattern || null,
      recurrenceDays: recentEmail.recurrenceDays || null,
      recurrenceTime: recentEmail.recurrenceTime || null,
      recurrenceLabel: recentEmail.recurrenceLabel || null
    });

    const attachNote = recentEmail.attachments ?`\n*Attachment:* ${recentEmail.attachments[0].fileName}` : '';
    const preview = gmailService.previewBody(draft.body || '');
    return `*Email Preview (using previous draft)*\n\n*To:* ${draft.to}\n*Subject:* ${draft.subject}${attachNote}\n\n${preview}\n\n_Send this email? Reply yes or no_`;
  }
  isScheduleIntentText(text) {
    const lower = (text || '').toLowerCase();

    // ── Body introducer split (prefix = stuff that drives ROUTING; suffix = email body content) ──
    // Anything after these words/punctuation is the body of the email — its
    // contents shouldn't drive routing. We split the message in two and only
    // check the prefix for scheduling signals.
    //
    // Bug v1 fix (Apr 2026): "send email to X about kickoff is tomorrow at 3pm..."
    // was matching "tomorrow" in the body and routing to email_schedule.
    //
    // Bug v2 fix (Apr 2026, this edit): "send a mail to X, let's schedule a
    // meeting tomorrow at 10:00 to discuss budget" was matching "schedule"
    // in the body and routing to email_schedule. The schedule keyword check
    // is now ALSO prefix-only (matches the lead-verb-strict philosophy in
    // the LLM intent prompt). We also added comma and "to discuss/to go over"
    // as body introducers so common phrasings split correctly.
    const bodyIntroducers = /\b(?:about|regarding|saying|mentioning|that\s+(?:the|i|we|she|he|it|they)|telling|informing|with\s+(?:subject|the\s+message)|to\s+say|to\s+tell|to\s+discuss|to\s+go\s+over|asking|letting\s+\w+\s+know)\b|,/;
    const prefix = lower.split(bodyIntroducers)[0];

    // Explicit scheduling verbs in the PREFIX only — body content with
    // "schedule" doesn't count (e.g. "send mail to X, let's schedule a meeting"
    // is an immediate email request whose body talks about scheduling something).
    if (/\b(schedule|scheduled|send\s+later|delay)\b/.test(prefix)) return true;

    // Time/day mentions in the prefix — these directly modify the SEND verb.
    return /\b(at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|today|tomorrow|next\s+\w+|on\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|every\s+(?:day|weekday|weekend|week)|daily|weekly|weekdays|weekends)\b/.test(prefix);
  }

  async getUserNameForSignature(userPhone) {
    try {
      const trunk = await memoryService.getMemoryTrunk(userPhone);
      const personal = Array.isArray(trunk.personal) ? trunk.personal : [];
      let name = personal.find(m => (m.key || '').toLowerCase() === 'name')?.value || null;
      if (!name) {
        for (const entries of Object.values(trunk)) {
          if (!Array.isArray(entries)) continue;
          const hit = entries.find(m => (m.key || '').toLowerCase() === 'name');
          if (hit?.value) { name = hit.value; break; }
        }
      }
      if (!name) return null;
      const cleaned = String(name).replace(/[^\p{L}\s.'-]/gu, '').trim().split(/\s+/).slice(0, 3).join(' ');
      return cleaned || null;
    } catch (error) {
      return null;
    }
  }

  addDefaultSignature(body, signerName) {
    if (!body) return '';
    if (!signerName) return body;

    let updated = body;
    const placeholderPatterns = [
      /\[your name\]/gi,
      /\[your name\/team\]/gi,
      /\[your team\]/gi
    ];
    for (const p of placeholderPatterns) {
      updated = updated.replace(p, signerName);
    }
    updated = updated
      .replace(/^\s*\[your position\]\s*$/gim, '')
      .replace(/^\s*\[your contact information\]\s*$/gim, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const normalized = updated.replace(/\r/g, '').trim();
    const trailingSignaturePattern = /(?:^|\n)(best(?: regards)?|kind regards|warm regards|regards|sincerely|cheers|thanks|thank you)[,!]?\s*\n[\p{L}][\p{L}\s.'-]{0,80}$/iu;
    if (trailingSignaturePattern.test(normalized)) {
      return updated;
    }

    return `${updated}\n\nBest regards,\n${signerName}`;
  }

  extractTimezoneFromText(text, fallbackTimezone = 'Asia/Kolkata') {
    const explicit = text.match(/\b(?:timezone|time\s*zone|tz)\s*[:=]?\s*([A-Za-z_\/+-]+)\b/i);
    const candidate = explicit?.[1];
    if (candidate) {
      const resolved = timezoneService.resolveTimezone(candidate) || candidate;
      try {
        Intl.DateTimeFormat('en-US', { timeZone: resolved });
        return resolved;
      } catch (e) { /* ignore */ }
    }

    const aliasMap = {
      ist: 'Asia/Kolkata',
      est: 'America/New_York',
      edt: 'America/New_York',
      cst: 'America/Chicago',
      cdt: 'America/Chicago',
      mst: 'America/Denver',
      mdt: 'America/Denver',
      pst: 'America/Los_Angeles',
      pdt: 'America/Los_Angeles',
      utc: 'UTC',
      gmt: 'UTC'
    };
    const lower = text.toLowerCase();
    const scrubbed = lower.replace(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi, ' ');
    const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const [alias, tz] of Object.entries(aliasMap)) {
      if (new RegExp(`\\b${escapeRegex(alias)}\\b`, 'i').test(scrubbed)) return tz;
    }

    const cityMap = timezoneService.cityTimezones || {};
    const cityKeys = Object.keys(cityMap).sort((a, b) => b.length - a.length);
    for (const key of cityKeys) {
      if (new RegExp(`\\b${escapeRegex(key.toLowerCase())}\\b`, 'i').test(scrubbed)) {
        return cityMap[key];
      }
    }

    return fallbackTimezone;
  }

  parseRecurringEmailConfig(text) {
    const lower = text.toLowerCase();
    if (/\b(every day|daily)\b/.test(lower)) {
      return { isRecurring: true, recurrencePattern: 'daily', recurrenceDays: null, recurrenceLabel: 'daily' };
    }
    if (/\b(weekdays|every weekday)\b/.test(lower)) {
      return { isRecurring: true, recurrencePattern: 'weekdays', recurrenceDays: 'mon,tue,wed,thu,fri', recurrenceLabel: 'weekdays' };
    }
    if (/\b(weekends|every weekend)\b/.test(lower)) {
      return { isRecurring: true, recurrencePattern: 'weekends', recurrenceDays: 'sat,sun', recurrenceLabel: 'weekends' };
    }
    if (/\bweekly\b|\bevery\s+week\b/.test(lower)) {
      return { isRecurring: true, recurrencePattern: 'weekly', recurrenceDays: null, recurrenceLabel: 'weekly' };
    }

    const dayMap = {
      monday: 'mon', mon: 'mon',
      tuesday: 'tue', tue: 'tue', tues: 'tue',
      wednesday: 'wed', wed: 'wed',
      thursday: 'thu', thu: 'thu', thurs: 'thu',
      friday: 'fri', fri: 'fri',
      saturday: 'sat', sat: 'sat',
      sunday: 'sun', sun: 'sun'
    };
    const dayRegex = /\b(mon(?:day)?|tue(?:sday|s)?|wed(?:nesday)?|thu(?:rsday|rs)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/gi;
    const days = [];
    let m;
    while ((m = dayRegex.exec(lower)) !== null) {
      const d = dayMap[m[1].toLowerCase()];
      if (d && !days.includes(d)) days.push(d);
    }
    if (/\bevery\b/.test(lower) && days.length > 0) {
      return { isRecurring: true, recurrencePattern: 'custom', recurrenceDays: days.join(','), recurrenceLabel: days.join(', ') };
    }
    return { isRecurring: false, recurrencePattern: null, recurrenceDays: null, recurrenceLabel: null };
  }

  parseEmailScheduleDetails(text, userTimezone) {
    const chrono = require('chrono-node');
    const timezone = this.extractTimezoneFromText(text, userTimezone);
    const recurrence = this.parseRecurringEmailConfig(text);
    const emailTzOffset = calendarNLPService.getTimezoneOffsetMinutes(timezone);
    const parsed = chrono.parse(text, new Date(), { forwardDate: true, timezone: emailTzOffset });
    let sendAt = null;
    if (parsed && parsed.length > 0) {
      const chronoStart = parsed[0].start;
      sendAt = reminderService.zonedWallTimeToUtcDate({
        year: chronoStart.get('year'),
        month: chronoStart.get('month'),
        day: chronoStart.get('day'),
        hour: chronoStart.get('hour'),
        minute: chronoStart.get('minute'),
        second: chronoStart.get('second') || 0
      }, timezone);
    } else {
      const timeMatch = text.match(/\b(?:at|@)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i);
      const dayMatch = text.match(/\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
      if (timeMatch) {
        sendAt = reminderService.parseScheduledTime(
          timeMatch[1],
          dayMatch ? dayMatch[1] : null,
          timezone
        );
      }
    }

    if (!sendAt) {
      return {
        success: false,
        error: 'Could not understand schedule time. Try: _"email ... tomorrow 9am timezone IST"_'
      };
    }

    if (sendAt <= new Date()) {
      return { success: false, error: 'The scheduled time is in the past. Please specify a future time.' };
    }

    const zoned = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(sendAt);
    const hour = zoned.find(p => p.type === 'hour')?.value || '09';
    const minute = zoned.find(p => p.type === 'minute')?.value || '00';
    const recurrenceTime = `${hour}:${minute}`;

    return {
      success: true,
      sendAt,
      timezone,
      isRecurring: recurrence.isRecurring,
      recurrencePattern: recurrence.recurrencePattern,
      recurrenceDays: recurrence.recurrenceDays,
      recurrenceLabel: recurrence.recurrenceLabel,
      recurrenceTime
    };
  }

  // ========== SCHEDULED EMAIL ==========
  async handleEmailSchedule(message, context, intentParams = {}) {
    // Viewing and cancelling scheduled email — long advertised in the tool
    // description but previously unreachable, because the contract had no
    // action field and demanded send arguments.
    const scheduleAction = String(intentParams.action || '').toLowerCase();
    if (scheduleAction === 'list') {
      const scheduled = await scheduledEmailJob.getScheduledEmails(message.from);
      if (!scheduled || scheduled.length === 0) return 'No scheduled emails right now.';
      const lines = scheduled.slice(0, 15).map((item, index) => {
        const when = item.send_at ? new Date(item.send_at).toLocaleString('en-IN', {
          weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
        }) : 'time unknown';
        return `${index + 1}. *${item.subject || '(no subject)'}* → ${item.recipients || item.recipient_email || 'unknown'}\n   ${when} (ID: ${item.id})`;
      });
      require('../utils/list-position-cache').remember(message.from, 'scheduled_emails',
        scheduled.slice(0, 15).map((item) => ({ id: item.id, title: item.subject })));
      return `*Scheduled emails:*\n\n${lines.join('\n')}\n\n_Say "cancel scheduled email [ID]" to stop one._`;
    }
    if (scheduleAction === 'cancel') {
      const id = Number(intentParams.scheduled_email_id);
      if (!Number.isInteger(id) || id <= 0) {
        return 'Which scheduled email should I cancel? Say "show scheduled emails" for the list.';
      }
      require('../utils/abort').throwIfAborted(message.signal, 'The scheduled-email cancellation');
      const result = await scheduledEmailJob.cancelScheduledEmail(message.from, id);
      if (!result?.success) return result?.error || 'I could not cancel that scheduled email.';
      return `Cancelled scheduled email #${id}. It will not be sent.`;
    }

    if (isAgentToolMessage(message)) {
      if (!await googleAuthService.isConnected(message.from)) {
        return 'Google not connected. Say "connect google" to link your Gmail first.';
      }
      const resolved = await this._resolveTypedEmailRecipients(message.from, intentParams.recipients);
      if (!resolved.success) return resolved.result;
      const agentAttachments = await this._resolveAgentEmailAttachments(message, intentParams);
      if (agentAttachments.error) return agentAttachments.error;
      const fallbackTimezone = context?.userTimezone || await timezoneService.getUserTimezone(message.from);
      const schedule = this._typedEmailSchedule(intentParams, fallbackTimezone);
      if (!schedule.success) return this._typedWaitingInput(schedule.error);
      const draft = this._typedEmailDraft(resolved.recipients, intentParams);
      const ctx = this.setScheduledEmailDraftContext(
        message.from,
        draft,
        schedule,
        agentAttachments.attachments,
        resolved.recipients,
      );
      return this.buildScheduledEmailPreview(draft, ctx, agentAttachments.attachments);
    }

    const directFlowType = this.getDirectEmailFlowType(message.text);
    if (directFlowType === 'email_bulk') {
      logger.info('Redirecting email_schedule -> email_bulk based on recipient count');
      return await this.handleEmailBulk(message, context, intentParams);
    }

    if (!await googleAuthService.isConnected(message.from)) {
      return 'Google not connected. Say "connect google" to link your Gmail first.';
    }

    const text = message.text;

    // Check for "my scheduled emails" / "scheduled emails" / "cancel scheduled email #5"
    const lower = text.toLowerCase().trim();
    if (this.isScheduledEmailListRequest(lower)) {
      const emails = await scheduledEmailJob.getScheduledEmails(message.from);
      return this.formatScheduledEmailList(emails);
    }

    const cancelMatch = lower.match(/^cancel\s+scheduled\s+(?:email|mail)\s+#?(\d+)/i);
    if (cancelMatch) {
      const result = await scheduledEmailJob.cancelScheduledEmail(message.from, parseInt(cancelMatch[1]));
      if (!result.success) return result.error;
      return `Scheduled email cancelled: "${result.email.subject}"`;
    }

    const userTimezone = await timezoneService.getUserTimezone(message.from);

    const agentAttachments = await this._resolveAgentEmailAttachments(message, intentParams);
    if (agentAttachments.error) return agentAttachments.error;

    // Draft the email content using AI (same as regular email)
    const docCtx = this.documentContext.get(message.from);
    const hasDoc = !agentAttachments.isAgentTool
      && docCtx && (Date.now() - docCtx.timestamp) < this.workflowContextTtls.document;
    const attachments = agentAttachments.isAgentTool
      ? agentAttachments.attachments
      : (hasDoc ? documentAttachmentsFromContext(docCtx) : null);

    const draft = await gmailService.draftEmailWithAI(text, hasDoc ? documentTextFromContext(docCtx) : null);
    if (!draft.success) return draft.error;
    const signerName = await this.getUserNameForSignature(message.from);
    draft.body = this.addDefaultSignature(draft.body, signerName);
    draft.htmlBody = gmailService.bodyToHtml(draft.body);

    const schedule = this.parseEmailScheduleDetails(text, userTimezone);
    if (!schedule.success) {
      this.storeRecentEmailContext(message.from, {
        type: 'single',
        referenceDraft: draft,
        attachments
      });
      return `${schedule.error}\n\nI kept the drafted email. Reply with a new time like "schedule it for today 5:25pm".`;
    }

    // Store for confirmation
    this.setScheduledEmailDraftContext(message.from, draft, schedule, attachments);

    const sendAtStr = schedule.sendAt.toLocaleString('en-IN', {
      weekday: 'short', day: 'numeric', month: 'short',
      hour: 'numeric', minute: '2-digit', hour12: true
    });
    const preview = gmailService.previewBody(draft.body);
    const recurrenceLine = schedule.isRecurring
      ?`\n*Repeats:* ${schedule.recurrenceLabel}`
      : '';
    const tzLine = `\n*Timezone:* ${schedule.timezone}`;
    const attachLine = attachments ?`\n*Attachment:* ${attachments[0].fileName}` : '';
    return `*Scheduled Email Preview*\n\n*To:* ${draft.to}\n*Subject:* ${draft.subject}\n*Sends at:* ${sendAtStr}${tzLine}${recurrenceLine}${attachLine}\n\n${preview}\n\n_Schedule this? Reply *yes* | Edit? Tell me what to change | *no* to cancel_`;
  }

  async handleScheduledEmailConfirm(message) {
    const ctx = this.scheduledEmailContext.get(message.from);
    if (!ctx) return null;

    const text = message.text.toLowerCase().trim();
    const sendAtStr_ = ctx.sendAt.toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
    const classification = classifySensitiveConfirmation(text);

    if (classification.decision === 'confirm') {
      this.scheduledEmailContext.delete(message.from);
      const htmlBody = gmailService.bodyToHtml(ctx.draft.body);
      const result = await scheduledEmailJob.scheduleEmail(message.from, {
        recipients: Array.isArray(ctx.recipients) && ctx.recipients.length > 0
          ? ctx.recipients
          : [ctx.draft.to],
        subject: ctx.draft.subject,
        body: ctx.draft.body,
        htmlBody,
        sendAt: ctx.sendAt,
        isRecurring: ctx.isRecurring,
        recurrencePattern: ctx.recurrencePattern,
        recurrenceDays: ctx.recurrenceDays,
        recurrenceTime: ctx.recurrenceTime,
        timezone: ctx.timezone,
        attachments: ctx.attachments || null
      });
      if (!result.success) return `Failed to schedule: ${result.error}`;
      this.storeRecentEmailContext(message.from, {
        type: 'single',
        referenceDraft: ctx.draft,
        attachments: ctx.attachments || null,
        sendAt: ctx.sendAt,
        timezone: ctx.timezone,
        isRecurring: ctx.isRecurring,
        recurrencePattern: ctx.recurrencePattern,
        recurrenceDays: ctx.recurrenceDays,
        recurrenceTime: ctx.recurrenceTime,
        recurrenceLabel: ctx.recurrenceLabel,
        scheduledIds: [result.scheduled.id]
      });
      const sendAtStr = ctx.sendAt.toLocaleString('en-IN', {
        weekday: 'short', day: 'numeric', month: 'short',
        hour: 'numeric', minute: '2-digit', hour12: true
      });
      const recLine = ctx.isRecurring ?`\n*Repeats:* ${ctx.recurrencePattern}${ctx.recurrenceDays ?` (${ctx.recurrenceDays})` : ''}` : '';
      return `Email scheduled!\n\n*To:* ${ctx.draft.to}\n*Subject:* ${ctx.draft.subject}\n*Sends:* ${sendAtStr}\n*Timezone:* ${ctx.timezone || 'local'}${recLine}\n\n_"scheduled emails" to view | "cancel scheduled email #${result.scheduled.id}" to cancel_`;
    }

    if (classification.decision === 'cancel') {
      this.scheduledEmailContext.delete(message.from);
      return 'Scheduled email cancelled.';
    }

    // Revision (edit or unrecognized input treated as revision)
    const revised = await gmailService.reviseEmailWithAI(ctx.draft, message.text);
    if (!revised.success) return revised.error;
    const signerName = await this.getUserNameForSignature(message.from);
    revised.body = this.addDefaultSignature(revised.body, signerName);
    revised.htmlBody = gmailService.bodyToHtml(revised.body);

    ctx.draft = { ...ctx.draft, subject: revised.subject, body: revised.body, htmlBody: revised.htmlBody };
    ctx.timestamp = Date.now();
    this.scheduledEmailContext.set(message.from, ctx);

    const sendAtStr = ctx.sendAt.toLocaleString('en-IN', {
      weekday: 'short', day: 'numeric', month: 'short',
      hour: 'numeric', minute: '2-digit', hour12: true
    });
    const preview = gmailService.previewBody(revised.body);
    return `*Revised Scheduled Email*\n\n*To:* ${revised.to}\n*Subject:* ${revised.subject}\n*Sends at:* ${sendAtStr}\n\n${preview}\n\n_Schedule? Reply *yes* | Edit more | *no* to cancel_`;
  }

  // ========== BULK EMAIL ==========
  async handleEmailBulk(message, context, intentParams = {}) {
    if (!await googleAuthService.isConnected(message.from)) {
      return 'Google not connected. Say "connect google" to link your Gmail first.';
    }

    if (isAgentToolMessage(message)) {
      const resolved = await this._resolveTypedEmailRecipients(message.from, intentParams.recipients);
      if (!resolved.success) return resolved.result;
      if (resolved.recipients.length < 2) {
        return this._typedWaitingInput('Bulk email needs at least two distinct recipients.');
      }
      const agentAttachments = await this._resolveAgentEmailAttachments(message, intentParams);
      if (agentAttachments.error) return agentAttachments.error;
      const subject = intentParams.subject === undefined ? '' : String(intentParams.subject);
      const template = String(intentParams.body || '');
      const personalize = intentParams.personalize === true;
      const drafts = resolved.entries.map((entry) => {
        let body = template;
        if (personalize) {
          const sourceName = entry.name || entry.email.split('@')[0].split(/[._+\-]/)[0] || 'there';
          const firstName = sourceName
            ? sourceName.charAt(0).toUpperCase() + sourceName.slice(1).toLowerCase()
            : 'there';
          body = body.replace(
            /\[\s*first[\s_-]?name\s*\]|\{\s*first[\s_-]?name\s*\}/gi,
            firstName,
          );
        }
        return {
          success: true,
          to: entry.email,
          subject,
          body,
          htmlBody: gmailService.bodyToHtml(body),
        };
      });

      const fallbackTimezone = context?.userTimezone || await timezoneService.getUserTimezone(message.from);
      let schedule = null;
      if (intentParams.send_at) {
        schedule = this._typedEmailSchedule(intentParams, fallbackTimezone);
        if (!schedule.success) return this._typedWaitingInput(schedule.error);
      }
      const bulkCtx = {
        drafts,
        previousDrafts: this.cloneDrafts(drafts),
        allRecipients: resolved.recipients,
        mode: personalize ? 'personalized' : 'shared',
        attachments: agentAttachments.attachments,
        sendAt: schedule?.sendAt || null,
        timezone: schedule?.timezone || null,
        isRecurring: false,
        recurrencePattern: null,
        recurrenceDays: null,
        recurrenceTime: null,
        recurrenceLabel: null,
        timestamp: Date.now(),
      };
      this.bulkEmailContext.set(message.from, bulkCtx);
      this.storeRecentEmailContext(message.from, {
        type: 'bulk',
        drafts,
        referenceDraft: drafts[0],
        mode: bulkCtx.mode,
        attachments: bulkCtx.attachments,
        sendAt: bulkCtx.sendAt,
        timezone: bulkCtx.timezone,
      });
      return this.buildBulkEmailPreview(bulkCtx);
    }

    const text = message.text;
    const parsedEmails = this.parseBulkEmailAddresses(text);
    const emailAddresses = parsedEmails.valid;

    if (emailAddresses.length < 2) {
      if (parsedEmails.invalid.length > 0) {
        return `I found invalid email format: ${parsedEmails.invalid.join(', ')}\n\nI need at least 2 valid email addresses for bulk send.`;
      }
      return 'I need at least 2 email addresses for bulk send. Try: _"send email to a@x.com, b@x.com, c@x.com about project update"_';
    }

    const agentAttachments = await this._resolveAgentEmailAttachments(message, intentParams);
    if (agentAttachments.error) return agentAttachments.error;
    const docCtx = this.documentContext.get(message.from);
    const hasDoc = !agentAttachments.isAgentTool
      && docCtx && (Date.now() - docCtx.timestamp) < this.workflowContextTtls.document;

    const mode = this.getBulkEmailMode(text);
    const signerName = await this.getUserNameForSignature(message.from);
    let drafts = [];

    // User-template short-circuit: if the message contains a complete email
    // body with a [First Name] (or similar) placeholder, skip the AI drafter
    // entirely and substitute names locally. Avoids the AI clarification
    // trap and respects the user's exact wording.
    const userTemplate = this.extractUserSuppliedTemplate(text);
    if (userTemplate) {
      const recipientsWithContext = this.parseRecipientContexts(text, emailAddresses);
      drafts = recipientsWithContext.map(({ email, context }) => {
        const firstName = this.extractFirstName(context, email);
        const personalized = userTemplate.body.replace(
          /\[\s*first[\s_-]?name\s*\]|\{\s*first[\s_-]?name\s*\}/gi,
          firstName || 'there'
        );
        const body = this.addDefaultSignature(personalized, signerName);
        return {
          success: true,
          to: email,
          subject: userTemplate.subject,
          body,
          htmlBody: gmailService.bodyToHtml(body)
        };
      });
    } else if (mode === 'shared') {
      const shared = await gmailService.draftSharedBulkEmail(
        emailAddresses,
        text,
        hasDoc ? documentTextFromContext(docCtx) : null
      );
      if (!shared.success) {
        this.savePendingBulkClarification(message.from, text, emailAddresses, mode, {
          agentToolCallId: isAgentToolMessage(message)
            ? (message.agentToolCallId || message.agentRunId)
            : null,
          attachmentIds: agentAttachments.isAgentTool
            ? (intentParams.attachment_ids || [])
            : null,
        });
        return shared.error;
      }
      drafts = emailAddresses.map(to => ({
        success: true,
        to,
        subject: shared.subject,
        body: this.addDefaultSignature(shared.body, signerName),
        htmlBody: gmailService.bodyToHtml(this.addDefaultSignature(shared.body, signerName))
      }));
    } else {
      const recipientsWithContext = this.parseRecipientContexts(text, emailAddresses);
      const result = await gmailService.draftPersonalizedBulkEmails(
        recipientsWithContext,
        text,
        hasDoc ? documentTextFromContext(docCtx) : null
      );
      if (!result.success) {
        this.savePendingBulkClarification(message.from, text, emailAddresses, mode, {
          agentToolCallId: isAgentToolMessage(message)
            ? (message.agentToolCallId || message.agentRunId)
            : null,
          attachmentIds: agentAttachments.isAgentTool
            ? (intentParams.attachment_ids || [])
            : null,
        });
        return result.error;
      }
      drafts = result.drafts;
      drafts = drafts.map(d => {
        const body = this.addDefaultSignature(d.body, signerName);
        return { ...d, body, htmlBody: gmailService.bodyToHtml(body) };
      });
    }

    // Prepare attachments
    let attachments = agentAttachments.isAgentTool ? agentAttachments.attachments : null;
    if (!agentAttachments.isAgentTool && hasDoc) {
      // Gmail rejects attachments >25 MB. Catch this before previewing the
      // bulk draft so the user doesn't confirm a send that's destined to
      // fail mid-loop.
      const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
      const documentAttachments = documentAttachmentsFromContext(docCtx);
      const size = documentAttachments.reduce((total, item) => total + item.buffer.length, 0);
      if (size > MAX_ATTACHMENT_BYTES) {
        const mb = (size / (1024 * 1024)).toFixed(1);
        return `The selected attachments total ${mb} MB — Gmail's limit is 25 MB. Try fewer or smaller files, or share them via Drive.`;
      }
      attachments = documentAttachments;
    }

    const userTimezone = await timezoneService.getUserTimezone(message.from);
    // For bulk email, only schedule if user explicitly says "schedule"/"send later"/"delay" —
    // NOT for date words in email body like "by Friday" or "next week"
    const wantsSchedule = /\b(schedule|scheduled|send\s+later|delay)\b/i.test(text);
    const schedule = wantsSchedule ? this.parseEmailScheduleDetails(text, userTimezone) : { success: false };
    if (wantsSchedule && !schedule.success) {
      this.storeRecentEmailContext(message.from, {
        type: 'bulk',
        drafts,
        referenceDraft: drafts[0],
        mode,
        attachments
      });
      return `${schedule.error}\n\nI kept the drafted bulk email. Reply with a new time like "schedule it for today 5:25pm".`;
    }
    const isScheduled = wantsSchedule && schedule.success;

    // Store for confirmation
    this.bulkEmailContext.set(message.from, {
      drafts,
      previousDrafts: this.cloneDrafts(drafts),
      allRecipients: emailAddresses,
      mode,
      attachments,
      sendAt: isScheduled ? schedule.sendAt : null,
      timezone: isScheduled ? schedule.timezone : null,
      isRecurring: isScheduled ? schedule.isRecurring : false,
      recurrencePattern: isScheduled ? schedule.recurrencePattern : null,
      recurrenceDays: isScheduled ? schedule.recurrenceDays : null,
      recurrenceTime: isScheduled ? schedule.recurrenceTime : null,
      recurrenceLabel: isScheduled ? schedule.recurrenceLabel : null,
      timestamp: Date.now()
    });
    this.storeRecentEmailContext(message.from, {
      type: 'bulk',
      drafts,
      referenceDraft: drafts[0],
      mode,
      attachments,
      sendAt: isScheduled ? schedule.sendAt : null,
      timezone: isScheduled ? schedule.timezone : null,
      isRecurring: isScheduled ? schedule.isRecurring : false,
      recurrencePattern: isScheduled ? schedule.recurrencePattern : null,
      recurrenceDays: isScheduled ? schedule.recurrenceDays : null,
      recurrenceTime: isScheduled ? schedule.recurrenceTime : null,
      recurrenceLabel: isScheduled ? schedule.recurrenceLabel : null
    });

    return this.buildBulkEmailPreview({
      drafts,
      mode,
      attachments,
      sendAt: isScheduled ? schedule.sendAt : null,
      timezone: isScheduled ? schedule.timezone : null,
      isRecurring: isScheduled ? schedule.isRecurring : false,
      recurrencePattern: isScheduled ? schedule.recurrencePattern : null,
      recurrenceDays: isScheduled ? schedule.recurrenceDays : null,
      recurrenceTime: isScheduled ? schedule.recurrenceTime : null,
      recurrenceLabel: isScheduled ? schedule.recurrenceLabel : null
    }, {
      dedupeCount: parsedEmails.duplicateCount,
      invalidEmails: parsedEmails.invalid
    });
  }

  // Parse per-recipient context from messages like:
  // "dk@x.com (he is CEO of Company hiring for Manager)"
  // "dk@x.com he is CEO of Company hiring for Manager"
  parseRecipientContexts(text, emails) {
    // The recipient's name is most often on the same LINE as the email — and
    // in user-supplied lists it usually appears BEFORE the email
    // (`Name<TAB>email@x.com`), not after. The previous version only looked
    // at the slice between an email and the *next* email, so it always
    // captured the next person's name as the current person's context.
    //
    // New behavior: take the line containing the email, strip markdown email
    // links, remove every recipient email from the line, and treat what's
    // left as the recipient's context. Falls back to a between-emails segment
    // only when several emails sit on the same line (inline list form).
    const lines = text.split(/\r?\n/);

    const stripMarkdownLinks = s => s
      .replace(/\[([^\]]+)\]\(mailto:[^)]*\)/gi, '$1')   // [Name](mailto:x) → Name
      .replace(/\]\(mailto:[^)]*\)/gi, '')               // dangling ](mailto:x)
      .replace(/\(mailto:[^)]*\)/gi, '');                // (mailto:x)

    const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const cleanContext = (raw) => {
      let s = stripMarkdownLinks(raw);
      for (const e of emails) {
        s = s.replace(new RegExp(escapeRe(e), 'gi'), ' ');
      }
      s = s.replace(/[<>\[\]]/g, ' ');
      s = s.replace(/\s+/g, ' ').trim();
      s = s.replace(/^[\s,;:.()\-]+/, '').replace(/[\s,;:.()\-]+$/, '').trim();
      return s;
    };

    const results = [];
    for (const email of emails) {
      const line = lines.find(l => l.toLowerCase().includes(email));
      if (!line) { results.push({ email, context: '' }); continue; }

      const emailsOnLine = emails.filter(e => line.toLowerCase().includes(e));
      if (emailsOnLine.length === 1) {
        results.push({ email, context: cleanContext(line) });
        continue;
      }

      // Inline form (multiple emails on one line): use the segment between
      // the previous email on the line and the next one.
      const lower = line.toLowerCase();
      const myIdx = lower.indexOf(email);
      let prevEnd = 0;
      let nextStart = line.length;
      for (const e of emailsOnLine) {
        if (e === email) continue;
        const before = lower.lastIndexOf(e, myIdx - 1);
        if (before > -1) prevEnd = Math.max(prevEnd, before + e.length);
        const after = lower.indexOf(e, myIdx + email.length);
        if (after > -1 && after < nextStart) nextStart = after;
      }
      results.push({ email, context: cleanContext(line.substring(prevEnd, nextStart)) });
    }
    return results;
  }

  // If the user pasted a complete email body (greeting + body + signoff) with
  // a [First Name] placeholder, return { subject, body }. Otherwise null.
  // Subject is derived as the first non-greeting prose line so we never need
  // an AI call (which is what gets us trapped in clarification loops).
  extractUserSuppliedTemplate(text) {
    if (!text) return null;
    if (!/\[\s*first[\s_-]?name\s*\]|\{\s*first[\s_-]?name\s*\}/i.test(text)) return null;

    const lines = text.split(/\r?\n/);

    // Find the greeting line containing the placeholder ("Hi [First Name],")
    const greetIdx = lines.findIndex(l =>
      /\[\s*first[\s_-]?name\s*\]|\{\s*first[\s_-]?name\s*\}/i.test(l)
        && /^\s*(hi|hello|hey|dear|namaste|greetings)\b/i.test(l)
    );
    if (greetIdx === -1) return null;

    // Body ends where the recipient list starts. Find the recipient block
    // by walking BACKWARD from the end of the message: a recipient line is
    // one that contains an email address and very little else (i.e., a name
    // and an address, not prose). Trailing blank lines are skipped. We then
    // keep walking up through blank lines and recipient-shaped lines to find
    // where the block begins. Body ends at that point.
    //
    // Walking backward (rather than forward) handles the common cases that
    // the previous logic missed:
    //   - "Name<TAB>email" with a single tab (the row that leaked into the
    //     body and got mailed to all 11 recipients on 2026-04-30 21:53)
    //   - "Name  email" with 2+ spaces
    //   - markdown form "Name<TAB>[email](mailto:email)"
    const isRecipientLine = (line) => {
      if (!line) return false;
      const emailMatch = line.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i);
      if (!emailMatch) return false;
      // Strip markdown wrapper, the email itself, mailto bits — what remains
      // should be short (a name) and not look like prose.
      let stripped = line
        .replace(/\[([^\]]+)\]\(mailto:[^)]*\)/gi, '$1')
        .replace(/\(mailto:[^)]*\)/gi, '')
        .replace(/\]/g, '').replace(/\[/g, '');
      stripped = stripped.replace(new RegExp(emailMatch[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
      stripped = stripped.replace(/[<>,;:]+/g, ' ').replace(/\s+/g, ' ').trim();
      // 0–60 chars of leftover content = name (or empty). Anything longer is
      // likely prose with an email in it (e.g. signature link, body sentence).
      return stripped.length <= 60;
    };

    let endIdx = lines.length;
    let i = lines.length - 1;
    while (i > greetIdx && !lines[i].trim()) i--;        // skip trailing blanks
    while (i > greetIdx && (isRecipientLine(lines[i]) || !lines[i].trim())) {
      if (isRecipientLine(lines[i])) endIdx = i;
      i--;
    }

    const body = lines.slice(greetIdx, endIdx).join('\n').trim();
    if (body.length < 30) return null;

    // Pick subject. Preference order:
    //   1. An explicit "Subject: ..." line if the user wrote one
    //   2. An ALL-CAPS noun phrase from the body (e.g. "JUDGING OPPORTUNITIES")
    //   3. The first non-pleasantry prose sentence, trimmed to a clean phrase
    let subject = '';
    const explicitSubject = text.match(/^\s*subject\s*:\s*(.+)$/im);
    if (explicitSubject) {
      subject = explicitSubject[1].trim().slice(0, 80);
    }
    if (!subject) {
      const capsMatch = body.match(/\b([A-Z][A-Z]{2,}(?:[\s\-/&][A-Z][A-Z]{2,}){0,5})\b/);
      if (capsMatch) {
        subject = capsMatch[1].toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
      }
    }
    if (!subject) {
      for (let i = greetIdx + 1; i < endIdx; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        if (/^(hope you|hope this|trust this|hi |hello |hey |dear )/i.test(line)) continue;
        const sentence = line.split(/[.!?]/)[0].trim();
        if (sentence.length >= 8) { subject = sentence.slice(0, 80); break; }
      }
    }
    if (!subject) subject = 'Following up';

    return { subject, body };
  }

  // Pull the recipient's first name out of the per-recipient context string
  // produced by parseRecipientContexts. Falls back to the email localpart.
  extractFirstName(context, email) {
    const ctx = (context || '').trim();
    if (ctx) {
      const firstWord = ctx.split(/[\s,]+/).find(Boolean);
      if (firstWord && /^[\p{L}][\p{L}\-']{1,}$/u.test(firstWord)) {
        return firstWord.charAt(0).toUpperCase() + firstWord.slice(1);
      }
    }
    const local = String(email || '').split('@')[0] || '';
    const guess = local.split(/[._\-+]/)[0];
    if (guess && /^[a-z]+$/i.test(guess) && guess.length >= 2) {
      return guess.charAt(0).toUpperCase() + guess.slice(1).toLowerCase();
    }
    return '';
  }

  // Defense-in-depth: when the AI drafter returns a clarifying question
  // instead of drafts, save enough state that the user's follow-up reply
  // can re-run the bulk-email flow with the answer appended.
  savePendingBulkClarification(userPhone, originalText, recipients, mode, delivery = {}) {
    this.bulkEmailContext.set(userPhone, {
      pendingClarification: true,
      originalText,
      allRecipients: recipients,
      mode,
      agentToolCallId: delivery.agentToolCallId || null,
      attachmentIds: Array.isArray(delivery.attachmentIds) ? [...delivery.attachmentIds] : null,
      drafts: [],
      timestamp: Date.now()
    });
  }

  // Parse which email numbers the user wants to update
  // Handles: "update 2 and 4", "change #1 #3", "revise email 2, 5", "fix 1st and 3rd",
  // "update 2nd email", "change the 3rd one", "edit 1 3 5", "redo number 2"
  parseTargetedEmailNumbers(text, totalDrafts) {
    const lower = text.toLowerCase();
    const indices = new Set();

    // First pass: extract all number references (ordinal + #N + bare digits)
    const allNumbers = [];

    // #1, #3
    let m;
    const p1 = /#(\d+)/g;
    while ((m = p1.exec(lower)) !== null) allNumbers.push(parseInt(m[1]));

    // 1st, 2nd, 3rd, 4th
    const p2 = /(\d+)(?:st|nd|rd|th)/g;
    while ((m = p2.exec(lower)) !== null) allNumbers.push(parseInt(m[1]));

    // "email 2", "number 3"
    const p3 = /(?:email|mail|number|no\.?|num)\s*(\d+)/g;
    while ((m = p3.exec(lower)) !== null) allNumbers.push(parseInt(m[1]));

    // If we found explicit references (#N, ordinals, "email N"), use them
    if (allNumbers.length > 0) {
      for (const num of allNumbers) {
        if (num >= 1 && num <= totalDrafts) indices.add(num - 1);
      }
      return [...indices].sort((a, b) => a - b);
    }

    // Second pass: if an action word is present, grab ALL bare digits in the message
    const hasActionWord = /\b(update|change|edit|fix|revise|redo|modify|rewrite)\b/.test(lower);
    if (hasActionWord) {
      const digitMatches = lower.match(/\b(\d+)\b/g);
      if (digitMatches) {
        for (const d of digitMatches) {
          const num = parseInt(d);
          if (num >= 1 && num <= totalDrafts) {
            indices.add(num - 1);
          }
        }
      }
    }

    return [...indices].sort((a, b) => a - b);
  }

  normalizeBulkRevisionInstruction(text) {
    const original = String(text || '').trim();
    if (!original) {
      return 'Rewrite this email to be clearer, more polished, and professional while keeping the same intent.';
    }

    let normalized = original
      .replace(/#\d+\b/gi, ' ')
      .replace(/\b\d+(?:st|nd|rd|th)\b\s*(?:email|mail|number|one)?/gi, ' ')
      .replace(/\b(?:email|mail|number|no\.?|num)\s*\d+\b/gi, ' ')
      .replace(/\b(?:the|this|that)\s+(?:email|mail|number|one)\b/gi, ' ')
      .replace(/\bthe\b(?=\s+(?:properly|better)\b)/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (/^(rewrite|revise|edit|update|change|fix|redo|modify)\s*(the\s+)?(properly|better)?$/i.test(normalized)
      || /^(properly|better)$/i.test(normalized)) {
      return 'Rewrite this email to be clearer, more polished, and professional while keeping the same intent.';
    }

    return normalized || 'Rewrite this email to be clearer, more polished, and professional while keeping the same intent.';
  }

  cloneDrafts(drafts = []) {
    return (Array.isArray(drafts) ? drafts : []).map(draft => ({
      to: draft.to,
      subject: draft.subject,
      body: draft.body,
      htmlBody: draft.htmlBody
    }));
  }

  getNewBulkRecipients(text, existingRecipients = []) {
    const existing = new Set((existingRecipients || []).map(email => String(email || '').toLowerCase()));
    return this.parseBulkEmailAddresses(text).valid.filter(email => !existing.has(email));
  }

  isBulkAddRecipientRequest(text, ctx = null) {
    const lower = String(text || '').toLowerCase();
    const newRecipients = this.getNewBulkRecipients(text, ctx?.allRecipients || []);
    if (newRecipients.length === 0) return false;

    return /^\s*(also|and)\b/.test(lower)
      || /\b(add|include|plus|another|one more|new)\b/.test(lower)
      || /\b(write|draft|send|mail|email)\b/.test(lower);
  }

  isBulkRestoreSubjectsRequest(text) {
    const lower = String(text || '').toLowerCase();
    return /\bsubject\b/.test(lower)
      && (/\b(keep|restore|revert|undo|use)\b/.test(lower) || /didn['’]?t\s+mean\s+to\s+change/.test(lower))
      && /\b(previous|earlier|before|old|same as before|as it was)\b/.test(lower);
  }

  isBulkRestorePreviousDraftsRequest(text) {
    const lower = String(text || '').toLowerCase();
    return !/\bsubject\b/.test(lower)
      && (/\b(restore|revert|undo)\b/.test(lower) || /\b(previous|earlier|before)\s+(one|email|draft|version)\b/.test(lower));
  }

  isBulkEditInstruction(text) {
    const lower = String(text || '').toLowerCase();
    return /\b(rewrite|revise|edit|update|change|fix|redo|modify|make|remove|delete|shorten|expand|improve|polish|clarify|professional|casual|formal|friendly|warmer|colder|subject|body|intro|opening|closing|tone|signature|typo|grammar|line)\b/.test(lower);
  }

  restoreBulkDraftsFromSnapshot(ctx, options = {}) {
    const snapshot = Array.isArray(ctx.previousDrafts) && ctx.previousDrafts.length > 0
      ? this.cloneDrafts(ctx.previousDrafts)
      : null;
    if (!snapshot) return [];

    const currentSnapshot = this.cloneDrafts(ctx.drafts);
    const subjectsOnly = Boolean(options.subjectsOnly);

    if (!subjectsOnly) {
      ctx.previousDrafts = currentSnapshot;
      ctx.drafts = snapshot;
      ctx.allRecipients = snapshot.map(draft => draft.to);
      return snapshot.map((_, index) => index);
    }

    const previousByRecipient = new Map(snapshot.map(draft => [String(draft.to || '').toLowerCase(), draft]));
    const updatedIndices = [];
    ctx.previousDrafts = currentSnapshot;
    ctx.drafts = ctx.drafts.map((draft, index) => {
      const previous = previousByRecipient.get(String(draft.to || '').toLowerCase());
      if (!previous || previous.subject === draft.subject) return draft;
      updatedIndices.push(index);
      return { ...draft, subject: previous.subject || draft.subject };
    });
    return updatedIndices;
  }

  async addRecipientsToBulkDraft(ctx, messageText, userPhone) {
    const newRecipients = this.getNewBulkRecipients(messageText, ctx.allRecipients || []);
    if (newRecipients.length === 0) {
      return { success: false, error: 'Tell me the email address you want to add.' };
    }

    const recipientContexts = this.parseRecipientContexts(messageText, newRecipients);
    const hasMeaningfulContext = recipientContexts.some(item => {
      const cleaned = String(item.context || '')
        .toLowerCase()
        .replace(/\b(also|and|add|include|plus|another|one more|new|mail|email|write|draft|send)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return cleaned.length >= 8;
    });

    if (ctx.mode !== 'shared' && !hasMeaningfulContext) {
      return {
        success: false,
        error:`I can add ${newRecipients.join(', ')}, but I need a little more context about who they are or what this email should say.\n\nExample: "add ${newRecipients[0]} - applying for Growth Associate at Acme Corp"`
      };
    }

    const snapshot = this.cloneDrafts(ctx.drafts);
    let newDrafts = [];

    if (ctx.mode === 'shared') {
      const baseDraft = ctx.drafts[0];
      if (!baseDraft) {
        return { success: false, error: 'I could not find the current bulk draft to copy from.' };
      }
      newDrafts = newRecipients
        .map(recipient => this.cloneDraftForRecipient(baseDraft, recipient))
        .filter(Boolean);
    } else {
      const docCtx = this.documentContext.get(userPhone);
      const hasDoc = docCtx && (Date.now() - docCtx.timestamp) < this.workflowContextTtls.document;
      const signerName = await this.getUserNameForSignature(userPhone);
      const result = await gmailService.draftPersonalizedBulkEmails(
        recipientContexts,
        messageText,
        hasDoc ? documentTextFromContext(docCtx) : null
      );
      if (!result.success) {
        return { success: false, error: result.error };
      }
      newDrafts = result.drafts.map(draft => {
        const body = this.addDefaultSignature(draft.body, signerName);
        return { ...draft, body, htmlBody: gmailService.bodyToHtml(body) };
      });
    }

    ctx.previousDrafts = snapshot;
    const startIndex = ctx.drafts.length;
    ctx.drafts = [...ctx.drafts, ...newDrafts];
    ctx.allRecipients = [...(ctx.allRecipients || ctx.drafts.map(draft => draft.to)), ...newRecipients];

    return {
      success: true,
      updatedIndices: newDrafts.map((_, index) => startIndex + index)
    };
  }

  async handleBulkEmailConfirm(message) {
    const ctx = this.bulkEmailContext.get(message.from);
    if (!ctx) return null;

    // Recovery from a clarification trap: the prior turn left us waiting on
    // the user's answer to an AI drafter question. Re-run the bulk handler
    // with the original text + their answer so the AI has what it needs.
    if (ctx.pendingClarification) {
      const reply = (message.text || '').trim();
      if (/^(no|nope|cancel|stop|abort|skip)\b/i.test(reply)) {
        this.bulkEmailContext.delete(message.from);
        return 'OK, cancelled the bulk email.';
      }
      this.bulkEmailContext.delete(message.from);
      const synthesized = {
        ...message,
        text: `${ctx.originalText}\n\n${reply}`,
        ...(ctx.agentToolCallId ? { agentToolCallId: ctx.agentToolCallId } : {}),
      };
      return await this.handleEmailBulk(synthesized, {}, {
        ...(Array.isArray(ctx.attachmentIds) ? { attachment_ids: ctx.attachmentIds } : {}),
      });
    }

    const text = message.text.toLowerCase().trim();
    const classification = classifySensitiveConfirmation(text);
    const defaultFooter = '\n\n_Send all? Reply *yes* | Edit? Tell me what to change | *no* to cancel_';
    const revisedFooter = '\n\n_Send all? Reply *yes* | Edit more | *no* to cancel_';

    if (classification.decision === 'confirm') {
      this.bulkEmailContext.delete(message.from);

      // If scheduled, schedule each personalized email separately
      if (ctx.sendAt) {
        let scheduled = 0;
        const scheduledIds = [];
        const scheduledDrafts = [];
        const scheduleFailures = [];
        for (const draft of ctx.drafts) {
          const htmlBody = gmailService.bodyToHtml(draft.body);
          const result = await scheduledEmailJob.scheduleEmail(message.from, {
            recipients: [draft.to],
            subject: draft.subject,
            body: draft.body,
            htmlBody,
            sendAt: ctx.sendAt,
            isRecurring: ctx.isRecurring,
            recurrencePattern: ctx.recurrencePattern,
            recurrenceDays: ctx.recurrenceDays,
            recurrenceTime: ctx.recurrenceTime,
            timezone: ctx.timezone,
            attachments: ctx.attachments || null
          });
          if (result.success) {
            scheduled++;
            scheduledIds.push(result.scheduled.id);
            scheduledDrafts.push(draft);
          } else {
            scheduleFailures.push(`${draft.to}${result.error ?` (${result.error})` : ''}`);
          }
        }
        const sendAtStr = ctx.sendAt.toLocaleString('en-IN', {
          weekday: 'short', day: 'numeric', month: 'short',
          hour: 'numeric', minute: '2-digit', hour12: true
        });
        const recurrenceLine = ctx.isRecurring ?`\n*Repeats:* ${ctx.recurrencePattern}${ctx.recurrenceDays ?` (${ctx.recurrenceDays})` : ''}` : '';

        if (scheduledDrafts.length > 0) {
          this.storeRecentEmailContext(message.from, {
            type: 'bulk',
            drafts: scheduledDrafts,
            referenceDraft: scheduledDrafts[0],
            mode: ctx.mode,
            attachments: ctx.attachments || null,
            sendAt: ctx.sendAt,
            timezone: ctx.timezone,
            isRecurring: ctx.isRecurring,
            recurrencePattern: ctx.recurrencePattern,
            recurrenceDays: ctx.recurrenceDays,
            recurrenceTime: ctx.recurrenceTime,
            recurrenceLabel: ctx.recurrenceLabel,
            scheduledIds
          });
        }

        if (scheduleFailures.length === 0) {
          return `${scheduled} bulk emails scheduled!\n\n*Sends at:* ${sendAtStr}\n*Timezone:* ${ctx.timezone || 'local'}${recurrenceLine}\n*Recipients:* ${ctx.allRecipients.join(', ')}\n\n_"scheduled emails" to view | "cancel scheduled email #ID" to cancel_`;
        }
        if (scheduled === 0) {
          return `Scheduling failed for all recipients.\n\n${scheduleFailures.join('\n')}`;
        }
        return `${scheduled}/${ctx.allRecipients.length} emails scheduled.\n*Sends at:* ${sendAtStr}\n*Timezone:* ${ctx.timezone || 'local'}${recurrenceLine}\nFailed: ${scheduleFailures.join(', ')}`;
      }

      // ─── Pre-send leak guard ──────────────────────────────────────────
      // Before any network call, verify no draft body contains another
      // recipient's email address. Catches the 2026-04-30 leak where the
      // recipient list bled into the body — fails loudly here instead of
      // mailing private contact info to ten people.
      const allEmailsLower = ctx.drafts.map(d => String(d.to || '').toLowerCase());
      const leaks = [];
      for (const draft of ctx.drafts) {
        const bodyLower = String(draft.body || '').toLowerCase();
        const myEmail = String(draft.to || '').toLowerCase();
        const offenders = allEmailsLower.filter(e => e && e !== myEmail && bodyLower.includes(e));
        if (offenders.length) leaks.push({ to: draft.to, leaked: offenders });
      }
      if (leaks.length) {
        this.bulkEmailContext.delete(message.from);
        const sample = leaks.slice(0, 3).map(l => `→ ${l.to} would have leaked: ${l.leaked.join(', ')}`).join('\n');
        logger.error(`[BulkSend] Leak guard tripped — aborted ${ctx.drafts.length} sends. ${leaks.length} drafts contained other recipients' emails.`);
        return `Aborted — ${leaks.length} draft(s) contain other recipients' emails. Nothing was sent.\n\n${sample}\n\nFix the body and try again.`;
      }

      // ─── Resumable send loop ──────────────────────────────────────────
      // On the first failure: pause the loop, save progress, and ask the
      // user whether to continue. Avoids silently mailing the back half
      // when something's clearly wrong (quota hit, attachment rejected,
      // network blip). User replies "yes" → we resume from where we left
      // off; "no" → we stop with the partial result they already have.
      const alreadySent = Array.isArray(ctx.partialSent) ? ctx.partialSent.slice() : [];
      const startIndex = alreadySent.length;
      const draftsToSend = ctx.drafts.slice(startIndex);
      let successCount = startIndex;
      let firstFailure = null;

      // A chat-sent bulk email used to leave no trace: no campaign row and no
      // per-recipient rows, so it never appeared under Contacts → Campaigns
      // and had no delivery record, while the identical dashboard send did.
      // Record the same rows here. Best-effort throughout — bookkeeping must
      // never block or fail an actual send.
      const emailTrackingService = require('../services/email-tracking.service');
      const campaignService = require('../services/campaign.service');
      let chatCampaignId = ctx.campaignId || null;
      if (!chatCampaignId && ctx.drafts.length > 1) {
        try {
          const created = await campaignService.createDraft(message.from, {
            groupId: null,
            subject: ctx.drafts[0]?.subject || 'Bulk email',
            bodyTemplate: ctx.drafts[0]?.body || '',
            recipientCount: ctx.drafts.length,
          });
          chatCampaignId = created?.id || null;
          if (chatCampaignId) {
            ctx.campaignId = chatCampaignId; // survives a resumed send
            await campaignService.updateCampaignFields(message.from, chatCampaignId, { status: 'sending' });
          }
        } catch (error) {
          logger.warn(`[BulkSend] could not record campaign row: ${error.message}`);
        }
      }

      for (let i = 0; i < draftsToSend.length; i++) {
        const draft = draftsToSend[i];
        // Light rate-limit so spam filters don't see a bursty firehose.
        if (i > 0) await new Promise(r => setTimeout(r, 100));
        try {
          const htmlBody = gmailService.bodyToHtml(draft.body);
          const result = await gmailService.sendEmail(message.from, {
            to: draft.to,
            subject: draft.subject,
            htmlBody,
            attachments: ctx.attachments || null
          });
          if (result.success) {
            successCount++;
            alreadySent.push(draft.to);
            emailTrackingService.recordSend({
              userPhone: message.from,
              campaignId: chatCampaignId,
              recipientEmail: draft.to,
              subject: draft.subject,
              gmailMessageId: result.messageId || result.id || null,
              token: emailTrackingService.generateToken(),
              status: 'sent',
            }).catch(() => {});
          } else {
            firstFailure = { to: draft.to, error: result.error || 'send returned success=false' };
            break;
          }
        } catch (err) {
          firstFailure = { to: draft.to, error: err.message || String(err) };
          break;
        }
      }

      if (firstFailure) {
        // Park progress, ask user. Reusing the existing confirm dispatcher:
        // their next "yes" hits handleBulkEmailConfirm, which resumes from
        // ctx.partialSent below.
        ctx.partialSent = alreadySent;
        ctx.partialFailure = firstFailure;
        ctx.timestamp = Date.now();
        this.bulkEmailContext.set(message.from, ctx);
        const remaining = ctx.drafts.length - alreadySent.length;
        if (chatCampaignId) {
          // The campaign stays 'sending' — the user may still resume it — but
          // the counts must reflect what actually went out.
          campaignService.updateCampaignFields(message.from, chatCampaignId, {}).catch(() => {});
          this._recordCampaignProgress(chatCampaignId, successCount, 1, 'paused').catch(() => {});
        }
        logger.warn(`[BulkSend] Paused after failure on ${firstFailure.to}: ${firstFailure.error}. Sent=${alreadySent.length}, remaining=${remaining}.`);
        return `Sent to ${alreadySent.length}/${ctx.drafts.length}, then hit a problem on ${firstFailure.to}:\n\n${firstFailure.error}\n\n_Continue with the remaining ${remaining}? Reply *yes* to retry from ${firstFailure.to} | *no* to stop here_`;
      }

      this.bulkEmailContext.delete(message.from);
      if (chatCampaignId) {
        this._recordCampaignProgress(chatCampaignId, successCount, 0, 'completed').catch(() => {});
      }
      return `Sent to all ${successCount} recipients!`;
    }

    if (classification.decision === 'cancel') {
      this.bulkEmailContext.delete(message.from);
      return 'Bulk email cancelled.';
    }

    const currentTimezone = ctx.timezone || await timezoneService.getUserTimezone(message.from);

    if (ctx.sendAt && this.isScheduleStatusRequest(message.text)) {
      ctx.timestamp = Date.now();
      this.bulkEmailContext.set(message.from, ctx);
      return this.buildBulkEmailPreview(ctx, { footer: defaultFooter });
    }

    if (ctx.sendAt && this.isScheduleAdjustmentRequest(message.text)) {
      const nextSchedule = this.parseEmailScheduleDetails(message.text, currentTimezone);
      if (!nextSchedule.success) {
        const currentSendAtStr = ctx.sendAt.toLocaleString('en-IN', {
          weekday: 'short', day: 'numeric', month: 'short',
          hour: 'numeric', minute: '2-digit', hour12: true
        });
        return `${nextSchedule.error}\n\n*Current schedule:* ${currentSendAtStr}\n*Timezone:* ${ctx.timezone || currentTimezone}\n\nReply with something like "change the time to 2:37 pm today".`;
      }

      ctx.sendAt = nextSchedule.sendAt;
      ctx.timezone = nextSchedule.timezone;
      ctx.isRecurring = Boolean(nextSchedule.isRecurring);
      ctx.recurrencePattern = nextSchedule.recurrencePattern || null;
      ctx.recurrenceDays = nextSchedule.recurrenceDays || null;
      ctx.recurrenceTime = nextSchedule.recurrenceTime || null;
      ctx.recurrenceLabel = nextSchedule.recurrenceLabel || null;
      ctx.timestamp = Date.now();
      this.bulkEmailContext.set(message.from, ctx);
      this.storeRecentEmailContext(message.from, {
        type: 'bulk',
        drafts: ctx.drafts,
        referenceDraft: ctx.drafts[0],
        mode: ctx.mode,
        attachments: ctx.attachments || null,
        sendAt: ctx.sendAt,
        timezone: ctx.timezone,
        isRecurring: ctx.isRecurring,
        recurrencePattern: ctx.recurrencePattern,
        recurrenceDays: ctx.recurrenceDays,
        recurrenceTime: ctx.recurrenceTime,
        recurrenceLabel: ctx.recurrenceLabel
      });
      return this.buildBulkEmailPreview(ctx, { footer: defaultFooter });
    }

    const updatedIndices = new Set();
    let appliedStructuredChange = false;
    let appliedRevision = false;

    if (this.isBulkRestoreSubjectsRequest(message.text) || this.isBulkRestorePreviousDraftsRequest(message.text)) {
      if (!Array.isArray(ctx.previousDrafts) || ctx.previousDrafts.length === 0) {
        return 'I do not have an earlier version saved for this bulk email. Tell me exactly what to change, for example: "rewrite email 2 to sound shorter".';
      }

      const restoreIndices = this.restoreBulkDraftsFromSnapshot(ctx, {
        subjectsOnly: this.isBulkRestoreSubjectsRequest(message.text)
      });
      restoreIndices.forEach(index => updatedIndices.add(index));
      appliedStructuredChange = true;
    }

    if (this.isBulkAddRecipientRequest(message.text, ctx)) {
      const addResult = await this.addRecipientsToBulkDraft(ctx, message.text, message.from);
      if (!addResult.success) {
        return addResult.error || 'I could not add that recipient. Please try again.';
      }
      addResult.updatedIndices.forEach(index => updatedIndices.add(index));
      appliedStructuredChange = true;
    }

    const targetIndices = appliedStructuredChange ? [] : this.parseTargetedEmailNumbers(message.text, ctx.drafts.length);
    const revisionInstruction = this.normalizeBulkRevisionInstruction(message.text);
    const hasExplicitBulkEdit = this.isBulkEditInstruction(message.text);

    if (!appliedStructuredChange && targetIndices.length === 0 && !hasExplicitBulkEdit) {
      return 'I want to make sure I understood. Do you want me to rewrite one of the current emails, add a new recipient, or change the schedule?\n\nExamples:\n- "rewrite email 2 to sound shorter"\n- "add rahul@example.com - applying for Growth Associate at Acme Corp"\n- "change the time to 6:30 pm"';
    }

    if (targetIndices.length > 0 || (!appliedStructuredChange && hasExplicitBulkEdit)) {
      ctx.previousDrafts = this.cloneDrafts(ctx.drafts);

      if (targetIndices.length > 0) {
        const signerName = await this.getUserNameForSignature(message.from);
        for (const idx of targetIndices) {
          const draft = ctx.drafts[idx];
          const revised = await gmailService.reviseEmailWithAI(draft, revisionInstruction);
          if (revised.success) {
            const body = this.addDefaultSignature(revised.body, signerName);
            ctx.drafts[idx] = { ...draft, subject: revised.subject, body, htmlBody: gmailService.bodyToHtml(body) };
            updatedIndices.add(idx);
          }
        }
        const updatedNums = targetIndices.map(i => i + 1).join(', ');
        logger.info(`[BulkEmail] Revised emails: #${updatedNums}`);
      } else {
        const signerName = await this.getUserNameForSignature(message.from);
        const revisedDrafts = [];
        for (const [index, draft] of ctx.drafts.entries()) {
          const revised = await gmailService.reviseEmailWithAI(draft, revisionInstruction);
          if (revised.success) {
            const body = this.addDefaultSignature(revised.body, signerName);
            revisedDrafts.push({ ...draft, subject: revised.subject, body, htmlBody: gmailService.bodyToHtml(body) });
            updatedIndices.add(index);
          } else {
            revisedDrafts.push(draft);
          }
        }
        ctx.drafts = revisedDrafts;
      }

      appliedRevision = true;
    }

    ctx.timestamp = Date.now();
    this.bulkEmailContext.set(message.from, ctx);
    this.storeRecentEmailContext(message.from, {
      type: 'bulk',
      drafts: ctx.drafts,
      referenceDraft: ctx.drafts[0],
      mode: ctx.mode,
      attachments: ctx.attachments || null,
      sendAt: ctx.sendAt,
      timezone: ctx.timezone,
      isRecurring: ctx.isRecurring,
      recurrencePattern: ctx.recurrencePattern,
      recurrenceDays: ctx.recurrenceDays,
      recurrenceTime: ctx.recurrenceTime,
      recurrenceLabel: ctx.recurrenceLabel
    });

    const title = appliedRevision
      ? (ctx.mode === 'shared' ? '*Revised Bulk Email*' : '*Revised Personalized Emails*')
      : (ctx.mode === 'shared' ? '*Updated Bulk Email*' : '*Updated Personalized Emails*');

    return this.buildBulkEmailPreview(ctx, {
      title,
      updatedIndices: [...updatedIndices].sort((a, b) => a - b),
      footer: revisedFooter
    });
  }

  // ========== ACCOUNT LINKING ==========
  //
  // Apr 29 2026 — WhatsApp-only cleanup deleted the Discord/Telegram/Slack/
  // GChat adapters. Until May 19 2026 the controller still advertised
  // those platforms here; the codes generated were never claimable because
  // the corresponding bots didn't exist. Result: confused users + dead
  // help text. Dashboard access now uses the shared Google + Composio flow.
  async handleAccountLink(message, params = {}) {
    const lower = message.text.trim().toLowerCase();
    const action = String(params.action || '').toLowerCase();

    // Keep older dashboard phrases useful without issuing WhatsApp login codes.
    // Gated on DASHBOARD_BASE_URL so the intent is dormant when the dashboard
    // isn't deployed.
    const wantsDashboard = action === 'dashboard_link' ||
      /^(open|launch|show|send|give|gimme)\s+(me\s+)?(the\s+)?(dashboard|web|website)(\s+(login|link))?$/i.test(lower)
      || /^(dashboard|web)\s+(login|link)$/i.test(lower)
      || /^login\s+(to\s+)?(dashboard|web)$/i.test(lower)
      || /^(link|connect)\s+(me\s+)?(to\s+)?(the\s+)?(dashboard|web)$/i.test(lower)
      || lower === 'link account'
      || lower === 'link';

    if (wantsDashboard) {
      if (!process.env.DASHBOARD_BASE_URL) {
        return 'The web dashboard isn\'t live yet. Everything works on WhatsApp — say "help" to see what I can do.';
      }
      const base = process.env.DASHBOARD_BASE_URL.replace(/\/+$/, '');
      const url = `${base}/login`;
      return `*Open Ari*\n\n${url}\n\nSign in with Google. Composio will securely connect the Google apps you authorize.`;
    }

    // "my accounts" / "linked accounts" — show connected services (Google,
    // Microsoft, Apple). Account linking across messaging platforms is no
    // longer supported (WhatsApp-only).
    if (action === 'list' || /^(my\s+)?(linked\s+)?accounts$|^(show|view|list)\s+(my\s+)?(linked\s+)?accounts$/i.test(lower)) {
      const accounts = await accountLinkService.getLinkedAccounts(message.from);
      return accountLinkService.formatLinkedAccounts(accounts);
    }

    // Politely decline the cross-platform link commands. If someone types
    // "link discord" they likely read old docs or saw a screenshot from
    // before the WhatsApp-only purge.
    if (/^link\s+(discord|telegram|slack|gchat|google\s*chat)$/i.test(lower)
        || /^unlink\s+(discord|telegram|slack|gchat|google\s*chat)$/i.test(lower)) {
      return 'Cross-platform messaging links are not supported. Open the Ari dashboard and sign in securely with Google and Composio.';
    }

    return 'Account connections are managed securely inside Ari. Sign in with Google, then use Composio to authorize the apps you want Ari to access.';
  }

  // ========== SALES ASSISTANT ==========
  /**
   * Dispatch a campaign through the dashboard's sender so chat and dashboard
   * sends behave identically (tracking rows, cross-recipient leak guard,
   * throttle, campaign finalize). Requiring the routes module lazily keeps the
   * routes -> controller load cycle intact.
   */
  async _startCampaignSend({ userPhone, campaign, drafts }) {
    try {
      const { runDashboardBulkSend } = require('../routes/webhook.routes')._internals;
      if (typeof runDashboardBulkSend !== 'function') {
        return { ok: false, error: 'The campaign sender is unavailable on this server.' };
      }
      const campaignService = require('../services/campaign.service');
      await campaignService.updateCampaignFields(userPhone, campaign.id, { status: 'sending' });
      // Fire-and-forget: the sender throttles per recipient and finalizes the
      // campaign row itself, so the turn must not block on thousands of sends.
      setImmediate(() => {
        runDashboardBulkSend({
          userPhone, campaignId: campaign.id, drafts, trackOpens: true,
        }).catch((error) => {
          logger.error(`[Campaign] send failed (id=${campaign.id}): ${error.message}`);
        });
      });
      return { ok: true };
    } catch (error) {
      logger.error('Campaign start error:', error.message);
      return { ok: false, error: 'I could not start that campaign.' };
    }
  }

  /** Best-effort campaign counters for a chat-driven bulk send. */
  async _recordCampaignProgress(campaignId, sent, failed, status) {
    try {
      const { query } = require('../config/database');
      await query(
        `UPDATE bulk_email_campaigns
            SET sent_count = $1, failed_count = $2, status = $3,
                completed_at = CASE WHEN $3 IN ('completed','partial','failed') THEN NOW() ELSE completed_at END
          WHERE id = $4`,
        [Number(sent) || 0, Number(failed) || 0, status, Number(campaignId)],
      );
    } catch (error) {
      logger.warn(`[BulkSend] campaign progress not recorded (id=${campaignId}): ${error.message}`);
    }
  }

  // ========== CAMPAIGNS (bulk_email_campaigns) ==========
  // Read + write. create_draft stages a campaign in the schema's existing
  // 'pending' state — composed but not sent and not scheduled — so
  // "make the campaign but don't send yet" is expressible. start is the only
  // action that sends, and it goes through the confirmation gate.
  async handleCampaignsManage(message, params = {}) {
    const { query } = require('../config/database');
    const campaignService = require('../services/campaign.service');
    const action = params.action || 'list';

    const findCampaign = async () => {
      try {
        return await campaignService.getCampaign(message.from, {
          campaignId: params.campaign_id,
          subjectQuery: params.campaign_subject,
        });
      } catch (error) {
        if (error.code === 'campaign_ambiguous') return { ambiguous: error.message };
        throw error;
      }
    };

    switch (action) {
      case 'compose': {
        try {
          const draft = await campaignService.composeDraft({
            purpose: params.purpose || params.full_text || message.text,
            tone: params.tone,
            groupName: params.group_name,
            senderName: params.sender_name,
          });
          return `Here's a draft you can use:\n\n*Subject:* ${draft.subject}\n\n${draft.body}\n\n_Say "create a campaign for [group] with this" to stage it, or tell me what to change._`;
        } catch (error) {
          return error.code ? error.message : 'I could not draft that email right now.';
        }
      }

      case 'create_draft': {
        const groupName = String(params.group_name || '').trim();
        if (!groupName) return 'Which CRM group should this campaign go to?';
        const { contactGroupService } = require('../services/contact-group.service');
        const group = await contactGroupService.findGroupByName(message.from, groupName);
        if (!group) return `No CRM group named "${groupName}". Say "show my groups" to see them.`;
        const members = await campaignService.listGroupMembersWithEmail(message.from, group.id);
        if (members.length === 0) {
          return `*${group.name}* has no members with an email address, so a campaign would reach nobody.`;
        }
        let subject = String(params.subject || '').trim();
        let body = String(params.body || '').trim();
        // Compose automatically when the user described intent but gave no copy.
        if (!subject || !body) {
          const purpose = String(params.purpose || params.full_text || message.text || '').trim();
          try {
            const draft = await campaignService.composeDraft({
              purpose, tone: params.tone, groupName: group.name, sampleMember: members[0],
            });
            subject = subject || draft.subject;
            body = body || draft.body;
          } catch (error) {
            return 'Tell me the subject and body for this campaign (or what it should say, and I will draft it).';
          }
        }
        require('../utils/abort').throwIfAborted(message.signal, 'The campaign draft');
        const created = await campaignService.createDraft(message.from, {
          groupId: group.id,
          subject,
          bodyTemplate: body,
          recipientCount: members.length,
          dailySendLimit: params.daily_send_limit,
        });
        return `Campaign drafted — *nothing has been sent*.\n\n*${created.subject}* (ID: ${created.id})\nAudience: *${group.name}* — ${members.length} recipient${members.length === 1 ? '' : 's'}\nDaily limit: ${created.daily_send_limit}\n\n_Preview:_\n${campaignService.compileForMember(body, members[0]).slice(0, 400)}\n\n_Say "start campaign ${created.id}" when you want it to go out._`;
      }

      case 'update': {
        const found = await findCampaign();
        if (found?.ambiguous) return found.ambiguous;
        if (!found) return 'Which campaign should I update? Say "my campaigns" for the list.';
        const updated = await campaignService.updateCampaignFields(message.from, found.id, {
          subject: params.subject !== undefined ? params.subject : undefined,
          bodyTemplate: params.body !== undefined ? params.body : undefined,
          dailySendLimit: params.daily_send_limit !== undefined ? params.daily_send_limit : undefined,
        });
        if (!updated) return 'Tell me what to change: the subject, the body, or the daily limit.';
        return `Updated *${updated.subject}* (ID: ${updated.id}). Daily limit: ${updated.daily_send_limit}.`;
      }

      case 'start': {
        const found = await findCampaign();
        if (found?.ambiguous) return found.ambiguous;
        if (!found) return 'Which campaign should I start? Say "my campaigns" for the list.';
        if (found.status === 'sending') return `*${found.subject}* is already sending.`;
        if (found.status === 'completed') return `*${found.subject}* has already finished sending.`;
        if (!found.group_id) return `*${found.subject}* has no audience group, so I cannot send it.`;
        const members = await campaignService.listGroupMembersWithEmail(message.from, found.group_id);
        if (members.length === 0) return `That campaign's group has no members with an email address.`;
        require('../utils/abort').throwIfAborted(message.signal, 'The campaign send');
        const drafts = members.map((member) => ({
          to: member.email,
          subject: campaignService.compileForMember(found.subject, member),
          body: campaignService.compileForMember(found.body_template, member),
        }));
        const result = await this._startCampaignSend({
          userPhone: message.from, campaign: found, drafts,
        });
        if (!result.ok) return result.error || 'I could not start that campaign.';
        return `Started *${found.subject}* — sending to ${drafts.length} recipient${drafts.length === 1 ? '' : 's'} (daily limit ${found.daily_send_limit || drafts.length}). Track it on the Campaigns page.`;
      }

      case 'pause':
      case 'resume': {
        const found = await findCampaign();
        if (found?.ambiguous) return found.ambiguous;
        if (!found) return `Which campaign should I ${action}?`;
        const updated = await campaignService.updateCampaignFields(message.from, found.id, {
          status: action === 'pause' ? 'paused' : 'sending',
        });
        if (!updated) return `I could not ${action} that campaign.`;
        return action === 'pause'
          ? `Paused *${updated.subject}*. Say "resume campaign ${updated.id}" to continue.`
          : `Resumed *${updated.subject}*.`;
      }

      case 'archive':
      case 'restore': {
        const found = await findCampaign();
        if (found?.ambiguous) return found.ambiguous;
        if (!found) return `Which campaign should I ${action}?`;
        const updated = await campaignService.updateCampaignFields(message.from, found.id, {
          archived: action === 'archive',
        });
        if (!updated) return `I could not ${action} that campaign.`;
        return action === 'archive'
          ? `Archived *${updated.subject}*. It stays in the Archived filter.`
          : `Restored *${updated.subject}* to your active campaigns.`;
      }

      case 'delete': {
        const found = await findCampaign();
        if (found?.ambiguous) return found.ambiguous;
        if (!found) return 'Which campaign should I delete?';
        require('../utils/abort').throwIfAborted(message.signal, 'The campaign deletion');
        const result = await campaignService.deleteCampaign(message.from, found.id);
        if (!result.deleted) {
          return result.reason === 'sending'
            ? `*${found.subject}* is sending right now, so I did not delete it. Pause it first.`
            : 'I could not delete that campaign.';
        }
        return `Deleted campaign *${result.subject || found.subject}*.`;
      }

      default:
        break;
    }
    const formatCampaign = (row) => {
      const stats = `${row.sent_count || 0}/${row.recipient_count || 0} sent`
        + (row.failed_count > 0 ? `, ${row.failed_count} failed` : '');
      return `*${row.subject}* (ID: ${row.id})\n   Status: ${row.status} | ${stats}\n   Created: ${new Date(row.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`;
    };
    try {
      if (action === 'status') {
        let row = null;
        if (params.campaign_id) {
          const r = await query(
            `SELECT * FROM bulk_email_campaigns WHERE user_phone = $1 AND id = $2`,
            [message.from, Number(params.campaign_id)],
          );
          row = r.rows[0] || null;
        } else if (params.campaign_subject) {
          const r = await query(
            `SELECT * FROM bulk_email_campaigns
              WHERE user_phone = $1 AND LOWER(subject) LIKE $2
              ORDER BY id DESC LIMIT 2`,
            [message.from, `%${String(params.campaign_subject).toLowerCase()}%`],
          );
          if (r.rows.length > 1) {
            return `Found ${r.rows.length}+ campaigns matching "${params.campaign_subject}". Say "my campaigns" and give me the ID.`;
          }
          row = r.rows[0] || null;
        }
        if (!row) return 'Which campaign? Say "my campaigns" to see the list, then ask by ID or subject.';
        let opened = 0; let clicked = 0;
        try {
          const events = await query(
            `SELECT COUNT(*) FILTER (WHERE opened_at IS NOT NULL)::int AS opened,
                    COUNT(*) FILTER (WHERE clicked_at IS NOT NULL)::int AS clicked
               FROM email_sends WHERE campaign_id = $1`,
            [row.id],
          );
          opened = events.rows[0]?.opened || 0;
          clicked = events.rows[0]?.clicked || 0;
        } catch (_) { /* tracking table may not exist yet */ }
        return `${formatCampaign(row)}\n   Opened: ${opened} | Clicked: ${clicked}`
          + (row.scheduled_for ? `\n   Scheduled for: ${new Date(row.scheduled_for).toLocaleString('en-IN')}` : '');
      }
      const r = await query(
        `SELECT id, subject, status, recipient_count, sent_count, failed_count, created_at
           FROM bulk_email_campaigns WHERE user_phone = $1 ORDER BY id DESC LIMIT 10`,
        [message.from],
      );
      if (r.rows.length === 0) {
        return 'No email campaigns yet. Start one with "email all [group name]" or from the dashboard under Contacts → Campaigns.';
      }
      require('../utils/list-position-cache').remember(message.from, 'campaigns',
        r.rows.map((row) => ({ id: row.id, title: row.subject })));
      return `*Your campaigns:*\n\n${r.rows.map((row, i) => `${i + 1}. ${formatCampaign(row)}`).join('\n\n')}`;
    } catch (error) {
      if (error.code === '42P01') return 'No email campaigns yet — nothing has been sent from this workspace.';
      logger.error('Campaigns view error:', error.message);
      return 'Could not load campaigns right now. Please try again.';
    }
  }

  // ========== MEETING RECORDINGS ==========
  // Reads plus the three writes the Meetings page offers: retry a stuck
  // recording, name a diarized speaker, and promote the report's suggested
  // action items to real tasks.
  _meetingRepository() {
    if (!this._meetingRepo) {
      const { pool, query } = require('../config/database');
      const { createMeetingRepository } = require('../services/manual-meetings/meeting-repository');
      this._meetingRepo = createMeetingRepository({ query, connect: () => pool.connect() });
    }
    return this._meetingRepo;
  }

  async _findMeetingRecording(userPhone, params) {
    const { query } = require('../config/database');
    if (params.meeting_id) {
      const r = await query(
        `SELECT * FROM meeting_recordings
          WHERE (user_phone = $1 OR team_admin_phone = $1) AND id = $2`,
        [userPhone, Number(params.meeting_id)],
      );
      return r.rows[0] || null;
    }
    if (params.meeting_title) {
      const r = await query(
        `SELECT * FROM meeting_recordings
          WHERE (user_phone = $1 OR team_admin_phone = $1)
            AND LOWER(COALESCE(title, '')) LIKE $2
          ORDER BY id DESC LIMIT 1`,
        [userPhone, `%${String(params.meeting_title).toLowerCase()}%`],
      );
      return r.rows[0] || null;
    }
    return null;
  }

  async handleMeetingRecordings(message, params = {}) {
    const { query } = require('../config/database');
    const action = params.action || 'list';
    const describe = (row) => {
      const minutes = row.duration_seconds ? `${Math.round(row.duration_seconds / 60)} min` : 'duration unknown';
      const when = new Date(row.created_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
      return `*${row.title || 'Untitled meeting'}* (ID: ${row.id})\n   ${when} | ${minutes} | Status: ${row.status}${row.processing_stage && row.status !== 'completed' ? ` (${row.processing_stage})` : ''}`;
    };
    try {
      if (action === 'status' && (params.meeting_id || params.meeting_title)) {
        let row = null;
        if (params.meeting_id) {
          const r = await query(
            `SELECT * FROM meeting_recordings
              WHERE (user_phone = $1 OR team_admin_phone = $1) AND id = $2`,
            [message.from, Number(params.meeting_id)],
          );
          row = r.rows[0] || null;
        } else {
          const r = await query(
            `SELECT * FROM meeting_recordings
              WHERE (user_phone = $1 OR team_admin_phone = $1)
                AND LOWER(COALESCE(title, '')) LIKE $2
              ORDER BY id DESC LIMIT 1`,
            [message.from, `%${String(params.meeting_title).toLowerCase()}%`],
          );
          row = r.rows[0] || null;
        }
        if (!row) return 'I could not find that recording. Say "my meeting recordings" to see the list.';
        let detail = describe(row);
        if (row.processing_error_message) detail += `\n   Error: ${String(row.processing_error_message).slice(0, 200)}`;
        if (row.summary) detail += `\n\n${String(row.summary).slice(0, 800)}`;
        detail += '\n\n_Open the Meetings page in the dashboard for the transcript, playback, and full report._';
        return detail;
      }

      if (action === 'retry' || action === 'rename_speaker' || action === 'create_tasks') {
        const row = await this._findMeetingRecording(message.from, params);
        if (!row) return 'I could not find that recording. Say "my meeting recordings" to see the list.';
        // The recorder writes rows under the owner's phone; team viewers can
        // read a shared recording but must not rewrite its transcript.
        if (action !== 'create_tasks' && row.user_phone !== message.from) {
          return `*${row.title || 'That recording'}* belongs to another account, so only its owner can change it.`;
        }

        if (action === 'retry') {
          if (row.status === 'completed') {
            return `*${row.title || 'That recording'}* already finished processing — there is nothing to retry.`;
          }
          require('../utils/abort').throwIfAborted(message.signal, 'The recording retry');
          const processor = require('../services/manual-meetings/processor');
          processor.retry({ meetingId: row.id, userPhone: row.user_phone })
            .catch((error) => logger.error(`Meeting retry ${row.id} failed: ${error.message}`));
          return `Reprocessing *${row.title || `recording #${row.id}`}*. It was stuck at "${row.processing_stage || row.status}". Ask "status of recording ${row.id}" in a few minutes.`;
        }

        if (action === 'rename_speaker') {
          const speakerId = String(params.speaker_id || '').trim().toUpperCase();
          const speakerName = String(params.speaker_name || '').trim();
          if (!/^[A-Z]+$/.test(speakerId) || !speakerName) {
            return 'Which speaker should I rename, and to what? Say: rename speaker A to Priya in recording 12.';
          }
          require('../utils/abort').throwIfAborted(message.signal, 'The speaker rename');
          try {
            const updated = await this._meetingRepository().renameSpeaker({
              meetingId: row.id, userPhone: row.user_phone, speakerId, name: speakerName,
            });
            return `Speaker ${speakerId} is now *${speakerName}* in "${updated?.title || row.title || `recording #${row.id}`}". The transcript, summary, and report were rebuilt with the new name.`;
          } catch (error) {
            if (error instanceof TypeError) return `Could not rename that speaker: ${error.message}`;
            if (error.code === 'MEETING_NOT_FOUND') return 'That recording is no longer available.';
            logger.error('Meeting speaker rename error:', error.message);
            return 'Could not rename that speaker right now. Please try again.';
          }
        }

        // create_tasks
        const suggested = Array.isArray(row.suggested_tasks) ? row.suggested_tasks
          : (typeof row.suggested_tasks === 'string' ? JSON.parse(row.suggested_tasks || '[]') : []);
        const titles = suggested
          .map((task) => String(task?.title || '').trim())
          .filter(Boolean);
        if (titles.length === 0) {
          return row.status === 'completed'
            ? `*${row.title || `Recording #${row.id}`}* has no suggested action items to save.`
            : `*${row.title || `Recording #${row.id}`}* is still processing (${row.processing_stage || row.status}), so there are no action items yet.`;
        }
        require('../utils/abort').throwIfAborted(message.signal, 'The task creation');
        const taskService = require('../services/task.service');
        const created = [];
        const failed = [];
        for (const title of titles.slice(0, 25)) {
          const result = await taskService.createPersonalTask(message.from, title);
          if (result.success) created.push(title); else failed.push(title);
        }
        let out = created.length > 0
          ? `Saved ${created.length} task${created.length === 1 ? '' : 's'} from *${row.title || `recording #${row.id}`}*:\n${created.map((title) => `- ${title}`).join('\n')}`
          : `Could not save any tasks from *${row.title || `recording #${row.id}`}*.`;
        if (failed.length > 0) out += `\n\nFailed to save: ${failed.join(', ')}.`;
        return out;
      }
      const r = await query(
        `SELECT id, title, status, processing_stage, duration_seconds, created_at
           FROM meeting_recordings
          WHERE user_phone = $1 OR team_admin_phone = $1
          ORDER BY id DESC LIMIT 10`,
        [message.from],
      );
      if (r.rows.length === 0) {
        return 'No meeting recordings yet. Record one from the Meetings page in the desktop app.';
      }
      require('../utils/list-position-cache').remember(message.from, 'meetings',
        r.rows.map((row) => ({ id: row.id, title: row.title })));
      return `*Your meeting recordings:*\n\n${r.rows.map((row, i) => `${i + 1}. ${describe(row)}`).join('\n\n')}\n\n_Ask "status of recording [number/title]" for details._`;
    } catch (error) {
      if (error.code === '42P01') return 'No meeting recordings yet — the recorder has not been used on this workspace.';
      logger.error('Meeting recordings view error:', error.message);
      return 'Could not load meeting recordings right now. Please try again.';
    }
  }

  async handleSalesManage(message, context, intentParams = null) {
    const cmd = await salesService.parseCommand(message.text, intentParams);
    if (!cmd) {
      return await aiService.chat(message.from, message.text, context);
    }

    switch (cmd.action) {
      case 'add': {
        const parsed = intentParams?.action === 'add_lead' && context?.agentExecution
          ? {
            name: intentParams.lead_name,
            company: intentParams.company || null,
            email: intentParams.email || null,
            notes: intentParams.notes || null,
            dealValue: intentParams.deal_value ?? null,
          }
          : await salesService.parseLeadFromText(cmd.raw);
        if (!parsed || !parsed.name) {
          return 'Could not parse lead info. Try: _"new lead John from Acme, john@acme.com, interested in premium plan"_';
        }
        const result = await salesService.addLead(message.from, parsed);
        if (!result.success) return `Failed to add lead: ${result.error}`;
        const lead = result.lead;
        let resp = `Lead added!\n\n*${lead.name}*`;
        if (lead.company) resp += ` @ ${lead.company}`;
        if (lead.email) resp += `\nEmail: ${lead.email}`;
        if (lead.notes) resp += `\nNotes: ${lead.notes}`;
        if (lead.deal_value) resp += `\nDeal: ${Number(lead.deal_value).toLocaleString('en-IN')}`;
        resp += `\nStage: ${salesService.stageLabel(lead.stage)} (ID: ${lead.id})`;
        resp += '\n\n_"my leads" to see pipeline | "follow up with [name]" to email_';
        return resp;
      }

      case 'list': {
        const leads = await salesService.getLeads(message.from, { stage: cmd.stage });
        return salesService.formatLeadsList(leads);
      }

      case 'details': {
        const resolved = await salesService.resolveLead(message.from, cmd.target);
        if (!resolved.found) return `Lead "${cmd.target}" not found.`;
        if (resolved.ambiguous) {
          return `Multiple leads found:\n${resolved.matches.map(l => `- *${l.name}* (ID: ${l.id})`).join('\n')}\n\nSpecify the ID: _"lead details #${resolved.matches[0].id}"_`;
        }
        return salesService.formatLead(resolved.lead);
      }

      case 'move': {
        const resolved = await salesService.resolveLead(message.from, cmd.target);
        if (!resolved.found) return `Lead "${cmd.target}" not found.`;
        if (resolved.ambiguous) {
          return `Multiple leads match. Use ID: _"move #${resolved.matches[0].id} to ${cmd.newStage}"_`;
        }
        // A Stop delivered during the resolveLead lookup used to slip past
        // every check and still commit the stage change (smoke-test C-1).
        // The write either has not started here — so it must not start — or
        // it runs to completion once begun.
        require('../utils/abort').throwIfAborted(message.signal, 'The lead stage change');
        const stage = cmd.newStage.replace(/[-\s]/g, '_');
        const result = await salesService.updateStage(message.from, resolved.lead.id, stage);
        if (!result.success) return result.error;
        return `*${result.lead.name}* moved to *${salesService.stageLabel(stage)}*`;
      }

      case 'update': {
        const fields = cmd.fields && typeof cmd.fields === 'object' ? cmd.fields : {};
        if (Object.keys(fields).length === 0) {
          return 'What should I update on that lead? I can change email, company, title, source, phone, LinkedIn, website, priority, location, deal value, or notes.';
        }
        const resolved = await salesService.resolveLead(message.from, cmd.target);
        if (!resolved.found) return `Lead "${cmd.target}" not found.`;
        if (resolved.ambiguous) {
          return `Multiple leads match. Use ID: _"update lead #${resolved.matches[0].id}"_`;
        }
        require('../utils/abort').throwIfAborted(message.signal, 'The lead update');
        const result = await salesService.updateLead(message.from, resolved.lead.id, fields);
        if (!result.success) return result.error || 'Could not update the lead.';
        const changed = Object.keys(fields).map((key) => key.replace(/_/g, ' ')).join(', ');
        return `*${resolved.lead.name}* updated (${changed}).`;
      }

      case 'delete': {
        const resolved = await salesService.resolveLead(message.from, cmd.target);
        if (!resolved.found) return `Lead "${cmd.target}" not found.`;
        if (resolved.ambiguous) {
          return `Multiple leads match. Use ID: _"delete lead #${resolved.matches[0].id}"_`;
        }
        require('../utils/abort').throwIfAborted(message.signal, 'The lead deletion');
        const result = await salesService.deleteLead(message.from, resolved.lead.id);
        if (!result.success) return result.error;
        return `Lead *${result.name}* deleted.`;
      }

      case 'archive':
      case 'restore': {
        const archiving = cmd.action === 'archive';
        const resolved = await salesService.resolveLead(message.from, cmd.target);
        if (!resolved.found) return `Lead "${cmd.target}" not found.`;
        if (resolved.ambiguous) {
          return `Multiple leads match. Use ID: _"${cmd.action} lead #${resolved.matches[0].id}"_`;
        }
        require('../utils/abort').throwIfAborted(message.signal, `The lead ${cmd.action}`);
        const result = await salesService.setLeadArchived(message.from, resolved.lead.id, archiving);
        if (!result.success) return result.error;
        return archiving
          ? `*${result.lead.name}* archived. Nothing was deleted — say "restore lead ${result.lead.name}" to bring them back.`
          : `*${result.lead.name}* restored to the active pipeline.`;
      }

      case 'mark_contacted': {
        const resolved = await salesService.resolveLead(message.from, cmd.target);
        if (!resolved.found) return `Lead "${cmd.target}" not found.`;
        if (resolved.ambiguous) {
          return `Multiple leads match. Use ID: _"mark #${resolved.matches[0].id} as contacted"_`;
        }
        require('../utils/abort').throwIfAborted(message.signal, 'The contact log');
        const result = await salesService.markLeadContacted(message.from, resolved.lead.id, cmd.notes || null);
        if (!result.success) return result.error;
        let resp = `Logged contact with *${result.lead.name}* just now.`;
        if (cmd.notes) resp += `\nNote added: ${cmd.notes}`;
        return resp;
      }

      case 'summary': {
        const summary = await salesService.getPipelineSummary(message.from);
        return salesService.formatPipelineSummary(summary);
      }

      case 'followup':
      case 'sales_email': {
        const emailType = cmd.emailType || 'followup';
        const resolved = await salesService.resolveLead(message.from, cmd.target);
        if (!resolved.found) return `Lead "${cmd.target}" not found.`;
        if (resolved.ambiguous) {
          return `Multiple leads match. Use ID: _"follow up with #${resolved.matches[0].id}"_`;
        }
        const lead = resolved.lead;
        if (!lead.email) {
          return `*${lead.name}* doesn't have an email address. Update it: _"lead note ${lead.id}: email is xyz@company.com"_`;
        }
        if (!await googleAuthService.isConnected(message.from)) {
          return 'Google not connected. Say "connect google" to link your Gmail first.';
        }

        const draft = await salesService.draftSalesEmail(message.from, lead, emailType);
        if (!draft.success) return draft.error;

        // Store for confirmation
        this.salesEmailContext.set(message.from, {
          lead,
          draft,
          timestamp: Date.now()
        });

        const preview = gmailService.previewBody(draft.body);
        return `*Sales Email Preview* (${emailType.replace(/_/g, ' ')})\n\n*To:* ${draft.to}\n*Subject:* ${draft.subject}\n\n${preview}\n\n_Send? Reply *yes* | Edit? Just tell me what to change | *no* to cancel_`;
      }

      case 'check_replies': {
        if (!await googleAuthService.isConnected(message.from)) {
          return 'Google not connected. Say "connect google" first.';
        }
        const result = await salesService.checkLeadReplies(message.from);
        if (!result.success) return result.error;
        return result.summary;
      }

      case 'followups_due': {
        const leads = await salesService.getFollowupsDue(message.from);
        if (leads.length === 0) return 'No follow-ups due right now.';
        let resp = `*Follow-ups Due* (${leads.length})\n\n`;
        for (const lead of leads) {
          const due = new Date(lead.next_followup_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
          resp += `> *${lead.name}*`;
          if (lead.company) resp += ` @ ${lead.company}`;
          resp += ` | Due: ${due} (ID: ${lead.id})\n`;
        }
        resp += '\n_"follow up with [name]" to send email_';
        return resp;
      }

      case 'add_note': {
        const resolved = await salesService.resolveLead(message.from, cmd.target);
        if (!resolved.found) return `Lead "${cmd.target}" not found.`;
        if (resolved.ambiguous) {
          return `Multiple leads match. Use ID: _"lead note #${resolved.matches[0].id}: your note"_`;
        }
        // Check if user is setting email via note
        const emailMatch = cmd.notes.match(/email\s+(?:is\s+)?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
        if (emailMatch) {
          const result = await salesService.updateLead(message.from, resolved.lead.id, { email: emailMatch[1] });
          if (!result.success) return result.error;
          return `Updated *${result.lead.name}*'s email to ${emailMatch[1]}`;
        }
        // Append to existing notes
        const existingNotes = resolved.lead.notes || '';
        const newNotes = existingNotes ?`${existingNotes}\n${cmd.notes}` : cmd.notes;
        const result = await salesService.updateLead(message.from, resolved.lead.id, { notes: newNotes });
        if (!result.success) return result.error;
        return `Note added to *${result.lead.name}*`;
      }

      case 'set_followup': {
        const resolved = await salesService.resolveLead(message.from, cmd.target);
        if (!resolved.found) return `Lead "${cmd.target}" not found.`;
        if (resolved.ambiguous) {
          return `Multiple leads match. Use ID.`;
        }
        // Parse time using chrono with user timezone
        const chrono = require('chrono-node');
        const followupTzOffset = calendarNLPService.getTimezoneOffsetMinutes(context.userTimezone || process.env.DEFAULT_TIMEZONE || 'Asia/Kolkata');
        const parsed = chrono.parseDate(cmd.timeRaw, new Date(), { forwardDate: true, timezone: followupTzOffset });
        if (!parsed) return `Could not understand "${cmd.timeRaw}". Try "in 3 days" or "next Monday".`;
        const result = await salesService.updateLead(message.from, resolved.lead.id, {
          next_followup_at: parsed.toISOString()
        });
        if (!result.success) return result.error;
        const fDate = parsed.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
        return `Follow-up with *${result.lead.name}* set for *${fDate}*`;
      }

      default:
        return await aiService.chat(message.from, message.text, context);
    }
  }

  // Handle sales email confirmation (called from confirm context)
  async handleSalesEmailConfirm(message) {
    const ctx = this.salesEmailContext.get(message.from);
    if (!ctx) return null;

    const text = message.text.toLowerCase().trim();
    const classification = classifySensitiveConfirmation(text);

    if (classification.decision === 'confirm') {
      this.salesEmailContext.delete(message.from);
      const result = await salesService.sendSalesEmail(message.from, ctx.lead, ctx.draft);
      if (!result.success) return `Failed to send: ${result.error}`;
      let resp = `Sales email sent to *${ctx.lead.name}*!`;
      if (ctx.lead.stage === 'new') resp += '\nLead auto-moved to *Contacted*.';
      return resp;
    }

    if (classification.decision === 'cancel') {
      this.salesEmailContext.delete(message.from);
      return 'Sales email cancelled.';
    }

    // Revision — use gmail revise
    const revised = await gmailService.reviseEmailWithAI(ctx.draft, message.text);
    if (!revised.success) return revised.error;

    // Update stored draft
    ctx.draft = { ...ctx.draft, subject: revised.subject, body: revised.body, htmlBody: revised.htmlBody };
    ctx.timestamp = Date.now();
    this.salesEmailContext.set(message.from, ctx);

    const preview = gmailService.previewBody(revised.body);
    return `*Revised Email*\n\n*To:* ${revised.to}\n*Subject:* ${revised.subject}\n\n${preview}\n\n_Send? Reply *yes* | Edit more | *no* to cancel_`;
  }

  // ========== VERSION INFO ==========
  async handleExportData(message) {
    try {
      const { query: dbQuery } = require('../config/database');
      const contacts = await contactService.getAllContacts(message.from);
      const memories = await memoryService.getMemoryTrunk(message.from);
      const noteTopics = await memoryService.getAllNoteTopics(message.from);

      let response = '*Your Data Export*\n\n';

      // Contacts — M1-N fix (Batch F5): until May 19 2026 we dumped
      // unmasked phone numbers AND raw notes (which sometimes contained
      // PII like passwords or addresses users had saved against a
      // contact name). Now we mask the middle digits of phones and
      // truncate notes. For full unredacted export, the roadmap is an
      // encrypted email or signed download URL.
      response += `*Contacts (${contacts.length}):*\n`;
      if (contacts.length > 0) {
        const { maskPhone } = contactService;
        contacts.forEach(c => {
          const maskedPhone = typeof maskPhone === 'function' ? maskPhone(c.phone) : c.phone;
          const notesPreview = c.notes ? ` (${String(c.notes).slice(0, 30)}${c.notes.length > 30 ? '…' : ''})` : '';
          response += `- ${c.name}: ${maskedPhone}${notesPreview}\n`;
        });
        response += `_Phone numbers are masked. Reply *"export full"* if you need the unredacted version emailed to you._\n`;
      } else {
        response += '_No contacts saved_\n';
      }

      // Memories
      response += `\n*Memories:*\n`;
      if (memories && Object.keys(memories).length > 0) {
        for (const [category, items] of Object.entries(memories)) {
          response += `\n_${category}:_\n`;
          items.forEach(m => {
            response += `- ${m.key_name}: ${m.value}\n`;
          });
        }
      } else {
        response += '_No memories saved_\n';
      }

      // Notes
      if (noteTopics.length > 0) {
        response += `\n*Notes (${noteTopics.length} topics):*\n`;
        noteTopics.forEach(t => {
          response += `- ${t.topic} (${t.count} notes)\n`;
        });
      }

      // Reminders
      try {
        const reminders = await dbQuery(
`SELECT message, reminder_time, status, is_recurring, recurrence_pattern FROM reminders WHERE user_phone = $1 AND status = 'pending' ORDER BY reminder_time ASC LIMIT 50`,
          [message.from]
        );
        if (reminders.rows.length > 0) {
          response += `\n*Active Reminders (${reminders.rows.length}):*\n`;
          reminders.rows.forEach(r => {
            const time = new Date(r.reminder_time).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
            const recurring = r.is_recurring ?` (${r.recurrence_pattern})` : '';
            response += `- ${r.message} â€” ${time}${recurring}\n`;
          });
        }
      } catch (e) { /* table may not exist */ }

      // Conversation stats
      try {
        const stats = await dbQuery(
`SELECT COUNT(*) as total, MIN(created_at) as first_msg FROM conversation_history WHERE user_phone = $1`,
          [message.from]
        );
        if (stats.rows[0]?.total > 0) {
          const first = new Date(stats.rows[0].first_msg).toLocaleDateString('en-IN');
          response += `\n*Conversation:* ${stats.rows[0].total} messages since ${first}\n`;
        }
      } catch (e) { /* table may not exist */ }

      // Linked accounts
      try {
        const accounts = await accountLinkService.getLinkedAccounts(message.from);
        if (accounts.length > 0) {
          response += `\n*Linked Accounts:* ${accounts.map(a => accountLinkService.platformLabel(a.platform)).join(', ')}\n`;
        }
      } catch (e) { /* non-critical */ }

      return response;
    } catch (error) {
      logger.error('Export data error:', error.message);
      return "Couldn't export your data right now. Try again?";
    }
  }

  async handleTranslate(message, params = {}) {
    try {
      const sourceText = String(params.text || '').trim();
      const target = String(params.target_language || '').trim();
      const source = String(params.source_language || '').trim();
      const request = sourceText && target
        ? `Translate this${source ? ` from ${source}` : ''} to ${target}:\n\n${sourceText}`
        : message.text;
      const response = await aiService.quickAI(
        request,
        {
          systemPrompt: `You are a translator. Translate only the requested source text. Output ONLY the translation, with no explanation or quotes.${params.preserve_formatting === false ? '' : ' Preserve line breaks, lists, and simple formatting.'}`,
          temperature: 0.1,
          maxTokens: 500
        }
      );
      return response || "Couldn't translate. Try: \"translate hello to Hindi\"";
    } catch (error) {
      logger.error('Translate error:', error.message);
      return "Translation failed. Try again?";
    }
  }

  handleVersionInfo() {
    const info = autoUpdateService.getVersionInfo();
    let response = `*WhatsApp Assistant v${info.version}*\n\n`;
    response += `*Features:*\n`;
    info.features.forEach(f => {
      response += `- ${f}\n`;
    });
    return response;
  }

  // Apr 30 2026 — VISA PROFILE BUILDER HANDLERS removed.
  // 9 controller methods (handleVisaFindOpportunities, tryResolveVisaResumeConfirm,
  // tryResolveVisaCriteriaPicker, handleVisaBatchSend, handleVisaApply,
  // handleVisaStatus, handleVisaEvidencePacket, handleVisaUploadResume,
  // handleVisaDismiss) plus 2 Inngest dispatcher functions (runBatchBuild,
  // sendBulkOutreachEmails) removed. The visa profile builder feature
  // moved to a separate dedicated bot.
}

module.exports = new WebhookController();
