'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  materializeMeeting,
  replaceSpeakerTokens,
} = require('../src/services/manual-meetings/meeting-renderer');

test('materializeMeeting applies speaker names to every artifact', () => {
  const canonical = {
    transcriptSegments: [
      { speakerId: 'A', startMs: 0, endMs: 900, text: 'I will send the proposal.' },
      { speakerId: 'B', startMs: 1000, endMs: 1800, text: 'Approved.' },
    ],
    report: {
      summary: 'Speaker A will send the proposal to Speaker B.',
      decisions: ['Speaker B approved the proposal.'],
      actionItems: [{ text: 'Send the proposal', assigneeSpeakerId: 'A', deadline: null }],
      suggestedTasks: [{ title: 'Send proposal', suggestedAssigneeSpeakerId: 'A', reason: 'Speaker A committed to it.' }],
      topics: ['Proposal'],
      reportMarkdown: '# Report\nSpeaker A owns the follow-up; Speaker B approved it.',
    },
  };

  const result = materializeMeeting(canonical, { A: 'Danish', B: 'Priya' });

  assert.match(result.transcript, /Danish: I will send/);
  assert.equal(result.summary, 'Danish will send the proposal to Priya.');
  assert.deepEqual(result.decisions, ['Priya approved the proposal.']);
  assert.equal(result.actionItems[0].assignee, 'Danish');
  assert.equal(result.suggestedTasks[0].suggestedAssignee, 'Danish');
  assert.match(result.reportMarkdown, /Danish owns.*Priya approved/s);
  assert.deepEqual(result.attendees, ['Danish', 'Priya']);
});

test('materializeMeeting keeps neutral labels when names are absent', () => {
  const result = materializeMeeting({
    transcriptSegments: [{ speakerId: 'A', startMs: 0, endMs: 1, text: 'Hello' }],
    report: {
      summary: 'Speaker A spoke.',
      decisions: [],
      actionItems: [],
      suggestedTasks: [],
      topics: [],
      reportMarkdown: 'Speaker A spoke.',
    },
  }, {});

  assert.equal(result.transcript, 'Speaker A: Hello');
  assert.equal(result.summary, 'Speaker A spoke.');
});

test('speaker replacement is token-boundary aware', () => {
  assert.equal(
    replaceSpeakerTokens('Speaker A replied to Speaker AA.', { A: 'Danish' }),
    'Danish replied to Speaker AA.',
  );
});
