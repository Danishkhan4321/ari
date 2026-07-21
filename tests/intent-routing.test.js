/**
 * Intent-routing regression tests (offline — no network, no DB, no API keys).
 *
 * Covers the July 2026 NLU fixes:
 *   1. Tool subsetting safety nets — core-priority padding, clarification tool
 *      in every subset, short-follow-up bypass, full-set retry on subset miss.
 *   2. detectIntent short-message gate — "2"/"ok" reach the LLM when history
 *      exists, are dropped only when there is nothing to anchor them.
 *   3. Intent prompt v3 — clarification policy present, keyword decrees gone.
 *   4. Confirmation gate — negation-aware yes/no ("ok, don't send it yet"
 *      must NOT send), typo/Hinglish confirms, LLM fallback, deflection expiry.
 *   5. classifyConfirmation — quick paths + safe fallback on a garbled LLM
 *      decision (must NOT default to confirm).
 *
 * Run: npm test   (node --test tests/*.test.js)
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

// ── Deterministic env BEFORE any src module loads ─────────────────────────
process.env.SEMANTIC_ROUTER_ENABLED = 'false';   // no 3B-classifier LLM calls
delete process.env.OPT_EMBEDDING_FAST_PATH;      // fastpath off (default)
delete process.env.OPT_RAG_MCP_ENABLED;          // RAG retrieval off (default)
delete process.env.TOOL_SUBSETTING_ENABLED;      // subsetting on (default)
delete process.env.INTENT_FULLSET_RETRY;         // retry on (default)
delete process.env.INTENT_PROMPT_VERSION;        // v3 (default)
delete process.env.TOOL_DEFS_VERSION;            // full descriptions

// ── Stub llm-provider via require cache so ai.service never hits the net ──
const llmProviderPath = require.resolve('../src/services/llm-provider');

/** Every LLM request lands here. Tests set `llmScript` to control replies. */
const llmCalls = [];
let llmScript = []; // array of responders, consumed one per chatCompletion call

function makeToolCallResponse(name, args) {
  return {
    data: {
      choices: [{
        message: {
          tool_calls: [{ function: { name, arguments: JSON.stringify(args || {}) } }]
        }
      }],
      usage: { total_tokens: 1 }
    }
  };
}

function makeTextResponse(content) {
  return { data: { choices: [{ message: { content } }], usage: { total_tokens: 1 } } };
}

const llmStub = {
  apiKey: () => 'test-key',
  chatUrl: () => 'http://127.0.0.1:9/v1/chat/completions',
  defaultModel: () => 'stub-default',
  fastModel: () => 'stub-fast',
  providerName: () => 'stub',
  // Return a distinct model name so detectIntent takes the routed
  // chatCompletion path (our stub) instead of the raw-axios _callOpenAI path.
  modelFor: (task) => (task === 'intent_primary' ? 'stub-intent' : null),
  defaultBodyExtras: () => ({}),
  chatCompletion: async (body, opts) => {
    llmCalls.push({ body, opts });
    const responder = llmScript.shift();
    if (!responder) throw new Error('llm stub: no scripted response left');
    return typeof responder === 'function' ? responder(body, opts) : responder;
  },
};

require.cache[llmProviderPath] = {
  id: llmProviderPath,
  filename: llmProviderPath,
  loaded: true,
  exports: llmStub,
  children: [],
  paths: [],
};

function resetLLM(...script) {
  llmCalls.length = 0;
  llmScript = script;
}

// ── Modules under test (loaded AFTER the stub is installed) ───────────────
const {
  getToolDefinitions,
  getToolsForCategory,
  classifyCategoryFromKeywords,
  getExplicitToolHint,
  getIntentForTool,
  TOOL_CATEGORY,
  ESSENTIAL_TOOLS,
  CORE_PAD_TOOLS,
} = require('../src/services/tool-definitions');

const aiService = require('../src/services/ai.service');
const gate = require('../src/services/confirmation-gate.service');

