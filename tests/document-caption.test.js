'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { extractActionableCaption } = require('../src/utils/document-caption');

test('an instruction sent with an attachment is actionable', () => {
  const caption = extractActionableCaption({
    type: 'document',
    text: 'i have attched the lead excel sheet i want you to create a group in our crm named lead for greencardguide',
    document: { fileName: 'Organized Contacts - Opportunity Matching.xlsx' },
  });
  assert.match(caption, /create a group/);
});

test('WhatsApp captions are read from document.caption', () => {
  const caption = extractActionableCaption({
    type: 'document',
    text: '',
    document: { filename: 'leads.pdf', caption: 'summarize this and remind me tomorrow' },
  });
  assert.equal(caption, 'summarize this and remind me tomorrow');
});

test('a bare attachment has no actionable caption', () => {
  assert.equal(
    extractActionableCaption({ type: 'document', text: '', document: { filename: 'leads.pdf' } }),
    null,
  );
});

test('filename echoes are not instructions', () => {
  const doc = { filename: 'Leads.xlsx' };
  assert.equal(extractActionableCaption({ text: 'leads.xlsx', document: doc }), null);
  assert.equal(extractActionableCaption({ text: 'Attached: Leads.xlsx', document: doc }), null);
});

test('whitespace-only captions and missing documents are null', () => {
  assert.equal(extractActionableCaption({ text: '   ', document: { filename: 'a.pdf' } }), null);
  assert.equal(extractActionableCaption({ text: 'do something' }), null);
  assert.equal(extractActionableCaption(null), null);
});
