import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { newId } from '../lib/ids.js';
import { badRequest, notFound } from '../lib/errors.js';
import { createUser, toPublicUser } from './users.js';
import { enqueue } from '../jobs/queue.js';

const API_SCOPES = new Set(['read', 'write', 'admin']);

function digest(value) {
  return crypto.createHmac('sha256', config.secret).update(value).digest('base64url');
}

function parseScopes(value) {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function createApiKey({
  userId,
  name,
  scopes = ['read', 'write'],
  expiresAt = null,
}) {
  const normalizedScopes = [...new Set(scopes)].filter((scope) => API_SCOPES.has(scope));
  if (!normalizedScopes.length) throw badRequest('Select at least one API scope.');
  const prefix = crypto.randomBytes(6).toString('base64url');
  const secret = crypto.randomBytes(32).toString('base64url');
  const token = `ytbl_${prefix}_${secret}`;
  const id = newId();
  await getDb().run(
    `INSERT INTO api_keys
       (id, user_id, name, key_prefix, key_hash, scopes, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      userId,
      String(name).trim(),
      prefix,
      digest(token),
      JSON.stringify(normalizedScopes),
      expiresAt,
      Date.now(),
    ],
  );
  return {
    apiKey: { id, name, prefix, scopes: normalizedScopes, expiresAt, createdAt: Date.now() },
    token,
  };
}

export async function resolveApiKey(token) {
  const match = /^ytbl_([A-Za-z0-9_-]{8})_([A-Za-z0-9_-]{40,})$/.exec(token ?? '');
  if (!match) return null;
  const row = await getDb().get(
    `SELECT * FROM api_keys
     WHERE key_prefix = ? AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > ?)`,
    [match[1], Date.now()],
  );
  if (!row) return null;
  const actual = Buffer.from(digest(token));
  const expected = Buffer.from(row.key_hash);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  void getDb().run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [Date.now(), row.id]);
  return { id: row.id, userId: row.user_id, scopes: parseScopes(row.scopes) };
}

export async function listApiKeys(userId) {
  const rows = await getDb().all(
    `SELECT id, name, key_prefix, scopes, expires_at, last_used_at, created_at
     FROM api_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
    [userId],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    prefix: row.key_prefix,
    scopes: parseScopes(row.scopes),
    expiresAt: row.expires_at ? Number(row.expires_at) : null,
    lastUsedAt: row.last_used_at ? Number(row.last_used_at) : null,
    createdAt: Number(row.created_at),
  }));
}

export async function revokeApiKey(id, userId) {
  const result = await getDb().run(
    'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
    [Date.now(), id, userId],
  );
  if (!result.changes) throw notFound('API key not found.');
}