// Keep gate tests offline + fast: stub the restart-safety persistence layer
// (it is fire-and-forget/best-effort in production; here it must not attempt
// TCP connects to a nonexistent Postgres).
gate._dbUpsertPending = async () => {};
gate._dbDeletePending = async () => {};
gate._dbFetchPending = async () => null;

const toolNames = (tools) => tools.map(t => t.function.name);
const FULL_TOOL_COUNT = getToolDefinitions().length;

// ═══════════════════════════════════════════════════════════════════════
// 1. Tool subsetting safety nets
// ═══════════════════════════════════════════════════════════════════════

test('request_clarification tool exists and maps to the clarify intent', () => {
  const names = toolNames(getToolDefinitions());
  assert.ok(names.includes('request_clarification'), 'tool must be defined');
  assert.strictEqual(getIntentForTool('request_clarification'), 'clarify');
});

test('every category subset contains request_clarification (escape hatch survives pruning)', () => {
  const categories = [...new Set(Object.values(TOOL_CATEGORY))];
  for (const cat of categories) {
    const subset = toolNames(getToolsForCategory(cat, 24));
    assert.ok(
      subset.includes('request_clarification'),
      `category "${cat}" subset is missing request_clarification`
    );
  }
});

test('wrong-category subsets still expose high-traffic tools via core padding', () => {
  // "help me write an email to my boss" keyword-matches the ACCOUNT category
  // (bare "help"). The old file-order padding excluded send_email entirely —
  // the LLM literally could not pick it. Core padding must keep it reachable.
  const cat = classifyCategoryFromKeywords('help me write an email to my boss abt the delay');
  assert.strictEqual(cat, 'account', 'precondition: the keyword misfire still exists');
  const subset = toolNames(getToolsForCategory(cat, 24));
  assert.ok(subset.includes('send_email'), 'send_email must survive an account-category misfire');
  assert.ok(subset.includes('set_reminder'), 'set_reminder must survive');
  assert.ok(subset.includes('create_calendar_event'), 'create_calendar_event must survive');
});

test('CRM add-lead prompts with email addresses route to sales tools, not email tools', () => {
  const cat = classifyCategoryFromKeywords('Add lead Rohan from Acme, email rohan@example.com, stage interested');
  assert.strictEqual(cat, 'sales');
  const subset = toolNames(getToolsForCategory(cat, 24));
  assert.ok(subset.includes('manage_sales'), 'manage_sales must be available for add-lead prompts');
});

test('Google Tasks stays exposed while Gmail-history contact search is removed', () => {
  const googleTaskCategory = classifyCategoryFromKeywords('Add submit report to my Google Tasks');
  assert.strictEqual(googleTaskCategory, 'google');
  assert.ok(
    toolNames(getToolsForCategory(googleTaskCategory, 24)).includes('manage_google_tasks'),
    'Google Tasks requests must expose manage_google_tasks'
  );

  const googleContactCategory = classifyCategoryFromKeywords("Find Alice's email in my Google contacts");
  assert.strictEqual(googleContactCategory, 'google');
  assert.equal(
    toolNames(getToolsForCategory(googleContactCategory, 24)).includes('search_google_contacts'),
    false,
    'Gmail-history contact search must not be exposed'
  );
});

test('automatic briefing requests expose briefing_toggle', () => {
  const category = classifyCategoryFromKeywords('Turn on my automatic morning briefing');
  assert.strictEqual(category, 'briefing');
  assert.ok(
    toolNames(getToolsForCategory(category, 24)).includes('briefing_toggle'),
    'briefing requests must expose briefing_toggle'
  );
});

