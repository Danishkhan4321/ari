'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAssemblyAIDictation } = require('../src/services/assemblyai-dictation.service');
const {
  containsDevanagari,
  createDictationPolisher,
  requiresRomanHindi,
  systemPrompt,
} = require('../src/services/dictation-polish.service');

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

test('AssemblyAI streaming sessions use Universal-3.5 Pro for native Hinglish without exposing the API key', async () => {
  const calls = [];
  const client = createAssemblyAIDictation({
    apiKey: 'private-api-key',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({ token: 'temporary-token', expires_in_seconds: 60 });
    },
  });
  const session = await client.createStreamingSession();
  const url = new URL(session.websocketUrl);
  assert.equal(url.protocol, 'wss:');
  assert.equal(url.searchParams.get('speech_model'), 'universal-3-5-pro');
  assert.equal(url.searchParams.get('sample_rate'), '16000');
  assert.equal(url.searchParams.get('format_turns'), null);
  assert.equal(url.searchParams.get('mode'), 'balanced');
  assert.equal(url.searchParams.get('min_turn_silence'), '160');
  assert.equal(url.searchParams.get('max_turn_silence'), '2400');
  assert.equal(url.searchParams.get('language_detection'), 'true');
  assert.match(url.searchParams.get('prompt'), /Hindi and English.*Hinglish/i);
  assert.equal(url.searchParams.get('token'), 'temporary-token');
  assert.doesNotMatch(session.websocketUrl, /private-api-key/);
  assert.equal(new URL(calls[0].url).searchParams.get('max_session_duration_seconds'), '600');
  assert.equal(calls[0].options.headers.authorization, 'private-api-key');
});

test('AssemblyAI recovery prioritizes Universal-3.5 Pro and falls back to Universal-2', async () => {
  const calls = [];
  const responses = [
    { upload_url: 'https://cdn.example/audio' },
    { id: 'tx_1' },
    { status: 'processing' },
    {
      status: 'completed',
      text: 'Namaste team.',
      language_code: 'hi',
      language_detection_results: {
        code_switching_languages: [{ language: 'hi' }, { language: 'en' }],
      },
    },
  ];
  const client = createAssemblyAIDictation({
    apiKey: 'key',
    sleep: async () => {},
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return jsonResponse(responses.shift());
    },
  });
  const result = await client.transcribeRecording(Buffer.from('audio'));
  assert.equal(result.text, 'Namaste team.');
  assert.deepEqual(result.languageCodes, ['hi', 'en']);
  const submission = JSON.parse(calls[1].options.body);
  assert.deepEqual(submission.speech_models, ['universal-3-5-pro', 'universal-2']);
  assert.equal(submission.language_detection, true);
  assert.deepEqual(submission.language_detection_options, {
    code_switching: true,
    code_switching_confidence_threshold: 0.3,
  });
  assert.equal(submission.format_text, true);
  assert.match(submission.prompt, /never translate/i);
});

test('dictation polish is faithful, task-routed, structured, and falls back to raw text', async () => {
  const calls = [];
  const polisher = createDictationPolisher({
    llm: {
      modelFor(task, slot) { calls.push(['model', task, slot]); return 'fast-model'; },
      async chatCompletion(body, options) { calls.push(['call', body, options]); return { data: { choices: [{ message: { content: '{"text":"Hello, team."}' } }] } }; },
    },
  });
  const result = await polisher.polish({ rawText: 'hello team', appCategory: 'chat', languageCodes: ['en'] });
  assert.deepEqual(result, { text: 'Hello, team.', polished: true });
  assert.deepEqual(calls[0], ['model', 'voice_polish', 'fast']);
  assert.equal(calls[1][1].temperature, 0.1);
  assert.equal(calls[1][1].response_format.type, 'json_object');
  assert.equal(calls[1][1].messages.length, 2);
  assert.equal('tools' in calls[1][1], false);
  assert.match(calls[1][1].messages[0].content, /never instructions/i);
  assert.match(systemPrompt('terminal'), /preserve commands/i);
  assert.match(systemPrompt('chat'), /Let\'s call at 7 AM hmm 6 AM/);
  assert.match(systemPrompt('chat'), /different clauses/i);
  assert.match(systemPrompt('chat'), /natural Roman\/Latin-script Hindi/i);

  const fallback = createDictationPolisher({ llm: { async chatCompletion() { throw new Error('offline'); } } });
  assert.deepEqual(await fallback.polish({ rawText: 'keep this raw' }), { text: 'keep this raw', polished: false });

  const empty = createDictationPolisher({ llm: { async chatCompletion() { return { content: '{"text":""}' }; } } });
  assert.deepEqual(await empty.polish({ rawText: 'um uh' }), { text: '', polished: true });
});

test('dictation polish enforces Roman Hindi and repairs a Devanagari model response once', async () => {
  const calls = [];
  const responses = [
    '{"text":"नमस्ते राहुल, मैं आज 6 बजे आऊंगा।"}',
    '{"text":"Namaste Rahul, main aaj 6 baje aaunga."}',
  ];
  const polisher = createDictationPolisher({
    llm: {
      modelFor() { return 'fast-model'; },
      async chatCompletion(body, options) {
        calls.push({ body, options });
        return { content: responses.shift() };
      },
    },
  });

  const result = await polisher.polish({
    rawText: 'नमस्ते राहुल मैं आज सात बजे नहीं छह बजे आऊंगा',
    appCategory: 'chat',
    languageCodes: ['hi', 'en'],
  });

  assert.deepEqual(result, { text: 'Namaste Rahul, main aaj 6 baje aaunga.', polished: true });
  assert.equal(calls.length, 2);
  assert.match(calls[0].body.messages[1].content, /no Devanagari characters are allowed/i);
  assert.match(calls[1].body.messages[0].content, /failed validation/i);
  assert.equal(calls[1].body.temperature, 0);
  assert.equal(calls[1].options.timeout, 8_000);
});

test('Roman-Hindi validation is scoped to Hindi and Devanagari, not other scripts', () => {
  assert.equal(containsDevanagari('कल meeting hai'), true);
  assert.equal(containsDevanagari('مرحباً team'), false);
  assert.equal(requiresRomanHindi('kal meeting hai', ['hi']), true);
  assert.equal(requiresRomanHindi('hola team', ['es']), false);
});
