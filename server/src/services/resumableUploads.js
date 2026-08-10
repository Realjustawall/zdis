import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { reserveStorage, releaseReservation } from './storageQuota.js';
import { storeUpload } from './uploads.js';
import { getSettings } from './settings.js';

function uploadDir(id) {
  return path.join(config.dataDir, 'resumable', id);
}

function partPath(id, number) {
  return path.join(uploadDir(id), `${String(number).padStart(8, '0')}.part`);
}

export async function createResumableUpload({
  userId,
  filename,
  declaredMime,
  totalSize,
  expectedSha256 = null,
}) {
  const settings = await getSettings();
  const maxBytes = settings.upload_limit_enabled
    ? Math.min(config.maxUploadBytes, settings.max_upload_mb * 1024 * 1024)
    : config.maxUploadBytes;
  if (totalSize <= 0 || totalSize > maxBytes) {
    throw badRequest(`Upload must be between 1 and ${maxBytes} bytes.`);
  }
  const reservationId = await reserveStorage(userId, totalSize);
  const id = newId();
  const chunkSize = Math.min(config.resumableChunkBytes, totalSize);
  const totalChunks = Math.ceil(totalSize / chunkSize);
  const now = Date.now();
  try {
    await fs.mkdir(uploadDir(id), { recursive: true, mode: 0o700 });
    await getDb().run(
      `INSERT INTO resumable_uploads
         (id, user_id, reservation_id, filename, declared_mime, total_size,
          chunk_size, total_chunks, expected_sha256, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?, ?)`,
      [
        id,
        userId,
        reservationId,
        filename,
        declaredMime,
        totalSize,
        chunkSize,
        totalChunks,
        expectedSha256,
        now + 24 * 3600_000,
        now,
        now,
      ],
    );
    return getResumableUpload(id, userId);
  } catch (error) {
    await releaseReservation(reservationId);
    await fs.rm(uploadDir(id), { recursive: true, force: true });
    throw error;
  }
}

export async function getResumableUpload(id, userId) {
  const row = await getDb().get(
    'SELECT * FROM resumable_uploads WHERE id = ? AND user_id = ?',
    [id, userId],
  );
  if (!row) return null;
  const parts = await getDb().all(
    'SELECT part_number, size, sha256 FROM resumable_parts WHERE upload_id = ? ORDER BY part_number',
    [id],
  );
  return {
    id: row.id,
    filename: row.filename,
    declaredMime: row.declared_mime,
    totalSize: Number(row.total_size),
    chunkSize: Number(row.chunk_size),
    totalChunks: Number(row.total_chunks),
    expectedSha256: row.expected_sha256,
    status: row.status,
    attachmentId: row.attachment_id,
    expiresAt: Number(row.expires_at),
    receivedParts: parts.map((part) => ({
      number: Number(part.part_number),
      size: Number(part.size),
      sha256: part.sha256,
    })),
  };
}

export async function writeResumablePart({ id, userId, partNumber, buffer, sha256 }) {
  const db = getDb();
  const upload = await db.get(
    `SELECT * FROM resumable_uploads
     WHERE id = ? AND user_id = ? AND status = 'uploading' AND expires_at > ?`,
    [id, userId, Date.now()],
  );
  if (!upload) throw notFound('Active upload not found.');
  if (partNumber < 1 || partNumber > Number(upload.total_chunks)) {
    throw badRequest('Part number is outside the upload range.');
  }
  const expectedSize =
    partNumber === Number(upload.total_chunks)
      ? Number(upload.total_size) - Number(upload.chunk_size) * (partNumber - 1)
      : Number(upload.chunk_size);
  if (buffer.length !== expectedSize) {
    throw badRequest(`Part ${partNumber} must contain exactly ${expectedSize} bytes.`);
  }
  const actualHash = crypto.createHash('sha256').update(buffer).digest('hex');
  if (sha256 && actualHash !== sha256.toLowerCase()) throw badRequest('Part checksum mismatch.');
  const existing = await db.get(
    'SELECT sha256 FROM resumable_parts WHERE upload_id = ? AND part_number = ?',
    [id, partNumber],
  );
  if (existing && existing.sha256 !== actualHash) {
    throw conflict('That part was already uploaded with different content.');
  }
  if (!existing) {
    await fs.writeFile(partPath(id, partNumber), buffer, { flag: 'wx', mode: 0o600 });
    await db.run(
      `INSERT INTO resumable_parts (upload_id, part_number, size, sha256, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [id, partNumber, buffer.length, actualHash, Date.now()],
    );
  }
  await db.run('UPDATE resumable_uploads SET updated_at = ? WHERE id = ?', [Date.now(), id]);
  return { partNumber, size: buffer.length, sha256: actualHash };
}

export async function completeResumableUpload(id, userId) {
  const db = getDb();
  const upload = await db.get(
    `SELECT * FROM resumable_uploads
     WHERE id = ? AND user_id = ? AND status = 'uploading'`,
    [id, userId],
  );
  if (!upload) throw notFound('Active upload not found.');
  const parts = await db.all(
    'SELECT part_number FROM resumable_parts WHERE upload_id = ? ORDER BY part_number',
    [id],
  );
  if (parts.length !== Number(upload.total_chunks)) throw badRequest('Upload is incomplete.');
  const claimed = await db.run(
    `UPDATE resumable_uploads SET status = 'assembling', updated_at = ?
     WHERE id = ? AND status = 'uploading'`,
    [Date.now(), id],
  );
  if (!claimed.changes) throw conflict('Upload is already being completed.');
  try {
    const buffers = [];
    for (let number = 1; number <= Number(upload.total_chunks); number += 1) {
      buffers.push(await fs.readFile(partPath(id, number)));
    }
    const buffer = Buffer.concat(buffers);
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    if (upload.expected_sha256 && hash !== upload.expected_sha256.toLowerCase()) {
      throw badRequest('Complete upload checksum mismatch.');
    }
    const attachment = await storeUpload({
      uploaderId: userId,
      reservationId: upload.reservation_id,
      file: {
        buffer,
        size: buffer.length,
        originalname: upload.filename,
        mimetype: upload.declared_mime,
      },
    });
    await db.run(
      `UPDATE resumable_uploads
       SET status = 'completed', attachment_id = ?, updated_at = ? WHERE id = ?`,
      [attachment.id, Date.now(), id],
    );
    await fs.rm(uploadDir(id), { recursive: true, force: true });
    return attachment;
  } catch (error) {
    await db.run(
      "UPDATE resumable_uploads SET status = 'failed', updated_at = ? WHERE id = ?",
      [Date.now(), id],
    );
    throw error;
  }
}

export async function cancelResumableUpload(id, userId) {
  const upload = await getDb().get(
    `SELECT * FROM resumable_uploads
     WHERE id = ? AND user_id = ? AND status IN ('uploading', 'failed')`,
    [id, userId],
  );
  if (!upload) throw notFound('Upload not found.');
  await getDb().run(
    "UPDATE resumable_uploads SET status = 'cancelled', updated_at = ? WHERE id = ?",
    [Date.now(), id],
  );
  await releaseReservation(upload.reservation_id);
  await fs.rm(uploadDir(id), { recursive: true, force: true });
}

export async function purgeExpiredResumableUploads() {
  const rows = await getDb().all(
    `SELECT id, user_id FROM resumable_uploads
     WHERE status IN ('uploading', 'failed') AND expires_at <= ? LIMIT 200`,
    [Date.now()],
  );
  for (const row of rows) await cancelResumableUpload(row.id, row.user_id);
  return rows.length;
}