export async function createBot({ ownerId, name, description = null }) {
  const id = newId();
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 18) || 'bot';
  const username = `${slug}${id.slice(-8)}`.slice(0, 32);
  const user = await createUser({
    email: `${id.toLowerCase()}@bots.invalid`,
    username,
    displayName: String(name).trim(),
    password: `${crypto.randomBytes(48).toString('base64url')}#Aa1`,
    createdBy: ownerId,
    skipPasswordPolicy: true,
  });
  await getDb().run(
    `INSERT INTO bots (id, user_id, owner_id, name, description, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, user.id, ownerId, String(name).trim(), description, Date.now()],
  );
  const credentials = await createApiKey({
    userId: user.id,
    name: 'Bot token',
    scopes: ['read', 'write'],
  });
  return {
    bot: { id, user: toPublicUser(user), name, description, createdAt: Date.now() },
    token: credentials.token,
  };
}

export async function listBots(ownerId) {
  const rows = await getDb().all(
    `SELECT b.*, u.username, u.display_name, u.avatar_url, u.is_active
     FROM bots b JOIN users u ON u.id = b.user_id
     WHERE b.owner_id = ? ORDER BY b.created_at DESC`,
    [ownerId],
  );
  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description,
    username: row.username,
    active: Boolean(row.is_active),
    createdAt: Number(row.created_at),
  }));
}

export async function disableBot(id, ownerId) {
  const bot = await getDb().get(
    'SELECT user_id FROM bots WHERE id = ? AND owner_id = ?',
    [id, ownerId],
  );
  if (!bot) throw notFound('Bot not found.');
  const now = Date.now();
  await getDb().tx(async (tx) => {
    await tx.run('UPDATE users SET is_active = 0, updated_at = ? WHERE id = ?', [now, bot.user_id]);
    await tx.run(
      'UPDATE api_keys SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
      [now, bot.user_id],
    );
    await tx.run(
      'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
      [now, bot.user_id],
    );
  });
}

function encryptionKey() {
  return crypto.createHash('sha256').update(config.secret).digest();
}

function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
}

function decryptSecret(value) {
  const [iv, tag, encrypted] = String(value).split('.').map((part) => Buffer.from(part, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function isPrivateIp(address) {
  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number);
    return (
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      parts[0] === 0
    );
  }
  const normalized = address.toLowerCase();
  return normalized === '::1' || normalized.startsWith('fe80:') || normalized.startsWith('fc') ||
    normalized.startsWith('fd');
}

export async function assertSafeWebhookEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw badRequest('Webhook endpoint is not a valid URL.');
  }
  if (url.protocol !== 'https:' && (config.isProd || url.protocol !== 'http:')) {
    throw badRequest('Webhook endpoints must use HTTPS.');
  }
  if (url.username || url.password) throw badRequest('Webhook URLs cannot contain credentials.');
  const addresses = await dns.lookup(url.hostname, { all: true }).catch(() => []);
  if (!addresses.length) throw badRequest('Webhook hostname could not be resolved.');
  if (addresses.some((item) => isPrivateIp(item.address)) && config.isProd) {
    throw badRequest('Webhook endpoint resolves to a private network.');
  }
  return url.toString();
}

export async function createWebhook({
  ownerId,
  groupId = null,
  permissionLevel = 'manageWebhooks',
  targetType,
  targetId,
  name,
  endpoint,
  events,
}) {
  const safeEndpoint = await assertSafeWebhookEndpoint(endpoint);
  const secret = `whsec_${crypto.randomBytes(32).toString('base64url')}`;
  const id = newId();
  const now = Date.now();
  await getDb().run(
    `INSERT INTO outgoing_webhooks
       (id, owner_id, group_id, permission_level, target_type, target_id, name, endpoint, events,
        secret_encrypted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      ownerId,
      groupId,
      permissionLevel,
      targetType,
      targetId,
      name,
      safeEndpoint,
      JSON.stringify([...new Set(events)]),
      encryptSecret(secret),
      now,
      now,
    ],
  );
  return { webhook: await getWebhook(id, ownerId), secret };
}

export async function getWebhook(id, ownerId = null) {
  const row = await getDb().get(
    `SELECT * FROM outgoing_webhooks WHERE id = ? ${ownerId ? 'AND owner_id = ?' : ''}`,
    ownerId ? [id, ownerId] : [id],
  );
  return row
    ? {
        id: row.id,
        ownerId: row.owner_id,
        groupId: row.group_id ?? null,
        permissionLevel: row.permission_level ?? 'manageWebhooks',
        targetType: row.target_type,
        targetId: row.target_id,
        name: row.name,
        endpoint: row.endpoint,
        events: parseScopes(row.events),
        active: Boolean(row.active),
        failureCount: Number(row.failure_count),
        circuitOpenUntil: row.circuit_open_until ? Number(row.circuit_open_until) : null,
        createdAt: Number(row.created_at),
      }
    : null;
}

export async function listWebhooks(ownerId) {
  const rows = await getDb().all(
    'SELECT id FROM outgoing_webhooks WHERE owner_id = ? ORDER BY created_at DESC',
    [ownerId],
  );
  return Promise.all(rows.map((row) => getWebhook(row.id, ownerId)));
}