test('explicit intent guard pins unambiguous commands that previously flaked under Qwen', () => {
  const cases = [
    ['Cancel reminder number 2', 'cancel_reminder'],
    ['Email everyone attending my project meeting about the delay', 'email_calendar_attendees'],
    ['Notify me if Alice does not reply to my last email', null],
    ['Connect my Apple Calendar', 'connect_apple'],
    ['Add to the knowledge base: deploy with Docker Compose', 'manage_knowledge_base'],
    ['Please link my Google account', 'connect_google'],
    ['Send an email to alice@example.com saying hello', 'send_email'],
    ['Create a task to submit the report tomorrow', 'manage_tasks'],
    ['Delete reminder 3 from my dashboard', 'delete_dashboard_item'],
    ['Schedule a meeting with alice@example.com tomorrow at 3pm', 'create_calendar_event'],
    ['Schedule an email to alice@example.com for tomorrow at 9am saying hello', 'schedule_email'],
    ['Did Rahul reply to my email?', null],
    ['Search my inbox for emails about the invoice', null],
    ['Send an email to alice@example.com saying the meeting is at 3pm', 'send_email'],
    ['When is Rahul free tomorrow?', 'check_team_availability'],
    ['Show action items from the last meeting', 'meeting_minutes'],
    ["What is Rahul's phone number?", 'manage_contacts'],
    ['Delete dashboard reminder 3', 'delete_dashboard_item'],
    ['Remind me about all my calendar events today', 'remind_all_calendar'],
    ['Show my scheduled messages', 'scheduled_message'],
    ['Share my project proposal with Rahul', 'share_drive_file'],
    ['Add a row to my Google Sheet budget', 'manage_sheets'],
    ['Make a quick note in Google Docs about the meeting', 'quick_note_docs'],
    ['Give me a deep dive on AMD news', 'news_deep_dive'],
  ];

  for (const [message, expected] of cases) {
    assert.strictEqual(getExplicitToolHint(message), expected, message);
  }

  assert.strictEqual(
    getExplicitToolHint('Send the same email again to bob@example.com', { hasRecentEmailContext: true }),
    'reuse_recent_email'
  );
  assert.strictEqual(
    getExplicitToolHint('Send that sales email', { lastBotAction: { action: 'sales_email_confirm' } }),
    'handle_sales_email_confirmation'
  );
  assert.strictEqual(
    getExplicitToolHint('yes, create that calendar event', { activeCalendarConfirmation: true }),
    'handle_calendar_confirmation'
  );
  assert.strictEqual(
    getExplicitToolHint('yes, send the email', { activeEmailDraftConfirmation: true }),
    'handle_email_confirmation'
  );
  assert.strictEqual(
    getExplicitToolHint('my standup is done: fixed the login bug', { activeStandupResponse: true }),
    'handle_standup_response'
  );
});

test('restricted Gmail tools are removed from the active tool catalog', () => {
  const removed = new Set([
    'check_inbox', 'search_inbox', 'email_query', 'followup_email',
    'manage_labels', 'manage_email_automation', 'track_email_reply',
    'search_google_contacts',
  ]);
  const active = new Set(toolNames(getToolDefinitions()));

  for (const name of removed) {
    assert.equal(active.has(name), false, `${name} must not be exposed`);
  }
  assert.equal(active.has('send_email'), true);
  assert.equal(active.has('create_drive_folder'), true);
  assert.equal(active.has('manage_docs'), true);
  assert.equal(active.has('manage_google_tasks'), true);
});

test('core padding fills in CORE_PAD_TOOLS priority order, not file order', () => {
  const subset = toolNames(getToolsForCategory('delegation', 24));
  // delegation has 2 own tools + essentials; the pad slots must be dominated
  // by core tools rather than whatever sits early in the definitions file.
  const coreInSubset = CORE_PAD_TOOLS.filter(n => subset.includes(n));
  assert.ok(
    coreInSubset.length >= 12,
    `expected ≥12 core tools in the delegation subset, got ${coreInSubset.length}: ${subset.join(', ')}`
  );
});

test('ESSENTIAL_TOOLS includes the clarification escape hatch', () => {
  assert.ok(ESSENTIAL_TOOLS.includes('request_clarification'));
});

