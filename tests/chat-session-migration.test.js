'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'migrations', '19_chat_sessions.js'), 'utf8');

test('chat session migration creates durable thread and idempotency storage', () => {
  assert.match(source, /CREATE TABLE IF NOT EXISTS ari_chat_sessions/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS ari_chat_submissions/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS ari_chat_attachments/);
  assert.match(source, /ADD COLUMN IF NOT EXISTS session_id UUID/);
  assert.match(source, /ADD COLUMN IF NOT EXISTS client_message_id UUID/);
  assert.match(source, /WHERE client_message_id IS NOT NULL AND role = 'user'/);
  assert.match(source, /Previous conversations/);
});
