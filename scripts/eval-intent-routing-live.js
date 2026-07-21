'use strict';

/**
 * Live intent-routing evaluation against the configured intent model.
 *
 * This script calls AIService.detectIntent() only. It never executes a tool,
 * writes to the database, or sends a message. Run it explicitly with:
 *
 *   node scripts/eval-intent-routing-live.js
 */

require('dotenv').config();

// Exercise the same keyword-subset path used in production without adding
// embedding-provider noise to what is specifically an intent-model eval.
process.env.OPT_RAG_MCP_ENABLED = 'false';
process.env.OPT_EMBEDDING_FAST_PATH = 'false';
process.env.SEMANTIC_ROUTER_ENABLED = 'false';

const aiService = require('../src/services/ai.service');
const { getToolDefinitions } = require('../src/services/tool-definitions');

const history = (...messages) => messages.map((content, index) => ({
  role: index % 2 === 0 ? 'assistant' : 'user',
  content,
}));

const CASES = [
  ['set_reminder', 'Remind me tomorrow at 9am to call mom'],
  ['view_reminders', 'What reminders do I have?'],
  ['cancel_reminder', 'Cancel reminder number 2'],
  ['save_memory', 'Remember that my passport expires in June 2028'],
  ['recall_memory', 'What do you remember about my passport?'],
  ['save_contact', "Save Rahul's number as +919876543210"],
  ['bulk_save_contacts', 'Save these contacts: Rahul +919876543210 and Priya +919123456789'],
  ['manage_contacts', "What is Rahul's phone number?"],
  ['view_dashboard', 'Show my dashboard'],
  ['delete_dashboard_item', 'Delete reminder 3 from my dashboard'],
  ['manage_images', 'Show my saved images'],
  ['save_image', 'Save this image as launch banner', {
    contextHints: { imageWaitingForSaveConfirm: true },
    recentMessages: history('I generated the image. Would you like to save it?'),
  }],
  ['create_calendar_event', 'Schedule a meeting with alice@example.com tomorrow at 3pm'],
  ['cancel_calendar_event', 'Cancel my 3pm calendar meeting'],
  ['reschedule_calendar_event', 'Move my project meeting to Friday at 4pm'],
  ['view_calendar', 'What meetings do I have tomorrow?'],
  ['email_calendar_attendees', 'Email everyone attending my project meeting about the delay'],
  ['remind_all_calendar', 'Turn on reminders for every calendar event'],
  ['list_calendars', 'Which calendars are connected?'],
  ['handle_calendar_confirmation', 'Go ahead with that meeting', {
    contextHints: { activeCalendarConfirmation: true },
    recentMessages: history('Book Project Review tomorrow at 3pm? Reply yes or no.'),
  }],
  ['send_email', 'Send an email to alice@example.com saying the meeting is at 3pm'],
  ['schedule_email', 'Schedule an email to alice@example.com for tomorrow at 9am saying hello'],
  ['bulk_email', 'Email alice@example.com and bob@example.com about the launch'],
  [['check_inbox', 'email_query'], 'Did Rahul reply to my email?'],
  [['search_inbox', 'check_inbox'], 'Search my inbox for emails about the invoice'],
  ['followup_email', 'Write a follow-up email to Alice about my previous message'],
  [['email_query', 'check_inbox'], 'Has the client sent me the report?'],
  ['handle_email_confirmation', 'Make it shorter and then send it', {
    contextHints: { activeEmailDraftConfirmation: true },
    recentMessages: history('Email draft ready. Say send it or ask for edits.'),
  }],
  ['reuse_recent_email', 'Send the same email again to bob@example.com', {
    contextHints: { hasRecentEmailContext: true, recentEmailType: 'sent' },
    recentMessages: history('Email sent to Alice with subject Launch Update.'),
  }],
  ['manage_tasks', 'Create a task to submit the report tomorrow'],
  ['manage_team', 'Add Rahul +919876543210 to the design team'],
  ['manage_leave', 'Apply for leave next Monday'],
  ['handle_leave_approval', 'Approve this leave request', {
    contextHints: { activeLeaveApproval: true },
    recentMessages: history('Rahul requested leave next Monday. Approve or reject?'),
  }],
  [['manage_standup', 'handle_standup_setup'], 'Set up a daily standup for the engineering team'],
  ['handle_standup_setup', 'Call it Daily Engineering Sync', {
    contextHints: { activeStandupSetup: true, standupSetupStep: 'name' },
    recentMessages: history('What should the new standup be called?'),
  }],
  ['handle_standup_response', 'Yesterday I finished the API; today I will build tests', {
    contextHints: { activeStandupResponse: true, standupQuestionIndex: 1 },
    recentMessages: history('What did you complete yesterday and what will you do today?'),
  }],
  ['manage_polls', 'Create a poll asking the team where to have lunch: Cafe or Office'],
  ['handle_poll_vote', 'Option 2', {
    contextHints: { activePollVote: true },
    recentMessages: history('Vote for lunch: 1. Cafe 2. Office'),
  }],
  ['check_team_availability', 'When is Rahul free tomorrow?'],
  ['manage_notes', 'Save a note that the launch code is blue'],
  ['manage_lists', 'Add milk and eggs to my grocery list'],
  ['daily_briefing', "What's on my plate today?"],
  ['thread_summary', 'Summarize our recent conversation'],
  ['delegate_message', 'Tell Rahul that the meeting moved to 4pm'],
  ['scheduled_message', 'Message Rahul tomorrow at 9am saying the build is ready'],
  ['connect_google', 'Please link my Google account'],
  ['disconnect_google', 'Disconnect my Google account'],
  ['search_drive', 'Find the launch plan in my Google Drive'],
  ['create_drive_folder', 'Create a Google Drive folder called Q3 Launch'],
  ['share_drive_file', 'Share the Q3 Launch folder with alice@example.com as editor'],
  ['manage_docs', 'Create a Google Doc called Launch Notes'],
  ['manage_sheets', 'Create a Google Sheet called Budget Tracker'],
  ['manage_slides', 'Create Google Slides called Investor Update'],
  ['upload_to_drive', 'Upload this PDF to my Google Drive', {
    contextHints: { hasDocumentAttachment: true },
    recentMessages: history('Document received: report.pdf'),
  }],
  ['manage_google_tasks', 'Add submit report to my Google Tasks'],
  ['search_google_contacts', "Find Alice's email in my Google contacts"],
  ['manage_labels', 'Mark the first inbox email as read'],
  ['manage_email_automation', 'Enable automatic email labeling'],
  ['track_email_reply', 'Notify me if Alice does not reply to my last email'],
  ['connect_outlook', 'Connect my Outlook account'],
  ['disconnect_outlook', 'Disconnect my Outlook account'],
  ['connect_apple', 'Connect my Apple Calendar'],
  ['disconnect_apple', 'Disconnect my Apple Calendar'],
  ['manage_sales', 'Add lead John from Acme to my sales pipeline'],
  ['handle_sales_email_confirmation', 'Send that sales email', {
    recentMessages: history('Sales email draft ready for John. Send it?'),
    contextHints: { lastBotAction: { action: 'sales_email_confirm' } },
  }],
  ['web_search', 'Search the web for the latest AMD news'],
  ['set_timezone', 'Set my timezone to Asia/Kolkata'],
  ['view_timezone', "What's my timezone?"],
  ['link_account', 'Link my Discord account'],
  ['translate_text', 'Translate good morning to French'],
  ['export_data', 'Export all my Ari data'],
  ['show_version', "What's new in this version?"],
  ['show_help', 'What can you do?'],
  ['clear_chat_history', 'Clear our chat history'],
  ['focus_mode', 'Start a 25 minute focus session'],
  ['manage_habits', 'Track habit: drink water'],
  ['manage_expenses', 'Log expense: 500 rupees for lunch'],
  ['track_time', 'Start tracking time for client work'],
  ['manage_follow_ups', 'Follow up with Rahul about the proposal on Friday'],
  ['manage_reading_list', 'Save https://example.com/article to my reading list'],
  ['quick_note_docs', 'Append to my notes doc: launch went well'],
  ['personal_standup', 'Log my standup: finished API, next build the UI'],
  ['manage_shared_board', 'Create a project board called Q3 Launch'],
  ['manage_knowledge_base', 'Add to the knowledge base: deploy with Docker Compose'],
  ['manage_sprints', 'Create a sprint called Q3 Launch'],
  ['manage_incidents', 'Report a critical incident: the API is down'],
  ['team_analytics', "Show this week's team performance report"],
  ['meeting_minutes', 'Show action items from the last meeting'],
  ['update_reminder', 'Move that reminder to 5pm', {
    recentMessages: history('Reminder set: call mom tomorrow at 4pm.'),
    contextHints: { lastBotAction: { action: 'reminder' } },
  }],
  ['news_deep_dive', 'Tell me more about news story 2', {
    recentMessages: history('Top news: 1. Story A 2. Story B 3. Story C'),
    contextHints: { lastBotAction: { action: 'briefing' } },
  }],
  ['briefing_toggle', 'Turn on my automatic morning briefing'],
  ['request_clarification', 'Tomorrow at 5pm with Rahul'],
];

