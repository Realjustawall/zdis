import { getDb } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { notify } from './notifications.js';

export async function recordSecurityEvent({
  userId,
  event,
  severity = 'info',
  ip = null,
  userAgent = null,
  meta = null,
  notifyUser = false,
}) {
  const row = {
    id: newId(),
    userId,
    event,
    severity,
    ip: String(ip ?? '').slice(0, 64) || null,
    userAgent: String(userAgent ?? '').slice(0, 255) || null,
    meta,
    createdAt: Date.now(),
  };
  await getDb().run(
    `INSERT INTO security_events
      (id, user_id, event, severity, ip, user_agent, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      userId,
      event,
      severity,
      row.ip,
      row.userAgent,
      meta ? JSON.stringify(meta) : null,
      row.createdAt,
    ],
  );
  if (notifyUser) {
    await notify({
      userId,
      type: 'security',
      title: securityTitle(event),
      body: securityBody(event, row.ip),
      data: { securityEventId: row.id, event, severity },
    });
  }
  return row;
}

export async function listSecurityEvents(userId, { limit = 100, before = null } = {}) {
  const params = [userId];
  let cursor = '';
  if (before) {
    cursor = 'AND id < ?';
    params.push(before);
  }
  params.push(limit);
  const rows = await getDb().all(
    `SELECT * FROM security_events WHERE user_id = ? ${cursor}
     ORDER BY id DESC LIMIT ?`,
    params,
  );
  return rows.map((row) => ({
    id: row.id,
    event: row.event,
    severity: row.severity,
    ip: row.ip,
    userAgent: row.user_agent,
    meta: safeParse(row.meta),
    acknowledgedAt: row.acknowledged_at ? Number(row.acknowledged_at) : null,
    createdAt: Number(row.created_at),
  }));
}

export async function acknowledgeSecurityEvent(userId, id) {
  return getDb().run(
    `UPDATE security_events SET acknowledged_at = ?
     WHERE id = ? AND user_id = ? AND acknowledged_at IS NULL`,
    [Date.now(), id, userId],
  );
}

export async function isNewLoginContext(userId, ip, userAgent) {
  const row = await getDb().get(
    `SELECT 1 AS known FROM sessions
     WHERE user_id = ? AND ip = ? AND user_agent = ? LIMIT 1`,
    [userId, String(ip ?? '').slice(0, 64), String(userAgent ?? '').slice(0, 255)],
  );
  return !row;
}

function securityTitle(event) {
  if (event === 'auth.new_login') return 'New sign-in';
  if (event === 'auth.recovery_code_used') return 'Recovery code used';
  if (event === 'auth.password_changed') return 'Password changed';
  if (event === 'auth.mfa_changed') return 'Two-factor authentication changed';
  return 'Security activity';
}

function securityBody(event, ip) {
  const suffix = ip ? ` IP: ${ip}` : '';
  if (event === 'auth.new_login') return `A new browser or network signed in to your account.${suffix}`;
  if (event === 'auth.recovery_code_used') return `A one-time recovery code was used.${suffix}`;
  if (event === 'auth.password_changed') return `Your account password was changed.${suffix}`;
  if (event === 'auth.mfa_changed') return `Your two-factor authentication settings changed.${suffix}`;
  return `Security-sensitive activity occurred on your account.${suffix}`;
}

function safeParse(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
