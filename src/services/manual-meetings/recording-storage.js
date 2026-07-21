'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

function required(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${name} is required for retained meeting recordings`);
  return normalized;
}

function parseStorageReference(reference, expectedBucket) {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(String(reference || ''));
  if (!match || !match[2] || match[2].includes('..')) {
    throw new TypeError('Invalid private recording storage reference');
  }
  if (expectedBucket && match[1] !== expectedBucket) {
    throw new TypeError('Recording storage reference is outside the configured bucket');
  }
  return { bucket: match[1], key: match[2] };
}

function extensionFor(filePath, mimeType) {
  const current = path.extname(filePath || '').toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(current)) return current;
  const extensions = {
    'audio/mp4': '.m4a',
    'audio/mpeg': '.mp3',
    'audio/webm': '.webm',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
  };
  return extensions[String(mimeType || '').split(';')[0].toLowerCase()] || '.audio';
}

function createRecordingStorage({
  s3,
  bucket = process.env.R2_BUCKET_NAME || process.env.S3_BUCKET_NAME,
  endpoint = process.env.R2_ENDPOINT || process.env.S3_ENDPOINT,
  accessKeyId = process.env.R2_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID,
  secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || process.env.S3_SECRET_ACCESS_KEY,
  region = process.env.S3_REGION || 'auto',
  sign = getSignedUrl,
  now = () => new Date(),
  uuid = () => crypto.randomUUID(),
} = {}) {
  const privateBucket = required(bucket, 'R2_BUCKET_NAME');
  const client = s3 || new S3Client({
    region,
    endpoint: required(endpoint, 'R2_ENDPOINT'),
    forcePathStyle: true,
    credentials: {
      accessKeyId: required(accessKeyId, 'R2_ACCESS_KEY_ID'),
      secretAccessKey: required(secretAccessKey, 'R2_SECRET_ACCESS_KEY'),
    },
  });

  async function uploadFile({ meetingId, userPhone, filePath, mimeType }) {
    const id = Number(meetingId);
    if (!Number.isInteger(id) || id <= 0) throw new TypeError('meetingId must be a positive integer');
    const phoneHash = crypto.createHash('sha256').update(required(userPhone, 'userPhone')).digest('hex');
    const month = now().toISOString().slice(0, 7);
    const key = `manual-meetings/${phoneHash}/${month}/${id}/${uuid()}${extensionFor(filePath, mimeType)}`;
    await client.send(new PutObjectCommand({
      Bucket: privateBucket,
      Key: key,
      Body: fs.createReadStream(required(filePath, 'filePath')),
      ContentType: required(mimeType, 'mimeType'),
      Metadata: { meetingId: String(id) },
    }));
    const reference = `s3://${privateBucket}/${key}`;
    await verify(reference);
    return reference;
  }

  async function verify(reference) {
    const location = parseStorageReference(reference, privateBucket);
    const result = await client.send(new HeadObjectCommand({
      Bucket: location.bucket,
      Key: location.key,
    }));
    return result.ContentLength === undefined || Number(result.ContentLength) >= 0;
  }

  async function signRead(reference, expiresInSeconds = 900) {
    const location = parseStorageReference(reference, privateBucket);
    const expiresIn = Math.min(3600, Math.max(60, Number(expiresInSeconds) || 900));
    return sign(client, new GetObjectCommand({ Bucket: location.bucket, Key: location.key }), { expiresIn });
  }

  async function deleteRecording(reference) {
    const location = parseStorageReference(reference, privateBucket);
    await client.send(new DeleteObjectCommand({ Bucket: location.bucket, Key: location.key }));
  }

  return { uploadFile, verify, signRead, delete: deleteRecording };
}

module.exports = { createRecordingStorage, parseStorageReference };
