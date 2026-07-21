'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const reminderService = require('../src/services/reminder.service');
const contactService = require('../src/services/contact.service');

test('saved contact names resolve case-insensitively to their WhatsApp phone', async () => {
  const originalFind = contactService.findByName;
  contactService.findByName = async (_userPhone, name) => {
    assert.equal(name, 'AKASH');
    return [{ name: 'Akash', phone: '919876543210' }];
  };
  try {
    const result = await contactService.resolveNameToPhone('919111111111', 'AKASH');
    assert.deepEqual(result, {
      found: true,
      phone: '919876543210',
      name: 'Akash',
      ambiguous: false,
    });
  } finally {
    contactService.findByName = originalFind;
  }
});

test('delegated reminder resolves the saved phone and keeps the sender timezone', async () => {
  const originalResolve = contactService.resolveNameToPhone;
  const originalParse = reminderService.parseOneTimeReminder;
  let received;
  contactService.resolveNameToPhone = async (_userPhone, name) => {
    assert.equal(name.toLowerCase(), 'akash');
    return { found: true, ambiguous: false, name: 'Akash', phone: '919876543210' };
  };
  reminderService.parseOneTimeReminder = async (userPhone, message, timezone, targetPhone) => {
    received = { userPhone, message, timezone, targetPhone };
    return { success: true, targetPhone };
  };
  try {
    const result = await reminderService.parseAndCreateReminder(
      '919111111111',
      'send reminder to AKASH at 8:00 pm to complete the task',
      'America/New_York'
    );
    assert.equal(result.success, true);
    assert.equal(received.targetPhone, '919876543210');
    assert.equal(received.timezone, 'America/New_York');
    assert.match(received.message, /8:00 pm/i);
  } finally {
    contactService.resolveNameToPhone = originalResolve;
    reminderService.parseOneTimeReminder = originalParse;
  }
});

test('8:00 pm is interpreted as 8pm in the supplied user timezone', () => {
  const timezone = 'America/New_York';
  const result = reminderService.parseWithRegex('remind me at 8:00 pm to complete the task', timezone);
  assert.equal(result.success, true);
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hourCycle: 'h23',
  }).format(result.reminderTime);
  assert.ok(hour === '20' || hour === '24', `expected 20:00 local, got hour=${hour}`);
});