test('every fast-path canonical intent points at a REAL tool (no name drift)', () => {
  // Regression: the embedding fast-path shipped with 'list_reminders' /
  // 'list_calendar_events' / 'list_memories' / 'clear_history' — none of
  // which exist — so "show my reminders" routed to an unknown intent type
  // in production whenever OPT_EMBEDDING_FAST_PATH was on.
  const { CANONICAL_INTENTS } = require('../src/services/intent-fastpath.service');
  const real = new Set(getToolDefinitions().map(t => t.function.name));
  const stale = [...new Set(CANONICAL_INTENTS.map(i => i.toolName))].filter(n => !real.has(n));
  assert.deepStrictEqual(stale, [], `fast-path references nonexistent tools: ${stale.join(', ')}`);
});

// ═══════════════════════════════════════════════════════════════════════
// 2. detectIntent — gates, short-follow-up bypass, full-set retry
// ═══════════════════════════════════════════════════════════════════════

const HISTORY = [
  { role: 'user', content: 'show my reminders' },
  { role: 'assistant', content: 'Your reminders:\n1. Call mom 5pm\n2. Take medicine 9pm\nReply with a number to cancel one.' },
];

test('detectIntent: bare positional words with no context never reach the LLM', async () => {
  // "all"/"first"/"yes" with zero history + no active workflow are
  // unresolvable — weak models grab view_dashboard because "all" appears in
  // its enum. Must return null deterministically, no LLM call.
  for (const word of ['all', 'first', 'yes', 'ok', '7', 'option 2', 'the second one']) {
    resetLLM();
    const result = await aiService.detectIntent(word, { recentMessages: [], contextHints: {} });
    assert.strictEqual(result, null, `"${word}" must not route to a tool`);
    assert.strictEqual(llmCalls.length, 0, `"${word}" must not call the LLM`);
  }
});

test('detectIntent: "2" with NO history is dropped without an LLM call', async () => {
  resetLLM();
  const result = await aiService.detectIntent('2', { recentMessages: [] });
  assert.strictEqual(result, null);
  assert.strictEqual(llmCalls.length, 0, 'no LLM call should be made');
});

test('detectIntent: "2" WITH history reaches the LLM with a history-derived subset', async () => {
  // Policy change (smoke-test H-1): the full 86-tool menu for bare numbers is
  // exactly how manage_images captured email/task selections. Short follow-ups
  // now derive their subset from the recent conversation; the full set is the
  // fallback only when history carries no category signal.
  resetLLM(makeToolCallResponse('cancel_reminder', { full_text: '2', position: '2' }));
  const result = await aiService.detectIntent('2', { recentMessages: HISTORY });
  assert.ok(result, 'intent expected');
  assert.strictEqual(result.toolName, 'cancel_reminder');
  assert.strictEqual(llmCalls.length, 1);
  const toolNames = llmCalls[0].body.tools.map((tool) => tool.function.name);
  assert.ok(toolNames.includes('cancel_reminder'), 'history-derived subset must keep the reminder tools visible');
  assert.ok(
    llmCalls[0].body.tools.length < FULL_TOOL_COUNT,
    'a bare number must not see the full tool menu'
  );
});

test('detectIntent: subset miss triggers ONE full-set retry that can recover the tool', async () => {
  // Long message that keyword-routes to the (wrong) account category.
  const msg = 'help me write an email to my new landlord about the broken heater situation please';
  resetLLM(
    makeTextResponse('no tool'),                       // subset call → no tool_calls
    makeToolCallResponse('send_email', { full_text: msg }) // full-set retry → send_email
  );
  const result = await aiService.detectIntent(msg, { recentMessages: [] });
  assert.ok(result, 'intent expected after retry');
  assert.strictEqual(result.toolName, 'send_email');
  assert.strictEqual(llmCalls.length, 2, 'expected subset call + full-set retry');
  assert.ok(
    llmCalls[0].body.tools.length < FULL_TOOL_COUNT,
    'first call should use a category subset'
  );
  assert.strictEqual(
    llmCalls[1].body.tools.length,
    FULL_TOOL_COUNT,
    'retry must use the full tool set'
  );
});

