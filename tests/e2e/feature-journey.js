#!/usr/bin/env node
'use strict';

/**
 * End-to-end feature journey — drive Ari the way a user actually does, then
 * check the database.
 *
 * The existing eval harness matches on reply text, which is necessary but not
 * sufficient: the failure mode this product has actually shipped is a
 * confident "Done!" over a write that never landed. Text assertions cannot see
 * that. Every step here therefore has TWO gates:
 *
 *   expect  — what the user should read
 *   verify  — a SQL check that the row really exists / changed / is gone
 *
 * A step that replies "I've added it" and fails `verify` is reported as
 * LIED — reply claimed success, database disagrees. That is the single most
 * important line this harness can print.
 *
 * Journeys run in order and share state (create -> edit -> delete), because
 * that is how features break in practice: the create works and the rename
 * silently targets nothing. Each journey cleans up after itself.
 *
 * Usage:
 *   node -r dotenv/config tests/e2e/feature-journey.js
 *   node -r dotenv/config tests/e2e/feature-journey.js --only groups
 *   node -r dotenv/config tests/e2e/feature-journey.js --keep    (skip cleanup)
 */

process.env.DISABLE_OUTBOUND_MESSAGES = 'true';
process.env.DISABLE_BACKGROUND_JOBS = 'true';

const path = require('path');
const fs = require('fs');

const ARGS = process.argv.slice(2);
const arg = (flag, fallback) => {
  const i = ARGS.indexOf(flag);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : fallback;
};
const ONLY = arg('--only', null);
const KEEP = ARGS.includes('--keep');
const TURN_TIMEOUT_MS = parseInt(arg('--turn-timeout', '90000'), 10);

// A dedicated synthetic user so a failed run can never touch real data.
const USER = process.env.E2E_USER_PHONE || '919900000001';
const phones = [USER, `+${USER}`];

function webhookBody(text, seq) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'E2E_WABA',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '10000000000', phone_number_id: 'E2E_PHONE' },
          contacts: [{ profile: { name: 'E2E User' }, wa_id: USER }],
          messages: [{
            from: USER,
            id: `wamid.E2E_${Date.now()}_${seq}_${Math.random().toString(36).slice(2, 8)}`,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'text',
            text: { body: text },
          }],
        },
      }],
    }],
  };
}

const stubRes = () => ({
  statusCode: 200,
  sendStatus() { return this; },
  status(c) { this.statusCode = c; return this; },
  send() { return this; },
  json() { return this; },
  end() { return this; },
});

module.exports = { webhookBody, stubRes, USER, phones, ONLY, KEEP, TURN_TIMEOUT_MS };

// Journeys live in a separate module so this file stays the runner.
const { JOURNEYS } = require('./journeys');

