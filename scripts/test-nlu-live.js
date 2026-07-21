'use strict';

/**
 * LIVE NLU verification — casual WhatsApp messages against the REAL
 * detectIntent pipeline (production prompt, tool subsetting, retry logic,
 * real LLM). Run on the production box for a true end-to-end reading:
 *
 *   node scripts/test-nlu-live.js
 *
 * Focus: typos, slang, short replies, incomplete sentences, multi-turn
 * context, and SAFETY on requests that have no matching tool (the bot must
 * not guess). Complements scripts/test-intent-golden-set.js.
 *
 * Exit: 0 when zero FAILs, 1 otherwise.
 */

require('dotenv').config();

const TEST_PHONE = '_nlu_live_test_';

// ─── History fixtures ────────────────────────────────────────────────────
const reminderCreated = [
  { role: 'user', content: 'remind me to call the plumber at 7' },
  { role: 'assistant', content: '✅ Reminder set: "call the plumber" at 7:00 PM today.' },
];

const emailListShown = [
  { role: 'user', content: 'check my inbox' },
  { role: 'assistant', content: '📧 Recent emails:\n\n1. Amazon — Your order has shipped (1h ago)\n2. HR — Offsite agenda (3h ago)\n3. GitHub — security alert (1d ago)\n\nReply with a number to read.' },
];

const calendarConfirmPending = [
  { role: 'user', content: 'set up a call with vikram tomorrow at 4' },
  { role: 'assistant', content: '📅 Confirm calendar event:\n• Call with Vikram\n• Tomorrow, 4:00 PM\n• Duration: 30 min\n\nReply YES to confirm or NO to cancel.' },
];

const clarifyAsked = [
  { role: 'user', content: 'kal 5 baje rahul' },
  { role: 'assistant', content: 'Kal 5 baje Rahul ke saath — what would you like me to do?\n\n1. Book a meeting\n2. Set a reminder\n3. Send him a message\n\n_Reply with a number or just tell me._' },
];

const emailDraftShown = [
  { role: 'user', content: 'email priya about the q3 numbers' },
  { role: 'assistant', content: '✉️ Draft email to Priya:\n\nSubject: Q3 Numbers\n\nHi Priya,\n\nSharing a quick note on the Q3 numbers — overall revenue tracked 12% above plan, with services leading the beat. Let me know if you want the detailed breakdown.\n\nBest,\nD\n\nReply *yes* to send, *no* to cancel, or *edit* to change it.' },
];

