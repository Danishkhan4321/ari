const test = require('node:test');
const assert = require('node:assert/strict');

const cases = require('./eval/dictation-polish.json');

test('dictation golden set contains at least 20 bounded multilingual, application-aware cases', () => {
  assert.ok(cases.length >= 20);
  assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);

  const languages = new Set(cases.map((item) => item.language));
  for (const language of ['en', 'hi', 'hi-en', 'es', 'ar']) {
    assert.ok(languages.has(language), `missing ${language}`);
  }

  const categories = new Set(cases.map((item) => item.appCategory));
  for (const category of ['chat', 'email', 'document', 'code', 'terminal', 'generic']) {
    assert.ok(categories.has(category), `missing ${category}`);
  }

  for (const item of cases) {
    assert.match(item.id, /^[a-z0-9-]+$/);
    assert.ok(item.raw.length > 0 && item.raw.length <= 20_000);
    assert.ok(item.expectedMeaning.length > 0);
    assert.ok(Array.isArray(item.mustPreserve));
    assert.ok(Array.isArray(item.mustNotAdd) && item.mustNotAdd.length > 0);
  }

  assert.ok(cases.some((item) => item.id.includes('self-correction')));
  assert.ok(cases.some((item) => item.id.includes('roman-hindi')));
  assert.ok(cases.some((item) => item.id.includes('correction-scope')));
  assert.ok(cases.some((item) => item.id.includes('spoken-list')));
  assert.ok(cases.some((item) => item.id.includes('prompt-injection')));
  assert.ok(cases.some((item) => item.id.includes('empty')));
});
