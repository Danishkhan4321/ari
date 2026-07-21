'use strict';

/**
 * PHASE 0 GOLDEN TEST HARNESS — Intent Detection Regression Suite
 *
 * 25 hand-curated test cases that lock in routing decisions we've verified
 * manually over the past week. Run before/after every prompt change to make
 * sure we don't regress.
 *
 * Coverage:
 *   - Lead-verb routing (calendar vs email, the big April 2026 bug)
 *   - Single-word context-resolution ("all" / "1" / "yes" with prior list)
 *   - Dashboard / subscription / web_search HARD-FORCE rules
 *   - Implicit reminders (action + future time, no "remind" word)
 *   - Memory saves / contact saves
 *   - Pure chat (no tool — must NOT misroute to dashboard/web_search)
 *   - Hinglish lead-verb + delegation
 *   - Anaphora ("actually make it 5pm" / "delete that")
 *
 * Run:    node scripts/test-intent-golden-set.js
 * Exit:   0 when all PASS, 1 when any FAIL.
 *
 * Each test:
 *   { msg: <user message>,
 *     expected: <tool name | null>,
 *     acceptable: [<alt tool names>] (optional),
 *     history: [{role, content}] (optional, for context-dependent tests),
 *     label: <short description> }
 */

require('dotenv').config();

const TEST_PHONE = '_intent_golden_test_';

// History fixtures — synthetic conversation context for tests that need it.
const reminderListHistory = [
  { role: 'user', content: 'show my reminders' },
  { role: 'assistant', content: '⏰ Your reminders:\n\n1. Call mom — 5:00 PM today\n2. Take medicine — 9:00 PM today\n3. Pay rent — tomorrow 10:00 AM\n\nReply with a number to cancel one.' },
];

const newsListHistory = [
  { role: 'user', content: 'daily briefing' },
  { role: 'assistant', content: '📰 Top stories today:\n\n1. RBI holds rates steady\n2. ISRO announces lunar mission date\n3. Monsoon arrives early in Kerala\n\nReply "know more about N" for the full story.' },
];

const emailListHistory = [
  { role: 'user', content: 'show my recent emails' },
  { role: 'assistant', content: '📧 Recent emails:\n\n1. Sarah Chen — Q3 deck review (2h ago)\n2. Acme HR — Interview confirmation (5h ago)\n3. GitHub — security alert (1d ago)\n\nReply with a number to read.' },
];

const calendarConfirmHistory = [
  { role: 'user', content: 'meeting with rahul tomorrow at 3pm' },
  { role: 'assistant', content: '📅 Confirm calendar event:\n• Meeting with Rahul\n• Tomorrow, 3:00 PM\n• Duration: 30 min\n\nReply YES to confirm or NO to cancel.' },
];

const reminderCreatedHistory = [
  { role: 'user', content: 'remind me to call john at 5pm' },
  { role: 'assistant', content: '✅ Reminder set: "call john" at 5:00 PM today.' },
];

const calendarCreatedHistory = [
  { role: 'user', content: 'meeting with priya tomorrow at 4pm' },
  { role: 'assistant', content: '✅ Calendar event created: "Meeting with Priya" tomorrow at 4:00 PM.' },
];