// ─── Test cases ──────────────────────────────────────────────────────────
// { msg, history?, expected, acceptable?, strictNotIn?, label, note? }
// expected/acceptable are TOOL names (null = correctly no tool → chat).
const tests = [

  // ── A. The user's exact examples ──
  {
    msg: 'book me appointment tomorrow',
    expected: 'create_calendar_event',
    acceptable: ['set_reminder', 'request_clarification'],
    strictNotIn: ['send_email', 'web_search', 'delegate_message'],
    label: 'A1: "book me appointment tomorrow" (no time given)',
  },
  {
    msg: 'can u remind me later',
    expected: 'set_reminder',
    acceptable: ['request_clarification'],
    strictNotIn: ['web_search', 'delegate_message', 'view_dashboard'],
    label: 'A2: "can u remind me later" (no time, no content)',
  },
  {
    msg: "what's my order status",
    expected: null,
    acceptable: ['request_clarification', 'check_inbox', 'search_inbox', 'email_query'],
    strictNotIn: ['view_dashboard', 'manage_tasks', 'web_search'],
    label: 'A3: "what\'s my order status" (NO order tool exists — must not guess)',
    note: 'checking the inbox for order emails is acceptable; dashboard is the classic keyword-match failure',
  },
  {
    msg: 'talk to support',
    expected: null,
    acceptable: ['show_help', 'request_clarification'],
    strictNotIn: ['delegate_message', 'send_email', 'web_search'],
    label: 'A4: "talk to support" (NO support tool — must not message a random contact)',
  },
  {
    msg: 'cancel it',
    expected: 'request_clarification',
    acceptable: [null],
    strictNotIn: ['cancel_reminder', 'cancel_calendar_event', 'clear_chat_history', 'briefing_toggle'],
    label: 'A5: "cancel it" with NO context (nothing to resolve "it")',
  },
  {
    msg: 'yes',
    expected: null,
    strictNotIn: ['view_dashboard', 'web_search', 'set_reminder'],
    label: 'A6: bare "yes" with NO context → no tool (deterministic guard)',
  },
  {
    msg: 'ok do it',
    expected: null,
    acceptable: ['request_clarification'],
    strictNotIn: ['view_dashboard', 'web_search', 'set_reminder', 'send_email'],
    label: 'A7: "ok do it" with NO context',
  },

  // ── B. Typos & slang ──
  {
    msg: 'remnd me tmrw abt d electricity bill',
    expected: 'set_reminder',
    label: 'B1: heavy typos → set_reminder',
  },
  {
    msg: 'shedule metting w john nxt tue 3pm',
    expected: 'create_calendar_event',
    acceptable: ['set_reminder'],
    label: 'B2: "shedule metting" typos → calendar',
  },
  {
    msg: 'wats d weather in delhi rn',
    expected: 'web_search',
    label: 'B3: slang weather query → web_search',
  },
  {
    msg: 'sve dis number 9876543210 as ramesh',
    expected: 'save_contact',
    acceptable: ['save_memory'],
    label: 'B4: "sve dis number" → save_contact',
  },
  {
    msg: 'yo bro wassup',
    expected: null,
    strictNotIn: ['web_search', 'view_dashboard', 'set_reminder', 'daily_briefing'],
    label: 'B5: pure slang greeting → no tool',
  },
  {
    msg: 'gimme my remindrs',
    expected: 'view_reminders',
    acceptable: ['view_dashboard'],
    label: 'B6: "gimme my remindrs" → view_reminders',
  },
  {
    msg: 'email boss im sick today wont come',
    expected: 'send_email',
    acceptable: ['delegate_message'],
    label: 'B7: terse sick-day email → send_email',
  },

  // ── C. Incomplete sentences / missing details ──
  {
    msg: 'meeting with',
    expected: 'request_clarification',
    acceptable: [null],
    strictNotIn: ['create_calendar_event', 'send_email', 'web_search'],
    label: 'C1: "meeting with" (cut-off fragment) → ask, don\'t book',
  },
  {
    msg: 'send email to',
    expected: 'request_clarification',
    acceptable: [null, 'send_email'],
    strictNotIn: ['web_search', 'delegate_message'],
    label: 'C2: "send email to" (no recipient/content)',
    note: 'send_email acceptable only because its handler asks for missing fields',
  },
  {
    msg: 'kal 5 baje rahul',
    expected: 'request_clarification',
    acceptable: ['set_reminder', 'create_calendar_event'],
    strictNotIn: ['send_email', 'delegate_message', 'web_search'],
    label: 'C3: Hinglish fragment "kal 5 baje rahul" → clarify preferred',
  },

  // ── D. Multi-turn context ──
  {
    msg: 'cancel it',
    history: reminderCreated,
    expected: 'cancel_reminder',
    acceptable: ['update_reminder'],
    label: 'D1: "cancel it" right after a reminder was created',
  },
  {
    msg: 'actually 8 not 7',
    history: reminderCreated,
    expected: 'update_reminder',
    acceptable: ['reschedule_calendar_event', 'set_reminder'],
    label: 'D2: "actually 8 not 7" after reminder create → update time',
  },
  {
    msg: '2',
    history: emailListShown,
    expected: 'check_inbox',
    acceptable: ['search_inbox', 'email_query'],
    label: 'D3: bare "2" after inbox list → read email 2',
  },
  {
    msg: 'yes',
    history: calendarConfirmPending,
    expected: 'handle_calendar_confirmation',
    acceptable: [null, 'create_calendar_event'],
    label: 'D4: "yes" with calendar confirmation pending',
  },
  {
    msg: '1',
    history: clarifyAsked,
    expected: 'create_calendar_event',
    acceptable: ['handle_calendar_confirmation'],
    strictNotIn: ['set_reminder', 'delegate_message', 'news_deep_dive', 'check_inbox'],
    label: 'D5: "1" answering the bot\'s own clarification options (round-trip)',
    note: 'option 1 was "Book a meeting" for "kal 5 baje rahul" — must pick calendar, not option 2/3 tools',
  },
  {
    msg: 'make it shorter n more casual',
    history: emailDraftShown,
    expected: 'send_email',
    acceptable: ['handle_email_confirmation'],
    strictNotIn: ['manage_notes', 'web_search', 'delegate_message'],
    label: 'D6: draft edit "make it shorter n more casual" → stay in email flow',
  },
  {
    msg: 'whats the weather in delhi',
    history: calendarConfirmPending,
    expected: 'web_search',
    label: 'D7: topic switch mid-confirmation → current message wins',
  },
];

