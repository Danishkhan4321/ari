'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createReportGenerator,
  reportSchema,
} = require('../src/services/manual-meetings/report-generator');

function validReport() {
  return {
    summary: 'Speaker A committed to shipping on Friday.',
    decisions: ['Speaker A will ship on Friday.'],
    actionItems: [{ text: 'Ship the release', assigneeSpeakerId: 'A', deadline: 'Friday' }],
    suggestedTasks: [{ title: 'Ship release', suggestedAssigneeSpeakerId: 'A', reason: 'Speaker A committed to it.' }],
    topics: ['Release'],
    openQuestions: ['Is QA complete?'],
    reportMarkdown: [
      '# Planning meeting report',
      '## Overview\nSpeaker A committed to shipping Friday.',
      '## Decisions\n- Ship Friday.',
      '## Action items\n- Speaker A: ship the release.',
      '## Suggested tasks and assignees\n- Ship release — Speaker A (suggestion only).',
      '## Open questions\n- Is QA complete?',
      '## Transcript notes\n- Speaker A committed to the date.',
    ].join('\n\n'),
  };
}

function fakeLlm(outputs, calls = []) {
  const queue = Array.isArray(outputs) ? [...outputs] : [outputs];
  return {
    fastModel: () => 'test-model',
    chatCompletion: async (body) => {
      calls.push(body);
      const output = queue.shift();
      return { data: { choices: [{ message: { content: typeof output === 'string' ? output : JSON.stringify(output) } }] } };
    },
  };
}

test('report keeps canonical speaker IDs and all required sections', async () => {
  const generator = createReportGenerator({ llm: fakeLlm(validReport()) });
  const report = await generator.generate({
    title: 'Planning',
    transcriptSegments: [{ speakerId: 'A', text: 'I will ship Friday.', startMs: 0, endMs: 10 }],
  });

  assert.equal(report.actionItems[0].assigneeSpeakerId, 'A');
  assert.ok(report.summary);
  assert.ok(report.reportMarkdown.includes('#'));
  assert.ok(Array.isArray(report.suggestedTasks));
  assert.ok(Array.isArray(report.openQuestions));
});

test('report parser accepts fenced JSON and retries malformed output once', async () => {
  const calls = [];
  const generator = createReportGenerator({
    llm: fakeLlm(['```json\n{"summary":"incomplete"}\n```', validReport()], calls),
  });
  const report = await generator.generate({
    title: 'Planning',
    transcriptSegments: [{ speakerId: 'A', text: 'Ship Friday.', startMs: 0, endMs: 10 }],
  });

  assert.equal(report.summary, validReport().summary);
  assert.equal(calls.length, 2);
  assert.match(calls[1].messages[1].content, /failed validation/i);
});

test('report rejects unknown or name-like speaker IDs', async () => {
  const report = validReport();
  report.actionItems[0].assigneeSpeakerId = 'Danish';
  const generator = createReportGenerator({ llm: fakeLlm([report, report]) });

  await assert.rejects(
    generator.generate({
      title: 'Planning',
      transcriptSegments: [{ speakerId: 'A', text: 'Ship Friday.', startMs: 0, endMs: 10 }],
    }),
    /Unknown speaker ID/,
  );
});

test('report schema rejects missing complete-report sections', () => {
  const result = reportSchema.safeParse({ ...validReport(), reportMarkdown: '# Overview\nShort.' });
  assert.equal(result.success, false);
});
