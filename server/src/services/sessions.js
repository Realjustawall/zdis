import crypto from 'node:crypto';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { newId, randomToken } from '../lib/ids.js';
import { cache } from '../cache/index.js';

/**
 * Sessions are opaque random tokens. Only a SHA-256 of the token is stored, so
 * a database leak does not hand out live sessions, and every session is
 * individually revocable (logout, admin kill, password change).
 */

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');
const sessionCacheKey = (tokenHash) => `session:${tokenHash}`;

export async function createSession({ userId, userAgent, ip }) {
  const token = randomToken(32);
  const tokenHash = hash(token);
  const csrfSecret = randomToken(24);
  const now = Date.now();

  await getDb().run(
    `INSERT INTO sessions (id, user_id, token_hash, csrf_secret, user_agent, ip,
      created_at, last_used_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId(),
      userId,
      tokenHash,
      csrfSecret,
      String(userAgent ?? '').slice(0, 255),
      String(ip ?? '').slice(0, 64),
      now,
      now,
      now + config.sessionTtlMs,
    ],
  );

  return { token, csrfSecret, expiresAt: now + config.sessionTtlMs };
}

export async function resolveSession(token) {
  if (!token || typeof token !== 'string' || token.length < 20) return null;
  const tokenHash = hash(token);

  const cached = await cache.get(sessionCacheKey(tokenHash));
  if (cached && cached.expiresAt > Date.now()) return cached;

  const row = await getDb().get(
    `SELECT s.id, s.user_id, s.csrf_secret, s.expires_at, s.revoked_at
     FROM sessions s WHERE s.token_hash = ?`,
    [tokenHash],
  );
  if (!row) return null;
  if (row.revoked_at) return null;
  if (Number(row.expires_at) <= Date.now()) return null;

  const session = {
    id: row.id,
    userId: row.user_id,
    csrfSecret: row.csrf_secret,
    expiresAt: Number(row.expires_at),
    tokenHash,
  };
  // Short TTL: an admin revoking a session takes effect within 30 seconds.
  await cache.set(sessionCacheKey(tokenHash), session, 30);
  return session;
}

export async function touchSession(sessionId, ip) {
  await getDb().run('UPDATE sessions SET last_used_at = ?, ip = ? WHERE id = ?', [
    Date.now(),
    String(ip ?? '').slice(0, 64),
    sessionId,
  ]);
}

export async function revokeSession(sessionId) {
  const row = await getDb().get('SELECT token_hash FROM sessions WHERE id = ?', [sessionId]);
  await getDb().run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [Date.now(), sessionId]);
  if (row) await cache.del(sessionCacheKey(row.token_hash));
}

export async function revokeSessionByToken(token) {
  if (!token) return;
  const tokenHash = hash(token);
  await getDb().run('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?', [Date.now(), tokenHash]);
  await cache.del(sessionCacheKey(tokenHash));
}

/** Used on password change, account disable and admin "force logout". */
export async function revokeAllSessions(userId, { exceptSessionId = null } = {}) {
  const db = getDb();
  const rows = await db.all(
    'SELECT id, token_hash FROM sessions WHERE user_id = ? AND revoked_at IS NULL',
    [userId],
  );
  const targets = rows.filter((row) => row.id !== exceptSessionId);
  if (!targets.length) return 0;

  for (const row of targets) {
    await db.run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [Date.now(), row.id]);
  }
  await cache.del(...targets.map((row) => sessionCacheKey(row.token_hash)));
  return targets.length;
}

export async function listSessions(userId) {
  const rows = await getDb().all(
    `SELECT id, user_agent, ip, created_at, last_used_at, expires_at, revoked_at
     FROM sessions WHERE user_id = ? ORDER BY last_used_at DESC LIMIT 50`,
    [userId],
  );
  return rows.map((row) => ({
    id: row.id,
    userAgent: row.user_agent,
    ip: row.ip,
    createdAt: Number(row.created_at),
    lastUsedAt: Number(row.last_used_at),
    expiresAt: Number(row.expires_at),
    active: !row.revoked_at && Number(row.expires_at) > Date.now(),
  }));
}

/** Periodic housekeeping so the table does not grow without bound. */
export async function purgeExpiredSessions() {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const result = await getDb().run(
    'DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)',
    [Date.now(), cutoff],
  );
  return result.changes;
}

/**
 * Double-submit CSRF token derived from the session's secret. The cookie holds
 * the token, the header must echo it, and only a holder of the session secret
 * can produce a valid pair.
 */
export function csrfTokenFor(csrfSecret) {
  return csrfTokenForKey(csrfSecret, config.secret);
}

export function csrfMatches(csrfSecret, presented) {
  if (!presented || typeof presented !== 'string') return false;
  const actual = Buffer.from(presented);
  return [config.secret, ...config.previousSecrets].some((key) => {
    const expected = Buffer.from(csrfTokenForKey(csrfSecret, key));
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  });
}

function csrfTokenForKey(csrfSecret, key) {
  return crypto.createHmac('sha256', key).update(csrfSecret).digest('base64url');
}
