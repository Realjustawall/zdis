import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { getSettings } from './settings.js';
import { logger } from '../lib/logger.js';
import { scanBuffer } from './antivirus.js';
import {
  deleteObject,
  localObjectPath,
  localObjectStream,
  saveObject,
} from './storage.js';
import { uploadsStored } from './metrics.js';
import { inspectDlp } from './dlp.js';
import {
  commitReservation,
  releaseReservation,
  releaseStoredBytes,
  reserveStorage,
} from './storageQuota.js';
import { enqueue } from '../jobs/queue.js';

/**
 * Allow-list of accepted types. Anything not listed here is rejected, so a
 * `.svg` (scriptable), `.html`, `.exe` or a renamed shell script never lands
 * on disk. Extensions are derived from the type we detect, not from the name
 * the client sent.
 */
export const ALLOWED_TYPES = {
  'image/png': { ext: 'png', category: 'image' },
  'image/jpeg': { ext: 'jpg', category: 'image' },
  'image/gif': { ext: 'gif', category: 'image' },
  'image/webp': { ext: 'webp', category: 'image' },
  'image/bmp': { ext: 'bmp', category: 'image' },
  'video/mp4': { ext: 'mp4', category: 'video' },
  'video/webm': { ext: 'webm', category: 'video' },
  'video/quicktime': { ext: 'mov', category: 'video' },
  'audio/mpeg': { ext: 'mp3', category: 'audio' },
  'audio/ogg': { ext: 'ogg', category: 'audio' },
  'audio/wav': { ext: 'wav', category: 'audio' },
  'audio/webm': { ext: 'weba', category: 'audio' },
  'application/pdf': { ext: 'pdf', category: 'document' },
  'application/zip': { ext: 'zip', category: 'document' },
  'text/plain': { ext: 'txt', category: 'document' },
  'application/json': { ext: 'json', category: 'document' },
  'application/vnd.zdis.encrypted': { ext: 'zdis', category: 'document' },
};

const CATEGORY_SETTING = {
  image: 'allow_image_uploads',
  video: 'allow_video_uploads',
  audio: 'allow_audio_uploads',
  document: 'allow_document_uploads',
};

/**
 * Magic-byte signatures. The browser-supplied Content-Type is advisory only —
 * we sniff the real bytes and refuse anything that disagrees.
 */
const SIGNATURES = [
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/bmp', bytes: [0x42, 0x4d] },
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
  { mime: 'application/zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { mime: 'audio/mpeg', bytes: [0x49, 0x44, 0x33] },
  { mime: 'audio/mpeg', bytes: [0xff, 0xfb] },
  { mime: 'audio/wav', bytes: [0x52, 0x49, 0x46, 0x46], at8: [0x57, 0x41, 0x56, 0x45] },
  { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46], at8: [0x57, 0x45, 0x42, 0x50] },
];

function matches(buffer, signature) {
  if (buffer.length < signature.bytes.length) return false;
  for (let i = 0; i < signature.bytes.length; i += 1) {
    if (buffer[i] !== signature.bytes[i]) return false;
  }
  if (signature.at8) {
    if (buffer.length < 8 + signature.at8.length) return false;
    for (let i = 0; i < signature.at8.length; i += 1) {
      if (buffer[8 + i] !== signature.at8[i]) return false;
    }
  }
  return true;
}

/** Returns the detected mime, or null when the bytes match nothing known. */
export function sniffMime(buffer, declared) {
  if (declared === 'application/vnd.zdis.encrypted' &&
      buffer.length > 8 && buffer.subarray(0, 8).toString('ascii') === 'ZDISENC1') {
    return declared;
  }
  for (const signature of SIGNATURES) {
    if (matches(buffer, signature)) return signature.mime;
  }

  // Container formats without a fixed prefix.
  if (buffer.length > 12) {
    const brand = buffer.subarray(4, 8).toString('latin1');
    if (brand === 'ftyp') {
      const sub = buffer.subarray(8, 12).toString('latin1');
      if (sub.startsWith('qt')) return 'video/quicktime';
      return 'video/mp4';
    }
  }
  if (buffer.length > 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    // Matroska/WebM: audio-only files declare audio/webm.
    return declared === 'audio/webm' ? 'audio/webm' : 'video/webm';
  }
  if (buffer.length > 4 && buffer.subarray(0, 4).toString('latin1') === 'OggS') return 'audio/ogg';

  // Text-ish payloads: accept only if they really are UTF-8 without NULs.
  if ((declared === 'text/plain' || declared === 'application/json') && isProbablyText(buffer)) {
    return declared;
  }
  return null;
}

