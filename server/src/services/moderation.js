import crypto from 'node:crypto';
import { getDb, likeClause, likeValue } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { badRequest, notFound } from '../lib/errors.js';
import { invalidateUser } from './users.js';
import { config } from '../config.js';

export async function createReport({ messageId, reporterId, reason, details = null, decryptedEvidence = null }) {
  const message = await getDb().get(
    'SELECT id, author_id, content, type, created_at FROM messages WHERE id = ?',
    [messageId],
  );
  if (!message) throw notFound('Message not found.');
  if (message.author_id === reporterId) throw badRequest('You cannot report your own message.');
  const existing = await getDb().get(
    `SELECT id FROM message_reports
     WHERE message_id = ? AND reporter_id = ? AND status IN ('open', 'reviewing')`,
    [messageId, reporterId],
  );
  if (existing) throw badRequest('You already reported this message.');
  const id = newId();
  const now = Date.now();
  const priority = ['violence', 'malware'].includes(reason) ? 'high' : 'normal';
  const slaDueAt = now + (priority === 'high' ? 4 : 24) * 60 * 60_000;
  const attachments = await getDb().all(
    `SELECT id, filename, mime, size, sha256 FROM attachments WHERE message_id = ?`,
    [messageId],
  );
  const disclosedContent = message.type === 'encrypted' && decryptedEvidence
    ? String(decryptedEvidence).slice(0, 65_536)
    : message.content;
  const snapshot = {
    messageId,
    authorId: message.author_id,
    content: disclosedContent,
    messageCreatedAt: Number(message.created_at),
    attachments,
  };
  const evidenceHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(snapshot))
    .digest('hex');
  await getDb().tx(async (tx) => {
    await tx.run(
      `INSERT INTO message_reports
        (id, message_id, reporter_id, reason, details, status, priority,
         sla_due_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      [id, messageId, reporterId, reason, details, priority, slaDueAt, now, now],
    );
    await tx.run(
      `INSERT INTO moderation_evidence
        (id, report_id, message_id, author_id, content, attachments,
         evidence_hash, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId(),
        id,
        messageId,
        message.author_id,
        disclosedContent,
        JSON.stringify(attachments),
        evidenceHash,
        now,
      ],
    );
  });
  return getDb().get('SELECT * FROM message_reports WHERE id = ?', [id]);
}

export async function createUserReport({ reportedUserId, reporterId, reason, details = null }) {
  if (reportedUserId === reporterId) throw badRequest('You cannot report yourself.');
  const target = await getDb().get('SELECT id FROM users WHERE id = ?', [reportedUserId]);
  if (!target) throw notFound('User not found.');
  const existing = await getDb().get(
    `SELECT id FROM user_reports WHERE reported_user_id = ? AND reporter_id = ? AND status IN ('open', 'reviewing')`,
    [reportedUserId, reporterId],
  );
  if (existing) throw badRequest('You already reported this user.');
  const id = newId();
  const now = Date.now();
  await getDb().run(
    `INSERT INTO user_reports
      (id, reported_user_id, reporter_id, reason, details, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
    [id, reportedUserId, reporterId, reason, details, now, now],
  );
  return getDb().get('SELECT * FROM user_reports WHERE id = ?', [id]);
}

export async function listUserReports({ status = null, search = '', limit = 100, offset = 0 }) {
  const clauses = [];
  const params = [];
  if (status) { clauses.push('r.status = ?'); params.push(status); }
  if (search) {
    clauses.push(`(${likeClause('r.reason')} OR ${likeClause('r.details')} OR ${likeClause('target.username')} OR ${likeClause('reporter.username')})`);
    const value = likeValue(search);
    params.push(value, value, value, value);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit, offset);
  const rows = await getDb().all(
    `SELECT r.*, target.username AS target_username, target.display_name AS target_display_name,
      reporter.username AS reporter_username, reviewer.username AS assigned_username
     FROM user_reports r
     JOIN users target ON target.id = r.reported_user_id
     JOIN users reporter ON reporter.id = r.reporter_id
     LEFT JOIN users reviewer ON reviewer.id = r.assigned_to
     ${where} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
    params,
  );
  return rows.map((row) => ({
    id: row.id,
    reportedUserId: row.reported_user_id,
    reportedUsername: row.target_username,
    reportedDisplayName: row.target_display_name,
    reporterId: row.reporter_id,
    reporterUsername: row.reporter_username,
    reason: row.reason,
    details: row.details ?? null,
    status: row.status,
    assignedTo: row.assigned_to ?? null,
    assignedUsername: row.assigned_username ?? null,
    resolution: row.resolution ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }));
}

