import { api } from './api';

interface PublicIdentity { encryption: JsonWebKey; signing: JsonWebKey }
interface StoredIdentity {
  id: string; encryptionPrivate: CryptoKey; encryptionPublic: CryptoKey;
  signingPrivate: CryptoKey; signingPublic: CryptoKey;
}
interface Participant { userId: string; username: string; displayName: string; publicKey: PublicIdentity | null; version: number | null }
interface BootstrapIdentity {
  publicKey: PublicIdentity;
  privateKey: { encryption: JsonWebKey; signing: JsonWebKey } | null;
  version: number;
}
interface EnvelopeBody {
  v: 1; alg: 'ECDH-P256+A256GCM+ES256'; sender: string; senderPublic: PublicIdentity;
  iv: string; ciphertext: string; keys: Record<string, { iv: string; ciphertext: string }>;
}
interface Envelope extends EnvelopeBody { signature: string }

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const identityPromises = new Map<string, Promise<StoredIdentity>>();
const identityReady = new Map<string, { promise: Promise<StoredIdentity>; expiresAt: number }>();
const participantCache = new Map<string, { promise: Promise<{ participants: Participant[] }>; expiresAt: number }>();
const wrappingKeyCache = new WeakMap<CryptoKey, Map<string, Promise<CryptoKey>>>();
const decryptionCache = new Map<string, Promise<string>>();
const CACHE_TTL_MS = 60_000;