test('detectIntent: retry kill switch still keeps explicit commands out of generic chat', async () => {
  process.env.INTENT_FULLSET_RETRY = 'false';
  try {
    const msg = 'send an email to my new landlord about the broken heater situation please';
    resetLLM(makeTextResponse('no tool'));
    const result = await aiService.detectIntent(msg, { recentMessages: [] });
    assert.strictEqual(result.toolName, 'send_email');
    assert.strictEqual(result._explicitFallback, true);
    assert.strictEqual(llmCalls.length, 1, 'no retry when disabled');
    assert.deepStrictEqual(llmCalls[0].body.tool_choice, {
      type: 'function',
      function: { name: 'send_email' },
    });
  } finally {
    delete process.env.INTENT_FULLSET_RETRY;
  }
});

test('detectIntent: request_clarification tool call maps to the clarify intent', async () => {
  resetLLM(makeToolCallResponse('request_clarification', {
    question: 'Kal 5 baje Rahul — meeting book karu ya reminder?',
    options: ['Book a meeting', 'Set a reminder'],
  }));
  const result = await aiService.detectIntent('kal 5 baje rahul', { recentMessages: [] });
  assert.ok(result);
  assert.strictEqual(result.type, 'clarify');
  assert.ok(result.params.question.length > 0);
});

test('detectIntent: explicit send-reminder command cannot be misrouted to email', async () => {
  const msg = 'send reminder to akash at 8:00 pm to complete the task';
  resetLLM(makeToolCallResponse('send_email', { full_text: msg }));

  const result = await aiService.detectIntent(msg, { recentMessages: [] });

  assert.ok(result);
  assert.strictEqual(result.toolName, 'set_reminder');
  assert.strictEqual(result.type, 'reminder');
  assert.strictEqual(result.params.target_name.toLowerCase(), 'akash');
  assert.strictEqual(result.params.full_text, msg);
});

test('detectIntent: explicit Google connection command overrides a conflicting provider tool', async () => {
  const msg = 'connect my google account';
  resetLLM(makeToolCallResponse('send_email', { full_text: msg, to: 'google' }));

  const result = await aiService.detectIntent(msg, { recentMessages: [] });

  assert.ok(result);
  assert.strictEqual(result.toolName, 'connect_google');
  assert.strictEqual(result.params.full_text, msg);
  assert.strictEqual(result.params.to, undefined);
});

test('detectIntent: v3 prompt is default — clarification policy in, keyword decrees out', async () => {
  resetLLM(makeTextResponse('no tool'), makeTextResponse('no tool'));
  await aiService.detectIntent('random message about nothing in particular today ok', { recentMessages: [] });
  assert.ok(llmCalls.length >= 1);
  const systemPrompt = llmCalls[0].body.messages[0].content;
  assert.ok(systemPrompt.includes('request_clarification'), 'v3 must teach the clarification tool');
  assert.ok(!systemPrompt.includes('OK to be slightly wrong'), 'guessing instruction must be gone');
  assert.ok(!systemPrompt.includes('LEAD-VERB ROUTING'), 'lead-verb decree must be gone');
  assert.ok(systemPrompt.includes('typos'), 'v3 must normalize casual text');
});

test('detectIntent: INTENT_PROMPT_VERSION=v1 still selects the legacy prompt', async () => {
  process.env.INTENT_PROMPT_VERSION = 'v1';
  try {
    resetLLM(makeTextResponse('no tool'), makeTextResponse('no tool'));
    await aiService.detectIntent('random message about nothing in particular today ok', { recentMessages: [] });
    const systemPrompt = llmCalls[0].body.messages[0].content;
    assert.ok(systemPrompt.includes('LEAD-VERB ROUTING'), 'v1 rollback must restore the old prompt');
  } finally {
    delete process.env.INTENT_PROMPT_VERSION;
  }
});