export async function updateUserReport(id, { status, assignedTo, resolution }) {
  const existing = await getDb().get('SELECT * FROM user_reports WHERE id = ?', [id]);
  if (!existing) throw notFound('User report not found.');
  await getDb().run(
    `UPDATE user_reports SET status = ?, assigned_to = ?, resolution = ?, updated_at = ? WHERE id = ?`,
    [status ?? existing.status, assignedTo === undefined ? existing.assigned_to : assignedTo, resolution === undefined ? existing.resolution : resolution, Date.now(), id],
  );
  return getDb().get('SELECT * FROM user_reports WHERE id = ?', [id]);
}

export async function listReports({ status = null, search = '', limit = 100, offset = 0 }) {
  const clauses = [];
  const params = [];
  if (status) {
    clauses.push('r.status = ?');
    params.push(status);
  }
  if (search) {
    clauses.push(
      `(${likeClause('r.reason')} OR ${likeClause('r.details')} OR ${likeClause('m.content')})`,
    );
    params.push(likeValue(search), likeValue(search), likeValue(search));
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit, offset);
  const rows = await getDb().all(
    `SELECT r.*, m.content AS message_content, m.author_id,
      reporter.username AS reporter_username,
      author.username AS author_username,
      reviewer.username AS assigned_username, evidence.evidence_hash,
      evidence.content AS evidence_content, evidence.attachments AS evidence_attachments
     FROM message_reports r
     JOIN messages m ON m.id = r.message_id
     JOIN users reporter ON reporter.id = r.reporter_id
     LEFT JOIN users author ON author.id = m.author_id
     LEFT JOIN users reviewer ON reviewer.id = r.assigned_to
     LEFT JOIN moderation_evidence evidence ON evidence.report_id = r.id
     ${where}
     ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
    params,
  );
  return rows.map((row) => ({
    id: row.id,
    messageId: row.message_id,
    reporterId: row.reporter_id,
    reporterUsername: row.reporter_username,
    authorId: row.author_id,
    authorUsername: row.author_username,
    reason: row.reason,
    details: row.details ?? null,
    status: row.status,
    assignedTo: row.assigned_to ?? null,
    assignedUsername: row.assigned_username ?? null,
    resolution: row.resolution ?? null,
    priority: row.priority ?? 'normal',
    slaDueAt: row.sla_due_at ? Number(row.sla_due_at) : null,
    resolvedAt: row.resolved_at ? Number(row.resolved_at) : null,
    evidence: row.evidence_hash
      ? {
          hash: row.evidence_hash,
          content: row.evidence_content,
          attachments: safeJson(row.evidence_attachments, []),
        }
      : null,
    messagePreview: String(row.evidence_content ?? row.message_content ?? '').slice(0, 300),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }));
}

export async function updateReport(id, { status, assignedTo, resolution }) {
  const existing = await getDb().get('SELECT * FROM message_reports WHERE id = ?', [id]);
  if (!existing) throw notFound('Report not found.');
  await getDb().run(
    `UPDATE message_reports SET status = ?, assigned_to = ?, resolution = ?,
      resolved_at = ?, updated_at = ?
     WHERE id = ?`,
    [
      status ?? existing.status,
      assignedTo === undefined ? existing.assigned_to : assignedTo,
      resolution === undefined ? existing.resolution : resolution,
      ['resolved', 'dismissed'].includes(status ?? existing.status) ? Date.now() : null,
      Date.now(),
      id,
    ],
  );
  return getDb().get('SELECT * FROM message_reports WHERE id = ?', [id]);
}

export async function moderateUser({
  targetUserId,
  actorId,
  action,
  reason,
  durationMinutes = null,
  intervalSeconds = 30,
}) {
  const target = await getDb().get('SELECT * FROM users WHERE id = ?', [targetUserId]);
  if (!target) throw notFound('User not found.');
  const now = Date.now();
  let expiresAt = null;
  if (action === 'timeout') {
    expiresAt = now + durationMinutes * 60_000;
    await getDb().run(
      'UPDATE users SET suspended_until = ?, moderation_reason = ?, updated_at = ? WHERE id = ?',
      [expiresAt, reason, now, targetUserId],
    );
  } else if (action === 'untimeout') {
    await getDb().run(
      'UPDATE users SET suspended_until = NULL, moderation_reason = NULL, updated_at = ? WHERE id = ?',
      [now, targetUserId],
    );
  } else if (action === 'ban') {
    await getDb().run(
      `UPDATE users SET banned_at = ?, moderation_reason = ?, presence = 'offline',
       updated_at = ? WHERE id = ?`,
      [now, reason, now, targetUserId],
    );
  } else if (action === 'unban') {
    await getDb().run(
      'UPDATE users SET banned_at = NULL, moderation_reason = NULL, updated_at = ? WHERE id = ?',
      [now, targetUserId],
    );
  } else if (action === 'shadowban') {
    await getDb().run(
      'UPDATE users SET shadow_banned_at = ?, moderation_reason = ?, updated_at = ? WHERE id = ?',
      [now, reason, now, targetUserId],
    );
  } else if (action === 'unshadow') {
    await getDb().run(
      'UPDATE users SET shadow_banned_at = NULL, moderation_reason = NULL, updated_at = ? WHERE id = ?',
      [now, targetUserId],
    );
  } else if (action === 'slow') {
    expiresAt = now + durationMinutes * 60_000;
    await getDb().run(
      `UPDATE users SET send_interval_seconds = ?, send_restricted_until = ?,
       moderation_reason = ?, updated_at = ? WHERE id = ?`,
      [Math.max(1, Number(intervalSeconds)), expiresAt, reason, now, targetUserId],
    );
  } else if (action === 'unslow') {
    await getDb().run(
      `UPDATE users SET send_interval_seconds = 0, send_restricted_until = NULL,
       moderation_reason = NULL, updated_at = ? WHERE id = ?`,
      [now, targetUserId],
    );
  } else {
    throw badRequest('Unknown moderation action.');
  }
  const actionId = newId();
  await getDb().run(
    `INSERT INTO moderation_actions
      (id, target_user_id, actor_id, action, reason, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [actionId, targetUserId, actorId, action, reason, expiresAt, now],
  );
  await invalidateUser(targetUserId);
  return { actionId, action, expiresAt };
}

export async function createAppeal({ actionId, userId, reason }) {
  const action = await getDb().get(
    'SELECT * FROM moderation_actions WHERE id = ? AND target_user_id = ?',
    [actionId, userId],
  );
  if (!action) throw notFound('Moderation action not found.');
  if (!['ban', 'timeout', 'shadowban', 'slow'].includes(action.action)) {
    throw badRequest('This action cannot be appealed.');
  }
  const id = newId();
  const now = Date.now();
  try {
    await getDb().run(
      `INSERT INTO moderation_appeals
        (id, action_id, user_id, reason, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'open', ?, ?)`,
      [id, actionId, userId, reason, now, now],
    );
  } catch {
    throw badRequest('An appeal already exists for this action.');
  }
  return getDb().get('SELECT * FROM moderation_appeals WHERE id = ?', [id]);
}

export async function listAppeals({ status = null, userId = null, limit = 100 }) {
  const clauses = [];
  const params = [];
  if (status) {
    clauses.push('a.status = ?');
    params.push(status);
  }
  if (userId) {
    clauses.push('a.user_id = ?');
    params.push(userId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit);
  return getDb().all(
    `SELECT a.*, m.action, m.reason AS action_reason, u.username,
      reviewer.username AS reviewer_username
     FROM moderation_appeals a
     JOIN moderation_actions m ON m.id = a.action_id
     JOIN users u ON u.id = a.user_id
     LEFT JOIN users reviewer ON reviewer.id = a.reviewer_id
     ${where} ORDER BY a.created_at DESC LIMIT ?`,
    params,
  );
}

export async function decideAppeal({ id, reviewerId, status, decision }) {
  const existing = await getDb().get(
    `SELECT a.*, m.action FROM moderation_appeals a
     JOIN moderation_actions m ON m.id = a.action_id WHERE a.id = ?`,
    [id],
  );
  if (!existing) throw notFound('Appeal not found.');
  const now = Date.now();
  await getDb().tx(async (tx) => {
    await tx.run(
      `UPDATE moderation_appeals SET status = ?, reviewer_id = ?, decision = ?,
       updated_at = ? WHERE id = ?`,
      [status, reviewerId, decision, now, id],
    );
    if (status === 'approved') {
      const updates = {
        ban: 'banned_at = NULL',
        timeout: 'suspended_until = NULL',
        shadowban: 'shadow_banned_at = NULL',
        slow: 'send_interval_seconds = 0, send_restricted_until = NULL',
      };
      if (updates[existing.action]) {
        await tx.run(
          `UPDATE users SET ${updates[existing.action]}, moderation_reason = NULL,
           updated_at = ? WHERE id = ?`,
          [now, existing.user_id],
        );
        await tx.run('UPDATE moderation_actions SET revoked_at = ? WHERE id = ?', [
          now,
          existing.action_id,
        ]);
      }
    }
  });
  await invalidateUser(existing.user_id);
  return getDb().get('SELECT * FROM moderation_appeals WHERE id = ?', [id]);
}

function safeJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

export function createAppealToken(userId, ttlSeconds = 30 * 24 * 3600) {
  const payload = Buffer.from(
    JSON.stringify({ userId, expiresAt: Date.now() + ttlSeconds * 1000 }),
  ).toString('base64url');
  const signature = crypto
    .createHmac('sha256', config.secret)
    .update(`appeal:${payload}`)
    .digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyAppealToken(token) {
  const [payload, signature] = String(token ?? '').split('.');
  if (!payload || !signature) return null;
  const expected = crypto
    .createHmac('sha256', config.secret)
    .update(`appeal:${payload}`)
    .digest('base64url');
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!parsed.userId || Number(parsed.expiresAt) <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}
