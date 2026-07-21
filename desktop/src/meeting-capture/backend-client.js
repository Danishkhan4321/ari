'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');

function createBackendClient({ backendUrl, internalToken, userPhone, requestImpl, maxResponseBytes = 256 * 1024 } = {}) {
  const root = new URL(backendUrl);
  if (!['http:', 'https:'].includes(root.protocol) || !['127.0.0.1', 'localhost', '::1'].includes(root.hostname)) {
    throw new TypeError('desktop meeting backend must be loopback HTTP(S)');
  }
  if (!internalToken || !userPhone) throw new Error('desktop meeting backend identity is not configured');
  const request = requestImpl || (root.protocol === 'https:' ? https.request : http.request);

  async function upload(manifest, { onProgress = () => {} } = {}) {
    const stats = await fs.promises.stat(manifest.recordingPath);
    return new Promise((resolve, reject) => {
      const url = new URL('/internal/desktop/meetings', root);
      const req = request(url, {
        method: 'POST',
        headers: {
          'content-type': manifest.codec?.includes('caf') ? 'audio/x-caf' : 'audio/webm',
          'content-length': String(stats.size),
          'x-ari-desktop-token': internalToken,
          'x-ari-user-phone': userPhone,
          'x-ari-capture-session': manifest.id,
          'x-ari-meeting-title': manifest.title,
          'x-ari-capture-platform': manifest.platform,
          'x-ari-capture-codec': manifest.codec,
        },
      }, (response) => {
        let body = '';
        let bytes = 0;
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > maxResponseBytes) {
            req.destroy(new Error('Meeting backend response exceeded limit'));
            return;
          }
          body += chunk;
        });
        response.on('end', () => {
          let payload;
          try { payload = JSON.parse(body); } catch (_) { return reject(new Error('Meeting backend returned invalid JSON')); }
          if (response.statusCode < 200 || response.statusCode >= 300 || !payload.ok) {
            return reject(new Error(payload.error || `Meeting backend returned HTTP ${response.statusCode}`));
          }
          return resolve(payload);
        });
      });
      req.on('error', reject);
      const stream = fs.createReadStream(manifest.recordingPath);
      let sent = 0;
      stream.on('data', (chunk) => {
        sent += chunk.length;
        onProgress({ sentBytes: sent, totalBytes: stats.size, ratio: stats.size ? sent / stats.size : 1 });
      });
      stream.on('error', reject);
      stream.pipe(req);
    });
  }

  return { upload };
}

module.exports = { createBackendClient };