function normalizeExpected(expected) {
  return Array.isArray(expected) ? expected : [expected];
}

async function main() {
  const registered = new Set(getToolDefinitions().map(tool => tool.function.name));
  const covered = new Set(CASES.flatMap(([expected]) => normalizeExpected(expected)));
  const uncovered = [...registered].filter(name => !covered.has(name));
  if (uncovered.length) {
    throw new Error(`Eval cases missing registered tools: ${uncovered.join(', ')}`);
  }

  const results = [];
  for (const [expectedValue, message, options = {}] of CASES) {
    const expected = normalizeExpected(expectedValue);
    const started = Date.now();
    try {
      const result = await aiService.detectIntent(message, {
        recentMessages: [],
        contextHints: {},
        ...options,
      });
      const actual = result?.toolName || null;
      results.push({
        pass: expected.includes(actual),
        expected,
        actual,
        message,
        intent: result?.type || null,
        params: result?.params || null,
        ms: Date.now() - started,
      });
    } catch (error) {
      results.push({
        pass: false,
        expected,
        actual: null,
        message,
        error: error.message,
        status: error.response?.status || null,
        ms: Date.now() - started,
      });
    }

    const latest = results[results.length - 1];
    console.log(`${latest.pass ? 'PASS' : 'FAIL'} ${expected.join('|')} <- ${latest.actual || latest.error || 'no tool'} :: ${message}`);
  }

  const failures = results.filter(result => !result.pass);
  console.log('\n' + JSON.stringify({
    model: process.env.MODEL_INTENT_PRIMARY || null,
    total: results.length,
    passed: results.length - failures.length,
    failed: failures.length,
    failures,
  }, null, 2));

  process.exitCode = failures.length ? 1 : 0;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
