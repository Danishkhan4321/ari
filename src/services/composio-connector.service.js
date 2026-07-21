const crypto = require('crypto');

function normalizePhone(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

function accountItems(response) {
  if (Array.isArray(response?.items)) return response.items;
  if (Array.isArray(response?.data?.items)) return response.data.items;
  if (Array.isArray(response?.data)) return response.data;
  return [];
}

class ComposioConnector {
  constructor({
    client = null,
    apiKey = process.env.COMPOSIO_API_KEY,
    userIdSecret = process.env.COMPOSIO_USER_ID_SECRET || process.env.ENCRYPTION_KEY,
  } = {}) {
    this.client = client;
    this.apiKey = apiKey;
    this.userIdSecret = userIdSecret;
  }

  isConfigured() {
    return Boolean(this.client || (this.apiKey && this.userIdSecret));
  }

  toExternalUserId(userPhone) {
    const normalized = normalizePhone(userPhone);
    if (!normalized) throw new Error('Ari user phone is required');
    if (!this.userIdSecret) throw new Error('COMPOSIO_USER_ID_SECRET is not configured');

    const digest = crypto
      .createHmac('sha256', this.userIdSecret)
      .update(normalized)
      .digest('hex')
      .slice(0, 32);
    return `ari_${digest}`;
  }

  async getClient() {
    if (this.client) return this.client;
    if (!this.apiKey) throw new Error('COMPOSIO_API_KEY is not configured');

    const { Composio } = await import('@composio/core');
    this.client = new Composio({ apiKey: this.apiKey });
    return this.client;
  }

  async findActiveAccount({ userPhone, authConfigId }) {
    if (!authConfigId) throw new Error('Composio auth config ID is required');
    // Negative cache: an unconnected user otherwise costs a ~500ms Composio
    // round-trip on EVERY agent turn (the context builder fetches calendar
    // context each turn). Misses are cached briefly; hits are never cached so
    // live token state stays authoritative. clearNotConnected() drops the
    // entry the moment a connect flow completes.
    const missKey = `${normalizePhone(userPhone)}:${authConfigId}`;
    const cachedMissAt = this._notConnectedCache?.get(missKey);
    if (cachedMissAt && Date.now() - cachedMissAt < 60_000) return null;
    const client = await this.getClient();
    const userId = this.toExternalUserId(userPhone);
    const response = await client.connectedAccounts.list({
      userIds: [userId],
      authConfigIds: [authConfigId],
      statuses: ['ACTIVE'],
    });
    const active = accountItems(response).find((account) => account.status === 'ACTIVE') || null;
    if (!active) {
      if (!this._notConnectedCache) this._notConnectedCache = new Map();
      if (this._notConnectedCache.size > 5000) this._notConnectedCache.clear();
      this._notConnectedCache.set(missKey, Date.now());
    } else {
      this._notConnectedCache?.delete(missKey);
    }
    return active;
  }

  /** Drop cached not-connected entries for a user (any auth config). */
  clearNotConnected(userPhone) {
    if (!this._notConnectedCache) return;
    const prefix = `${normalizePhone(userPhone)}:`;
    for (const key of this._notConnectedCache.keys()) {
      if (key.startsWith(prefix)) this._notConnectedCache.delete(key);
    }
  }

  async createConnectionLink({ userPhone, authConfigId, callbackUrl }) {
    const existing = await this.findActiveAccount({ userPhone, authConfigId });
    if (existing) {
      return { alreadyConnected: true, connectedAccountId: existing.id };
    }

    const client = await this.getClient();
    const request = await client.connectedAccounts.link(
      this.toExternalUserId(userPhone),
      authConfigId,
      { callbackUrl, allowMultiple: false },
    );
    return {
      alreadyConnected: false,
      connectionRequestId: request.id,
      redirectUrl: request.redirectUrl,
    };
  }

  async proxyExecute({ userPhone, authConfigId, endpoint, method, body, parameters }) {
    const account = await this.findActiveAccount({ userPhone, authConfigId });
    if (!account) {
      const error = new Error('Google account is not connected through Composio');
      error.code = 'COMPOSIO_ACCOUNT_NOT_CONNECTED';
      throw error;
    }

    const request = {
      connectedAccountId: account.id,
      endpoint,
      method,
    };
    if (body !== undefined) request.body = body;
    if (parameters !== undefined) request.parameters = parameters;

    const client = await this.getClient();
    return client.tools.proxyExecute(request);
  }

  async disconnect({ userPhone, authConfigId }) {
    const account = await this.findActiveAccount({ userPhone, authConfigId });
    if (!account) return false;
    const client = await this.getClient();
    await client.connectedAccounts.delete(account.id);
    return true;
  }

  createGoogleAuthClient({ userPhone, authConfigId, resolveAuthConfigId }) {
    const connector = this;
    return {
      credentials: {},
      async getRequestHeaders() {
        return {};
      },
      async request(options = {}) {
        const rawHeaders = options.headers instanceof Headers
          ? Object.fromEntries(options.headers.entries())
          : (options.headers || {});
        const parameters = Object.entries(rawHeaders)
          .filter(([name, value]) => value !== undefined && name.toLowerCase() !== 'authorization')
          .map(([name, value]) => ({ name, value: String(value), in: 'header' }));

        const selectedAuthConfigId = typeof resolveAuthConfigId === 'function'
          ? resolveAuthConfigId(options.url)
          : authConfigId;
        if (!selectedAuthConfigId) {
          throw new Error(`No Composio auth configuration is mapped for Google endpoint: ${options.url || 'unknown'}`);
        }

        const response = await connector.proxyExecute({
          userPhone,
          authConfigId: selectedAuthConfigId,
          endpoint: options.url,
          method: String(options.method || 'GET').toUpperCase(),
          body: options.data,
          parameters: parameters.length ? parameters : undefined,
        });

        if (response.status < 200 || response.status >= 300) {
          const error = new Error(response.data?.error?.message || `Google API request failed (${response.status})`);
          error.code = response.status;
          error.response = response;
          throw error;
        }
        return response;
      },
    };
  }
}

module.exports = new ComposioConnector();
module.exports.ComposioConnector = ComposioConnector;
