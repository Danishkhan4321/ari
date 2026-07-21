const test = require('node:test');
const assert = require('node:assert/strict');

const { ComposioConnector } = require('../src/services/composio-connector.service');

function fakeClient(overrides = {}) {
  return {
    connectedAccounts: {
      list: async () => ({ items: [] }),
      link: async () => ({ id: 'link_1', redirectUrl: 'https://connect.example/link_1' }),
      get: async () => ({ id: 'ca_1', status: 'ACTIVE' }),
      delete: async () => {},
      ...overrides.connectedAccounts,
    },
    tools: {
      proxyExecute: async (request) => ({ status: 200, data: request }),
      ...overrides.tools,
    },
  };
}

test('uses a stable non-PII Composio user id', () => {
  const connector = new ComposioConnector({ client: fakeClient(), userIdSecret: 'test-secret' });
  const first = connector.toExternalUserId('+91 99999 11111');
  const second = connector.toExternalUserId('+919999911111');

  assert.equal(first, second);
  assert.match(first, /^ari_[a-f0-9]{32}$/);
  assert.doesNotMatch(first, /99999/);
});

test('reuses Ari encryption secret when no dedicated Composio user-id secret exists', () => {
  const previous = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = 'existing-ari-secret';
  try {
    const connector = new ComposioConnector({ client: fakeClient() });
    assert.match(connector.toExternalUserId('+919999911111'), /^ari_[a-f0-9]{32}$/);
  } finally {
    if (previous === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previous;
  }
});

test('returns the existing active account instead of creating a duplicate link', async () => {
  let linkCalls = 0;
  const connector = new ComposioConnector({
    userIdSecret: 'test-secret',
    client: fakeClient({
      connectedAccounts: {
        list: async () => ({ items: [{ id: 'ca_existing', status: 'ACTIVE' }] }),
        link: async () => { linkCalls += 1; },
      },
    }),
  });

  const result = await connector.createConnectionLink({
    userPhone: '+919999911111',
    authConfigId: 'ac_google',
    callbackUrl: 'http://localhost/callback',
  });

  assert.deepEqual(result, { alreadyConnected: true, connectedAccountId: 'ca_existing' });
  assert.equal(linkCalls, 0);
});

test('creates a hosted connection link with duplicate connections disabled', async () => {
  let received;
  const connector = new ComposioConnector({
    userIdSecret: 'test-secret',
    client: fakeClient({
      connectedAccounts: {
        list: async () => ({ items: [] }),
        link: async (...args) => {
          received = args;
          return { id: 'link_1', redirectUrl: 'https://connect.example/link_1' };
        },
      },
    }),
  });

  const result = await connector.createConnectionLink({
    userPhone: '+919999911111',
    authConfigId: 'ac_google',
    callbackUrl: 'http://localhost/callback',
  });

  assert.equal(result.redirectUrl, 'https://connect.example/link_1');
  assert.deepEqual(received.slice(1), [
    'ac_google',
    { callbackUrl: 'http://localhost/callback', allowMultiple: false },
  ]);
});

test('proxy execution requires an active account and forwards authenticated requests', async () => {
  let received;
  const connector = new ComposioConnector({
    userIdSecret: 'test-secret',
    client: fakeClient({
      connectedAccounts: {
        list: async () => ({ items: [{ id: 'ca_google', status: 'ACTIVE' }] }),
      },
      tools: {
        proxyExecute: async (request) => {
          received = request;
          return { status: 200, data: { ok: true } };
        },
      },
    }),
  });

  const response = await connector.proxyExecute({
    userPhone: '+919999911111',
    authConfigId: 'ac_google',
    endpoint: '/calendar/v3/calendars/primary/events',
    method: 'GET',
  });

  assert.deepEqual(response.data, { ok: true });
  assert.deepEqual(received, {
    connectedAccountId: 'ca_google',
    endpoint: '/calendar/v3/calendars/primary/events',
    method: 'GET',
  });
});

test('Google auth compatibility client proxies googleapis requests without forwarding authorization headers', async () => {
  let received;
  const connector = new ComposioConnector({
    userIdSecret: 'test-secret',
    client: fakeClient({
      connectedAccounts: {
        list: async () => ({ items: [{ id: 'ca_google', status: 'ACTIVE' }] }),
      },
      tools: {
        proxyExecute: async (request) => {
          received = request;
          return { status: 200, data: { items: [] }, headers: { etag: 'abc' } };
        },
      },
    }),
  });

  const auth = connector.createGoogleAuthClient({
    userPhone: '+919999911111',
    authConfigId: 'ac_google',
  });
  const response = await auth.request({
    url: 'https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=10',
    method: 'POST',
    data: { summary: 'Demo' },
    headers: { Authorization: 'Bearer must-not-leak', 'Content-Type': 'application/json' },
  });

  assert.deepEqual(response, { status: 200, data: { items: [] }, headers: { etag: 'abc' } });
  assert.deepEqual(received, {
    connectedAccountId: 'ca_google',
    endpoint: 'https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=10',
    method: 'POST',
    body: { summary: 'Demo' },
    parameters: [{ name: 'Content-Type', value: 'application/json', in: 'header' }],
  });
});

test('Google auth compatibility client exposes upstream failures like googleapis errors', async () => {
  const connector = new ComposioConnector({
    userIdSecret: 'test-secret',
    client: fakeClient({
      connectedAccounts: {
        list: async () => ({ items: [{ id: 'ca_google', status: 'ACTIVE' }] }),
      },
      tools: {
        proxyExecute: async () => ({ status: 403, data: { error: { message: 'insufficient scope' } }, headers: {} }),
      },
    }),
  });

  const auth = connector.createGoogleAuthClient({ userPhone: '9999911111', authConfigId: 'ac_google' });
  await assert.rejects(
    () => auth.request({ url: 'https://www.googleapis.com/tasks/v1/users/@me/lists', method: 'GET' }),
    (error) => error.response?.status === 403 && error.code === 403,
  );
});

test('disconnect deletes only the active connected account for the Ari user', async () => {
  let deleted;
  const connector = new ComposioConnector({
    userIdSecret: 'test-secret',
    client: fakeClient({
      connectedAccounts: {
        list: async () => ({ items: [{ id: 'ca_google', status: 'ACTIVE' }] }),
        delete: async (id) => { deleted = id; },
      },
    }),
  });

  assert.equal(await connector.disconnect({ userPhone: '9999911111', authConfigId: 'ac_google' }), true);
  assert.equal(deleted, 'ca_google');
});

test('Google compatibility client selects the auth config for each API endpoint', async () => {
  const lookups = [];
  const connector = new ComposioConnector({
    userIdSecret: 'test-secret',
    client: fakeClient({
      connectedAccounts: {
        list: async ({ authConfigIds }) => {
          lookups.push(authConfigIds[0]);
          return { items: [{ id: `ca_${authConfigIds[0]}`, status: 'ACTIVE' }] };
        },
      },
      tools: { proxyExecute: async () => ({ status: 200, data: {}, headers: {} }) },
    }),
  });
  const auth = connector.createGoogleAuthClient({
    userPhone: '9999911111',
    resolveAuthConfigId: (endpoint) => endpoint.includes('calendar') ? 'ac_calendar' : 'ac_gmail',
  });

  await auth.request({ url: 'https://www.googleapis.com/calendar/v3/calendars/primary/events' });
  await auth.request({ url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile' });
  assert.deepEqual(lookups, ['ac_calendar', 'ac_gmail']);
});
