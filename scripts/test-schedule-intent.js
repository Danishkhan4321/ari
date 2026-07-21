'use strict';

// Standalone test for isScheduleIntentText — the regex that decides whether
// "send email to X about Y at Z" should route to email_schedule (future send)
// or email_send (immediate). The function lives on the WebhookController
// class but is pure (depends only on `text`), so we extract it for testing.
//
// Bug regression we're locking in (Apr 2026):
// "send email to X about kickoff is tomorrow at 3pm" was matching "tomorrow"
// even though it's part of body content, and incorrectly routing to schedule.
//
// Run: node scripts/test-schedule-intent.js

// We re-implement the function inline (mirrors webhook.controller.js exactly)
// so this test is self-contained and runs without booting the bot.
function isScheduleIntentText(text) {
  // Apr 2026 v2: schedule keyword is now ALSO prefix-only. Comma + "to discuss/to go over"
  // added to body introducers so common phrasings split correctly.
  const lower = (text || '').toLowerCase();
  const bodyIntroducers = /\b(?:about|regarding|saying|mentioning|that\s+(?:the|i|we|she|he|it|they)|telling|informing|with\s+(?:subject|the\s+message)|to\s+say|to\s+tell|to\s+discuss|to\s+go\s+over|asking|letting\s+\w+\s+know)\b|,/;
  const prefix = lower.split(bodyIntroducers)[0];
  if (/\b(schedule|scheduled|send\s+later|delay)\b/.test(prefix)) return true;
  return /\b(at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|today|tomorrow|next\s+\w+|on\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|every\s+(?:day|weekday|weekend|week)|daily|weekly|weekdays|weekends)\b/.test(prefix);
}

let passed = 0;
let failed = 0;
function expect(input, want, label) {
  const got = isScheduleIntentText(input);
  if (got === want) {
    passed++;
    console.log(`PASS  ${label}`);
  } else {
    failed++;
    console.log(`FAIL  ${label}`);
    console.log(`  input:    ${JSON.stringify(input)}`);
    console.log(`  expected: ${want}, got: ${got}`);
  }
}

// ─── REGRESSION: original bug case must NOT match ──────────────────────
expect(
  'send email to test@example.com about Welcome to Acme Corp onboarding kickoff is tomorrow at 3pm I have set up a shared drive folder for our documents',
  false,
  'REGRESSION v1: "send email about kickoff tomorrow at 3pm" → immediate (false)'
);

// ─── REGRESSION v2 (Apr 2026): comma-separated body with "schedule" in body ──
// User: "send a mail to X, let's schedule a meeting tomorrow at 10:00 to discuss budget"
// LLM picks send_email correctly. BEFORE this fix, the regex matched "schedule"
// in the body and overrode the LLM, routing to schedule_email instead. Now the
// comma + "to discuss" both act as body introducers and "schedule" is prefix-only.
expect(
  "send a mail to test@example.com, let's schedule a meeting tomorrow at 10:00 to discuss about budget",
  false,
  'REGRESSION v2: "send mail, let\'s schedule meeting tomorrow at 10..." → immediate (false)'
);
expect(
  'email priya, let\'s schedule a sync next week',
  false,
  'REGRESSION v2: comma + body "schedule a sync" → immediate (false)'
);
expect(
  'mail john to discuss scheduling Q3 review tomorrow',
  false,
  'REGRESSION v2: "to discuss" introducer with body schedule + tomorrow → immediate (false)'
);
expect(
  'send email to bob to go over the budget tomorrow',
  false,
  'REGRESSION v2: "to go over" introducer with body tomorrow → immediate (false)'
);

// ─── More body-content traps that should NOT match ─────────────────────
expect('send email to john about meeting tomorrow at 3pm', false, 'body: meeting tomorrow at 3pm → false');
expect('email priya about Q3 deadline next Friday', false, 'body: deadline next Friday → false');
expect('mail bob saying call is at 5pm', false, 'body: call is at 5pm → false');
expect('send email to mom saying happy birthday tomorrow', false, 'body: happy birthday tomorrow → false');
expect('email john about the kickoff every monday', false, 'body: every monday → false');
expect('send mail to sarah regarding Q4 planning on Friday', false, 'regarding: Q4 planning on Friday → false');

// ─── Happy path: legit schedule intent MUST still match ────────────────
expect('schedule an email to john for tomorrow', true, 'explicit "schedule" verb → true');
expect('schedule a follow-up email to alice for Monday', true, 'explicit schedule + day → true');
expect('send email to john at 9am tomorrow', true, 'send X at 9am tomorrow → true');
expect('email priya on Monday morning', true, 'email Y on Monday → true');
expect('send email to alice tomorrow about Q3', true, 'send tomorrow before "about" → true');
expect('send email at 5pm to bob', true, 'send at 5pm before recipient → true');
expect('send mail to john next Friday about deadline', true, 'send next Friday before about → true');
expect('send later this email to bob', true, '"send later" literal phrase → true');
expect('send the email later', false, 'words between "send" and "later" → false (matches original behavior)');

// ─── Edge cases ────────────────────────────────────────────────────────
expect('', false, 'empty string → false');
expect(null, false, 'null → false');
expect('send email to john', false, 'plain immediate send, no time → false');
expect('schedule email about meeting', true, 'explicit schedule even with body → true');
expect('show scheduled emails', true, 'scheduled (status query) → true (caller dispatches differently)');

console.log('\n────────────────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