test('detectIntent: assistant history turns keep 1500 chars (numbered lists survive)', async () => {
  const longList = 'Your options:\n' + Array.from({ length: 12 }, (_, i) =>
    `${i + 1}. Option number ${i + 1} with a reasonably descriptive label attached to it for realism`
  ).join('\n');
  assert.ok(longList.length > 800, 'precondition: list longer than the old 500-char cap');
  resetLLM(makeToolCallResponse('cancel_reminder', { position: '7' }));
  await aiService.detectIntent('the 7th one', {
    recentMessages: [
      { role: 'user', content: 'show options' },
      { role: 'assistant', content: longList },
    ],
  });
  const assistantTurn = llmCalls[0].body.messages.find(m => m.role === 'assistant');
  assert.ok(assistantTurn, 'assistant history turn expected');
  assert.ok(
    assistantTurn.content.length > 500,
    `assistant turn truncated to ${assistantTurn.content.length} — numbered list would be cut`
  );
});

test('semantic router examples no longer route positional replies to the removed visa category', () => {
  // Guard against regression: the few-shot block must not contain "→ visa".
  const src = require('fs').readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'ai.service.js'), 'utf8'
  );
  assert.ok(!/→ visa/.test(src), 'visa few-shot examples must stay removed');
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Confirmation gate — negation-aware matching + LLM fallback
// ═══════════════════════════════════════════════════════════════════════

function pendTestAction(executed) {
  return gate.pend('15550001111', {
    actionType: 'email',
    summary: 'Email to Priya: "Q3 numbers"',
    execute: async () => { executed.value = true; return 'SENT'; },
  });
}

test('gate: "ok, don\'t send it yet" must NOT send (negated action → cancel)', async () => {
  const executed = { value: false };
  await pendTestAction(executed);
  const result = await gate.tryResolve('15550001111', "ok, don't send it yet");
  assert.strictEqual(executed.value, false, 'the email must NOT be sent');
  assert.ok(result && /cancel/i.test(result), `expected a cancel reply, got: ${result}`);
  gate.clear('15550001111');
});

test('gate: clean confirmations still send — "yes pls", "yess", "han bhej de", "krdo"', async () => {
  for (const phrase of ['yes pls', 'yess', 'han bhej de', 'krdo', 'ok send it', 'haan bhej do']) {
    const executed = { value: false };
    await pendTestAction(executed);
    const result = await gate.tryResolve('15550001111', phrase);
    assert.strictEqual(executed.value, true, `"${phrase}" should confirm`);
    assert.strictEqual(result, 'SENT');
  }
});

test('gate: clean refusals cancel — "nvm", "mat bhejo", "dont send"', async () => {
  for (const phrase of ['nvm', 'mat bhejo', 'dont send', 'nahi']) {
    const executed = { value: false };
    await pendTestAction(executed);
    const result = await gate.tryResolve('15550001111', phrase);
    assert.strictEqual(executed.value, false, `"${phrase}" must not send`);
    assert.ok(/cancel/i.test(result), `"${phrase}" should cancel, got: ${result}`);
  }
});

test('gate: refusal words beat affirmative anchors — "pls cancel", "ok cancel that", "plz stop"', async () => {
  // Regression for the adversarial-review critical: bare pls/plz anchors made
  // "pls cancel" EXECUTE the send. Refusal verbs anywhere must cancel.
  for (const phrase of ['pls cancel', 'plz stop', 'ok cancel that', 'yes but skip it', 'cancel kar do']) {
    const executed = { value: false };
    await pendTestAction(executed);
    const result = await gate.tryResolve('15550001111', phrase);
    assert.strictEqual(executed.value, false, `"${phrase}" must NOT send`);
    assert.ok(/cancel/i.test(String(result)), `"${phrase}" should cancel, got: ${result}`);
  }
});

test('gate: LLM "confirm" verdict NEVER executes — hard gate nags for an explicit yes', async () => {
  // Hard-gate invariant: only the strict allowlist may fire an outbound send.
  // An LLM judgment (or classifyConfirmation's looser quick-list: "done",
  // "great") must not execute — it downgrades to a reminder nag.
  const executed = { value: false };
  await pendTestAction(executed);
  const original = gate._llmClassify;
  gate._llmClassify = async () => ({ decision: 'confirm' });
  try {
    const result = await gate.tryResolve('15550001111', 'no worries, send it');
    assert.strictEqual(executed.value, false, 'LLM confirm must NOT execute the send');
    assert.ok(/pending/i.test(result), `expected the confirmation nag, got: ${result}`);
    assert.strictEqual(gate.hasPending('15550001111'), true, 'pending action survives');
  } finally {
    gate._llmClassify = original;
    gate.clear('15550001111');
  }
});

