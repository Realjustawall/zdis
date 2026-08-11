import crypto from 'node:crypto';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { newId } from '../lib/ids.js';
import { logger } from '../lib/logger.js';

const GENESIS_HASH = '0'.repeat(64);
const SIGNATURE_VERSION = 1;
const AUDIT_LOCK_ID = 746_392_811;

function canonicalEntry(entry) {
  return JSON.stringify({
    id: entry.id,
    actorId: entry.actorId ?? null,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    meta: entry.meta ?? null,
    ip: entry.ip ?? null,
    createdAt: entry.createdAt,
    previousHash: entry.previousHash,
    signatureVersion: SIGNATURE_VERSION,
  });
}

function sign(entry) {
  const key = config.auditSigningKey || config.secret;
  return crypto.createHmac('sha256', key).update(canonicalEntry(entry)).digest('hex');
}

/**
 * Append-only, tamper-evident security trail. Every row signs the complete
 * previous row hash, so deletion, reordering and mutation are detectable.
 * PostgreSQL uses an advisory transaction lock to preserve one chain across
 * all application replicas.
 */
export async function audit({
  actorId = null,
  action,
  targetType = null,
  targetId = null,
  meta = null,
  ip = null,
}) {
  try {
    const db = getDb();
    await db.tx(async (tx) => {
      if (db.dialect === 'postgres') {
        await tx.get('SELECT pg_advisory_xact_lock(?) AS locked', [AUDIT_LOCK_ID]);
      }
      let state = await tx.get("SELECT head_hash FROM audit_chain_state WHERE id = 'main'");
      if (!state) {
        // Upgrades can already contain signed rows from the pre-head format.
        // Continue from a leaf (an entry not referenced by another entry).
        const leaf = await tx.get(
          `SELECT a.entry_hash FROM audit_logs a
           WHERE a.entry_hash IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM audit_logs child
               WHERE child.previous_hash = a.entry_hash
             )
           ORDER BY a.created_at DESC, a.id DESC LIMIT 1`,
        );
        state = { head_hash: leaf?.entry_hash ?? GENESIS_HASH };
        await tx.run(
          `INSERT INTO audit_chain_state (id, head_hash, updated_at)
           VALUES ('main', ?, ?)`,
          [state.head_hash, Date.now()],
        );
      }
      const entry = {
        id: newId(),
        actorId,
        action,
        targetType,
        targetId,
        meta,
        ip,
        createdAt: Date.now(),
        previousHash: state.head_hash,
      };
      const entryHash = sign(entry);
      await tx.run(
        `INSERT INTO audit_logs
          (id, actor_id, action, target_type, target_id, meta, ip, previous_hash,
           entry_hash, signature_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.id,
          actorId,
          action,
          targetType,
          targetId,
          meta ? JSON.stringify(meta) : null,
          ip,
          entry.previousHash,
          entryHash,
          SIGNATURE_VERSION,
          entry.createdAt,
        ],
      );
      await tx.run(
        "UPDATE audit_chain_state SET head_hash = ?, updated_at = ? WHERE id = 'main'",
        [entryHash, entry.createdAt],
      );
    });
  } catch (error) {
    // Availability is kept separate from audit integrity. Alerting receives the
    // structured error, while a logging outage does not turn into an API outage.
    logger.error('audit write failed', { action, error: error.message });
  }
}

export async function listAuditLogs({ limit = 100, offset = 0, before = null, action = null, actorId = null, search = null, includeHidden = false }) {
  const clauses = [];
  const params = [];
  if (!includeHidden) clauses.push('r.audit_log_id IS NULL');
  if (before) {
    clauses.push('a.id < ?');
    params.push(before);
  }
  if (action) {
    clauses.push('a.action = ?');
    params.push(action);
  }
  if (actorId) {
    clauses.push('a.actor_id = ?');
    params.push(actorId);
  }
  if (search) {
    clauses.push(`(LOWER(a.action) LIKE ? OR LOWER(COALESCE(u.username, '')) LIKE ? OR LOWER(COALESCE(u.display_name, '')) LIKE ? OR LOWER(COALESCE(a.meta, '')) LIKE ? OR LOWER(COALESCE(a.ip, '')) LIKE ?)`);
    const term = `%${String(search).toLowerCase()}%`;
    params.push(term, term, term, term, term);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit, offset);

  const rows = await getDb().all(
    `SELECT a.*, u.username AS actor_username, u.display_name AS actor_display_name
     FROM audit_logs a
     LEFT JOIN users u ON u.id = a.actor_id
     LEFT JOIN audit_log_redactions r ON r.audit_log_id = a.id
     ${where}
     ORDER BY a.id DESC
     LIMIT ? OFFSET ?`,
    params,
  );

  return rows.map(toAuditLog);
}

export async function countAuditLogs({ action = null, actorId = null, search = null, includeHidden = false } = {}) {
  const clauses = [];
  const params = [];
  if (!includeHidden) clauses.push('r.audit_log_id IS NULL');
  if (action) { clauses.push('a.action = ?'); params.push(action); }
  if (actorId) { clauses.push('a.actor_id = ?'); params.push(actorId); }
  if (search) {
    clauses.push(`(LOWER(a.action) LIKE ? OR LOWER(COALESCE(u.username, '')) LIKE ? OR LOWER(COALESCE(u.display_name, '')) LIKE ? OR LOWER(COALESCE(a.meta, '')) LIKE ? OR LOWER(COALESCE(a.ip, '')) LIKE ?)`);
    const term = `%${String(search).toLowerCase()}%`;
    params.push(term, term, term, term, term);
  }
  const row = await getDb().get(
    `SELECT COUNT(*) AS count FROM audit_logs a
     LEFT JOIN users u ON u.id = a.actor_id
     LEFT JOIN audit_log_redactions r ON r.audit_log_id = a.id
     ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}`,
    params,
  );
  return Number(row?.count ?? 0);
}

export async function hideAuditLog({ id, actorId, reason = null }) {
  const db = getDb();
  const existing = await db.get('SELECT id, action FROM audit_logs WHERE id = ?', [id]);
  if (!existing) return null;
  await db.run(
    `INSERT INTO audit_log_redactions (audit_log_id, redacted_by, reason, created_at)
     VALUES (?, ?, ?, ?) ON CONFLICT (audit_log_id) DO NOTHING`,
    [id, actorId, reason, Date.now()],
  );
  return existing;
}

export async function verifyAuditChain() {
  const rows = await getDb().all(
    `SELECT * FROM audit_logs WHERE entry_hash IS NOT NULL`,
  );
  const unsigned = await getDb().get(
    'SELECT COUNT(*) AS count FROM audit_logs WHERE entry_hash IS NULL',
  );
  const byPrevious = new Map();
  for (const row of rows) {
    const children = byPrevious.get(row.previous_hash) ?? [];
    children.push(row);
    byPrevious.set(row.previous_hash, children);
  }
  let previousHash = GENESIS_HASH;
  let checked = 0;
  const visited = new Set();
  while (checked < rows.length) {
    const children = byPrevious.get(previousHash) ?? [];
    if (children.length !== 1) {
      return {
        valid: false,
        checked,
        unsigned: Number(unsigned?.count ?? 0),
        brokenAt: children[0]?.id ?? null,
        reason: children.length > 1 ? 'fork' : 'missing-link',
      };
    }
    const row = children[0];
    if (visited.has(row.id)) {
      return {
        valid: false,
        checked,
        unsigned: Number(unsigned?.count ?? 0),
        brokenAt: row.id,
        reason: 'cycle',
      };
    }
    const entry = {
      id: row.id,
      actorId: row.actor_id,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      meta: row.meta ? safeParse(row.meta) : null,
      ip: row.ip,
      createdAt: Number(row.created_at),
      previousHash: row.previous_hash,
    };
    const valid =
      Number(row.signature_version) === SIGNATURE_VERSION &&
      row.previous_hash === previousHash &&
      safeEqual(row.entry_hash, sign(entry));
    if (!valid) {
      return {
        valid: false,
        checked,
        unsigned: Number(unsigned?.count ?? 0),
        brokenAt: row.id,
        reason: 'signature',
      };
    }
    visited.add(row.id);
    previousHash = row.entry_hash;
    checked += 1;
  }
  const state = await getDb().get("SELECT head_hash FROM audit_chain_state WHERE id = 'main'");
  if (state && state.head_hash !== previousHash) {
    return {
      valid: false,
      checked,
      unsigned: Number(unsigned?.count ?? 0),
      brokenAt: null,
      reason: 'head-mismatch',
    };
  }
  return {
    valid: true,
    checked,
    unsigned: Number(unsigned?.count ?? 0),
    head: previousHash,
  };
}

function toAuditLog(row) {
  return {
    id: row.id,
    action: row.action,
    actorId: row.actor_id,
    actorUsername: row.actor_username,
    actorDisplayName: row.actor_display_name,
    targetType: row.target_type,
    targetId: row.target_id,
    meta: row.meta ? safeParse(row.meta) : null,
    ip: row.ip,
    integrityProtected: Boolean(row.entry_hash),
    createdAt: Number(row.created_at),
  };
}

function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
