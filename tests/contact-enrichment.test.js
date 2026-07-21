const test = require('node:test');
const assert = require('node:assert/strict');

const { parseEnrichmentOutput } = require('../src/services/contact-enrichment.service');

test('contact enrichment parses grounded structured output without extra fields', () => {
  const result = parseEnrichmentOutput(JSON.stringify({
    email: 'akash@example.com',
    company: 'Acme',
    title: 'Founder',
    linkedin_url: 'https://linkedin.com/in/akash',
    website: 'https://example.com',
    secret: 'ignore me',
  }));

  assert.deepEqual(result, {
    email: 'akash@example.com',
    company: 'Acme',
    title: 'Founder',
    linkedin_url: 'https://linkedin.com/in/akash',
    website: 'https://example.com',
  });
});

test('contact enrichment safely handles missing or malformed output', () => {
  assert.deepEqual(parseEnrichmentOutput('not json'), {
    email: null,
    company: null,
    title: null,
    linkedin_url: null,
    website: null,
  });
});