export async function deleteWebhook(id, ownerId) {
  const result = await getDb().run('DELETE FROM outgoing_webhooks WHERE id = ? AND owner_id = ?', [
    id,
    ownerId,
  ]);
  if (!result.changes) throw notFound('Webhook not found.');
}

export async function dispatchWebhookEvent({ targetType, targetId, eventType, payload }) {
  const rows = await getDb().all(
    `SELECT id, events FROM outgoing_webhooks
     WHERE target_type = ? AND target_id = ? AND active = 1
       AND (circuit_open_until IS NULL OR circuit_open_until <= ?)`,
    [targetType, targetId, Date.now()],
  );
  const eventId = newId();
  for (const row of rows) {
    if (!parseScopes(row.events).includes(eventType)) continue;
    const deliveryId = newId();
    await getDb().run(
      `INSERT INTO webhook_deliveries
         (id, webhook_id, event_id, event_type, status, created_at, payload)
       VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
      [deliveryId, row.id, eventId, eventType, Date.now(), JSON.stringify(payload)],
    );
    await enqueue('webhook.deliver', { deliveryId, payload });
  }
  return eventId;
}

export async function deliverWebhook({ deliveryId, payload }) {
  const db = getDb();
  const row = await db.get(
    `SELECT d.*, w.endpoint, w.secret_encrypted, w.active, w.circuit_open_until
     FROM webhook_deliveries d JOIN outgoing_webhooks w ON w.id = d.webhook_id
     WHERE d.id = ?`,
    [deliveryId],
  );
  if (!row || !row.active) return { skipped: true };
  await assertSafeWebhookEndpoint(row.endpoint);
  const body = JSON.stringify({
    id: row.event_id,
    type: row.event_type,
    createdAt: row.created_at,
    data: payload,
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto
    .createHmac('sha256', decryptSecret(row.secret_encrypted))
    .update(`${timestamp}.${body}`)
    .digest('hex');
  try {
    const response = await fetch(row.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'sahsha-Webhooks/1.0',
        'x-youtbelimo-event': row.event_type,
        'x-youtbelimo-delivery': row.event_id,
        'x-youtbelimo-timestamp': String(timestamp),
        'x-youtbelimo-signature': `v1=${signature}`,
      },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}.`);
    await db.run(
      `UPDATE webhook_deliveries
       SET status = 'delivered', response_status = ?, attempts = attempts + 1,
           completed_at = ? WHERE id = ?`,
      [response.status, Date.now(), deliveryId],
    );
    await db.run(
      'UPDATE outgoing_webhooks SET failure_count = 0, circuit_open_until = NULL WHERE id = ?',
      [row.webhook_id],
    );
    return { status: response.status };
  } catch (error) {
    const failures = Number(
      (await db.get('SELECT failure_count FROM outgoing_webhooks WHERE id = ?', [row.webhook_id]))
        ?.failure_count ?? 0,
    ) + 1;
    await db.run(
      `UPDATE outgoing_webhooks SET failure_count = ?,
       circuit_open_until = ? WHERE id = ?`,
      [failures, failures >= 10 ? Date.now() + 15 * 60_000 : null, row.webhook_id],
    );
    await db.run(
      `UPDATE webhook_deliveries
       SET status = 'failed', attempts = attempts + 1, error = ?, completed_at = ? WHERE id = ?`,
      [String(error.message).slice(0, 500), Date.now(), deliveryId],
    );
    throw error;
  }
}

export async function recordSyncEvent({ targetType, targetId, eventType, entityId, payload }) {
  const id = newId();
  await getDb().run(
    `INSERT INTO sync_events
       (id, target_type, target_id, event_type, entity_id, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, targetType, targetId, eventType, entityId, JSON.stringify(payload), Date.now()],
  );
  return id;
}
