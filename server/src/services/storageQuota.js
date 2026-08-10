import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { newId } from '../lib/ids.js';
import { badRequest, notFound } from '../lib/errors.js';

export async function ensureQuota(userId) {
  await getDb().run(
    `INSERT INTO storage_quotas (user_id, limit_bytes, used_bytes, reserved_bytes, updated_at)
     VALUES (?, ?, 0, 0, ?)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, config.userStorageQuotaBytes, Date.now()],
  );
}

export async function getQuota(userId) {
  await ensureQuota(userId);
  const row = await getDb().get('SELECT * FROM storage_quotas WHERE user_id = ?', [userId]);
  return {
    limitBytes: Number(row.limit_bytes),
    usedBytes: Number(row.used_bytes),
    reservedBytes: Number(row.reserved_bytes),
    availableBytes: Math.max(
      0,
      Number(row.limit_bytes) - Number(row.used_bytes) - Number(row.reserved_bytes),
    ),
  };
}

export async function reserveStorage(userId, bytes, ttlMs = 24 * 3600_000) {
  await ensureQuota(userId);
  const result = await getDb().run(
    `UPDATE storage_quotas
     SET reserved_bytes = reserved_bytes + ?, updated_at = ?
     WHERE user_id = ? AND used_bytes + reserved_bytes + ? <= limit_bytes`,
    [bytes, Date.now(), userId, bytes],
  );
  if (!result.changes) throw badRequest('Your storage quota is exhausted.');
  const id = newId();
  try {
    await getDb().run(
      `INSERT INTO storage_reservations
         (id, user_id, bytes, status, expires_at, created_at)
       VALUES (?, ?, ?, 'active', ?, ?)`,
      [id, userId, bytes, Date.now() + ttlMs, Date.now()],
    );
    return id;
  } catch (error) {
    await getDb().run(
      `UPDATE storage_quotas SET reserved_bytes = reserved_bytes - ?, updated_at = ?
       WHERE user_id = ?`,
      [bytes, Date.now(), userId],
    );
    throw error;
  }
}

export async function commitReservation(id) {
  const db = getDb();
  const reservation = await db.get(
    "SELECT * FROM storage_reservations WHERE id = ? AND status = 'active'",
    [id],
  );
  if (!reservation) throw notFound('Storage reservation not found.');
  await db.tx(async (tx) => {
    const changed = await tx.run(
      "UPDATE storage_reservations SET status = 'consumed' WHERE id = ? AND status = 'active'",
      [id],
    );
    if (!changed.changes) throw notFound('Storage reservation not found.');
    await tx.run(
      `UPDATE storage_quotas
       SET reserved_bytes = reserved_bytes - ?, used_bytes = used_bytes + ?, updated_at = ?
       WHERE user_id = ?`,
      [reservation.bytes, reservation.bytes, Date.now(), reservation.user_id],
    );
  });
}

export async function releaseReservation(id) {
  const db = getDb();
  const reservation = await db.get(
    "SELECT * FROM storage_reservations WHERE id = ? AND status = 'active'",
    [id],
  );
  if (!reservation) return false;
  await db.tx(async (tx) => {
    const changed = await tx.run(
      "UPDATE storage_reservations SET status = 'released' WHERE id = ? AND status = 'active'",
      [id],
    );
    if (!changed.changes) return;
    await tx.run(
      `UPDATE storage_quotas SET reserved_bytes = reserved_bytes - ?, updated_at = ?
       WHERE user_id = ?`,
      [reservation.bytes, Date.now(), reservation.user_id],
    );
  });
  return true;
}

export async function releaseStoredBytes(userId, bytes) {
  await ensureQuota(userId);
  await getDb().run(
    `UPDATE storage_quotas
     SET used_bytes = CASE WHEN used_bytes > ? THEN used_bytes - ? ELSE 0 END, updated_at = ?
     WHERE user_id = ?`,
    [bytes, bytes, Date.now(), userId],
  );
}

export async function purgeExpiredReservations() {
  const rows = await getDb().all(
    `SELECT id FROM storage_reservations
     WHERE status = 'active' AND expires_at <= ? LIMIT 500`,
    [Date.now()],
  );
  for (const row of rows) await releaseReservation(row.id);
  return rows.length;
}

export async function reconcileStorageQuotas() {
  const rows = await getDb().all(
    `SELECT uploader_id, COALESCE(SUM(size), 0) AS used
     FROM attachments WHERE quarantined_at IS NULL GROUP BY uploader_id`,
  );
  for (const row of rows) {
    await ensureQuota(row.uploader_id);
    await getDb().run(
      'UPDATE storage_quotas SET used_bytes = ?, updated_at = ? WHERE user_id = ?',
      [Number(row.used), Date.now(), row.uploader_id],
    );
  }
  return rows.length;
}
