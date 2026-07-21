'use strict';

function createDictationBackendClient({ backendUrl, internalToken, userPhone, fetchImpl = fetch } = {}) {
  const root = new URL(backendUrl);
  if (!['http:', 'https:'].includes(root.protocol) || !['127.0.0.1', 'localhost', '::1'].includes(root.hostname)) {
    throw new TypeError('desktop dictation backend must be loopback HTTP(S)');
  }
  if (!internalToken || !userPhone) throw new Error('desktop dictation backend identity is not configured');
  const identityHeaders = {
    'x-ari-desktop-token': internalToken,
    'x-ari-user-phone': userPhone,
  };

  async function request(pathname, options = {}) {
    const response = await fetchImpl(new URL(pathname, root), {
      ...options,
      headers: { ...identityHeaders, ...(options.headers || {}) },
      signal: options.signal || AbortSignal.timeout(30_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error(payload.error || `Dictation backend returned HTTP ${response.status}`);
    return payload;
  }

  return {
    session: () => request('/internal/desktop/dictation/session', { method: 'POST' }),
    polish: (input) => request('/internal/desktop/dictation/polish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(25_000),
    }),
    retry: (audio, { mimeType = 'audio/webm', appCategory = 'generic' } = {}) => request('/internal/desktop/dictation/retry', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-ari-app-category': appCategory,
        'x-ari-audio-mime-type': String(mimeType || 'audio/webm').slice(0, 100),
      },
      body: Buffer.isBuffer(audio) ? audio : Buffer.from(audio),
      signal: AbortSignal.timeout(120_000),
    }),
  };
}

module.exports = { createDictationBackendClient };
