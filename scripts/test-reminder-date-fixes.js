// scripts/test-reminder-date-fixes.js
// Unit-tests for the reminder date-parsing fixes:
//   Bug 1: user said "tomorrow" / "kal" / "parso" but LLM dropped it.
//   Bug 2: user said an absolute date ("19th May") — schema now carries it.
//
// We stub `llm.chatCompletion` so the test runs offline and is deterministic.

process.env.NODE_ENV = 'test';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
process.env.MODEL_INTENT_PRIMARY = process.env.MODEL_INTENT_PRIMARY || 'gemini-2.5-flash';

const path = require('path');
const llm = require(path.join('..', 'src', 'services', 'llm-provider'));

// Pre-stub LLM before reminderService imports it.
let stubbedResponse = null;
llm.chatCompletion = async () => ({
  data: {
    choices: [{ message: { content: JSON.stringify(stubbedResponse) } }],
    usage: { prompt_tokens: 0, completion_tokens: 0 }
  }
});

const reminderService = require(path.join('..', 'src', 'services', 'reminder.service'));

const TZ = 'Asia/Kolkata';

// Helpers
function localDateParts(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const parts = {};
  for (const p of dtf.formatToParts(date)) if (p.type !== 'literal') parts[p.type] = p.value;
  return parts;
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    process.exitCode = 1;
    return false;
  }
  console.log(`  ok:   ${msg}`);
  return true;
}

