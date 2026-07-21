#!/usr/bin/env node
'use strict';

/**
 * Conversation eval harness (τ-bench-shaped, scaled to Ari).
 *
 * Replays scenario conversations through the REAL webhook controller —
 * same entry point Meta calls — and asserts on the replies Ari would
 * have sent to WhatsApp. Outbound sends are captured (never delivered):
 * DISABLE_OUTBOUND_MESSAGES is forced on AND messaging is monkey-patched.
 *
 * Modes:
 *   - LIVE (default): needs DATABASE_URL + an LLM key. Exercises the full
 *     pipeline including intent routing. This is the mode that matters for
 *     migration safety (legacy router vs agent loop parity).
 *   - Without env, the runner reports SKIPPED and exits 0 so CI without
 *     secrets stays green.
 *
 * Reliability is measured as pass^k (a scenario passes only if it passes
 * ALL k runs) — consistency, not just pass@1. Use --runs <k> (default 1).
 *
 * Usage:
 *   node -r dotenv/config tests/eval/eval-runner.js [--runs 3] [--only <name>]
 *
 * Scenario format (tests/eval/scenarios/*.json):
 *   {
 *     "name": "reminder-set",
 *     "description": "...",
 *     "user": "eval_911111111111",        // synthetic phone; namespaced
 *     "turns": [
 *       { "send": "remind me tomorrow 9am to call mom",
 *         "expect": { "matchesAny": ["reminder", "9:00|9 ?am"], "notMatches": ["error"] } }
 *     ]
 *   }
 */

const fs = require('fs');
const path = require('path');

process.env.DISABLE_OUTBOUND_MESSAGES = 'true';
process.env.DISABLE_BACKGROUND_JOBS = 'true';

const ARGS = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = ARGS.indexOf(flag);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : fallback;
}
const RUNS = Math.max(1, parseInt(argValue('--runs', '1'), 10) || 1);
const ONLY = argValue('--only', null);
const TURN_TIMEOUT_MS = parseInt(argValue('--turn-timeout', '90000'), 10);

const SCENARIO_DIR = path.join(__dirname, 'scenarios');

function loadScenarios() {
  const files = fs.readdirSync(SCENARIO_DIR).filter((f) => f.endsWith('.json'));
  const scenarios = files.map((f) => {
    const parsed = JSON.parse(fs.readFileSync(path.join(SCENARIO_DIR, f), 'utf8'));
    parsed._file = f;
    return parsed;
  });
  return ONLY ? scenarios.filter((s) => s.name === ONLY) : scenarios;
}

function hasLiveEnv() {
  const hasDb = !!process.env.DATABASE_URL;
  const hasLlm = !!(
    process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY
    || process.env.GROQ_API_KEY || process.env.FIREWORKS_API_KEY
    || process.env.AWS_ACCESS_KEY_ID
  );
  return hasDb && hasLlm;
}

/** Build the Meta Cloud API webhook envelope for a plain text message. */
function webhookBody(fromPhone, text, seq) {
  const now = Math.floor(Date.now() / 1000);
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'EVAL_WABA',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '10000000000', phone_number_id: 'EVAL_PHONE' },
          contacts: [{ profile: { name: 'Eval User' }, wa_id: fromPhone }],
          messages: [{
            from: fromPhone,
            id: `wamid.EVAL_${Date.now()}_${seq}_${Math.random().toString(36).slice(2, 8)}`,
            timestamp: String(now),
            type: 'text',
            text: { body: text },
          }],
        },
      }],
    }],
  };
}

function stubRes() {
  return {
    statusCode: 200,
    sendStatus() { return this; },
    status(code) { this.statusCode = code; return this; },
    send() { return this; },
    json() { return this; },
    end() { return this; },
  };
}

async function runTurn(controller, capture, scenario, turn, seq) {
  capture.messages.length = 0;
  const req = { body: webhookBody(scenario.user, turn.send, seq), headers: {} };

  const done = new Promise((resolve) => { capture.onMessage = resolve; });
  await controller.handleMessage(req, stubRes());

  // The reply may arrive asynchronously (fire-and-forget sends). Wait for the
  // first captured outbound message or time out.
  const reply = await Promise.race([
    done,
    new Promise((resolve) => setTimeout(() => resolve(null), TURN_TIMEOUT_MS)),
  ]);

  const allText = capture.messages.map((m) => m.text).join('\n');
  return { reply: reply || allText || '', allText };
}