function b64(bytes: ArrayBuffer | Uint8Array) {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let offset = 0; offset < array.length; offset += 0x8000) {
    binary += String.fromCharCode(...array.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function unb64(value: string) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function randomIv() { return crypto.getRandomValues(new Uint8Array(12)); }
function aad(conversationId: string, purpose: string) { return encoder.encode(`zdis:e2ee:v1:${conversationId}:${purpose}`); }

function openIdentityDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('zdis-e2ee', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('identity', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function loadStoredIdentity(userId: string): Promise<StoredIdentity | null> {
  const db = await openIdentityDb();
  return new Promise((resolve, reject) => {
    const id = `user:${userId}`;
    const transaction = db.transaction('identity', 'readwrite');
    const store = transaction.objectStore('identity');
    const request = store.get(id);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      if (request.result) {
        transaction.oncomplete = () => { db.close(); resolve(request.result); };
        return;
      }
      // Versions before per-account key isolation used one `current` record.
      // Move it to the first account that opens the upgraded client so that
      // existing ciphertext remains decryptable without sharing the key with
      // every later login in this browser.
      const legacy = store.get('current');
      legacy.onerror = () => reject(legacy.error);
      legacy.onsuccess = () => {
        if (legacy.result) {
          store.put({ ...legacy.result, id });
          store.delete('current');
        }
        transaction.oncomplete = () => {
          db.close();
          resolve(legacy.result ? { ...legacy.result, id } : null);
        };
      };
    };
    transaction.onerror = () => { db.close(); reject(transaction.error); };
  });
}
async function saveStoredIdentity(identity: StoredIdentity) {
  const db = await openIdentityDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('identity', 'readwrite');
    tx.objectStore('identity').put(identity);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  });
  db.close();
}
async function importBootstrapIdentity(userId: string, bootstrap: BootstrapIdentity) {
  if (!bootstrap.privateKey) return null;
  const identity: StoredIdentity = {
    id: `user:${userId}`,
    encryptionPrivate: await crypto.subtle.importKey(
      'jwk', bootstrap.privateKey.encryption,
      { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
    ),
    encryptionPublic: await crypto.subtle.importKey(
      'jwk', bootstrap.publicKey.encryption,
      { name: 'ECDH', namedCurve: 'P-256' }, true, [],
    ),
    signingPrivate: await crypto.subtle.importKey(
      'jwk', bootstrap.privateKey.signing,
      { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'],
    ),
    signingPublic: await crypto.subtle.importKey(
      'jwk', bootstrap.publicKey.signing,
      { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'],
    ),
  };
  await saveStoredIdentity(identity);
  return identity;
}
async function localIdentity(userId: string) {
  let promise = identityPromises.get(userId);
  if (!promise) {
    promise = (async () => {
      const existing = await loadStoredIdentity(userId);
      const bootstrap = await api
        .get<{ identity: BootstrapIdentity | null }>('/api/e2ee/identity/bootstrap')
        .then((result) => result.identity)
        .catch(() => null);
      if (bootstrap?.privateKey) {
        if (existing && samePublic(await exportedPublic(existing), bootstrap.publicKey)) return existing;
        const imported = await importBootstrapIdentity(userId, bootstrap);
        if (imported) return imported;
      }
      if (existing) return existing;
      const encryption = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      const signing = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const identity: StoredIdentity = { id: `user:${userId}`, encryptionPrivate: encryption.privateKey,
        encryptionPublic: encryption.publicKey, signingPrivate: signing.privateKey, signingPublic: signing.publicKey };
      await saveStoredIdentity(identity);
      return identity;
    })();
    identityPromises.set(userId, promise);
  }
  return promise;
}
async function exportedPublic(identity: StoredIdentity): Promise<PublicIdentity> {
  return { encryption: await crypto.subtle.exportKey('jwk', identity.encryptionPublic),
    signing: await crypto.subtle.exportKey('jwk', identity.signingPublic) };
}
function samePublic(left: PublicIdentity | null, right: PublicIdentity) {
  return left?.encryption.x === right.encryption.x && left?.encryption.y === right.encryption.y &&
    left?.signing.x === right.signing.x && left?.signing.y === right.signing.y;
}

export async function ensureE2eeIdentity(userId: string) {
  if (!crypto.subtle || !indexedDB) throw new Error('این مرورگر از Web Crypto/IndexedDB پشتیبانی نمی‌کند.');
  const cached = identityReady.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const promise = (async () => {
    const identity = await localIdentity(userId);
    const publicKey = await exportedPublic(identity);
    const remote = await api.get<{ identity: { publicKey: PublicIdentity } | null }>('/api/e2ee/identity');
    if (!samePublic(remote.identity?.publicKey ?? null, publicKey)) await api.put('/api/e2ee/identity', { publicKey });
    return identity;
  })();
  identityReady.set(userId, { promise, expiresAt: Date.now() + CACHE_TTL_MS });
  promise.catch(() => identityReady.delete(userId));
  return promise;
}

async function wrappingKey(privateKey: CryptoKey, publicJwk: JsonWebKey, conversationId: string) {
  let cache = wrappingKeyCache.get(privateKey);
  if (!cache) {
    cache = new Map();
    wrappingKeyCache.set(privateKey, cache);
  }
  const cacheKey = `${conversationId}:${publicJwk.x ?? ''}:${publicJwk.y ?? ''}`;
  let promise = cache.get(cacheKey);
  if (!promise) {
    promise = (async () => {
      const publicKey = await crypto.subtle.importKey('jwk', publicJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
      const context = aad(conversationId, 'key-wrap');
      const material = new Uint8Array(shared.byteLength + context.byteLength);
      material.set(new Uint8Array(shared)); material.set(context, shared.byteLength);
      const digest = await crypto.subtle.digest('SHA-256', material);
      return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
    })();
    cache.set(cacheKey, promise);
    promise.catch(() => cache?.delete(cacheKey));
  }
  return promise;
}

function conversationParticipants(conversationId: string) {
  const cached = participantCache.get(conversationId);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const promise = api.get<{ participants: Participant[] }>(`/api/e2ee/conversations/${conversationId}/participants`);
  participantCache.set(conversationId, { promise, expiresAt: Date.now() + 30_000 });
  promise.catch(() => participantCache.delete(conversationId));
  return promise;
}

export async function prepareConversationEncryption(conversationId: string, userId: string) {
  await Promise.all([ensureE2eeIdentity(userId), conversationParticipants(conversationId)]);
}

export async function encryptConversationMessage(conversationId: string, senderId: string, plaintext: string) {
  if (!plaintext.trim()) throw new Error('پیام خالی است.');
  const identity = await ensureE2eeIdentity(senderId);
  const directory = await conversationParticipants(conversationId);
  const missing = directory.participants.filter((participant) => !participant.publicKey);
  if (missing.length) throw new Error(`کلید رمزنگاری ${missing.map((item) => item.displayName).join('، ')} هنوز ثبت نشده است.`);
  const senderPublic = await exportedPublic(identity);
  const contentKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const rawContentKey = await crypto.subtle.exportKey('raw', contentKey);
  const contentIv = randomIv();
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: contentIv, additionalData: aad(conversationId, 'content') }, contentKey, encoder.encode(plaintext));
  const keys: EnvelopeBody['keys'] = {};
  for (const participant of directory.participants) {
    const iv = randomIv();
    const key = await wrappingKey(identity.encryptionPrivate, participant.publicKey!.encryption, conversationId);
    const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(conversationId, participant.userId) }, key, rawContentKey);
    keys[participant.userId] = { iv: b64(iv), ciphertext: b64(wrapped) };
  }
  const body: EnvelopeBody = { v: 1, alg: 'ECDH-P256+A256GCM+ES256', sender: senderId, senderPublic,
    iv: b64(contentIv), ciphertext: b64(ciphertext), keys };
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.signingPrivate, encoder.encode(JSON.stringify(body)));
  const envelope: Envelope = { ...body, signature: b64(signature) };
  return `e2ee:v1:${b64(encoder.encode(JSON.stringify(envelope)))}`;
}