test('gate: hesitant confirmation-adjacent replies get one reminder, never a guessed cancel', async () => {
  // Deterministic ambiguous policy (LLM classifier removed): a vague reply
  // that is still about the pending action reminds once and keeps it armed —
  // the gate never guesses cancel OR confirm from unclear text.
  const executed = { value: false };
  await pendTestAction(executed);
  try {
    const result = await gate.tryResolve('15550001111', 'hmm on second thought maybe another day');
    assert.strictEqual(executed.value, false);
    assert.ok(/pending/i.test(result), `expected the confirmation reminder, got: ${result}`);
    assert.strictEqual(gate.hasPending('15550001111'), true, 'pending action survives');
  } finally {
    gate.clear('15550001111');
  }
});

test('gate: long messages fall through WITHOUT burning the pending action', async () => {
  const executed = { value: false };
  await pendTestAction(executed);
  const long = 'also mention the Q3 numbers in the report and tell him the deadline moved to friday morning please';
  assert.ok(long.length > 80);
  const r1 = await gate.tryResolve('15550001111', long);
  const r2 = await gate.tryResolve('15550001111', long + ' and cc the finance team on it too');
  assert.strictEqual(r1, null);
  assert.strictEqual(r2, null);
  assert.strictEqual(gate.hasPending('15550001111'), true, 'long edit instructions must not expire the pending send');
  gate.clear('15550001111');
});

test('gate: new-topic replies fall through (null) and expire the pending action after 2 deflections', async () => {
  const executed = { value: false };
  await pendTestAction(executed);
  const original = gate._llmClassify;
  gate._llmClassify = async () => ({ decision: 'new_request' });
  try {
    const r1 = await gate.tryResolve('15550001111', 'whats the weather in dubai');
    assert.strictEqual(r1, null, 'new topic must fall through to normal routing');
    assert.strictEqual(gate.hasPending('15550001111'), true, 'pending survives one deflection');

    const r2 = await gate.tryResolve('15550001111', 'and book me a cab for 6');
    assert.strictEqual(r2, null);
    assert.strictEqual(gate.hasPending('15550001111'), false, 'pending expires after 2 deflections');
    assert.strictEqual(executed.value, false, 'nothing was ever sent');
  } finally {
    gate._llmClassify = original;
    gate.clear('15550001111');
  }
});

