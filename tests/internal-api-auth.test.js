const test = require('node:test');
const assert = require('node:assert/strict');

const { isAllowedInternalAddress } = require('../src/utils/internal-api-auth');

test('internal API always accepts loopback callers', () => {
  assert.equal(isAllowedInternalAddress('127.0.0.1'), true);
  assert.equal(isAllowedInternalAddress('::1'), true);
  assert.equal(isAllowedInternalAddress('::ffff:127.0.0.1'), true);
});

test('internal API accepts private Docker callers only when explicitly enabled', () => {
  assert.equal(isAllowedInternalAddress('172.18.0.4'), false);
  assert.equal(isAllowedInternalAddress('172.18.0.4', { allowPrivate: true }), true);
  assert.equal(isAllowedInternalAddress('10.0.3.7', { allowPrivate: true }), true);
  assert.equal(isAllowedInternalAddress('192.168.1.10', { allowPrivate: true }), true);
});

test('internal API rejects public callers unless public access is explicitly enabled', () => {
  assert.equal(isAllowedInternalAddress('129.212.189.5', { allowPrivate: true }), false);
  assert.equal(isAllowedInternalAddress('129.212.189.5', { allowPublic: true }), true);
});
