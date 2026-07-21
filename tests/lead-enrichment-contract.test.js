'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../src/services/lead-enrichment.service');

test('bounds Exa enrichment rows and paid contact fields', () => {
  const payload = service.buildRunPayload([{ lead_id: 1, name: 'Ada', company: 'Acme' }], ['profile']);
  const item = payload.outputSchema.properties.leads.items.properties;
  assert.equal(payload.effort, 'low');
  assert.equal(payload.outputSchema.properties.leads.maxItems, 1);
  assert.equal(item.work_email, undefined);
  assert.equal(item.phone, undefined);
  assert.deepEqual(item.identity_confidence.enum, ['high', 'medium', 'low']);
  assert.equal(payload.outputSchema.properties.leads.items.required.includes('identity_confidence'), true);
  assert.equal(payload.outputSchema.properties.leads.items.required.includes('matched_name'), true);
  assert.equal(payload.outputSchema.properties.leads.items.required.includes('source_urls'), true);
  assert.match(payload.query, /high confidence/i);
  assert.match(payload.query, /full name and company/i);
  assert.deepEqual(payload.input.data[0], { lead_id: 1, name: 'Ada', company: 'Acme' });
});

test('adds email and phone formats only when explicitly requested', () => {
  const schema = service.buildOutputSchema(['profile', 'email', 'phone'], 10);
  const props = schema.properties.leads.items.properties;
  assert.equal(props.work_email.format, 'email');
  assert.equal(props.phone.format, 'phone');
  assert.equal(schema.properties.leads.maxItems, 10);
});
