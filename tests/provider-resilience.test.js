'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Configure the provider before loading modules that snapshot env at require time.
process.env.LLM_PROVIDER = 'vertex_gemma';
process.env.GOOGLE_VERTEX_PROJECT = 'test-project';
process.env.GOOGLE_VERTEX_LOCATION = 'global';
process.env.GOOGLE_VERTEX_ACCESS_TOKEN = 'test-vertex-token';
process.env.FIREWORKS_API_KEY = 'test-fireworks-token';
process.env.FIREWORKS_FALLBACK_MODEL = 'accounts/fireworks/models/qwen3p7-plus';
process.env.MODEL_LANGUAGE_DETECT = 'accounts/fireworks/models/qwen3p7-plus';
process.env.MODEL_MEM0 = 'accounts/fireworks/models/qwen3p7-plus';
process.env.MODEL_INTENT_PRIMARY = 'accounts/fireworks/models/qwen3p7-plus';

const axios = require('axios');
const llmProvider = require('../src/services/llm-provider');
const webhookController = require('../src/controllers/webhook.controller');
const { parseHabitCommand } = require('../src/handlers/habit.handler');
const modelUsageTracker = require('../src/services/model-usage-tracker.service');

test('habit parser recognizes mark-habit-done variants without an LLM', () => {
  assert.deepEqual(parseHabitCommand('mark drink water done today'), {
    action: 'log',
    habit_name: 'drink water',
    full_text: 'mark drink water done today',
  });
  assert.deepEqual(parseHabitCommand('mark drink water as done'), {
    action: 'log',
    habit_name: 'drink water',
    full_text: 'mark drink water as done',
  });
  assert.deepEqual(parseHabitCommand('done drink water'), {
    action: 'log',
    habit_name: 'drink water',
    full_text: 'done drink water',
  });
});

test('deterministic command parser bypasses the LLM for help and explicit habit commands', () => {
  assert.deepEqual(webhookController.parseDeterministicCommand('help'), { type: 'help', params: {} });
  assert.deepEqual(webhookController.parseDeterministicCommand('show help'), { type: 'help', params: {} });
  assert.deepEqual(webhookController.parseDeterministicCommand('track habit: drink water'), {
    type: 'habit_manage',
    params: {
      action: 'create',
      habit_name: 'drink water',
      frequency: 'daily',
      target_count: 1,
      full_text: 'track habit: drink water',
    },
  });
  assert.equal(webhookController.parseDeterministicCommand('help me write an email'), null);
});

test('Exa pre-routing does not steal account or workspace tool commands', () => {
  const toolCommands = [
    'connect google',
    'disconnect my Google account',
    'link my Outlook account',
    'connect Apple Calendar',
    'search Google Drive for the launch plan',
    'create a Google Doc called Launch Notes',
    'add submit report to my Google Tasks',
    'find Alice in my Google contacts',
    'check my Gmail inbox',
    'share my Drive file with alice@example.com',
  ];

  for (const command of toolCommands) {
    assert.equal(webhookController.shouldUseExaWebSearch(command), false, command);
  }
});

test('Exa pre-routing still recognizes explicit and live web searches', () => {
  const webQueries = [
    'search the web for AMD demo news',
    'search for the latest ROCm release',
    'google AMD developer cloud pricing',
    'look up the current USD to INR rate',
    'who won the latest IPL match?',
  ];

  for (const query of webQueries) {
    assert.equal(webhookController.shouldUseExaWebSearch(query), true, query);
  }
});

test('habit log bypass only claims commands for a habit that actually exists', () => {
  const command = {
    type: 'habit_manage',
    params: { action: 'log', habit_name: 'drink water' },
  };
  assert.equal(webhookController.shouldRouteDeterministicHabit(command, [{ name: 'Drink Water' }]), true);
  assert.equal(webhookController.shouldRouteDeterministicHabit(command, [{ name: 'walk 10km' }]), false);
});

test('Vertex capacity errors fail over to Fireworks serverless without reasoning tokens', async () => {
  const originalPost = axios.post;
  const calls = [];
  axios.post = async (url, body) => {
    calls.push({ url, body });
    if (String(url).includes('aiplatform.googleapis.com')) {
      const error = new Error('The request queue is full.');
      error.response = { status: 429, data: { error: { status: 'RESOURCE_EXHAUSTED' } } };
      throw error;
    }
    return {
      data: {
        choices: [{ message: { content: 'fallback response' } }],
        usage: { total_tokens: 4 },
      },
    };
  };

  try {
    const result = await llmProvider.chatCompletion({
      model: 'gemma-4-26b-a4b-it-maas',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 50,
    }, { task: 'chat', timeout: 5000 });

    assert.equal(result.data.choices[0].message.content, 'fallback response');
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /aiplatform\.googleapis\.com/);
    assert.equal(calls[1].url, 'https://api.fireworks.ai/inference/v1/chat/completions');
    assert.equal(calls[1].body.model, 'accounts/fireworks/models/qwen3p7-plus');
    assert.equal(calls[1].body.reasoning_effort, 'none');
  } finally {
    axios.post = originalPost;
  }
});

test('an explicit Fireworks task model is not forced back through Vertex', async () => {
  const originalPost = axios.post;
  const calls = [];
  axios.post = async (url, body) => {
    calls.push({ url, body });
    return {
      data: {
        choices: [{ message: { content: 'routed response' } }],
        usage: { total_tokens: 3 },
      },
    };
  };

  try {
    await llmProvider.chatCompletion({
      model: 'accounts/fireworks/models/qwen3p7-plus',
      messages: [{ role: 'user', content: 'classify this' }],
      max_tokens: 30,
    }, { task: 'language_detect', timeout: 3000 });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.fireworks.ai/inference/v1/chat/completions');
    assert.equal(calls[0].body.model, 'accounts/fireworks/models/qwen3p7-plus');
    assert.equal(calls[0].body.reasoning_effort, 'none');
  } finally {
    axios.post = originalPost;
  }
});

test('model usage tracking accepts the explicitly configured Fireworks task model', () => {
  assert.equal(
    modelUsageTracker.isExpectedModel('language_detect', 'accounts/fireworks/models/qwen3p7-plus'),
    true
  );
  assert.equal(
    modelUsageTracker.isExpectedModel('intent_primary', 'accounts/fireworks/models/qwen3p7-plus'),
    true
  );
});

test('non-retryable Vertex errors do not switch providers', async () => {
  const originalPost = axios.post;
  let calls = 0;
  axios.post = async () => {
    calls += 1;
    const error = new Error('invalid request');
    error.response = { status: 400 };
    throw error;
  };

  try {
    await assert.rejects(() => llmProvider.chatCompletion({
      model: 'gemma-4-26b-a4b-it-maas',
      messages: [{ role: 'user', content: 'hello' }],
    }));
    assert.equal(calls, 1);
  } finally {
    axios.post = originalPost;
  }
});