// ─── 25 Golden Test Cases ──────────────────────────────────────────────
const tests = [
  // ── A. Lead-verb routing: calendar vs email (April 2026 bug) ──
  {
    msg: 'schedule meeting tomorrow 3pm with john@example.com about Q3 review',
    expected: 'create_calendar_event',
    label: 'A1: lead "schedule" + email attendee → calendar (NOT email)',
  },
  {
    msg: 'book a call with priya@example.com Friday 5pm',
    expected: 'create_calendar_event',
    label: 'A2: lead "book a call" + email attendee → calendar',
  },
  {
    msg: "send a mail to test@example.com, let's schedule a meeting tomorrow at 10:00 to discuss budget",
    expected: 'send_email',
    label: 'A3: lead "send mail", "schedule meeting" in body → email (NOT calendar)',
  },
  {
    msg: 'email rahul about the friday deadline',
    expected: 'send_email',
    label: 'A4: lead "email" + recipient + "about" body → email',
  },
  {
    msg: 'send email at 9am tomorrow to john@example.com',
    expected: 'schedule_email',
    acceptable: ['send_email'],
    label: 'A5: time directly modifies SEND verb → schedule_email',
  },

  // ── B. Single-word context-resolution ──
  // (B1 used to target the visa list — feature removed Apr 30 2026; the
  // stale case expected visa_batch_send, a tool that no longer exists.)
  {
    msg: 'cancel the 2nd one',
    history: reminderListHistory,
    expected: 'cancel_reminder',
    acceptable: ['update_reminder', 'delete_dashboard_item'],
    label: 'B1: "cancel the 2nd one" after reminder list → cancel_reminder',
  },
  {
    msg: '1',
    history: emailListHistory,
    expected: 'check_inbox',
    acceptable: ['search_inbox', 'email_query', 'read_email'],
    label: 'B2: "1" after email list → email read action',
  },
  {
    msg: 'yes',
    history: calendarConfirmHistory,
    expected: 'handle_calendar_confirmation',
    acceptable: [null, 'create_calendar_event'],
    label: 'B3: "yes" with active calendar confirm → confirmation handler (or null+confirm flow)',
  },
  {
    msg: 'all',
    history: [],
    expected: null,
    label: 'B4: "all" with NO list context → null (must NOT route to view_dashboard)',
    // strictNotIn = these are the hallucination targets; if LLM picks one, FAIL
    // regardless of the expected/acceptable arrays.
    strictNotIn: ['view_dashboard', 'web_search', 'set_reminder'],
  },

  // ── C. Dashboard ──
  {
    msg: 'dashboard',
    expected: 'view_dashboard',
    label: 'C1: bare "dashboard" → view_dashboard',
  },
  {
    msg: 'show my dashboard',
    expected: 'view_dashboard',
    label: 'C2: "show my dashboard" → view_dashboard',
  },

  // ── D. Implicit reminders (no "remind" keyword) ──
  {
    msg: 'call mahaprasad at 11',
    expected: 'set_reminder',
    acceptable: ['create_calendar_event'],
    label: 'D1: action + future time → set_reminder (or calendar)',
  },
  {
    msg: 'gym tomorrow 6am',
    expected: 'set_reminder',
    acceptable: ['create_calendar_event'],
    label: 'D2: activity + tomorrow + time → set_reminder',
  },
  {
    msg: 'pay electricity bill by monday',
    expected: 'set_reminder',
    label: 'D3: bill + by-deadline → set_reminder',
  },

  // ── E. Web search (real-time data) ──
  {
    msg: 'weather in mumbai',
    expected: 'web_search',
    label: 'E1: weather query → web_search',
  },
  {
    msg: 'price of bitcoin today',
    expected: 'web_search',
    label: 'E2: live price query → web_search',
  },

  // ── F. Pure chat (must NOT route) ──
  {
    msg: 'thanks!',
    expected: null,
    label: 'F1: "thanks!" → null (no tool)',
    strictNotIn: ['view_dashboard', 'web_search', 'set_reminder', 'send_email'],
  },
  {
    msg: "how's life going",
    expected: null,
    label: 'F2: casual chat → null',
    strictNotIn: ['view_dashboard', 'web_search', 'set_reminder'],
  },

  // ── H. Memory / contact ──
  {
    msg: 'my wifi password is iloveindia123',
    expected: 'save_memory',
    label: 'H1: factual statement → save_memory',
  },
  {
    msg: "rohan's number is +919876543210",
    expected: 'save_contact',
    acceptable: ['save_memory'],
    label: 'H2: name + phone → save_contact',
  },

  // ── I. Hinglish ──
  {
    msg: 'kal 11am pe rahul@example.com se meeting set karo',
    expected: 'create_calendar_event',
    label: 'I1: Hinglish "set karo" + meeting + email → calendar',
  },
  {
    msg: 'rahul ko bolo meeting 3 baje hai',
    expected: 'delegate_message',
    acceptable: ['set_reminder', 'create_calendar_event'],
    label: 'I2: Hinglish "rahul ko bolo" → delegate_message',
  },

  // ── J. Anaphora (modify previous item) ──
  {
    msg: 'actually make it 5pm',
    history: calendarCreatedHistory,
    expected: 'reschedule_calendar_event',
    acceptable: ['create_calendar_event', 'update_reminder'],
    label: 'J1: "actually make it 5pm" after calendar create → reschedule',
  },
  {
    msg: 'delete that',
    history: reminderCreatedHistory,
    expected: 'cancel_reminder',
    acceptable: ['delete_dashboard_item'],
    label: 'J2: "delete that" after reminder create → cancel_reminder',
  },

  // ── K. Casual WhatsApp: typos, slang, Hinglish fragments, short replies ──
  // Added Jul 2026 with the v3 intent prompt. These lock in "read for meaning,
  // not keywords" behavior on realistic message shapes.
  {
    msg: 'remnd me abt d visa docs kal',
    expected: 'set_reminder',
    label: 'K1: heavy typos + abbreviations → set_reminder',
  },
  {
    msg: 'shoot raj a mail abt the delay',
    expected: 'send_email',
    acceptable: ['delegate_message'],
    label: 'K2: slang "shoot a mail" → send_email',
  },
  {
    msg: 'shedule a meting tomorow at 2 wth priya',
    expected: 'create_calendar_event',
    acceptable: ['set_reminder'],
    label: 'K3: misspelled schedule/meeting → calendar',
  },
  {
    msg: '2',
    history: reminderListHistory,
    expected: 'cancel_reminder',
    acceptable: ['update_reminder', 'view_reminders', 'delete_dashboard_item'],
    label: 'K4: bare "2" after reminder list → act on reminder #2 (not chat)',
  },
  {
    msg: 'ya do it',
    history: calendarConfirmHistory,
    expected: 'handle_calendar_confirmation',
    acceptable: [null, 'create_calendar_event'],
    label: 'K5: "ya do it" with active calendar confirm → confirmation flow',
  },
  {
    msg: 'kal 5 baje rahul',
    expected: 'request_clarification',
    acceptable: ['set_reminder', 'create_calendar_event'],
    label: 'K6: ambiguous fragment → ask, not guess (clarification preferred)',
    strictNotIn: ['send_email', 'delegate_message', 'web_search'],
  },
  {
    msg: 'usko cancel kar do',
    history: reminderCreatedHistory,
    expected: 'cancel_reminder',
    acceptable: ['update_reminder'],
    label: 'K7: Hinglish anaphora "usko cancel" after reminder → cancel_reminder',
  },
  {
    msg: 'boss ko mail bhej de ki main late aaunga',
    expected: 'send_email',
    acceptable: ['delegate_message'],
    label: 'K8: Hinglish verb-final "mail bhej de" → send_email',
  },
  {
    msg: 'tell me more about story 2',
    history: newsListHistory,
    expected: 'news_deep_dive',
    label: 'K9: "tell me more about story 2" after news list → news_deep_dive (not delegation)',
  },
  {
    msg: 'bore ho raha hu yaar',
    expected: null,
    strictNotIn: ['view_dashboard', 'web_search', 'set_reminder', 'send_email'],
    label: 'K10: Hinglish chit-chat → null (no tool)',
  },
];

