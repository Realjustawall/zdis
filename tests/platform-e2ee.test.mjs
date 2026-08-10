import crypto from 'node:crypto';

const BASE = 'http://localhost:4000';
const subtle = crypto.webcrypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
class Client {
  constructor(name) { this.name = name; this.cookies = new Map(); this.csrf = null; }
  cookieHeader() { return [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '); }
  async request(method, route, body, allowFail = false) {
    const headers = { cookie: this.cookieHeader() };
    if (this.csrf) headers['x-csrf-token'] = this.csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(BASE + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const line of response.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';'); const index = pair.indexOf('=');
      this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    const result = await response.json().catch(() => null);
    if (!allowFail && !response.ok) throw new Error(`${this.name} ${method} ${route}: ${response.status} ${JSON.stringify(result)}`);
    return { status: response.status, body: result };
  }
  get(route) { return this.request('GET', route); }
  post(route, body, allowFail) { return this.request('POST', route, body, allowFail); }
  put(route, body) { return this.request('PUT', route, body); }
  patch(route, body) { return this.request('PATCH', route, body); }
  async upload(route, file) {
    const form = new FormData(); form.append('file', file);
    const response = await fetch(BASE + route, { method: 'POST', headers: {
      cookie: this.cookieHeader(), 'x-csrf-token': this.csrf,
    }, body: form });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`${this.name} POST ${route}: ${response.status} ${JSON.stringify(result)}`);
    return result;
  }
  async bytes(route) {
    const response = await fetch(BASE + route, { headers: { cookie: this.cookieHeader() } });
    if (!response.ok) throw new Error(`${this.name} GET ${route}: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  async login(identifier, password) { const result = await this.post('/api/auth/login', { identifier, password }); this.csrf = result.body.csrfToken; return result.body.user; }
}
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const b64 = (value) => Buffer.from(value).toString('base64url');
const unb64 = (value) => Buffer.from(value, 'base64url');
const aad = (conversationId, purpose) => encoder.encode(`zdis:e2ee:v1:${conversationId}:${purpose}`);
async function identity() {
  const encryption = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const signing = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { encryption, signing, publicKey: { encryption: await subtle.exportKey('jwk', encryption.publicKey), signing: await subtle.exportKey('jwk', signing.publicKey) } };
}
async function wrapKey(privateKey, publicJwk, conversationId) {
  const publicKey = await subtle.importKey('jwk', publicJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const context = aad(conversationId, 'key-wrap');
  const material = Buffer.concat([Buffer.from(shared), Buffer.from(context)]);
  return subtle.importKey('raw', await subtle.digest('SHA-256', material), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function encrypt(conversationId, sender, senderIdentity, recipients, plaintext) {
  const contentKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const raw = await subtle.exportKey('raw', contentKey); const iv = crypto.randomBytes(12);
  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(conversationId, 'content') }, contentKey, encoder.encode(plaintext));
  const keys = {};
  for (const recipient of recipients) {
    const wrapIv = crypto.randomBytes(12);
    const wrapping = await wrapKey(senderIdentity.encryption.privateKey, recipient.publicKey.encryption, conversationId);
    keys[recipient.userId] = { iv: b64(wrapIv), ciphertext: b64(await subtle.encrypt({ name: 'AES-GCM', iv: wrapIv, additionalData: aad(conversationId, recipient.userId) }, wrapping, raw)) };
  }
  const body = { v: 1, alg: 'ECDH-P256+A256GCM+ES256', sender, senderPublic: senderIdentity.publicKey, iv: b64(iv), ciphertext: b64(ciphertext), keys };
  const signature = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, senderIdentity.signing.privateKey, encoder.encode(JSON.stringify(body)));
  return `e2ee:v1:${b64(encoder.encode(JSON.stringify({ ...body, signature: b64(signature) })))}`;
}
async function decrypt(content, conversationId, recipientId, recipientIdentity) {
  const envelope = JSON.parse(decoder.decode(unb64(content.slice(8))));
  const wrapped = envelope.keys[recipientId];
  const wrapping = await wrapKey(recipientIdentity.encryption.privateKey, envelope.senderPublic.encryption, conversationId);
  const raw = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(wrapped.iv), additionalData: aad(conversationId, recipientId) }, wrapping, unb64(wrapped.ciphertext));
  const contentKey = await subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  return decoder.decode(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(envelope.iv), additionalData: aad(conversationId, 'content') }, contentKey, unb64(envelope.ciphertext)));
}

console.log('=== platform control plane / e2ee protocol ===\n');
let passed = 0;
async function check(name, work) { await work(); passed += 1; console.log(`  PASS  ${name}`); }
const suffix = Math.random().toString(36).slice(2, 9);
const admin = new Client('admin'); const alice = new Client('alice'); const bob = new Client('bob');
await admin.login('office@intesho.com', 'cNL2*8o$1F;"');
const create = async (prefix, password) => (await admin.post('/api/admin/users', { email: `${prefix}-${suffix}@example.com`, username: `${prefix}${suffix}`, displayName: prefix, password, role: 'member', mustChangePassword: false })).body.user;
const aliceUser = await create('cryptoa', 'Crypto-Alice#2026'); const bobUser = await create('cryptob', 'Crypto-Bob#2026');
await alice.login(aliceUser.email, 'Crypto-Alice#2026'); await bob.login(bobUser.email, 'Crypto-Bob#2026');

await check('new accounts receive recoverable bootstrap identities before joining a DM', async () => {
  const aliceBootstrap = await alice.get('/api/e2ee/identity/bootstrap');
  const bobBootstrap = await bob.get('/api/e2ee/identity/bootstrap');
  assert(aliceBootstrap.body.identity?.privateKey?.encryption?.d, 'Alice bootstrap private key is missing');
  assert(bobBootstrap.body.identity?.privateKey?.signing?.d, 'Bob bootstrap signing key is missing');
  assert(
    aliceBootstrap.body.identity.publicKey.encryption.x === aliceBootstrap.body.identity.privateKey.encryption.x,
    'Alice escrow key does not match the published identity',
  );
});

await check('admin platform status, analytics and feature flags are reachable', async () => {
  const platform = await admin.get('/api/admin/platform');
  assert(platform.body.storage && platform.body.queue && platform.body.providers, 'platform status is incomplete');
  const analytics = await admin.get('/api/admin/analytics?hours=6');
  assert(analytics.body.series.length === 6, 'analytics did not return six buckets');
  const settings = await admin.patch('/api/admin/settings', { feature_e2ee: true, e2ee_required_for_dms: true });
  assert(settings.body.settings.feature_e2ee === true && settings.body.settings.e2ee_required_for_dms === true, 'mandatory E2EE policy did not persist');
});

await check('Fish Audio secret is write-only and an empty update preserves it', async () => {
  const configured = await admin.patch('/api/admin/platform/configuration', {
    'fishAudio.apiKey': `test-fish-key-${suffix}`,
    'fishAudio.model': 's2-pro',
    'fishAudio.referenceId': `voice-${suffix}`,
  });
  assert(configured.body.configuration['fishAudio.apiKey'] === '', 'Fish API key leaked in configuration response');
  assert(configured.body.configuration['fishAudio.apiKeyConfigured'] === true, 'Fish API key was not marked configured');
  const preserved = await admin.patch('/api/admin/platform/configuration', { 'fishAudio.apiKey': '' });
  assert(preserved.body.configuration['fishAudio.apiKeyConfigured'] === true, 'empty Fish API key erased the stored secret');
  const platform = await admin.get('/api/admin/platform');
  assert(platform.body.providers.fishAudio.configured === true, 'Fish Audio provider did not become available');
});

const aliceIdentity = await identity(); const bobIdentity = await identity();
await check('users publish separate encryption and signing identities', async () => {
  await alice.put('/api/e2ee/identity', { publicKey: aliceIdentity.publicKey });
  await bob.put('/api/e2ee/identity', { publicKey: bobIdentity.publicKey });
});
const conversation = (await alice.post('/api/conversations/dm', { userId: bobUser.id })).body.conversation;
let encryptedMessageId;
await check('participant key directory is scoped to conversation members', async () => {
  const directory = await alice.get(`/api/e2ee/conversations/${conversation.id}/participants`);
  assert(directory.body.participants.length === 2 && directory.body.participants.every((item) => item.publicKey), 'participant keys are missing');
});
await check('ciphertext survives server transport and decrypts only with recipient key', async () => {
  const plaintext = `پیام محرمانه ${suffix}`;
  const envelope = await encrypt(conversation.id, aliceUser.id, aliceIdentity, [
    { userId: aliceUser.id, publicKey: aliceIdentity.publicKey }, { userId: bobUser.id, publicKey: bobIdentity.publicKey },
  ], plaintext);
  const sent = await alice.post(`/api/conversations/${conversation.id}/messages`, { content: envelope, encrypted: true, attachmentIds: [] });
  encryptedMessageId = sent.body.message.id;
  assert(sent.body.message.type === 'encrypted' && !sent.body.message.content.includes(plaintext), 'server response leaked plaintext');
  assert(await decrypt(sent.body.message.content, conversation.id, bobUser.id, bobIdentity) === plaintext, 'recipient could not decrypt ciphertext');
  const tampered = JSON.parse(decoder.decode(unb64(envelope.slice(8)))); tampered.ciphertext = b64(crypto.randomBytes(48));
  const badSignature = await alice.post(`/api/conversations/${conversation.id}/messages`, { content: `e2ee:v1:${b64(encoder.encode(JSON.stringify(tampered)))}`, encrypted: true }, true);
  assert(badSignature.status === 400, `tampered ciphertext returned ${badSignature.status}`);
  const forged = JSON.parse(decoder.decode(unb64(envelope.slice(8)))); forged.sender = bobUser.id;
  const rejected = await alice.post(`/api/conversations/${conversation.id}/messages`, { content: `e2ee:v1:${b64(encoder.encode(JSON.stringify(forged)))}`, encrypted: true }, true);
  assert(rejected.status === 400, `forged sender returned ${rejected.status}`);
});
await check('encrypted sidebar and reply previews never expose ciphertext', async () => {
  const conversations = await bob.get('/api/conversations');
  const listed = conversations.body.conversations.find((item) => item.id === conversation.id);
  assert(listed.lastMessage.preview === 'Encrypted message', 'sidebar preview was not readable');
  assert(listed.lastMessage.encrypted === true, 'sidebar preview was not marked encrypted');
  assert(listed.lastMessage.encryptedContent.startsWith('e2ee:v1:'), 'client decryptable sidebar payload is missing');

  const envelope = await encrypt(conversation.id, bobUser.id, bobIdentity, [
    { userId: aliceUser.id, publicKey: aliceIdentity.publicKey }, { userId: bobUser.id, publicKey: bobIdentity.publicKey },
  ], `پاسخ محرمانه ${suffix}`);
  const reply = await bob.post(`/api/conversations/${conversation.id}/messages`, {
    content: envelope, encrypted: true, attachmentIds: [], replyToId: encryptedMessageId,
  });
  assert(reply.body.message.replyTo.preview === 'Encrypted message', 'reply preview was not readable');
  assert(!reply.body.message.replyTo.preview.includes('🔒'), 'reply preview still contains a lock emoji');
  assert(reply.body.message.replyTo.encryptedContent.startsWith('e2ee:v1:'), 'client decryptable reply payload is missing');
});
await check('scheduled private messages are encrypted before database storage', async () => {
  const plaintext = `پیام زمان‌بندی‌شده محرمانه ${suffix}`;
  const envelope = await encrypt(conversation.id, aliceUser.id, aliceIdentity, [
    { userId: aliceUser.id, publicKey: aliceIdentity.publicKey }, { userId: bobUser.id, publicKey: bobIdentity.publicKey },
  ], plaintext);
  const created = await alice.post(`/api/conversations/${conversation.id}/scheduled`, {
    content: envelope, encrypted: true, attachmentIds: [], sendAt: Date.now() + 60_000,
  });
  assert(created.body.scheduled.encrypted === true, 'scheduled message was not marked encrypted');
  assert(!created.body.scheduled.content.includes(plaintext), 'scheduled message leaked plaintext');
});
await check('private file bytes are encrypted before upload and decrypt only in the client', async () => {
  const plaintext = Buffer.from(`private-file-${suffix}`);
  const fileKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const rawKey = await subtle.exportKey('raw', fileKey); const fileIv = crypto.randomBytes(12);
  const ciphertext = Buffer.from(await subtle.encrypt({ name: 'AES-GCM', iv: fileIv }, fileKey, plaintext));
  const uploaded = await alice.upload('/api/files', new File([Buffer.from('ZDISENC1'), ciphertext], 'secret.txt.zdis', { type: 'application/vnd.zdis.encrypted' }));
  const payload = JSON.stringify({ v: 1, text: '', attachments: [{ id: uploaded.attachment.id,
    name: 'secret.txt', mime: 'text/plain', key: b64(rawKey), iv: b64(fileIv) }] });
  const envelope = await encrypt(conversation.id, aliceUser.id, aliceIdentity, [
    { userId: aliceUser.id, publicKey: aliceIdentity.publicKey }, { userId: bobUser.id, publicKey: bobIdentity.publicKey },
  ], payload);
  const sent = await alice.post(`/api/conversations/${conversation.id}/messages`, {
    content: envelope, encrypted: true, attachmentIds: [uploaded.attachment.id],
  });
  const stored = await bob.bytes(sent.body.message.attachments[0].url);
  assert(stored.subarray(0, 8).toString() === 'ZDISENC1' && !stored.includes(plaintext), 'server stored readable file bytes');
  const clear = await subtle.decrypt({ name: 'AES-GCM', iv: fileIv }, fileKey, stored.subarray(8));
  assert(Buffer.from(clear).equals(plaintext), 'recipient could not decrypt file bytes');
  await bob.post(`/api/conversations/${conversation.id}/messages/${sent.body.message.id}/report`, {
    reason: 'other', details: 'encrypted media evidence', decryptedEvidence: payload,
  });
  const reports = await admin.get('/api/moderation/reports?status=open');
  const report = reports.body.reports.find((item) => item.messageId === sent.body.message.id);
  assert(report?.evidence?.content === payload, 'moderator did not receive participant-disclosed evidence');
  assert((await admin.bytes(sent.body.message.attachments[0].url)).subarray(0, 8).toString() === 'ZDISENC1', 'moderator could not retrieve reported encrypted media');
});
await check('private poll questions and choices remain encrypted', async () => {
  const payload = JSON.stringify({ v: 1, kind: 'poll', poll: {
    question: `پرسش محرمانه ${suffix}`, options: ['گزینه محرمانه اول', 'گزینه محرمانه دوم'],
    multiple: false, anonymous: true, examMode: false, correctIndex: null,
  } });
  const envelope = await encrypt(conversation.id, aliceUser.id, aliceIdentity, [
    { userId: aliceUser.id, publicKey: aliceIdentity.publicKey }, { userId: bobUser.id, publicKey: bobIdentity.publicKey },
  ], payload);
  const created = await alice.post(`/api/conversations/${conversation.id}/polls`, {
    encrypted: true, content: envelope, question: '🔒', options: ['option-1', 'option-2'],
    multiple: false, anonymous: true, examMode: false, correctOptionIndexes: [], closesAt: null,
  });
  assert(created.body.message.type === 'encrypted', 'encrypted poll was stored as plaintext');
  assert(await decrypt(created.body.message.content, conversation.id, aliceUser.id, aliceIdentity) === payload, 'encrypted poll payload did not round-trip');
  assert(created.body.message.poll.options.every((option) => !option.label.includes('محرمانه')), 'poll option plaintext leaked');
});
console.log(`\n${passed} passed, 0 failed`);