test('gate: LLM classifier failure keeps the pending action and nags once (safe default)', async () => {
  const executed = { value: false };
  await pendTestAction(executed);
  const original = gate._llmClassify;
  gate._llmClassify = async () => { throw new Error('boom'); };
  try {
    const result = await gate.tryResolve('15550001111', 'hmm what');
    assert.strictEqual(executed.value, false);
    assert.ok(/pending/i.test(result), 'should remind about the pending action');
    assert.strictEqual(gate.hasPending('15550001111'), true);
  } finally {
    gate._llmClassify = original;
    gate.clear('15550001111');
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 4. classifyConfirmation — quick paths + safe fallback
// ═══════════════════════════════════════════════════════════════════════

test('gate: after a restart, a "yes" to a lost pending action gets an honest notice, not silence', async () => {
  // Simulate: pending metadata persisted, process restarted (in-memory map
  // empty), user replies "yes".
  gate.clear('15550002222');
  const originalFetch = gate._dbFetchPending;
  const originalDelete = gate._dbDeletePending;
  let deleted = 0;
  gate._dbFetchPending = async () => ({ action_type: 'email', summary: 'Email to Priya', created_at: new Date().toISOString() });
  gate._dbDeletePending = async () => { deleted++; };
  try {
    const result = await gate.tryResolve('15550002222', 'yes');
    assert.ok(result && /nothing was sent/i.test(result), `expected the lost-pending notice, got: ${result}`);
    assert.strictEqual(deleted, 1, 'orphaned row must be cleaned up');
  } finally {
    gate._dbFetchPending = originalFetch;
    gate._dbDeletePending = originalDelete;
  }
});

test('gate: stale orphaned rows (past TTL) are silently cleaned, message falls through', async () => {
  const originalFetch = gate._dbFetchPending;
  const originalDelete = gate._dbDeletePending;
  gate._dbFetchPending = async () => ({ action_type: 'email', summary: 'old', created_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString() });
  gate._dbDeletePending = async () => {};
  try {
    const result = await gate.tryResolve('15550002222', 'yes');
    assert.strictEqual(result, null, 'stale orphan must not produce a notice');
  } finally {
    gate._dbFetchPending = originalFetch;
    gate._dbDeletePending = originalDelete;
  }
});

test('gate: non-confirmation messages never trigger the orphan DB lookup', async () => {
  const originalFetch = gate._dbFetchPending;
  let fetches = 0;
  gate._dbFetchPending = async () => { fetches++; return null; };
  try {
    await gate.tryResolve('15550002222', 'whats the weather in delhi');
    assert.strictEqual(fetches, 0, 'no DB lookup for a clearly-new-topic message');
  } finally {
    gate._dbFetchPending = originalFetch;
  }
});

test('detectIntent: "1" with NO history but a pending clarification hint reaches the LLM', async () => {
  resetLLM(makeToolCallResponse('create_calendar_event', { full_text: 'kal 5 baje rahul' }));
  const result = await aiService.detectIntent('1', {
    recentMessages: [],
    contextHints: {
      pendingIntentClarification: {
        question: 'Meeting book karu ya reminder?',
        options: ['Book a meeting', 'Set a reminder'],
        originalText: 'kal 5 baje rahul',
      },
    },
  });
  assert.ok(result, 'intent expected — the clarification hint must anchor the bare number');
  assert.strictEqual(result.toolName, 'create_calendar_event');
  assert.strictEqual(llmCalls.length, 1, 'LLM must be consulted');
  const sys = llmCalls[0].body.messages[0].content;
  assert.ok(sys.includes('Meeting book karu ya reminder?'), 'system prompt must carry the question');
  assert.ok(sys.includes('kal 5 baje rahul'), 'system prompt must carry the original request');
});

test('formatIntentContextHints renders a pending clarification prominently', () => {
  const text = aiService.formatIntentContextHints({
    pendingIntentClarification: {
      question: 'Meeting book karu ya reminder?',
      options: ['Book a meeting', 'Set a reminder'],
      originalText: 'kal 5 baje rahul',
    },
  });
  assert.ok(text.includes('Meeting book karu ya reminder?'), 'question must appear');
  assert.ok(text.includes('kal 5 baje rahul'), 'original request must appear');
  assert.ok(text.includes('1) Book a meeting'), 'options must be numbered');
});

test('classifyConfirmation: quick paths need no LLM', async () => {
  resetLLM();
  assert.deepStrictEqual(await aiService.classifyConfirmation('yes', 'email'), { decision: 'confirm' });
  assert.deepStrictEqual(await aiService.classifyConfirmation('krdo', 'email'), { decision: 'confirm' });
  assert.deepStrictEqual(await aiService.classifyConfirmation('yess', 'email'), { decision: 'confirm' });
  assert.deepStrictEqual(await aiService.classifyConfirmation('nvm', 'email'), { decision: 'cancel' });
  const sel = await aiService.classifyConfirmation('2', 'email');
  assert.strictEqual(sel.decision, 'select_option');
  assert.strictEqual(sel.option_number, 2);
  assert.strictEqual(llmCalls.length, 0, 'quick paths must not call the LLM');
});

test('classifyConfirmation: garbled LLM decision falls back to new_request, never confirm', async () => {
  resetLLM(makeTextResponse('{"decision":"banana"}'));
  const result = await aiService.classifyConfirmation('ya go ahead maybe?', 'email', 'Send email to Priya');
  assert.strictEqual(result.decision, 'new_request', 'invalid decision must NOT default to confirm');
});
