const test = require('node:test');
const assert = require('node:assert/strict');
const {
  runWithChatSession,
  currentChatSession,
  conversationStateKey,
  SessionScopedBoundedMap,
} = require('../src/services/chat-session-context');

test('chat session context survives async boundaries and then clears', async () => {
  await runWithChatSession({ sessionId: 'session-a', clientMessageId: 'message-a' }, async () => {
    await Promise.resolve();
    assert.equal(currentChatSession().sessionId, 'session-a');
    assert.equal(currentChatSession().clientMessageId, 'message-a');
    assert.equal(conversationStateKey('user'), 'user::session:session-a');
  });
  assert.equal(currentChatSession(), null);
  assert.equal(conversationStateKey('user'), 'user');
});

test('session-scoped maps isolate the same user key between sessions', async () => {
  const values = new SessionScopedBoundedMap(20, 10000);
  await runWithChatSession({ sessionId: 'session-a' }, async () => values.set('user', 'alpha'));
  await runWithChatSession({ sessionId: 'session-b' }, async () => values.set('user', 'beta'));

  assert.equal(await runWithChatSession({ sessionId: 'session-a' }, async () => values.get('user')), 'alpha');
  assert.equal(await runWithChatSession({ sessionId: 'session-b' }, async () => values.get('user')), 'beta');
  assert.equal(values.get('user'), undefined);
});

test('dashboard controller locks use the session-scoped conversation key', () => {
  const source = require('node:fs').readFileSync(require.resolve('../src/controllers/webhook.controller'), 'utf8');
  assert.match(source, /const processingLockKey = conversationStateKey\(message\.from\)/);
  assert.match(source, /acquireUserLock\(processingLockKey\)/);
  assert.match(source, /releaseUserLock\(processingLockKey\)/);
});
