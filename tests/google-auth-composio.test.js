const test = require('node:test');
const assert = require('node:assert/strict');

process.env.COMPOSIO_GOOGLE_AUTH_CONFIG_ID = 'ac_google';
process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = 'ac_gmail';
process.env.COMPOSIO_GOOGLE_CALENDAR_AUTH_CONFIG_ID = 'ac_calendar';
process.env.COMPOSIO_GOOGLE_DRIVE_AUTH_CONFIG_ID = 'ac_drive';
process.env.COMPOSIO_GOOGLE_TASKS_AUTH_CONFIG_ID = 'ac_tasks';
process.env.COMPOSIO_GOOGLE_DOCS_AUTH_CONFIG_ID = 'ac_docs';
process.env.COMPOSIO_GOOGLE_SHEETS_AUTH_CONFIG_ID = 'ac_sheets';
process.env.COMPOSIO_GOOGLE_SLIDES_AUTH_CONFIG_ID = 'ac_slides';
process.env.COMPOSIO_GOOGLE_CALLBACK_URL = 'https://ari.test/auth/google/composio-callback';
process.env.GOOGLE_CLIENT_SECRET = 'test-state-secret';

const composio = require('../src/services/composio-connector.service');
const googleAuth = require('../src/services/google-auth.service');
const messaging = require('../src/services/messaging.service');

async function withPatchedComposio(patches, run) {
  const originals = {};
  for (const [name, value] of Object.entries(patches)) {
    originals[name] = composio[name];
    composio[name] = value;
  }
  try {
    return await run();
  } finally {
    Object.assign(composio, originals);
  }
}

test('Google connection URL uses Composio hosted auth when configured', async () => {
  await withPatchedComposio({
    isConfigured: () => true,
    createConnectionLink: async (input) => {
      assert.equal(input.userPhone, '+919999911111');
      assert.equal(input.authConfigId, 'ac_gmail');
      assert.match(input.callbackUrl, /^https:\/\/ari\.test\/auth\/google\/composio-callback\?state=/);
      return { redirectUrl: 'https://connect.composio.dev/link_1' };
    },
  }, async () => {
    assert.equal(
      await googleAuth.generateAuthUrl('+919999911111'),
      'https://connect.composio.dev/link_1',
    );
  });
});

test('Google API clients use the Composio compatibility client when configured', async () => {
  const sentinel = { request: async () => ({ status: 200 }) };
  await withPatchedComposio({
    isConfigured: () => true,
    createGoogleAuthClient: (input) => {
      assert.equal(input.userPhone, '+919999911111');
      assert.equal(input.resolveAuthConfigId('https://www.googleapis.com/calendar/v3/events'), 'ac_calendar');
      assert.equal(input.resolveAuthConfigId('https://sheets.googleapis.com/v4/spreadsheets/1'), 'ac_sheets');
      return sentinel;
    },
  }, async () => {
    assert.equal(await googleAuth.getAuthClient('+919999911111'), sentinel);
  });
});

test('Connect all begins with Gmail and carries the remaining products through the callback', async () => {
  await withPatchedComposio({
    isConfigured: () => true,
    createConnectionLink: async (input) => {
      assert.equal(input.authConfigId, 'ac_gmail');
      const callback = new URL(input.callbackUrl);
      assert.equal(callback.searchParams.get('product'), 'gmail');
      assert.equal(callback.searchParams.get('remaining'), 'calendar,drive,docs,sheets,slides,tasks');
      return { redirectUrl: 'https://connect.composio.dev/gmail' };
    },
  }, async () => {
    assert.equal(await googleAuth.generateAuthUrl('+919999911111'), 'https://connect.composio.dev/gmail');
  });
});

test('individual Google products use their own managed auth config', async () => {
  await withPatchedComposio({
    isConfigured: () => true,
    createConnectionLink: async (input) => {
      assert.equal(input.authConfigId, 'ac_drive');
      assert.equal(new URL(input.callbackUrl).searchParams.get('product'), 'drive');
      return { redirectUrl: 'https://connect.composio.dev/drive' };
    },
  }, async () => {
    assert.equal(await googleAuth.generateProductAuthUrl('+919999911111', 'drive'), 'https://connect.composio.dev/drive');
  });
});

test('Google connection status is resolved from Composio instead of the legacy token table', async () => {
  await withPatchedComposio({
    isConfigured: () => true,
    findActiveAccount: async () => ({ id: 'ca_google', status: 'ACTIVE' }),
  }, async () => {
    assert.equal(await googleAuth.isConnected('+919999911111'), true);
  });
});

test('scope checks and disconnect use the unified Composio Google connection', async () => {
  let disconnected = false;
  await withPatchedComposio({
    isConfigured: () => true,
    findActiveAccount: async () => ({ id: 'ca_google', status: 'ACTIVE' }),
    disconnect: async () => { disconnected = true; return true; },
  }, async () => {
    assert.equal(await googleAuth.hasScope('+919999911111', 'tasks'), true);
    assert.equal(await googleAuth.revokeTokens('+919999911111'), true);
    assert.equal(disconnected, true);
  });
});

test('Composio callback confirms an active Google connection', async () => {
  const express = require('express');
  const originalConnected = googleAuth.isProductConnected;
  const originalEmail = googleAuth.getGoogleEmail;
  const originalSend = messaging.send;
  googleAuth.isProductConnected = async () => true;
  googleAuth.getGoogleEmail = async () => 'person@example.com';
  messaging.send = async () => {};

  const app = express();
  app.use('/auth/google', require('../src/routes/auth.routes'));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const state = googleAuth.generateStateParam('+919999911111');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/auth/google/composio-callback?state=${state}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /person@example\.com/);
  } finally {
    googleAuth.isProductConnected = originalConnected;
    googleAuth.getGoogleEmail = originalEmail;
    messaging.send = originalSend;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Composio callback continues to the next Google product', async () => {
  const express = require('express');
  const originalConnected = googleAuth.isProductConnected;
  const originalNext = googleAuth.generateProductAuthUrl;
  googleAuth.isProductConnected = async (_phone, product) => product === 'gmail';
  googleAuth.generateProductAuthUrl = async (_phone, product, remaining) => {
    assert.equal(product, 'calendar');
    assert.deepEqual(remaining, ['drive']);
    return 'https://connect.composio.dev/calendar';
  };

  const app = express();
  app.use('/auth/google', require('../src/routes/auth.routes'));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const state = googleAuth.generateStateParam('+919999911111');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/auth/google/composio-callback?state=${state}&product=gmail&remaining=calendar,drive`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), 'https://connect.composio.dev/calendar');
  } finally {
    googleAuth.isProductConnected = originalConnected;
    googleAuth.generateProductAuthUrl = originalNext;
    await new Promise((resolve) => server.close(resolve));
  }
});