async function decryptConversationMessageUncached(content: string, conversationId: string, currentUserId: string, expectedSenderId: string) {
  if (!content.startsWith('e2ee:v1:')) throw new Error('قالب پیام رمز‌شده معتبر نیست.');
  const envelope = JSON.parse(decoder.decode(unb64(content.slice(8)))) as Envelope;
  if (envelope.v !== 1 || envelope.sender !== expectedSenderId || !envelope.keys[currentUserId]) throw new Error('هویت فرستنده یا گیرنده معتبر نیست.');
  const { signature, ...body } = envelope;
  const signingKey = await crypto.subtle.importKey('jwk', envelope.senderPublic.signing, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, unb64(signature), encoder.encode(JSON.stringify(body)));
  if (!valid) throw new Error('امضای دیجیتال پیام معتبر نیست.');
  const identity = await localIdentity(currentUserId);
  const wrapped = envelope.keys[currentUserId];
  const wrapKey = await wrappingKey(identity.encryptionPrivate, envelope.senderPublic.encryption, conversationId);
  const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(wrapped.iv), additionalData: aad(conversationId, currentUserId) }, wrapKey, unb64(wrapped.ciphertext));
  const contentKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(envelope.iv), additionalData: aad(conversationId, 'content') }, contentKey, unb64(envelope.ciphertext));
  return decoder.decode(plaintext);
}

export function decryptConversationMessage(content: string, conversationId: string, currentUserId: string, expectedSenderId: string) {
  const cacheKey = `${currentUserId}:${conversationId}:${expectedSenderId}:${content}`;
  let promise = decryptionCache.get(cacheKey);
  if (!promise) {
    promise = decryptConversationMessageUncached(content, conversationId, currentUserId, expectedSenderId);
    decryptionCache.set(cacheKey, promise);
    promise.catch(() => decryptionCache.delete(cacheKey));
    // Bound sensitive plaintext retained in memory while still avoiding the
    // repeated signature/ECDH/decrypt work done by previews and message rows.
    if (decryptionCache.size > 500) {
      const oldest = decryptionCache.keys().next().value;
      if (oldest) decryptionCache.delete(oldest);
    }
  }
  return promise;
}

/** Turns a decrypted structured payload into the short text used by preview UIs. */
export function readableEncryptedPreview(plaintext: string) {
  try {
    const payload = JSON.parse(plaintext);
    if (payload?.v === 1 && payload.kind === 'poll' && typeof payload.poll?.question === 'string') {
      return payload.poll.question;
    }
    if (payload?.v === 1 && typeof payload.text === 'string' && Array.isArray(payload.attachments)) {
      return payload.text.trim() || payload.attachments[0]?.name || 'Attachment';
    }
  } catch { /* legacy encrypted messages contain plain text */ }
  return plaintext;
}
