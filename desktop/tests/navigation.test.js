const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyUrl } = require('../src/navigation');

test('allows the local dashboard and its routes', () => {
  assert.equal(classifyUrl('http://127.0.0.1:43101/tasks', 'http://127.0.0.1:43101'), 'local');
});

test('never treats remote application hosts as the local dashboard', () => {
  assert.equal(classifyUrl('https://dashboard.example.test/login', 'http://127.0.0.1:43101'), 'external');
  assert.equal(classifyUrl('https://api.example.test/health', 'http://127.0.0.1:43101'), 'external');
});

test('opens other http links externally and blocks unsafe protocols', () => {
  assert.equal(classifyUrl('https://accounts.google.com/', 'http://127.0.0.1:43101'), 'external');
  assert.equal(classifyUrl('file:///C:/Windows/System32', 'http://127.0.0.1:43101'), 'blocked');
  assert.equal(classifyUrl('javascript:alert(1)', 'http://127.0.0.1:43101'), 'blocked');
});

test('does not mistake lookalike hosts for the local dashboard', () => {
  assert.equal(classifyUrl('http://127.0.0.1.example.com:43101/', 'http://127.0.0.1:43101'), 'external');
});
