import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const dataDir = path.join(root, '.tmp', `e2ee-migration-${process.pid}`);
await fs.rm(dataDir, { recursive: true, force: true });
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATA_DIR: dataDir,
  APP_SECRET: 'e2ee-migration-test-secret-longer-than-thirty-two-characters',
  LOG_LEVEL: 'error',
});

const { initDb, getDb, closeDatabases } = await import('../server/src/db/index.js');
const { initCache, closeCache } = await import('../server/src/cache/index.js');
const { createUser } = await import('../server/src/services/users.js');
const { openDirectMessage } = await import('../server/src/services/conversations.js');
const { createMessage } = await import('../server/src/services/messages.js');
const { getE2eeBootstrap, openE2eeSecret } = await import('../server/src/services/e2eeKeys.js');

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const aad = (conversationId, purpose) =>
  new TextEncoder().encode(`zdis:e2ee:v1:${conversationId}:${purpose}`);

async function decrypt(content, conversationId, userId, privateJwk) {
  const envelope = JSON.parse(Buffer.from(content.slice(8), 'base64url').toString('utf8'));
  const privateKey = await crypto.webcrypto.subtle.importKey(
    'jwk', privateJwk.encryption, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'],
  );
  const senderPublic = await crypto.webcrypto.subtle.importKey(
    'jwk', envelope.senderPublic.encryption, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const shared = await crypto.webcrypto.subtle.deriveBits(
    { name: 'ECDH', public: senderPublic }, privateKey, 256,
  );
  const context = aad(conversationId, 'key-wrap');
  const material = Buffer.concat([Buffer.from(shared), Buffer.from(context)]);
  const wrappingKey = await crypto.webcrypto.subtle.importKey(
    'raw', await crypto.webcrypto.subtle.digest('SHA-256', material), 'AES-GCM', false, ['decrypt'],
  );
  const wrapped = envelope.keys[userId];
  const raw = await crypto.webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv: Buffer.from(wrapped.iv, 'base64url'), additionalData: aad(conversationId, userId) },
    wrappingKey,
    Buffer.from(wrapped.ciphertext, 'base64url'),
  );
  const contentKey = await crypto.webcrypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv: Buffer.from(envelope.iv, 'base64url'), additionalData: aad(conversationId, 'content') },
    contentKey,
    Buffer.from(envelope.ciphertext, 'base64url'),
  );
  return Buffer.from(plaintext).toString('utf8');
}

try {
  await initDb();
  await initCache();
  const alice = await createUser({
    email: 'migration-alice@example.com', username: 'migrationalice', displayName: 'Alice',
    password: 'Migration-Alice#2026', skipPasswordPolicy: true,
  });
  const bob = await createUser({
    email: 'migration-bob@example.com', username: 'migrationbob', displayName: 'Bob',
    password: 'Migration-Bob#2026', skipPasswordPolicy: true,
  });
  const conversation = await openDirectMessage(alice.id, bob.id);
  const plaintext = 'A message that must survive the encryption migration.';
  const message = await createMessage({
    conversationId: conversation.id,
    authorId: alice.id,
    content: plaintext,
    scopeUserIds: [alice.id, bob.id],
  });
  await closeCache();
  await closeDatabases();

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server/src/scripts/migrate-dms-to-e2ee.js'], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(output)));
  });

  await initDb();
  await initCache();
  const stored = await getDb().get('SELECT content, type FROM messages WHERE id = ?', [message.id]);
  assert(stored.type === 'encrypted', 'message type was not migrated');
  assert(stored.content.startsWith('e2ee:v1:'), 'message content is not an E2EE envelope');
  assert(!stored.content.includes(plaintext), 'plaintext remains in the migrated message row');
  const backup = await getDb().get(
    "SELECT encrypted_original FROM e2ee_migration_backups WHERE record_type = 'message' AND record_id = ?",
    [message.id],
  );
  assert(backup, 'encrypted rollback record is missing');
  assert(openE2eeSecret(backup.encrypted_original).content === plaintext, 'rollback record did not preserve content');
  const bobIdentity = await getE2eeBootstrap(bob.id);
  assert(bobIdentity?.privateKey, 'recipient bootstrap key is missing');
  assert(
    await decrypt(stored.content, conversation.id, bob.id, bobIdentity.privateKey) === plaintext,
    'recipient could not decrypt the migrated message',
  );
  const setting = await getDb().get("SELECT value FROM settings WHERE key = 'e2ee_required_for_dms'");
  assert(setting?.value === '1', 'migration did not restore mandatory E2EE');
  console.log('E2EE migration test passed.');
} finally {
  await closeCache().catch(() => {});
  await closeDatabases().catch(() => {});
  await fs.rm(dataDir, { recursive: true, force: true });
}
