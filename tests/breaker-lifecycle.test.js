/**
 * Live circuit breaker lifecycle test.
 * Simulates an "OpenAI outage" and watches the breaker go through its full cycle:
 *   CLOSED -> (failures) -> OPEN -> (reset timeout) -> HALF-OPEN -> (success) -> CLOSED
 *
 * Measures latency in each state to prove:
 *   - Closed: calls take as long as upstream does (1s per failure in this sim)
 *   - Open: fallback returns in <10ms (shed load)
 *   - Half-open: one test call determines recovery
 */

const CircuitBreaker = require('opossum');

let upstreamHealthy = false;
let upstreamCalls = 0;

// Simulated upstream — stands in for a real axios.post to OpenAI.
async function fakeOpenAI() {
  upstreamCalls++;
  await new Promise(r => setTimeout(r, 1000));
  if (!upstreamHealthy) {
    throw new Error('Simulated 503: OpenAI is down');
  }
  return { data: { choices: [{ message: { content: 'healthy response' } }] } };
}

// Same config as real openaiBreaker, with shorter resetTimeout for test speed.
const breaker = new CircuitBreaker(fakeOpenAI, {
  timeout: 3000,
  errorThresholdPercentage: 50,
  resetTimeout: 3000,
  rollingCountTimeout: 10000,
  volumeThreshold: 5,
  name: 'test-openai'
});

breaker.fallback(() => ({
  degraded: true,
  reason: 'openai_unavailable',
  text: 'My AI brain is catching up. Try again in 30 seconds?'
}));

const transitions = [];
breaker.on('open', () => transitions.push({ state: 'OPEN', at: Date.now() }));
breaker.on('halfOpen', () => transitions.push({ state: 'HALF-OPEN', at: Date.now() }));
breaker.on('close', () => transitions.push({ state: 'CLOSED', at: Date.now() }));

function fmtMs(n) { return String(n).padStart(5, ' ') + 'ms'; }

async function fire(attempt) {
  const start = Date.now();
  try {
    const result = await breaker.fire();
    const elapsed = Date.now() - start;
    if (result.degraded) {
      console.log(`  #${String(attempt).padStart(2)} ${fmtMs(elapsed)}  FALLBACK     state=${currentState()}`);
    } else {
      console.log(`  #${String(attempt).padStart(2)} ${fmtMs(elapsed)}  SUCCESS      state=${currentState()}`);
    }
    return { success: true, degraded: !!result.degraded, elapsed };
  } catch (e) {
    const elapsed = Date.now() - start;
    const errType = e.message.startsWith('Simulated') ? 'UPSTREAM-503' : 'BREAKER-OPEN';
    console.log(`  #${String(attempt).padStart(2)} ${fmtMs(elapsed)}  ${errType} state=${currentState()}`);
    return { success: false, elapsed, error: e.message };
  }
}

function currentState() {
  if (breaker.opened) return 'OPEN     ';
  if (breaker.halfOpen) return 'HALF-OPEN';
  return 'CLOSED   ';
}

