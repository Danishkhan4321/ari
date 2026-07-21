const { AsyncLocalStorage } = require('node:async_hooks');
const BoundedMap = require('../utils/bounded-map');

const storage = new AsyncLocalStorage();

function runWithChatSession(context, work) {
  if (!context?.sessionId) return work();
  const value = Object.freeze({
    sessionId: String(context.sessionId),
    clientMessageId: context.clientMessageId ? String(context.clientMessageId) : null,
    runId: context.runId ? String(context.runId) : null,
    userPhone: context.userPhone ? String(context.userPhone) : null,
    signal: context.signal || null,
  });
  return storage.run(value, work);
}

function currentChatSession() {
  return storage.getStore() || null;
}

function conversationStateKey(key) {
  const context = currentChatSession();
  return context?.sessionId ? `${String(key)}::session:${context.sessionId}` : key;
}

class SessionScopedBoundedMap extends BoundedMap {
  get(key) { return super.get(conversationStateKey(key)); }
  set(key, value, ttl) { return super.set(conversationStateKey(key), value, ttl); }
  has(key) { return super.has(conversationStateKey(key)); }
  delete(key) { return super.delete(conversationStateKey(key)); }
}

module.exports = {
  runWithChatSession,
  currentChatSession,
  conversationStateKey,
  SessionScopedBoundedMap,
};
