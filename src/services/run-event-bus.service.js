'use strict';

// In-process pub/sub for live run progress (status lines, tool events, text
// deltas). This is the PUSH path the dashboard streams from — unlike
// agent_run_events (durable, polled), the bus is ephemeral: high-frequency
// events like assistant text deltas go ONLY here, never to Postgres.
//
// A small per-user ring buffer supports SSE reconnect catch-up via
// Last-Event-ID without any storage.

const { EventEmitter } = require('node:events');

const emitter = new EventEmitter();
emitter.setMaxListeners(500);

const RING_SIZE = 200;
const RING_TTL_MS = 5 * 60 * 1000;
const rings = new Map(); // userPhone -> { events: [], lastAt }

let sequence = 0;

function normalizeUser(userPhone) {
  return String(userPhone || '').replace(/\D/g, '');
}

function publish(userPhone, event) {
  const user = normalizeUser(userPhone);
  if (!user || !event || !event.type) return null;
  const entry = { seq: ++sequence, ts: Date.now(), ...event };
  let ring = rings.get(user);
  if (!ring) { ring = { events: [], lastAt: 0 }; rings.set(user, ring); }
  ring.lastAt = entry.ts;
  ring.events.push(entry);
  if (ring.events.length > RING_SIZE) ring.events.splice(0, ring.events.length - RING_SIZE);
  emitter.emit(`user:${user}`, entry);
  // Opportunistic GC of idle rings.
  if (rings.size > 1000) {
    const cutoff = Date.now() - RING_TTL_MS;
    for (const [key, value] of rings) { if (value.lastAt < cutoff) rings.delete(key); }
  }
  return entry;
}

/**
 * Subscribe to a user's live events. Returns an unsubscribe function.
 * Events already buffered with seq > afterSeq are replayed first.
 */
function subscribe(userPhone, { afterSeq = 0, onEvent }) {
  const user = normalizeUser(userPhone);
  const ring = rings.get(user);
  if (ring) {
    for (const entry of ring.events) {
      if (entry.seq > afterSeq) {
        try { onEvent(entry); } catch (_) { /* consumer's problem */ }
      }
    }
  }
  const listener = (entry) => { try { onEvent(entry); } catch (_) {} };
  emitter.on(`user:${user}`, listener);
  return () => emitter.removeListener(`user:${user}`, listener);
}

module.exports = { publish, subscribe };
