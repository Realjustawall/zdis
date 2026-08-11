import crypto from 'node:crypto';
import { config } from '../config.js';
import { getDb } from '../db/index.js';

const subtle = crypto.webcrypto.subtle;
const encoder = new TextEncoder();
const ESCROW_CONTEXT = 'zdis:e2ee:key-escrow:v1';

const b64 = (value) => Buffer.from(value).toString('base64url');
const aad = (conversationId, purpose) =>
  encoder.encode(`zdis:e2ee:v1:${conversationId}:${purpose}`);

function escrowKey() {
  return crypto.createHash('sha256').update(ESCROW_CONTEXT).update('\0').update(config.secret).digest();
}

export function sealE2eeSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', escrowKey(), iv);
  cipher.setAAD(Buffer.from(ESCROW_CONTEXT));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return `v1.${b64(iv)}.${b64(cipher.getAuthTag())}.${b64(ciphertext)}`;
}

export function openE2eeSecret(value) {
  const [version, iv, tag, ciphertext] = String(value).split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('Invalid E2EE escrow payload.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', escrowKey(), Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(ESCROW_CONTEXT));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8'));
}

export async function generateE2eeIdentity() {
  const encryption = await subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  );
  const signing = await subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  );
  return {
    publicKey: {
      encryption: await subtle.exportKey('jwk', encryption.publicKey),
      signing: await subtle.exportKey('jwk', signing.publicKey),
    },
    privateKey: {
      encryption: await subtle.exportKey('jwk', encryption.privateKey),
      signing: await subtle.exportKey('jwk', signing.privateKey),
    },
    cryptoKeys: { encryption, signing },
  };
}

function publicKeysMatch(left, right) {
  return left?.encryption?.x === right?.encryption?.x &&
    left?.encryption?.y === right?.encryption?.y &&
    left?.signing?.x === right?.signing?.x &&
    left?.signing?.y === right?.signing?.y;
}

export async function provisionE2eeIdentity(userId, { force = false } = {}) {
  const db = getDb();
  const current = await db.get(
    `SELECT i.public_key, i.key_version, e.encrypted_private_key
     FROM e2ee_identities i LEFT JOIN e2ee_key_escrows e ON e.user_id = i.user_id
     WHERE i.user_id = ?`,
    [userId],
  );
  if (current && !force) return { created: false, escrowed: Boolean(current.encrypted_private_key) };

  const identity = await generateE2eeIdentity();
  const now = Date.now();
  const version = Number(current?.key_version ?? 0) + 1;
  await db.tx(async (tx) => {
    await tx.run(
      `INSERT INTO e2ee_identities (user_id, public_key, key_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET public_key = excluded.public_key,
         key_version = excluded.key_version, updated_at = excluded.updated_at`,
      [userId, JSON.stringify(identity.publicKey), version, now, now],
    );
    await tx.run(
      `INSERT INTO e2ee_key_escrows
         (user_id, encrypted_private_key, key_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET encrypted_private_key = excluded.encrypted_private_key,
         key_version = excluded.key_version, updated_at = excluded.updated_at`,
      [userId, sealE2eeSecret(identity.privateKey), version, now, now],
    );
  });
  return { created: true, escrowed: true, version };
}

export async function provisionE2eeIdentities(userIds, options) {
  const results = [];
  for (const userId of [...new Set(userIds)]) {
    results.push(await provisionE2eeIdentity(userId, options));
  }
  return results;
}

export async function getE2eeBootstrap(userId) {
  await provisionE2eeIdentity(userId);
  const row = await getDb().get(
    `SELECT i.public_key, i.key_version, e.encrypted_private_key
     FROM e2ee_identities i LEFT JOIN e2ee_key_escrows e ON e.user_id = i.user_id
     WHERE i.user_id = ?`,
    [userId],
  );
  if (!row) return null;
  const publicKey = JSON.parse(row.public_key);
  if (!row.encrypted_private_key) return { publicKey, privateKey: null, version: Number(row.key_version) };
  const privateKey = openE2eeSecret(row.encrypted_private_key);
  const derivedPublic = {
    encryption: { ...privateKey.encryption, d: undefined },
    signing: { ...privateKey.signing, d: undefined },
  };
  if (!publicKeysMatch(publicKey, derivedPublic)) {
    return { publicKey, privateKey: null, version: Number(row.key_version) };
  }
  return { publicKey, privateKey, version: Number(row.key_version) };
}

async function wrappingKey(privateKey, publicJwk, conversationId) {
  const publicKey = await subtle.importKey(
    'jwk', publicJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const shared = await subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const context = aad(conversationId, 'key-wrap');
  const material = Buffer.concat([Buffer.from(shared), Buffer.from(context)]);
  const digest = await subtle.digest('SHA-256', material);
  return subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt']);
}

export async function encryptE2eeEnvelope({ conversationId, senderId, plaintext, participants, identity }) {
  const senderIdentity = identity ?? await generateE2eeIdentity();
  const contentKey = await subtle.generateKey(
    { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'],
  );
  const rawContentKey = await subtle.exportKey('raw', contentKey);
  const contentIv = crypto.randomBytes(12);
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv: contentIv, additionalData: aad(conversationId, 'content') },
    contentKey,
    encoder.encode(plaintext),
  );
  const keys = {};
  for (const participant of participants) {
    const iv = crypto.randomBytes(12);
    const key = await wrappingKey(
      senderIdentity.cryptoKeys.encryption.privateKey,
      participant.publicKey.encryption,
      conversationId,
    );
    const wrapped = await subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad(conversationId, participant.userId) },
      key,
      rawContentKey,
    );
    keys[participant.userId] = { iv: b64(iv), ciphertext: b64(wrapped) };
  }
  const body = {
    v: 1,
    alg: 'ECDH-P256+A256GCM+ES256',
    sender: senderId,
    senderPublic: senderIdentity.publicKey,
    iv: b64(contentIv),
    ciphertext: b64(ciphertext),
    keys,
  };
  const signature = await subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    senderIdentity.cryptoKeys.signing.privateKey,
    encoder.encode(JSON.stringify(body)),
  );
  return `e2ee:v1:${b64(encoder.encode(JSON.stringify({ ...body, signature: b64(signature) })))}`;
}
