const test = require('node:test');
const assert = require('node:assert/strict');

const {
  exchangeDesktopTicket,
  googleAuthStartUrl,
  ticketFromCommandLine,
  ticketFromDeepLink,
} = require('../src/desktop-auth');

const ticket = 'a'.repeat(64);

test('desktop auth accepts only the Ari callback protocol with a bounded ticket', () => {
  assert.equal(ticketFromDeepLink(`ari://auth/callback?ticket=${ticket}`), ticket);
  assert.equal(ticketFromDeepLink(`https://example.test/callback?ticket=${ticket}`), null);
  assert.equal(ticketFromDeepLink('ari://auth/callback?ticket=short'), null);
  assert.equal(ticketFromCommandLine(['Ari.exe', `ari://auth/callback?ticket=${ticket}`]), ticket);
});

test('desktop Google sign-in starts on the dashboard in system-browser mode', () => {
  assert.equal(
    googleAuthStartUrl('https://ari.example.test'),
    'https://ari.example.test/api/auth/google/start?client=desktop',
  );
});

test('ticket exchange stores a persistent HTTP-only dashboard cookie', async () => {
  let cookie;
  const fetchImpl = async () => ({
    ok: true,
    headers: { get: () => 'application/json' },
    json: async () => ({ ok: true, token: 'b'.repeat(64), maxAge: 86400 }),
  });
  await exchangeDesktopTicket({
    dashboardUrl: 'https://ari.example.test',
    ticket,
    fetchImpl,
    cookieStore: { set: async (value) => { cookie = value; } },
  });
  assert.equal(cookie.name, 'ari_session');
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.secure, true);
  assert.equal(cookie.url, 'https://ari.example.test');
  assert.ok(cookie.expirationDate > Date.now() / 1000);
});
