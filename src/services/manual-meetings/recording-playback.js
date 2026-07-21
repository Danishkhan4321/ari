'use strict';

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { createRecordingStorage } = require('./recording-storage');

function configuredEndpoint(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return new URL(raw.startsWith('http') ? raw : `https://${raw}`);
}

async function resolveRecordingPlayback(recording, {
  storage,
  sign = getSignedUrl,
  env = process.env,
} = {}) {
  const objectReference = recording?.recording_object_key;
  if (objectReference) {
    const retainedStorage = storage || createRecordingStorage();
    return retainedStorage.signRead(objectReference, 3600);
  }

  const legacyReference = String(recording?.recording_url || '').trim();
  if (!legacyReference) return null;
  if (legacyReference.startsWith('s3://')) {
    const retainedStorage = storage || createRecordingStorage();
    return retainedStorage.signRead(legacyReference, 3600);
  }

  const url = new URL(legacyReference);
  if (url.protocol !== 'https:') throw new TypeError('Historical recording URL must use HTTPS');

  const endpoint = configuredEndpoint(env.R2_ENDPOINT || env.S3_ENDPOINT);
  const accessKeyId = env.R2_ACCESS_KEY_ID || env.S3_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY || env.S3_SECRET_ACCESS_KEY;
  if (!endpoint || url.host !== endpoint.host || !accessKeyId || !secretAccessKey) {
    return url.toString();
  }

  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const bucket = parts.shift() || env.R2_BUCKET_NAME || env.S3_BUCKET_NAME;
  const key = parts.join('/');
  if (!bucket || !key || key.includes('..')) throw new TypeError('Invalid historical recording URL');

  const client = new S3Client({
    region: env.S3_REGION || 'auto',
    endpoint: endpoint.toString().replace(/\/$/, ''),
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  return sign(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 3600 });
}

module.exports = { resolveRecordingPlayback };