function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (sample.includes(0x00)) return false;
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(sample);
  return !decoded.includes('�');
}

export const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.maxUploadBytes,
    files: 1,
    fields: 6,
    parts: 8,
  },
});

/** Random on-disk name; the original never touches the filesystem path. */
function storedNameFor(ext) {
  return `${crypto.randomBytes(20).toString('hex')}.${ext}`;
}

export async function storeUpload({
  file,
  uploaderId,
  reservationId = null,
  kind = 'file',
  durationMs = null,
}) {
  const settings = await getSettings();
  if (!settings.uploads_enabled) throw forbidden('File uploads are disabled by the administrator.');

  const maxBytes = settings.upload_limit_enabled
    ? Math.min(config.maxUploadBytes, settings.max_upload_mb * 1024 * 1024)
    : config.maxUploadBytes;
  if (!file) throw badRequest('No file received.');
  if (file.size === 0) throw badRequest('File is empty.');
  if (file.size > maxBytes) {
    const label = settings.upload_limit_enabled ? `${settings.max_upload_mb} MB` : `${Math.round(config.maxUploadBytes / 1024 / 1024)} MB infrastructure safety`;
    throw badRequest(`File exceeds the ${label} limit.`);
  }
  const activeReservation = reservationId ?? (await reserveStorage(uploaderId, file.size));

  try {
    const declared = String(file.mimetype || '').split(';')[0].trim().toLowerCase();
    const detected = sniffMime(file.buffer, declared);
    if (!detected) throw badRequest('That file type is not supported.');

    const spec = ALLOWED_TYPES[detected];
    if (!spec) throw badRequest('That file type is not supported.');
    if (kind === 'voice' && spec.category !== 'audio') {
      throw badRequest('Voice messages must contain audio.');
    }

    const categoryFlag = CATEGORY_SETTING[spec.category];
    if (categoryFlag && !settings[categoryFlag]) {
      throw forbidden(`${spec.category} uploads are disabled by the administrator.`);
    }

    if (detected === 'text/plain' || detected === 'application/json') {
      await inspectDlp(file.buffer, { source: 'attachment', actorId: uploaderId });
    }
    const scan = await scanBuffer(file.buffer);
    const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
    const storedName = storedNameFor(spec.ext);
    const stored = await saveObject({
      storedName,
      buffer: file.buffer,
      mime: detected,
      sha256,
    });

    const dimensions = spec.category === 'image' ? readImageSize(file.buffer, detected) : null;

    const id = newId();
    try {
      await getDb().run(
      `INSERT INTO attachments (
        id, message_id, uploader_id, filename, stored_name, mime, size, width,
        height, duration_ms, kind, storage_provider, storage_key, sha256, scan_status, processing_status,
        retention_until, last_scanned_at, created_at
       ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        uploaderId,
        safeFilename(file.originalname, spec.ext),
        storedName,
        detected,
        file.size,
        dimensions?.width ?? null,
        dimensions?.height ?? null,
        kind === 'voice' ? Math.max(0, Number(durationMs ?? 0)) : null,
        kind === 'voice' ? 'voice' : 'file',
        stored.provider,
        stored.key,
        sha256,
        scan.status,
        ['image', 'video', 'audio'].includes(spec.category) ? 'queued' : 'complete',
        config.uploadRetentionDays > 0
          ? Date.now() + config.uploadRetentionDays * 24 * 3600_000
          : null,
        Date.now(),
        Date.now(),
      ],
    );
    } catch (error) {
      await deleteObject({ stored_name: storedName, storage_provider: stored.provider, storage_key: stored.key })
        .catch(() => {});
      throw error;
    }

    await commitReservation(activeReservation);
    if (['image', 'video', 'audio'].includes(spec.category)) {
      await enqueue('media.process', { attachmentId: id }).catch((error) => {
        logger.warn('media processing enqueue failed', { id, error: error.message });
      });
    }
    uploadsStored.inc({ provider: stored.provider, scan_status: scan.status });
    return getDb().get('SELECT * FROM attachments WHERE id = ?', [id]);
  } catch (error) {
    await releaseReservation(activeReservation).catch(() => {});
    throw error;
  }
}

/**
 * Keeps a readable name for the download prompt while stripping anything that
 * could traverse directories or fake an extension.
 */
const UNSAFE_NAME_CHARS = new RegExp('[\\u0000-\\u001f\\u007f<>:"/\\\\|?*]+', 'g');

export function safeFilename(original, expectedExt) {
  const base = path
    .basename(String(original ?? 'file'))
    .replace(UNSAFE_NAME_CHARS, '_')
    .replace(/^\.+/, '')
    .slice(0, 96)
    .trim();
  const withoutExt = base.replace(/\.[a-z0-9]{1,8}$/i, '') || 'file';
  return `${withoutExt}.${expectedExt}`;
}

/** Minimal dimension readers so the client can reserve layout space. */
function readImageSize(buffer, mime) {
  try {
    if (mime === 'image/png' && buffer.length > 24) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (mime === 'image/gif' && buffer.length > 10) {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
    if (mime === 'image/bmp' && buffer.length > 26) {
      return { width: buffer.readInt32LE(18), height: Math.abs(buffer.readInt32LE(22)) };
    }
    if (mime === 'image/jpeg') return readJpegSize(buffer);
  } catch {
    /* dimensions are a nicety, never a failure condition */
  }
  return null;
}

function readJpegSize(buffer) {
  let offset = 2;
  while (offset < buffer.length - 9) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    // SOF0..SOF15, excluding the non-frame markers.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

export async function getAttachment(attachmentId) {
  return getDb().get('SELECT * FROM attachments WHERE id = ?', [attachmentId]);
}

export function attachmentPath(attachment) {
  return localObjectPath(attachment.stored_name);
}

export function attachmentStream(attachment, range) {
  if ((attachment.storage_provider ?? 'local') !== 'local') {
    throw notFound('That file is stored remotely.');
  }
  return localObjectStream(attachment, range);
}

export async function deleteAttachments(attachments) {
  for (const attachment of attachments) {
    try {
      await deleteObject(attachment);
    } catch (error) {
      if (error.code !== 'ENOENT') logger.warn('failed to unlink attachment', { id: attachment.id });
    }
    await releaseStoredBytes(attachment.uploader_id, Number(attachment.size)).catch(() => {});
  }
  if (attachments.length) {
    const ids = attachments.map((a) => a.id);
    await getDb().run(
      `DELETE FROM attachments WHERE id IN (${ids.map(() => '?').join(', ')})`,
      ids,
    );
  }
}

/**
 * Uploads that were never attached to a message are dead weight — and a place
 * to stash data. Cleared after an hour.
 */
export async function purgeOrphanAttachments() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  const rows = await getDb().all(
    `SELECT a.* FROM attachments a
     WHERE a.message_id IS NULL AND a.created_at < ?
       AND NOT EXISTS (
         SELECT 1 FROM users u WHERE u.avatar_url = '/api/files/' || a.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM chat_groups g WHERE g.icon_url = '/api/files/' || a.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM group_expressions e WHERE e.attachment_id = a.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM server_roles r WHERE r.icon_attachment_id = a.id
       )
     LIMIT 200`,
    [cutoff],
  );
  if (rows.length) await deleteAttachments(rows);
  return rows.length;
}
