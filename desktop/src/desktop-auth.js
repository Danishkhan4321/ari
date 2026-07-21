'use strict';

const AUTH_SCHEME = 'ari:';
const AUTH_HOST = 'auth';
const AUTH_PATH = '/callback';
const TICKET_PATTERN = /^[a-f0-9]{64}$/i;

function ticketFromDeepLink(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl || '')); } catch { return null; }
  if (url.protocol !== AUTH_SCHEME || url.hostname !== AUTH_HOST || url.pathname !== AUTH_PATH) return null;
  const ticket = url.searchParams.get('ticket') || '';
  return TICKET_PATTERN.test(ticket) ? ticket : null;
}

function ticketFromCommandLine(commandLine = []) {
  for (const arg of commandLine) {
    const ticket = ticketFromDeepLink(arg);
    if (ticket) return ticket;
  }
  return null;
}

function googleAuthStartUrl(dashboardUrl) {
  const url = new URL('/api/auth/google/start', dashboardUrl);
  url.searchParams.set('client', 'desktop');
  return url.toString();
}

async function exchangeDesktopTicket({ dashboardUrl, ticket, fetchImpl = fetch, cookieStore }) {
  if (!TICKET_PATTERN.test(String(ticket || ''))) throw new TypeError('invalid desktop auth ticket');
  const endpoint = new URL('/api/auth/desktop/exchange', dashboardUrl);
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticket }),
    signal: AbortSignal.timeout(15_000),
  });
  const contentType = response.headers?.get?.('content-type') || '';
  if (!response.ok || !contentType.toLowerCase().includes('application/json')) {
    throw new Error('Ari could not complete desktop sign-in. Start Google sign-in again.');
  }
  const result = await response.json();
  if (result?.ok !== true || !/^[a-f0-9]{64}$/i.test(String(result.token || ''))) {
    throw new Error('Ari received an invalid desktop session. Start Google sign-in again.');
  }
  const maxAge = Math.min(3650 * 86400, Math.max(86400, Number(result.maxAge) || 365 * 86400));
  const origin = new URL(dashboardUrl);
  await cookieStore.set({
    url: origin.origin,
    name: 'ari_session',
    value: result.token,
    path: '/',
    httpOnly: true,
    secure: origin.protocol === 'https:',
    sameSite: 'lax',
    expirationDate: Math.floor(Date.now() / 1000) + maxAge,
  });
  return { ok: true };
}

module.exports = {
  exchangeDesktopTicket,
  googleAuthStartUrl,
  ticketFromCommandLine,
  ticketFromDeepLink,
};
