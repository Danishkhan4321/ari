'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../src/services/lead-enrichment-policy');

test('requires a name and one usable lead identifier', () => {
  assert.equal(policy.eligibility({ name: 'Ada', linkedin_url: 'linkedin.com/in/ada' }).eligible, true);
  assert.equal(policy.eligibility({ name: 'Ada', email: 'ada@example.com' }).eligible, true);
  assert.equal(policy.eligibility({ name: 'Ada', company: 'Acme', website: 'acme.com' }).eligible, true);
  assert.equal(policy.eligibility({ name: 'Ada', company: 'Acme' }).eligible, true);
  assert.equal(policy.eligibility({ company: 'Acme', website: 'acme.com' }).eligible, false);
});

test('estimates bounded paid-field costs', () => {
  assert.equal(policy.estimateCost(10, ['profile']), 0.165);
  assert.equal(policy.estimateCost(10, ['profile', 'email']), 0.365);
  assert.equal(policy.estimateCost(10, ['profile', 'email', 'phone']), 1.065);
  assert.equal(policy.estimateCost(500, ['phone']), policy.estimateCost(100, ['phone']));
});

test('normalizes returned contact and company data', () => {
  const result = policy.normalizeResult({
    work_email: ' ADA@EXAMPLE.COM ',
    phone: '+1 (415) 555-1212',
    linkedin_url: 'linkedin.com/in/ada/',
    company_website: 'https://www.example.com/',
    company_founded_year: '2020',
    social_profiles: ['https://x.com/ada', 'https://x.com/ada'],
  });
  assert.equal(result.email, 'ada@example.com');
  assert.equal(result.phone, '+14155551212');
  assert.equal(result.company_domain, 'example.com');
  assert.equal(result.company_founded_year, 2020);
  assert.deepEqual(result.social_profiles, ['https://x.com/ada']);
  assert.equal(result.identity_confidence, 'low');
});

test('only applies empty fields and silently preserves populated fields', () => {
  assert.equal(policy.classifyField(null, 'VP Sales'), 'apply');
  assert.equal(policy.classifyField('VP Sales', 'VP Sales'), 'unchanged');
  assert.equal(policy.classifyField('VP Sales', 'Chief Revenue Officer'), 'ignored');
  assert.equal(policy.classifyField('VP Sales', null), 'empty');
});

test('requires a close local identity match before applying enrichment', () => {
  const base = {
    matched_name: 'Amina Fields',
    identity_verified: true,
    identity_confidence: 'high',
    source_urls: ['https://example.com/profile/amina'],
  };
  assert.equal(policy.isHighConfidenceMatch(
    { name: 'Amina Fields', company: 'CAIR-CA, Amina Fields Law Office' },
    { ...base, company: 'CAIR-LA' },
  ), false);
  assert.equal(policy.isHighConfidenceMatch(
    { name: 'Omar Gastelum', company: 'Gastelum Law, PPLSI' },
    { ...base, matched_name: 'Omar Gastelum', company: 'Gastelum Law PPLSI' },
  ), true);
  assert.equal(policy.isHighConfidenceMatch(
    { name: 'Omar Gastelum', company: 'Gastelum Law, PPLSI' },
    { ...base, matched_name: 'Omar Gastelum', company: 'Gastelum Law PPLSI', source_urls: [] },
  ), false);
});