// ─── Runner ────────────────────────────────────────────────────────────
(async () => {
  const aiService = require('../src/services/ai.service');

  let passed = 0;
  let partial = 0;  // ← matched an "acceptable" alt but not the primary expected
  let failed = 0;
  const failures = [];

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  GOLDEN INTENT TEST  —  ${tests.length} cases`);
  console.log(`  Model: ${process.env.MODEL_INTENT_PRIMARY || process.env.OPENAI_MODEL_FAST || 'default'}`);
  console.log(`  Prompt: ${process.env.INTENT_PROMPT_VERSION || 'v3 (default)'}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (let i = 0; i < tests.length; i++) {
    const tc = tests[i];
    const idx = String(i + 1).padStart(2, '0');
    let result;
    try {
      result = await aiService.detectIntent(tc.msg, {
        userPhone: TEST_PHONE,
        recentMessages: tc.history || [],
      });
    } catch (e) {
      console.log(`⚠️  ${idx}. ${tc.label}`);
      console.log(`     ERROR: ${e.message}\n`);
      failed++;
      failures.push({ idx, label: tc.label, expected: tc.expected, got: `ERROR: ${e.message}` });
      continue;
    }

    const got = result?.toolName || null;
    const accepts = [tc.expected, ...(tc.acceptable || [])];
    const isPrimaryMatch = got === tc.expected;
    const isAcceptable = accepts.includes(got);
    const violatesStrict = tc.strictNotIn && tc.strictNotIn.includes(got);

    let status;
    if (violatesStrict) {
      status = 'FAIL'; // Strict-not-in violation overrides
    } else if (isPrimaryMatch) {
      status = 'PASS';
    } else if (isAcceptable) {
      status = 'PARTIAL';
    } else {
      status = 'FAIL';
    }

    const icon = status === 'PASS' ? '✅' : status === 'PARTIAL' ? '🟡' : '❌';
    console.log(`${icon} ${idx}. ${tc.label}`);
    console.log(`     msg:      "${tc.msg.slice(0, 100)}${tc.msg.length > 100 ? '…' : ''}"`);
    console.log(`     expected: ${tc.expected ?? 'null (no tool)'}${tc.acceptable ? ` (accept: ${tc.acceptable.join(', ')})` : ''}`);
    console.log(`     got:      ${got ?? 'null (no tool)'}`);
    if (tc.history && tc.history.length) {
      console.log(`     ctx:      ${tc.history.length} prior turn(s)`);
    }
    console.log();

    if (status === 'PASS') passed++;
    else if (status === 'PARTIAL') partial++;
    else {
      failed++;
      failures.push({ idx, label: tc.label, expected: tc.expected, got });
    }
  }

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  RESULTS:  ${passed} PASS  |  ${partial} PARTIAL  |  ${failed} FAIL  (${tests.length} total)`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (failures.length) {
    console.log('FAILURES:');
    for (const f of failures) {
      console.log(`  ❌ ${f.idx}. ${f.label}`);
      console.log(`       expected: ${f.expected ?? 'null'}, got: ${f.got ?? 'null'}`);
    }
    console.log();
  }

  // Exit 0 only when zero outright FAILs. PARTIALs are warning-level —
  // the suite reports them, but doesn't block CI on alt-acceptable matches.
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => {
  console.error('TOP-LEVEL ERROR:', e.message, e.stack);
  process.exit(2);
});
