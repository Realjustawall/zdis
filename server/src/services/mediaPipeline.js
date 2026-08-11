import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import sharp from 'sharp';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { deleteObject, readObjectBuffer, saveObject } from './storage.js';
import { scanBuffer } from './antivirus.js';
import { deleteAttachments } from './uploads.js';

// Keep native image processing predictable on small servers. Heavy work runs
// in BullMQ workers, and bounded libvips caches prevent burst uploads from
// consuming all available RAM.
sharp.cache({ memory: 32, files: 0, items: 64 });
sharp.concurrency(config.mediaConcurrency);

const run = promisify(execFile);

function randomName(ext) {
  return `${crypto.randomBytes(20).toString('hex')}.${ext}`;
}

async function saveDerived(buffer, mime, ext) {
  const storedName = randomName(ext);
  const stored = await saveObject({
    storedName,
    buffer,
    mime,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  });
  return { ...stored, storedName, mime };
}

export async function processAttachment(attachmentId) {
  const db = getDb();
  const attachment = await db.get('SELECT * FROM attachments WHERE id = ?', [attachmentId]);
  if (!attachment || attachment.quarantined_at) return { skipped: true };
  await db.run("UPDATE attachments SET processing_status = 'processing' WHERE id = ?", [
    attachmentId,
  ]);
  try {
    const input = await readObjectBuffer(attachment);
    let preview = null;
    let derived = null;
    if (attachment.mime.startsWith('image/')) {
      const thumbnail = await sharp(input)
        .rotate()
        .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 78 })
        .toBuffer();
      preview = await saveDerived(thumbnail, 'image/webp', 'webp');
    } else if (attachment.mime.startsWith('video/')) {
      ({ preview, derived } = await processWithFfmpeg(input, attachment.mime, true));
    } else if (attachment.mime.startsWith('audio/')) {
      ({ derived } = await processWithFfmpeg(input, attachment.mime, false));
    }
    await db.run(
      `UPDATE attachments SET processing_status = 'complete',
       preview_provider = ?, preview_key = ?, preview_mime = ?,
       derived_provider = ?, derived_key = ?, derived_mime = ?
       WHERE id = ?`,
      [
        preview?.provider ?? null,
        preview?.key ?? null,
        preview?.mime ?? null,
        derived?.provider ?? null,
        derived?.key ?? null,
        derived?.mime ?? null,
        attachmentId,
      ],
    );
    return { attachmentId, preview: Boolean(preview), derived: Boolean(derived) };
  } catch (error) {
    await db.run("UPDATE attachments SET processing_status = 'failed' WHERE id = ?", [
      attachmentId,
    ]);
    throw error;
  }
}

async function processWithFfmpeg(input, mime, video) {
  const tempDir = await fs.mkdtemp(path.join(config.dataDir, 'media-'));
  const inputExt = mime.split('/')[1]?.replace('quicktime', 'mov') || 'bin';
  const inputPath = path.join(tempDir, `input.${inputExt}`);
  const outputPath = path.join(tempDir, video ? 'optimized.mp4' : 'optimized.ogg');
  const posterPath = path.join(tempDir, 'poster.jpg');
  try {
    await fs.writeFile(inputPath, input, { mode: 0o600 });
    if (video) {
      await run(
        'ffmpeg',
        [
          '-nostdin',
          '-y',
          '-i',
          inputPath,
          '-vf',
          "scale='min(1280,iw)':-2",
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '24',
          '-c:a',
          'aac',
          '-movflags',
          '+faststart',
          outputPath,
        ],
        { timeout: 10 * 60_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      );
      await run(
        'ffmpeg',
        ['-nostdin', '-y', '-ss', '0', '-i', inputPath, '-frames:v', '1', '-vf', 'scale=640:-2', posterPath],
        { timeout: 120_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      );
      return {
        derived: await saveDerived(await fs.readFile(outputPath), 'video/mp4', 'mp4'),
        preview: await saveDerived(await fs.readFile(posterPath), 'image/jpeg', 'jpg'),
      };
    }
    await run(
      'ffmpeg',
      ['-nostdin', '-y', '-i', inputPath, '-vn', '-c:a', 'libopus', '-b:a', '96k', outputPath],
      { timeout: 10 * 60_000, windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    return {
      derived: await saveDerived(await fs.readFile(outputPath), 'audio/ogg', 'ogg'),
      preview: null,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function variantObject(attachment, prefix) {
  const provider = attachment[`${prefix}_provider`];
  const key = attachment[`${prefix}_key`];
  if (!provider || !key) return null;
  return {
    storage_provider: provider,
    storage_key: key,
    stored_name: key,
  };
}

async function deleteVariants(attachment) {
  for (const prefix of ['preview', 'derived']) {
    const object = variantObject(attachment, prefix);
    if (object) await deleteObject(object).catch(() => {});
  }
}

export async function rescanAttachment(attachmentId) {
  const db = getDb();
  const attachment = await db.get('SELECT * FROM attachments WHERE id = ?', [attachmentId]);
  if (!attachment || attachment.quarantined_at) return { skipped: true };
  try {
    await scanBuffer(await readObjectBuffer(attachment));
    await db.run(
      "UPDATE attachments SET scan_status = 'clean', last_scanned_at = ? WHERE id = ?",
      [Date.now(), attachmentId],
    );
    return { clean: true };
  } catch (error) {
    if (error.status !== 403) throw error;
    await deleteObject(attachment).catch(() => {});
    await deleteVariants(attachment);
    await db.run(
      `UPDATE attachments SET scan_status = 'infected', quarantined_at = ?,
       processing_status = 'quarantined' WHERE id = ?`,
      [Date.now(), attachmentId],
    );
    return { clean: false, quarantined: true };
  }
}

export async function rescanDueAttachments(limit = 100) {
  const cutoff = Date.now() - config.antivirusRescanDays * 24 * 3600_000;
  const rows = await getDb().all(
    `SELECT id FROM attachments
     WHERE quarantined_at IS NULL AND (last_scanned_at IS NULL OR last_scanned_at < ?)
     ORDER BY last_scanned_at ASC LIMIT ?`,
    [cutoff, limit],
  );
  for (const row of rows) await rescanAttachment(row.id);
  return rows.length;
}

export async function purgeRetentionExpiredAttachments() {
  const rows = await getDb().all(
    `SELECT * FROM attachments
     WHERE retention_until IS NOT NULL AND retention_until <= ? LIMIT 200`,
    [Date.now()],
  );
  for (const attachment of rows) await deleteVariants(attachment);
  await deleteAttachments(rows);
  return rows.length;
}
