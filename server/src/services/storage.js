import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl as getS3SignedUrl } from '@aws-sdk/s3-request-presigner';
import { getSignedUrl as getCloudFrontSignedUrl } from '@aws-sdk/cloudfront-signer';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

let s3;
let publicS3;

function createS3Client(endpoint) {
  const credentials =
    config.s3.accessKeyId && config.s3.secretAccessKey
      ? {
          accessKeyId: config.s3.accessKeyId,
          secretAccessKey: config.s3.secretAccessKey,
        }
      : undefined;
  return new S3Client({
    region: config.s3.region,
    endpoint: endpoint || undefined,
    forcePathStyle: config.s3.forcePathStyle,
    credentials,
    maxAttempts: 4,
  });
}

function s3Client() {
  if (s3) return s3;
  s3 = createS3Client(config.s3.endpoint);
  return s3;
}

function signingS3Client() {
  if (!config.s3.publicEndpoint) return s3Client();
  if (!publicS3) publicS3 = createS3Client(config.s3.publicEndpoint);
  return publicS3;
}

export function localObjectPath(storedName) {
  return path.join(config.uploadDir, storedName.slice(0, 2), storedName);
}

function objectKey(storedName) {
  return `uploads/${storedName.slice(0, 2)}/${storedName}`;
}

function encryptionOptions() {
  if (config.s3.kmsKeyId) {
    return {
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: config.s3.kmsKeyId,
    };
  }
  if (config.s3.serverSideEncryption) {
    return { ServerSideEncryption: config.s3.serverSideEncryption };
  }
  return {};
}

export async function saveObject({ storedName, buffer, mime, sha256 }) {
  if (config.storageDriver !== 's3') {
    const target = localObjectPath(storedName);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, buffer, { mode: 0o600 });
    return { provider: 'local', key: storedName };
  }
  if (!config.s3.bucket) throw new Error('S3_BUCKET is required when STORAGE_DRIVER=s3');
  const key = objectKey(storedName);
  await s3Client().send(
    new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      Body: buffer,
      ContentType: mime,
      Metadata: { sha256 },
      ...encryptionOptions(),
    }),
  );
  return { provider: 's3', key };
}

export async function deleteObject(attachment) {
  if ((attachment.storage_provider ?? 'local') === 's3') {
    await s3Client().send(
      new DeleteObjectCommand({
        Bucket: config.s3.bucket,
        Key: attachment.storage_key || objectKey(attachment.stored_name),
      }),
    );
    return;
  }
  await fsp.unlink(localObjectPath(attachment.stored_name));
}

export async function readObjectBuffer(attachment) {
  if ((attachment.storage_provider ?? 'local') === 's3') {
    const response = await s3Client().send(
      new GetObjectCommand({
        Bucket: config.s3.bucket,
        Key: attachment.storage_key || objectKey(attachment.stored_name),
      }),
    );
    return Buffer.from(await response.Body.transformToByteArray());
  }
  return fsp.readFile(localObjectPath(attachment.stored_name));
}

export async function readObjectRange(attachment, start, end) {
  if ((attachment.storage_provider ?? 'local') !== 's3') {
    const handle = await fsp.open(localObjectPath(attachment.stored_name), 'r');
    try {
      const buffer = Buffer.alloc(end - start + 1);
      await handle.read(buffer, 0, buffer.length, start);
      return buffer;
    } finally {
      await handle.close();
    }
  }
  const response = await s3Client().send(
    new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: attachment.storage_key || objectKey(attachment.stored_name),
      Range: `bytes=${start}-${end}`,
    }),
  );
  return Buffer.from(await response.Body.transformToByteArray());
}

export function localObjectStream(attachment, range) {
  return fs.createReadStream(localObjectPath(attachment.stored_name), range);
}

export async function authorizedObjectUrl(attachment, responseOverrides = {}) {
  if ((attachment.storage_provider ?? 'local') !== 's3') return null;
  const key = attachment.storage_key || objectKey(attachment.stored_name);
  const expiresAt = new Date(Date.now() + config.s3.signedUrlTtlSeconds * 1000);

  if (config.cdnBaseUrl && config.cdnKeyPairId && config.cdnPrivateKeyPath) {
    const privateKey = await fsp.readFile(config.cdnPrivateKeyPath, 'utf8');
    return getCloudFrontSignedUrl({
      url: `${config.cdnBaseUrl.replace(/\/$/, '')}/${key}`,
      keyPairId: config.cdnKeyPairId,
      privateKey,
      dateLessThan: expiresAt.toISOString(),
    });
  }

  return getS3SignedUrl(
    signingS3Client(),
    new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      ResponseContentType: responseOverrides.contentType,
      ResponseContentDisposition: responseOverrides.contentDisposition,
    }),
    { expiresIn: config.s3.signedUrlTtlSeconds },
  );
}

export async function storageHealth() {
  if (config.storageDriver !== 's3') {
    await fsp.access(config.uploadDir, fs.constants.R_OK | fs.constants.W_OK);
    return { driver: 'local', ok: true };
  }
  try {
    await s3Client().send(new HeadBucketCommand({ Bucket: config.s3.bucket }));
    return { driver: 's3', ok: true };
  } catch (error) {
    logger.warn('object storage health check failed', { error: error.message });
    return { driver: 's3', ok: false, error: error.message };
  }
}

export async function saveBackupArchive(filename, body, sha256) {
  if (config.storageDriver !== 's3') return null;
  const key = `backups/${filename}`;
  await s3Client().send(
    new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      Body: body,
      ContentType: 'application/gzip',
      Metadata: { sha256 },
      ...encryptionOptions(),
    }),
  );
  return `s3://${config.s3.bucket}/${key}`;
}

export async function readBackupArchive(location) {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(location);
  if (!match) throw new Error('Backup location is not an S3 URI.');
  const [, bucket, key] = match;
  const response = await s3Client().send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  const body = Buffer.from(await response.Body.transformToByteArray());
  const expected = response.Metadata?.sha256;
  if (expected) {
    const actual = crypto
      .createHash('sha256')
      .update(body)
      .digest('hex');
    if (actual !== expected) throw new Error('S3 backup checksum mismatch.');
  }
  return body;
}