async function run() {
  const now = new Date();
  const todayIST = localDateParts(now, TZ);
  const todayY = parseInt(todayIST.year);
  const todayM = parseInt(todayIST.month);
  const todayD = parseInt(todayIST.day);

  // Compute tomorrow / day-after in IST for assertions.
  const tomorrowMs = new Date(now.getTime() + 86400000);
  const tomorrowIST = localDateParts(tomorrowMs, TZ);
  const dayAfterMs = new Date(now.getTime() + 2 * 86400000);
  const dayAfterIST = localDateParts(dayAfterMs, TZ);

  console.log('\n=== Bug 1a: "Remind me tomorrow at 7:30 pm ..." with LLM dropping is_tomorrow ===');
  stubbedResponse = {
    minutes_from_now: null,
    specific_time: '19:30',
    is_tomorrow: false,                       // <-- LLM regression we want to recover from
    reminder_message: 'bhada jakar le lena',
    target_name: null,
    target_phone: null
  };
  let r = await reminderService.parseWithAI(
    'Remind me tomorrow at 7:30 pm bhada jakar le lena', TZ
  );
  assert(r.success, 'parse succeeded');
  if (r.success) {
    const got = localDateParts(r.reminderTime, TZ);
    assert(got.year === tomorrowIST.year && got.month === tomorrowIST.month && got.day === tomorrowIST.day,
      `lands on tomorrow IST (got ${got.year}-${got.month}-${got.day}, want ${tomorrowIST.year}-${tomorrowIST.month}-${tomorrowIST.day})`);
    assert(got.hour === '19' && got.minute === '30', `at 19:30 IST (got ${got.hour}:${got.minute})`);
  }

  console.log('\n=== Bug 1b: "kal subah 7 baje ..." with LLM dropping is_tomorrow ===');
  stubbedResponse = {
    minutes_from_now: null,
    specific_time: '07:00',
    is_tomorrow: false,                       // LLM dropped it
    reminder_message: 'gym jaana hai',
    target_name: null,
    target_phone: null
  };
  r = await reminderService.parseWithAI('kal subah 7 baje yaad dilana gym jaana hai', TZ);
  assert(r.success, 'parse succeeded');
  if (r.success) {
    const got = localDateParts(r.reminderTime, TZ);
    assert(got.year === tomorrowIST.year && got.month === tomorrowIST.month && got.day === tomorrowIST.day,
      `lands on tomorrow IST (got ${got.year}-${got.month}-${got.day})`);
    assert(got.hour === '07' && got.minute === '00', `at 07:00 IST (got ${got.hour}:${got.minute})`);
  }

  console.log('\n=== Bug 1c: "parso 10am ..." — LLM dropped specific_date, override sets it to today+2 ===');
  stubbedResponse = {
    minutes_from_now: null,
    specific_time: '10:00',
    is_tomorrow: true,                        // LLM picked the wrong field
    reminder_message: 'gym jaana hai',
    target_name: null,
    target_phone: null
  };
  r = await reminderService.parseWithAI('parso 10 baje gym jaana hai', TZ);
  assert(r.success, 'parse succeeded');
  if (r.success) {
    const got = localDateParts(r.reminderTime, TZ);
    assert(got.year === dayAfterIST.year && got.month === dayAfterIST.month && got.day === dayAfterIST.day,
      `lands on today+2 IST (got ${got.year}-${got.month}-${got.day}, want ${dayAfterIST.year}-${dayAfterIST.month}-${dayAfterIST.day})`);
    assert(got.hour === '10' && got.minute === '00', `at 10:00 IST (got ${got.hour}:${got.minute})`);
  }

  console.log('\n=== Bug 2a: "Remind me on 19th May at 11:55am ..." — LLM emits specific_date ===');
  // Pick a target date that is at least 3 days away so it's always future.
  const futureMs = new Date(now.getTime() + 3 * 86400000);
  const future = localDateParts(futureMs, TZ);
  const futureIso = `${future.year}-${future.month}-${future.day}`;
  stubbedResponse = {
    minutes_from_now: null,
    specific_time: '11:55',
    specific_date: futureIso,
    is_tomorrow: false,
    reminder_message: 'take rabish injection',
    target_name: null,
    target_phone: null
  };
  r = await reminderService.parseWithAI(`Remind me on ${future.month}/${future.day} at 11:55am to take rabish injection`, TZ);
  assert(r.success, 'parse succeeded');
  if (r.success) {
    const got = localDateParts(r.reminderTime, TZ);
    assert(got.year === future.year && got.month === future.month && got.day === future.day,
      `lands on ${futureIso} (got ${got.year}-${got.month}-${got.day})`);
    assert(got.hour === '11' && got.minute === '55', `at 11:55 IST (got ${got.hour}:${got.minute})`);
  }

  console.log('\n=== Bug 2b: past explicit date rejected (LLM picked stale year) ===');
  stubbedResponse = {
    minutes_from_now: null,
    specific_time: '11:55',
    specific_date: '2020-05-19',           // long past
    is_tomorrow: false,
    reminder_message: 'take rabish injection',
    target_name: null,
    target_phone: null
  };
  r = await reminderService.parseWithAI('Remind me on 19th May 2020 at 11:55am to take rabish injection', TZ);
  assert(!r.success && r.reason === 'past_date', `rejected with reason=past_date (got success=${r.success}, reason=${r.reason})`);

  console.log('\n=== Bug 2c: LLM omits specific_date but regex catches "25th May" ===');
  stubbedResponse = {
    minutes_from_now: null,
    specific_time: '09:00',
    is_tomorrow: true,                       // LLM (Gemini Flash) regression seen in prod
    reminder_message: 'test absolute date',
    target_name: null,
    target_phone: null
  };
  r = await reminderService.parseWithAI('remind me on 25th may at 9am to test absolute date', TZ);
  assert(r.success, 'parse succeeded');
  if (r.success) {
    const got = localDateParts(r.reminderTime, TZ);
    // Should land on May 25 of the appropriate year (this year if future, else next).
    const todayCmp = todayY * 10000 + todayM * 100 + todayD;
    const expectedYear = todayCmp <= 2026 * 10000 + 5 * 100 + 25 ? 2026 : 2027;
    assert(got.year === String(expectedYear) && got.month === '05' && got.day === '25',
      `lands on ${expectedYear}-05-25 (got ${got.year}-${got.month}-${got.day})`);
    assert(got.hour === '09' && got.minute === '00', `at 09:00 IST (got ${got.hour}:${got.minute})`);
  }

  console.log('\n=== Bug 2d: regex catches "May 25" (month-first form) ===');
  stubbedResponse = {
    minutes_from_now: null,
    specific_time: '14:30',
    is_tomorrow: false,
    reminder_message: 'foo',
    target_name: null,
    target_phone: null
  };
  r = await reminderService.parseWithAI('remind me on May 25 at 2:30pm to foo', TZ);
  assert(r.success, 'parse succeeded');
  if (r.success) {
    const got = localDateParts(r.reminderTime, TZ);
    assert(got.month === '05' && got.day === '25', `lands on May 25 (got ${got.year}-${got.month}-${got.day})`);
  }

  console.log('\n=== Bug 2e: regex catches "next Friday" ===');
  stubbedResponse = {
    minutes_from_now: null,
    specific_time: '18:00',
    is_tomorrow: false,
    reminder_message: 'submit report',
    target_name: null,
    target_phone: null
  };
  r = await reminderService.parseWithAI('remind me next friday at 6pm to submit report', TZ);
  assert(r.success, 'parse succeeded');
  if (r.success) {
    // Day-of-week of resulting reminder must be Friday (5)
    const localY = localDateParts(r.reminderTime, TZ);
    const utcCmp = new Date(Date.UTC(parseInt(localY.year), parseInt(localY.month) - 1, parseInt(localY.day)));
    assert(utcCmp.getUTCDay() === 5, `day-of-week is Friday (got dow=${utcCmp.getUTCDay()}, date=${localY.year}-${localY.month}-${localY.day})`);
    assert(r.reminderTime.getTime() > Date.now(), 'reminder is in the future');
  }

  console.log('\n=== Bug 2f: regex catches "Dec 25" — picks future year ===');
  stubbedResponse = {
    minutes_from_now: null,
    specific_time: '09:00',
    is_tomorrow: false,
    reminder_message: 'wish family',
    target_name: null,
    target_phone: null
  };
  r = await reminderService.parseWithAI('remind me on Dec 25 at 9am to wish family', TZ);
  assert(r.success, 'parse succeeded');
  if (r.success) {
    const got = localDateParts(r.reminderTime, TZ);
    assert(got.month === '12' && got.day === '25', `lands on Dec 25 (got ${got.year}-${got.month}-${got.day})`);
    assert(r.reminderTime.getTime() > Date.now(), 'reminder is in the future');
  }

  console.log('\n=== Regression: bare "in 30 minutes" still works ===');
  stubbedResponse = {
    minutes_from_now: 30,
    specific_time: null,
    is_tomorrow: false,
    reminder_message: 'call mom',
    target_name: null,
    target_phone: null
  };
  r = await reminderService.parseWithAI('remind me in 30 minutes to call mom', TZ);
  assert(r.success, 'parse succeeded');
  if (r.success) {
    const deltaMin = Math.round((r.reminderTime.getTime() - Date.now()) / 60000);
    assert(deltaMin >= 29 && deltaMin <= 31, `~30 minutes from now (got ${deltaMin}m)`);
  }

  console.log('\n=== Regression: "at 7:30 pm today" with PM qualifier — no spurious override ===');
  // User did NOT say tomorrow. is_tomorrow=false must stick.
  stubbedResponse = {
    minutes_from_now: null,
    specific_time: '19:30',
    is_tomorrow: false,
    reminder_message: 'call mom',
    target_name: null,
    target_phone: null
  };
  r = await reminderService.parseWithAI('remind me at 7:30 pm to call mom', TZ);
  assert(r.success, 'parse succeeded');
  if (r.success) {
    const got = localDateParts(r.reminderTime, TZ);
    // Should be today IF 19:30 hasn't passed in IST, else tomorrow (existing past-rollforward).
    const localNow = localDateParts(now, TZ);
    const nowMin = parseInt(localNow.hour) * 60 + parseInt(localNow.minute);
    const expectedTomorrow = nowMin > 19 * 60 + 30;
    const expected = expectedTomorrow ? tomorrowIST : { year: localNow.year, month: localNow.month, day: localNow.day };
    assert(got.year === expected.year && got.month === expected.month && got.day === expected.day,
      `lands on ${expectedTomorrow ? 'tomorrow' : 'today'} (got ${got.year}-${got.month}-${got.day})`);
  }

  if (process.exitCode === 1) {
    console.log('\n✗ SOME TESTS FAILED');
  } else {
    console.log('\n✓ All assertions passed');
  }
}

run().catch(e => {
  console.error('Test runner crashed:', e);
  process.exit(2);
});