function checkExpectations(turn, replyText) {
  const failures = [];
  const expect = turn.expect || {};
  const text = String(replyText || '');

  if (Array.isArray(expect.matchesAny) && expect.matchesAny.length > 0) {
    const hit = expect.matchesAny.some((p) => new RegExp(p, 'i').test(text));
    if (!hit) failures.push(`no matchesAny hit (${expect.matchesAny.join(' | ')})`);
  }
  for (const p of expect.matchesAll || []) {
    if (!new RegExp(p, 'i').test(text)) failures.push(`missing required pattern: ${p}`);
  }
  for (const p of expect.notMatches || []) {
    if (new RegExp(p, 'i').test(text)) failures.push(`forbidden pattern matched: ${p}`);
  }
  if (expect.nonEmpty !== false && text.trim().length === 0) {
    failures.push('empty reply');
  }
  return failures;
}

async function runScenarioOnce(controller, capture, scenario, runIdx) {
  const turnResults = [];
  let seq = 0;
  for (const turn of scenario.turns) {
    seq += 1;
    const { reply } = await runTurn(controller, capture, scenario, turn, `${runIdx}_${seq}`);
    const failures = checkExpectations(turn, reply);
    turnResults.push({ send: turn.send, reply: String(reply).slice(0, 300), failures });
    if (failures.length > 0 && turn.stopOnFail !== false) break;
  }
  const failed = turnResults.some((t) => t.failures.length > 0);
  return { passed: !failed, turns: turnResults };
}

(async () => {
  const scenarios = loadScenarios();
  if (scenarios.length === 0) {
    console.log('No scenarios found.');
    process.exit(0);
  }

  if (!hasLiveEnv()) {
    console.log(`SKIPPED: eval harness needs DATABASE_URL + one LLM key (${scenarios.length} scenario(s) not run).`);
    console.log('Set env (e.g. via .env + node -r dotenv/config) and re-run: npm run eval');
    process.exit(0);
  }

  // Load the app AFTER env overrides so outbound suppression is active.
  const controller = require('../../src/controllers/webhook.controller');
  const messagingService = require('../../src/services/messaging.service');

  // Capture every outbound send instead of delivering it.
  const capture = { messages: [], onMessage: null };
  const record = (userId, text) => {
    const entry = { userId, text: String(text || '') };
    capture.messages.push(entry);
    if (capture.onMessage) { capture.onMessage(entry.text); capture.onMessage = null; }
    return Promise.resolve({ skipped: true, reason: 'eval_capture' });
  };
  messagingService.send = record;
  messagingService.sendButtonMessage = (userId, bodyText) => record(userId, bodyText);
  messagingService.sendTemplate = (userId, templateName) => record(userId, `[template:${templateName}]`);

  const report = [];
  for (const scenario of scenarios) {
    process.stdout.write(`\n▶ ${scenario.name} (${RUNS} run${RUNS > 1 ? 's' : ''}) `);
    const runs = [];
    for (let k = 0; k < RUNS; k += 1) {
      // eslint-disable-next-line no-await-in-loop
      const result = await runScenarioOnce(controller, capture, scenario, k);
      runs.push(result);
      process.stdout.write(result.passed ? '✓' : '✗');
    }
    const passK = runs.every((r) => r.passed);
    report.push({ name: scenario.name, passK, runs });
    console.log(passK ? '  PASS' : '  FAIL');
    for (const run of runs.filter((r) => !r.passed)) {
      for (const t of run.turns.filter((x) => x.failures.length > 0)) {
        console.log(`   ✗ "${t.send}" → "${t.reply.slice(0, 120)}"`);
        for (const f of t.failures) console.log(`     - ${f}`);
      }
    }
  }

  const passed = report.filter((r) => r.passK).length;
  console.log(`\npass^${RUNS}: ${passed}/${report.length} scenarios`);
  const outPath = path.join(__dirname, 'last-report.json');
  fs.writeFileSync(outPath, JSON.stringify({ runs: RUNS, when: new Date().toISOString(), report }, null, 2));
  console.log(`Report: ${outPath}`);
  process.exit(passed === report.length ? 0 : 1);
})().catch((e) => {
  console.error(`Eval runner crashed: ${e.stack || e.message}`);
  process.exit(1);
});