// ─── Gate classifier cases (LLM path of classifyConfirmation) ────────────
const gateCases = [
  { text: 'hmm ok go ahead i guess', expect: ['confirm'], label: 'G1: hesitant approval → confirm' },
  { text: 'wait not yet', expect: ['cancel', 'edit', 'new_request'], label: 'G2: "wait not yet" → anything but confirm', mustNotBe: 'confirm' },
  { text: 'change the subject to Q3 update', expect: ['edit'], label: 'G3: inline edit instruction → edit' },
];

// ─── Runner ──────────────────────────────────────────────────────────────
(async () => {
  const aiService = require('../src/services/ai.service');

  let passed = 0, partial = 0, failed = 0;
  const rows = [];

  console.log('═════════════════════════════════════════════════════════════');
  console.log(`  LIVE NLU TEST — ${tests.length} intent cases + ${gateCases.length} gate cases`);
  console.log(`  Prompt: ${process.env.INTENT_PROMPT_VERSION || 'v3 (default)'}`);
  console.log('═════════════════════════════════════════════════════════════\n');

  for (let i = 0; i < tests.length; i++) {
    const tc = tests[i];
    let result;
    try {
      result = await aiService.detectIntent(tc.msg, {
        userPhone: TEST_PHONE,
        recentMessages: tc.history || [],
      });
    } catch (e) {
      failed++;
      rows.push({ label: tc.label, status: 'FAIL', got: `ERROR: ${e.message}` });
      console.log(`⚠️  ${tc.label}\n     ERROR: ${e.message}\n`);
      continue;
    }

    const got = result?.toolName || null;
    const accepts = [tc.expected, ...(tc.acceptable || [])];
    const violates = tc.strictNotIn && tc.strictNotIn.includes(got);
    const status = violates ? 'FAIL' : got === tc.expected ? 'PASS' : accepts.includes(got) ? 'PARTIAL' : 'FAIL';

    if (status === 'PASS') passed++;
    else if (status === 'PARTIAL') partial++;
    else failed++;

    const icon = status === 'PASS' ? '✅' : status === 'PARTIAL' ? '🟡' : '❌';
    const paramsPreview = result?.params
      ? JSON.stringify(Object.fromEntries(Object.entries(result.params).filter(([k]) => k !== 'full_text'))).slice(0, 140)
      : '';
    console.log(`${icon} ${tc.label}`);
    console.log(`     msg:      "${tc.msg}"${tc.history ? `  (+${tc.history.length} ctx turns)` : ''}`);
    console.log(`     expected: ${tc.expected ?? 'null'}${tc.acceptable ? ` (accept: ${tc.acceptable.map(a => a ?? 'null').join(', ')})` : ''}`);
    console.log(`     got:      ${got ?? 'null'}${paramsPreview && paramsPreview !== '{}' ? `  params=${paramsPreview}` : ''}`);
    if (tc.note) console.log(`     note:     ${tc.note}`);
    console.log();
    rows.push({ label: tc.label, status, got });
  }

  console.log('─── Confirmation-gate LLM classifier ───\n');
  let gatePassed = 0, gateFailed = 0;
  for (const gc of gateCases) {
    try {
      const r = await aiService.classifyConfirmation(gc.text, 'email', 'Send email to Priya: "Q3 numbers"');
      const ok = gc.expect.includes(r.decision) && r.decision !== gc.mustNotBe;
      ok ? gatePassed++ : gateFailed++;
      console.log(`${ok ? '✅' : '❌'} ${gc.label}`);
      console.log(`     "${gc.text}" → ${r.decision}${r.edit_instruction ? ` (edit: ${r.edit_instruction})` : ''}\n`);
      rows.push({ label: gc.label, status: ok ? 'PASS' : 'FAIL', got: r.decision });
    } catch (e) {
      gateFailed++;
      console.log(`⚠️  ${gc.label}: ERROR ${e.message}\n`);
    }
  }

  console.log('═════════════════════════════════════════════════════════════');
  console.log(`  INTENT:  ${passed} PASS | ${partial} PARTIAL | ${failed} FAIL  (${tests.length})`);
  console.log(`  GATE:    ${gatePassed} PASS | ${gateFailed} FAIL  (${gateCases.length})`);
  console.log('═════════════════════════════════════════════════════════════');

  process.exit(failed + gateFailed === 0 ? 0 : 1);
})().catch(e => {
  console.error('TOP-LEVEL ERROR:', e.message, e.stack);
  process.exit(2);
});
