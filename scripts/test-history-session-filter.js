'use strict';

// Standalone test for the LLM-history session filter.
//
// What we're locking in:
//   - Continuous chat (small inter-message gaps) → return all
//   - Single message → return as-is
//   - Empty → return []
//   - Two clusters separated by > sessionGap → drop the older cluster
//   - Multiple gaps → keep only the most recent session (everything after
//     the LAST gap > sessionGap)
//   - Custom session-gap parameter respected
//
// Run with: node scripts/test-history-session-filter.js

const { filterToCurrentSession } = require('../src/utils/history-session-filter');

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

const NOW = Date.parse('2026-04-27T14:00:00Z');
const min = (m) => new Date(NOW - m * 60_000).toISOString();

const msg = (role, content, minutesAgo) => ({
  role,
  content,
  created_at: min(minutesAgo),
});

// ─── Continuous chat: no gaps > 60 min → return all ───────────────────
assertEqual(
  filterToCurrentSession([
    msg('user', 'hi', 10),
    msg('assistant', 'hello', 9),
    msg('user', 'set a reminder', 8),
    msg('assistant', 'when?', 7),
  ]).map(m => m.content),
  ['hi', 'hello', 'set a reminder', 'when?'],
  'A1: continuous chat → keep all'
);

// ─── Single message ───────────────────────────────────────────────────
assertEqual(
  filterToCurrentSession([msg('user', 'hi', 5)]).map(m => m.content),
  ['hi'],
  'A2: single message → keep'
);

// ─── Empty / null / undefined ────────────────────────────────────────
assertEqual(filterToCurrentSession([]), [], 'A3: empty array → []');
assertEqual(filterToCurrentSession(null), [], 'A4: null → []');
assertEqual(filterToCurrentSession(undefined), [], 'A5: undefined → []');

// ─── Two sessions: yesterday + today ──────────────────────────────────
// Yesterday's chat (1440 min ago) and today's (5 min ago) — drop yesterday.
assertEqual(
  filterToCurrentSession([
    msg('user', 'cancel 1 & 2', 24 * 60 + 30),       // yesterday 13:30 UTC
    msg('assistant', 'cancelled', 24 * 60 + 29),     // yesterday 13:31 UTC
    msg('user', 'remind me at 3pm', 5),              // today 13:55 UTC
    msg('assistant', 'about what?', 4),              // today 13:56 UTC
  ]).map(m => m.content),
  ['remind me at 3pm', 'about what?'],
  'B1: yesterday + today → only today'
);

// ─── Two sessions, different sizes ────────────────────────────────────
assertEqual(
  filterToCurrentSession([
    msg('user', 'old msg 1', 200),     // 3h20m ago
    msg('user', 'old msg 2', 199),
    msg('user', 'old msg 3', 198),
    msg('user', 'recent', 30),         // 30 min ago — gap from prev = 168 min > 60
    msg('assistant', 'reply', 29),
  ]).map(m => m.content),
  ['recent', 'reply'],
  'B2: 3-msg old session + 2-msg recent → only recent'
);

// ─── Multiple gaps: keep only the latest session ─────────────────────
assertEqual(
  filterToCurrentSession([
    msg('user', 'session 1 msg', 360),    // 6h ago
    msg('user', 'session 2 msg', 240),    // 4h ago (gap 120 min)
    msg('user', 'session 3 msg', 30),     // 30 min ago (gap 210 min)
    msg('assistant', 'session 3 reply', 29),
  ]).map(m => m.content),
  ['session 3 msg', 'session 3 reply'],
  'B3: three sessions → only the latest'
);

// ─── Gap exactly at threshold (60 min) → not a session break ─────────
// > 60 is the threshold, so exactly 60 min should KEEP both.
assertEqual(
  filterToCurrentSession([
    msg('user', 'first', 65),
    msg('user', 'second', 5),     // gap exactly 60 min → keep
  ]).map(m => m.content),
  ['first', 'second'],
  'C1: 60-min gap (boundary) → keep both'
);

// ─── Just over threshold → split ─────────────────────────────────────
assertEqual(
  filterToCurrentSession([
    msg('user', 'first', 66),
    msg('user', 'second', 5),     // gap 61 min → split
  ]).map(m => m.content),
  ['second'],
  'C2: 61-min gap → drop first'
);

// ─── Custom session gap parameter ────────────────────────────────────
assertEqual(
  filterToCurrentSession([
    msg('user', 'first', 20),
    msg('user', 'second', 5),     // gap 15 min — under default 60, over custom 10
  ], 10).map(m => m.content),
  ['second'],
  'D1: custom gap=10min → 15-min gap splits'
);

// ─── Messages without created_at fall through unchanged ──────────────
assertEqual(
  filterToCurrentSession([
    { role: 'user', content: 'no timestamp 1' },
    { role: 'user', content: 'no timestamp 2' },
  ]).map(m => m.content),
  ['no timestamp 1', 'no timestamp 2'],
  'E1: missing timestamps → keep all (defensive)'
);

console.log('\n────────────────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
