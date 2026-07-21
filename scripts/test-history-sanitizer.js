'use strict';

// Standalone test for the assistant-history sanitizer.
//
// Why this exists: even after history-session-filter cuts cross-day bleed,
// within-session prior assistant replies still contain `Example: "Remind X:
// <title>"` lines. The LLM splices fragments from those examples into fresh
// clarifications (the "kainsl vn en too" hallucination class). The system
// prompt already has a TEMPLATE-FILLING RULE forbidding this, but LLMs
// ignore it because the prior content is right there in the messages
// array, demonstrating the pattern.
//
// The sanitizer strips Example/Try/Like lines from PRIOR assistant turns
// only. User turns are never modified — that would corrupt context. The
// current turn isn't touched either.

const { sanitizeAssistantHistoryForLLM, stripExampleLines } =
  require('../src/utils/history-sanitizer');

let passed = 0;
let failed = 0;

function assertEqual(actual, expected, name) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`  expected: ${e}`);
    console.log(`  actual:   ${a}`);
  }
}

// ─── stripExampleLines: targeted line removal ─────────────────────────
assertEqual(
  stripExampleLines('Okay, who should I remind?\nExample: "Remind Sneha: kainsl vn en too at 2pm"'),
  'Okay, who should I remind?',
  'A1: strip simple Example line'
);

assertEqual(
  stripExampleLines('Sure! When?\nExample: "Remind me in 30 min"\nLet me know.'),
  'Sure! When?\nLet me know.',
  'A2: strip Example sandwiched between content'
);

assertEqual(
  stripExampleLines('Try: "set a reminder at 5pm"\nThanks!'),
  'Thanks!',
  'A3: strip "Try:" prefix'
);

assertEqual(
  stripExampleLines('Like: "Remind X at Y"\nDone!'),
  'Done!',
  'A4: strip "Like:" prefix'
);

assertEqual(
  stripExampleLines('For example: "Remind Bob at 5pm"\nThis works.'),
  'This works.',
  'A5: strip "For example:" prefix'
);

assertEqual(
  stripExampleLines('  Example: "lower-case match"\nbody'),
  'body',
  'A6: strip Example with leading whitespace'
);

assertEqual(
  stripExampleLines('Plain text with no examples.\nJust normal content.'),
  'Plain text with no examples.\nJust normal content.',
  'A7: pass-through when no Example: pattern'
);

assertEqual(
  stripExampleLines('Line 1\n\n\n\nLine 2'),
  'Line 1\n\nLine 2',
  'A8: collapse triple+ newlines down to double'
);

assertEqual(
  stripExampleLines(''),
  '',
  'A9: empty string passes through'
);

assertEqual(
  stripExampleLines('I\'ll send an email to alice@example.com'),
  'I\'ll send an email to alice@example.com',
  'A10: do not strip lines that just contain "example.com" or other noise'
);

// ─── sanitizeAssistantHistoryForLLM: only assistant turns, only Example lines ──
assertEqual(
  sanitizeAssistantHistoryForLLM([
    { role: 'user', content: 'Example: "user typed this"' },
    { role: 'assistant', content: 'Got it.\nExample: "Remind X at Y"' },
    { role: 'user', content: 'cool' },
  ]),
  [
    { role: 'user', content: 'Example: "user typed this"' },        // user untouched
    { role: 'assistant', content: 'Got it.' },                       // example stripped
    { role: 'user', content: 'cool' },
  ],
  'B1: strips assistant Example lines, leaves user turns intact'
);

assertEqual(
  sanitizeAssistantHistoryForLLM([
    { role: 'assistant', content: 'When should I remind you?\nExample: "in 30 minutes to call mom"' },
    { role: 'user', content: 'in 1 hour' },
    { role: 'assistant', content: 'Reminder set for 1 hour from now.' },
  ]),
  [
    { role: 'assistant', content: 'When should I remind you?' },
    { role: 'user', content: 'in 1 hour' },
    { role: 'assistant', content: 'Reminder set for 1 hour from now.' },
  ],
  'B2: typical reminder-clarification flow — only the example line is removed'
);

assertEqual(
  sanitizeAssistantHistoryForLLM([]),
  [],
  'B3: empty array → []'
);

assertEqual(
  sanitizeAssistantHistoryForLLM(null),
  [],
  'B4: null → [] (defensive)'
);

assertEqual(
  sanitizeAssistantHistoryForLLM([
    { role: 'assistant', content: null },
    { role: 'assistant', content: '' },
  ]),
  [
    { role: 'assistant', content: null },
    { role: 'assistant', content: '' },
  ],
  'B5: missing/empty content passes through unchanged'
);

// ─── Don't break system messages or unknown roles ────────────────────
assertEqual(
  sanitizeAssistantHistoryForLLM([
    { role: 'system', content: 'Previous summary: Example: stay calm' },
    { role: 'assistant', content: 'okay\nExample: "stripped"' },
  ]),
  [
    { role: 'system', content: 'Previous summary: Example: stay calm' },  // system untouched
    { role: 'assistant', content: 'okay' },
  ],
  'C1: system role untouched (only assistant turns are sanitized)'
);

console.log('\n────────────────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