(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('SKIPPED: needs DATABASE_URL (run with -r dotenv/config).');
    process.exit(0);
  }

  const controller = require('../../src/controllers/webhook.controller');
  const messagingService = require('../../src/services/messaging.service');
  const { query } = require('../../src/config/database');

  // Capture outbound instead of sending. Everything the agent would have said
  // to the user lands here.
  const capture = { messages: [], onMessage: null };
  const record = (userId, text) => {
    const entry = { userId, text: String(text || '') };
    capture.messages.push(entry);
    if (capture.onMessage) { capture.onMessage(entry.text); capture.onMessage = null; }
    return Promise.resolve({ skipped: true, reason: 'e2e_capture' });
  };
  messagingService.send = record;
  messagingService.sendButtonMessage = (userId, body) => record(userId, body);
  messagingService.sendTemplate = (userId, name) => record(userId, `[template:${name}]`);

  let seq = 0;
  async function say(text) {
    seq += 1;
    capture.messages.length = 0;
    const done = new Promise((resolve) => { capture.onMessage = resolve; });
    const started = Date.now();
    await controller.handleMessage({ body: webhookBody(text, seq), headers: {} }, stubRes());
    const first = await Promise.race([
      done,
      new Promise((resolve) => setTimeout(() => resolve(null), TURN_TIMEOUT_MS)),
    ]);
    // The agent narrates before it acts ("Moving X to negotiation…") and sends
    // the result afterwards, so the FIRST outbound message can arrive while the
    // write is still in flight. Verifying there produces false accusations of
    // lying. Wait for the stream of outbound messages to go quiet instead.
    let settled = capture.messages.length;
    const quietUntil = Date.now() + 6000;
    for (;;) {
      await new Promise((r) => setTimeout(r, 700));
      if (capture.messages.length === settled) break;
      settled = capture.messages.length;
      if (Date.now() > quietUntil) break;
    }

    const all = capture.messages.map((m) => m.text).join('\n');
    return { reply: all || first || '', all, ms: Date.now() - started };
  }

  const journeys = ONLY ? JOURNEYS.filter((j) => j.name.includes(ONLY)) : JOURNEYS;
  const results = [];
  const startedAll = Date.now();

  const confirmationGate = require('../../src/services/confirmation-gate.service');

  // The synthetic user accumulates conversation history across runs, so by the
  // third run the model has seen this exact request succeed several times and
  // answers "I've already saved that for you" without acting. That is an
  // artefact of replaying identical prompts, not something a real user does —
  // start every run from an empty conversation so the journey measures the
  // feature rather than the transcript.
  for (const table of ['conversation_history', 'ari_agent_conversation_state', 'ari_agent_conversation_summaries']) {
    await query(`DELETE FROM ${table} WHERE user_phone = ANY($1)`, [phones]).catch(() => {});
  }

  for (const journey of journeys) {
    console.log(`\n▶ ${journey.name}`);
    // Journeys share one synthetic user, so an unanswered confirmation left by
    // a previous journey ("delete this group?") intercepts this journey's first
    // message and gets scored as that feature failing. Start with a clean gate.
    try { confirmationGate.clear(USER); } catch (_) { /* best effort */ }
    const steps = [];
    const state = {};
    for (const step of journey.steps) {
      const text = typeof step.say === 'function' ? step.say(state) : step.say;
      let reply = ''; let ms = 0; let crashed = null;
      try {
        const out = await say(text);
        reply = out.reply; ms = out.ms;
      } catch (e) {
        crashed = (e.message || String(e)).slice(0, 120);
      }

      const problems = [];
      if (crashed) problems.push(`crashed: ${crashed}`);
      if (!crashed && step.expect && !step.expect.test(reply)) {
        problems.push(`reply did not match ${step.expect}`);
      }
      let verified = null;
      if (!crashed && step.verify) {
        try {
          verified = await step.verify({ query, phones, state, reply });
          if (!verified) problems.push('DATABASE CHECK FAILED');
        } catch (e) {
          problems.push(`verify threw: ${(e.message || '').slice(0, 90)}`);
        }
      }

      // The distinction that matters: did it merely fail, or did it claim
      // success while the database says otherwise?
      // An honest "I hit an error" is a failure, not a lie — only call it
      // LIED when the reply actually claims the work was done.
      const apologised = /sorry|trouble|couldn.t|could not|unable|error|failed|did not|didn.t/i.test(String(reply));
      const claimedSuccess = !crashed && step.expect && step.expect.test(reply) && !apologised;
      const lied = claimedSuccess && verified === false;

      steps.push({ say: text, reply: String(reply).slice(0, 160), ms, problems, lied });
      const mark = problems.length === 0 ? '  ok  ' : (lied ? ' LIED ' : ' FAIL ');
      console.log(`  ${mark} ${String(ms).padStart(5)}ms  ${text.slice(0, 68)}`);
      if (problems.length) {
        console.log(`         reply: "${String(reply).slice(0, 110)}"`);
        for (const p of problems) console.log(`         - ${p}`);
      }
      if (problems.length && step.stopOnFail !== false) break;
    }

    if (!KEEP && journey.cleanup) {
      try { await journey.cleanup({ query, phones }); } catch (e) {
        console.log(`  (cleanup failed: ${(e.message || '').slice(0, 80)})`);
      }
    }
    results.push({ name: journey.name, steps });
  }

  const allSteps = results.flatMap((r) => r.steps);
  const failed = allSteps.filter((s) => s.problems.length);
  const lies = allSteps.filter((s) => s.lied);

  console.log('\n=== feature journey summary ===');
  for (const r of results) {
    const bad = r.steps.filter((s) => s.problems.length).length;
    console.log(`  ${bad === 0 ? 'PASS' : 'FAIL'}  ${r.name}  (${r.steps.length - bad}/${r.steps.length} steps)`);
  }
  console.log(`\n${allSteps.length - failed.length}/${allSteps.length} steps passed   `
    + `elapsed ${((Date.now() - startedAll) / 1000).toFixed(0)}s`);
  if (lies.length) {
    console.log(`\n  ${lies.length} step(s) REPORTED SUCCESS WITH NO DATABASE CHANGE:`);
    for (const s of lies) console.log(`    "${s.say}"\n      said: "${s.reply.slice(0, 100)}"`);
  }

  const out = path.join(__dirname, 'last-journey-report.json');
  fs.writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
  console.log(`\nReport: ${out}`);
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error(`journey runner crashed: ${e.stack || e.message}`);
  process.exit(1);
});
