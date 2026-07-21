#!/usr/bin/env node
'use strict';

/**
 * Live smoke test for the Vertex Gemini tool-calling path.
 *
 * Read-only inference — makes two small model calls and prints results.
 * Never prints secrets. No database access.
 *
 * Usage (own env):
 *   LLM_PROVIDER=vertex_gemma node -r dotenv/config scripts/vertex-smoke-test.js
 * Usage (borrowing another .env, e.g. the demo deployment's Google creds):
 *   LLM_PROVIDER=vertex_gemma DOTENV_CONFIG_PATH=/path/to/.env \
 *     node -r dotenv/config scripts/vertex-smoke-test.js [model]
 */

const MODEL = process.argv[2] || 'gemini-2.5-flash';

(async () => {
  const llm = require('../src/services/llm-provider');

  console.log(`provider   : ${llm.providerName()}`);
  console.log(`model      : ${MODEL}`);
  console.log(`project set: ${!!(process.env.GOOGLE_VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT)}`);
  console.log(`creds set  : ${!!(process.env.GOOGLE_VERTEX_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_VERTEX_ACCESS_TOKEN)}`);
  console.log('');

  // ── Test 1: plain completion ────────────────────────────────────────────
  try {
    const t0 = Date.now();
    const resp = await llm.chatCompletion({
      model: MODEL,
      messages: [{ role: 'user', content: 'Reply with exactly: VERTEX OK' }],
      // Gemini 2.5 is a thinking model — leave headroom so reasoning tokens
      // don't consume the whole budget and return empty text.
      max_tokens: 200,
      temperature: 0,
    }, { timeout: 30000 });
    const text = resp?.data?.choices?.[0]?.message?.content || '(empty)';
    console.log(`[1/2] plain completion  : PASS (${Date.now() - t0}ms) → "${String(text).trim().slice(0, 60)}"`);
  } catch (e) {
    console.log(`[1/2] plain completion  : FAIL → ${e.response?.status || ''} ${e.response?.data?.error?.message || e.message}`);
    process.exitCode = 1;
    return;
  }

  // ── Test 2: native tool calling ─────────────────────────────────────────
  try {
    const t0 = Date.now();
    const resp = await llm.chatCompletion({
      model: MODEL,
      messages: [{ role: 'user', content: 'Assign a task to Akash to fix the login bug, and remind me tomorrow at 10am to review it.' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'tasks_assign',
            description: 'Assign a work item to a team member',
            parameters: {
              type: 'object',
              properties: {
                assignee: { type: 'string' },
                title: { type: 'string' },
              },
              required: ['assignee', 'title'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'reminders_create',
            description: 'Create a reminder for the user themself at a specific time',
            parameters: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                time: { type: 'string', description: 'natural language time' },
              },
              required: ['message', 'time'],
            },
          },
        },
      ],
      tool_choice: 'auto',
      max_tokens: 300,
      temperature: 0,
    }, { timeout: 30000 });

    const msg = resp?.data?.choices?.[0]?.message || {};
    const calls = msg.tool_calls || [];
    if (calls.length === 0) {
      console.log(`[2/2] native tool calls : WEAK — model answered with text instead of tool_calls: "${String(msg.content || '').slice(0, 100)}"`);
      process.exitCode = 1;
      return;
    }
    console.log(`[2/2] native tool calls : PASS (${Date.now() - t0}ms) → ${calls.length} call(s):`);
    for (const c of calls) {
      console.log(`      • ${c.function?.name}(${String(c.function?.arguments || '').slice(0, 120)})`);
    }
    if (calls.length >= 2) {
      console.log('      ↑ compound utterance produced BOTH tool calls in one turn — the screenshot failure mode is fixed at the model layer.');
    }
  } catch (e) {
    console.log(`[2/2] native tool calls : FAIL → ${e.response?.status || ''} ${e.response?.data?.error?.message || e.message}`);
    process.exitCode = 1;
  }
})();