async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  console.log('\n===============================================================');
  console.log('  CIRCUIT BREAKER LIFECYCLE TEST');
  console.log('  Simulating: OpenAI outage -> bot calls continuing -> recovery');
  console.log('===============================================================\n');

  // PHASE 1: Upstream DOWN, breaker still CLOSED, calls take real time.
  console.log('-- PHASE 1: Upstream returns 503, breaker CLOSED --');
  console.log('Expected: each call takes ~1000ms (real wall time of failure)\n');

  upstreamHealthy = false;
  const phase1 = [];
  for (let i = 1; i <= 6; i++) {
    phase1.push(await fire(i));
    await wait(100);
  }
  await wait(200);

  const phase1SlowFallbacks = phase1.filter(r => r.degraded && r.elapsed >= 500);
  const phase1AvgMs = phase1SlowFallbacks.length
    ? Math.round(phase1SlowFallbacks.reduce((s, r) => s + r.elapsed, 0) / phase1SlowFallbacks.length)
    : 0;

  console.log(`\n  -> ${phase1SlowFallbacks.length} slow degraded calls took avg ${phase1AvgMs}ms each`);
  console.log(`  -> Breaker state: ${currentState().trim()}  (upstream hit ${upstreamCalls} times)\n`);

  // PHASE 2: Breaker OPEN, fail-fast via fallback.
  console.log('-- PHASE 2: Breaker OPEN -- subsequent calls should fail FAST --');
  console.log('Expected: each call takes <10ms (fallback, no upstream hit)\n');

  const upstreamBefore = upstreamCalls;
  const phase2 = [];
  for (let i = 7; i <= 16; i++) {
    phase2.push(await fire(i));
  }

  const phase2Fallbacks = phase2.filter(r => r.degraded);
  const phase2AvgMs = phase2Fallbacks.length
    ? Math.round(phase2Fallbacks.reduce((s, r) => s + r.elapsed, 0) / phase2Fallbacks.length)
    : 0;
  const upstreamSaved = phase2.length - (upstreamCalls - upstreamBefore);

  console.log(`\n  -> ${phase2Fallbacks.length} fallbacks took avg ${phase2AvgMs}ms each`);
  console.log(`  -> Upstream calls avoided: ${upstreamSaved} of ${phase2.length}` +
    ` (${Math.round(upstreamSaved / phase2.length * 100)}% shed)\n`);

  // PHASE 3: Wait for resetTimeout -> HALF-OPEN
  console.log('-- PHASE 3: Waiting 3.5s for breaker resetTimeout --\n');
  await wait(3500);
  console.log(`  -> State after wait: ${currentState().trim()}` +
    `  (opened=${breaker.opened} halfOpen=${breaker.halfOpen})\n`);

  // PHASE 4: Upstream recovers, breaker should go HALF-OPEN -> CLOSED on first success.
  console.log('-- PHASE 4: Upstream recovers, breaker closes --');
  console.log('Expected: one success -> CLOSED, subsequent calls pass through\n');

  upstreamHealthy = true;
  const phase4 = [];
  for (let i = 17; i <= 22; i++) {
    phase4.push(await fire(i));
    await wait(100);
  }

  const phase4Success = phase4.filter(r => r.success && !r.degraded);
  console.log(`\n  -> ${phase4Success.length} successful calls after recovery`);
  console.log(`  -> Final state: ${currentState().trim()}\n`);

  // Summary
  console.log('===============================================================');
  console.log('  STATE TRANSITIONS OBSERVED:');
  console.log('===============================================================');
  const t0 = transitions[0] ? transitions[0].at : Date.now();
  transitions.forEach((t) => {
    const dt = t.at - t0;
    console.log(`  t=+${String(dt).padStart(5)}ms  ->  ${t.state}`);
  });

  console.log('\n===============================================================');
  console.log('  PERFORMANCE COMPARISON:');
  console.log('===============================================================');
  console.log(`  BEFORE breaker opens (CLOSED): avg ${phase1AvgMs}ms per failed call`);
  console.log(`  AFTER breaker opens  (OPEN):   avg ${phase2AvgMs}ms per fallback call`);
  if (phase1AvgMs > 0 && phase2AvgMs >= 0) {
    const speedup = Math.round(phase1AvgMs / Math.max(phase2AvgMs, 1));
    console.log(`  SPEEDUP DURING OUTAGE: ${speedup}x  (${phase1AvgMs}ms -> ${phase2AvgMs}ms)`);
  }

  const finalStats = breaker.stats;
  console.log('\n  Final breaker.stats:');
  console.log(`    fires:      ${finalStats.fires}`);
  console.log(`    successes:  ${finalStats.successes}`);
  console.log(`    failures:   ${finalStats.failures}`);
  console.log(`    timeouts:   ${finalStats.timeouts}`);
  console.log(`    fallbacks:  ${finalStats.fallbacks}`);
  console.log(`    rejects:    ${finalStats.rejects}`);
  console.log('\n===============================================================\n');

  // Assertions
  const passes = [];
  const fails = [];
  const check = (name, ok) => (ok ? passes : fails).push(name);

  check('breaker opened during outage', transitions.some(t => t.state === 'OPEN'));
  check('breaker closed after recovery', currentState().trim() === 'CLOSED');
  check('fallbacks faster than failures', phase2AvgMs < phase1AvgMs);
  check('fallback latency is <50ms', phase2AvgMs < 50);
  check('upstream calls shed during OPEN', upstreamSaved >= 5);
  check('halfOpen transition observed', transitions.some(t => t.state === 'HALF-OPEN'));

  console.log(`ASSERTIONS: ${passes.length}/${passes.length + fails.length} passed`);
  passes.forEach(p => console.log(`  PASS  ${p}`));
  fails.forEach(f => console.log(`  FAIL  ${f}`));

  process.exit(fails.length > 0 ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
