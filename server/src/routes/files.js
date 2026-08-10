import fs from 'node:fs';
import express from 'express';
import { asyncRoute, badRequest, forbidden, notFound } from '../lib/errors.js';
import { parse, idSchema, z } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { uploadLimiter } from '../middleware/rateLimit.js';
import {
  memoryUpload,
  storeUpload,
  getAttachment,
  attachmentPath,
  ALLOWED_TYPES,
} from '../services/uploads.js';
import { toAttachment, getMessage } from '../services/messages.js';
import { getSettings } from '../services/settings.js';
import { getChannel } from '../services/groups.js';
import { groupContext, canAccessChannel, isConversationMember } from '../services/permissions.js';
import { channelPermission } from '../services/channelPermissions.js';
import { audit } from '../services/audit.js';
import { clientIp } from '../middleware/auth.js';
import { authorizedObjectUrl, readObjectBuffer } from '../services/storage.js';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { getQuota } from '../services/storageQuota.js';
import { can, CAPABILITIES } from '../services/capabilities.js';
import {
  cancelResumableUpload,
  completeResumableUpload,
  createResumableUpload,
  getResumableUpload,
  writeResumablePart,
} from '../services/resumableUploads.js';

export const filesRouter = express.Router();
filesRouter.use(requireAuth);

filesRouter.get(
  '/limits',
  asyncRoute(async (_req, res) => {
    const settings = await getSettings();
    return res.json({
      enabled: settings.uploads_enabled,
      limitEnabled: settings.upload_limit_enabled,
      maxBytes: settings.upload_limit_enabled ? settings.max_upload_mb * 1024 * 1024 : config.maxUploadBytes,
      maxMb: settings.upload_limit_enabled ? settings.max_upload_mb : null,
      accept: Object.keys(ALLOWED_TYPES),
      resumable: true,
      chunkBytes: config.resumableChunkBytes,
      quota: await getQuota(_req.user.id),
    });
  }),
);

filesRouter.get(
  '/quota',
  asyncRoute(async (req, res) => res.json({ quota: await getQuota(req.user.id) })),
);

filesRouter.post(
  '/resumable',
  uploadLimiter,
  asyncRoute(async (req, res) => {
    const body = parse(
      z.object({
        filename: z.string().trim().min(1).max(120),
        mime: z.string().trim().min(1).max(120),
        size: z.number().int().positive(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional().nullable(),
      }),
      req.body,
    );
    const upload = await createResumableUpload({
      userId: req.user.id,
      filename: body.filename,
      declaredMime: body.mime,
      totalSize: body.size,
      expectedSha256: body.sha256,
    });
    return res.status(201).json({ upload });
  }),
);

filesRouter.get(
  '/:attachmentId/:variant(preview|optimized)',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.attachmentId);
    const attachment = await getAttachment(id);
    if (!attachment || attachment.quarantined_at || attachment.scan_status === 'infected') {
      throw notFound('File not found.');
    }
    if (!(await canReadAttachment(attachment, req.user))) throw notFound('File not found.');
    const prefix = req.params.variant === 'preview' ? 'preview' : 'derived';
    const provider = attachment[`${prefix}_provider`];
    const key = attachment[`${prefix}_key`];
    const mime = attachment[`${prefix}_mime`];
    if (!provider || !key || !mime) throw notFound('File variant not found.');
    if (provider === 's3') {
      const url = await authorizedObjectUrl(
        { storage_provider: 's3', storage_key: key, stored_name: key },
        { contentType: mime, contentDisposition: 'inline' },
      );
      return res.redirect(302, url);
    }
    const target = attachmentPath({ stored_name: key });
    if (!fs.existsSync(target)) throw notFound('File variant not found.');
    res.setHeader('Content-Type', mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, max-age=86400');
    return fs.createReadStream(target).pipe(res);
  }),
);

filesRouter.get(
  '/resumable/:uploadId',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.uploadId);
    const upload = await getResumableUpload(id, req.user.id);
    if (!upload) throw notFound('Upload not found.');
    return res.json({ upload });
  }),
);

filesRouter.put(
  '/resumable/:uploadId/parts/:partNumber',
  uploadLimiter,
  express.raw({ type: 'application/octet-stream', limit: config.resumableChunkBytes }),
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.uploadId);
    const partNumber = parse(
      z.coerce.number().int().positive().max(100000),
      req.params.partNumber,
    );
    if (!Buffer.isBuffer(req.body)) throw badRequest('Part body must be application/octet-stream.');
    const part = await writeResumablePart({
      id,
      userId: req.user.id,
      partNumber,
      buffer: req.body,
      sha256: req.get('content-sha256') ?? null,
    });
    return res.json({ part });
  }),
);

filesRouter.post(
  '/resumable/:uploadId/complete',
  uploadLimiter,
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.uploadId);
    const attachment = await completeResumableUpload(id, req.user.id);
    await audit({
      actorId: req.user.id,
      action: 'file.resumable_completed',
      targetType: 'attachment',
      targetId: attachment.id,
      meta: { mime: attachment.mime, size: Number(attachment.size) },
      ip: clientIp(req),
    });
    return res.status(201).json({ attachment: toAttachment(attachment) });
  }),
);

filesRouter.delete(
  '/resumable/:uploadId',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.uploadId);
    await cancelResumableUpload(id, req.user.id);
    return res.json({ ok: true });
  }),
);

/**
 * Two-step upload: the file is stored unattached, then the returned id is
 * passed to POST /messages. Orphans are swept hourly.
 */
filesRouter.post(
  '/voice',
  uploadLimiter,
  asyncRoute(async (req, res, next) => {
    const settings = await getSettings();
    if (!settings.uploads_enabled) {
      throw forbidden('Voice messages are disabled because uploads are disabled.');
    }
    return memoryUpload.single('file')(req, res, (error) => {
      if (error) return next(error);
      const durationMs = Number(req.body?.durationMs ?? 0);
      if (!Number.isFinite(durationMs) || durationMs < 250 || durationMs > 20 * 60_000) {
        return next(badRequest('Voice messages must be between 0.25 seconds and 20 minutes.'));
      }
      return storeUpload({
        file: req.file,
        uploaderId: req.user.id,
        kind: 'voice',
        durationMs: Math.round(durationMs),
      })
        .then((attachment) => {
          res.status(201).json({ attachment: toAttachment(attachment) });
        })
        .catch(next);
    });
  }),
);

filesRouter.post(
  '/',
  uploadLimiter,
  asyncRoute(async (req, res, next) => {
    const settings = await getSettings();
    if (!settings.uploads_enabled) {
      throw forbidden('File uploads are disabled by the administrator.');
    }
    return memoryUpload.single('file')(req, res, (error) => {
      if (error) return next(error);
      return storeUpload({ file: req.file, uploaderId: req.user.id })
        .then(async (attachment) => {
          await audit({
            actorId: req.user.id,
            action: 'file.upload',
            targetType: 'attachment',
            targetId: attachment.id,
            meta: { mime: attachment.mime, size: Number(attachment.size) },
            ip: clientIp(req),
          });
          res.status(201).json({ attachment: toAttachment(attachment) });
        })
        .catch(next);
    });
  }),
);

/**
 * Authorised download. Files are never served statically — the caller must be
 * able to read the message the attachment belongs to (or be its uploader,
 * while it is still unattached).
 */
filesRouter.get(
  '/:attachmentId',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.attachmentId);
    const attachment = await getAttachment(id);
    if (!attachment) throw notFound('File not found.');
    if (attachment.quarantined_at || attachment.scan_status === 'infected') {
      throw notFound('File not found.');
    }

    if (!(await canReadAttachment(attachment, req.user))) throw notFound('File not found.');

    const isInline = attachment.mime.startsWith('image/') ||
      attachment.mime.startsWith('video/') ||
      attachment.mime.startsWith('audio/');
    const disposition =
      `${isInline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`;

    // Encrypted attachments must be readable by Web Crypto in the browser.
    // Proxying their already-encrypted bytes also avoids requiring storage-bucket
    // CORS access; the server still never possesses the decryption key.
    if (attachment.mime === 'application/vnd.zdis.encrypted') {
      const bytes = await readObjectBuffer(attachment);
      res.setHeader('Content-Type', attachment.mime);
      res.setHeader('Content-Disposition', disposition);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.send(bytes);
    }

    if ((attachment.storage_provider ?? 'local') === 's3') {
      const url = await authorizedObjectUrl(attachment, {
        contentType: attachment.mime,
        contentDisposition: disposition,
      });
      if (!url) throw notFound('File not found.');
      res.setHeader('Cache-Control', 'private, no-store');
      return res.redirect(302, url);
    }

    const target = attachmentPath(attachment);
    if (!fs.existsSync(target)) throw notFound('File not found.');
    const stat = fs.statSync(target);

    // Even for inline media, lock the response down: no sniffing, no scripts,
    // and a sandboxed CSP so a crafted file cannot execute in our origin.
    res.setHeader('Content-Type', attachment.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox; frame-ancestors 'none'");
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader(
      'Content-Disposition',
      disposition,
    );

    // Range support so video and audio can seek.
    const range = req.headers.range;
    if (range && isInline) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (match) {
        let start;
        let end;
        if (!match[1] && match[2]) {
          const suffixLength = Number(match[2]);
          if (!suffixLength) {
            res.setHeader('Content-Range', `bytes */${stat.size}`);
            return res.status(416).end();
          }
          start = Math.max(0, stat.size - suffixLength);
          end = stat.size - 1;
        } else {
          start = Number(match[1]);
          end = match[2] ? Number(match[2]) : stat.size - 1;
        }
        if (start >= stat.size || end >= stat.size || start > end) {
          res.setHeader('Content-Range', `bytes */${stat.size}`);
          return res.status(416).end();
        }
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Length', end - start + 1);
        return fs.createReadStream(target, { start, end }).pipe(res);
      }
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      return res.status(416).end();
    }

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', stat.size);
    return fs.createReadStream(target).pipe(res);
  }),
);

async function canReadAttachment(attachment, user) {
  if (attachment.uploader_id === user.id) return true;
  if (attachment.message_id && await can(user, CAPABILITIES.MODERATE)) {
    const reported = await getDb().get(
      'SELECT 1 AS ok FROM message_reports WHERE message_id = ? LIMIT 1',
      [attachment.message_id],
    );
    if (reported) return true;
  }
  const publicAvatar = await getDb().get(
    "SELECT 1 AS ok FROM users WHERE avatar_url = '/api/files/' || ? LIMIT 1",
    [attachment.id],
  );
  if (publicAvatar) return true;
  const publicGroupIcon = await getDb().get(
    "SELECT 1 AS ok FROM chat_groups WHERE icon_url = '/api/files/' || ? LIMIT 1",
    [attachment.id],
  );
  if (publicGroupIcon) return true;
  const expressionAccess = await getDb().get(
    `SELECT 1 AS ok FROM group_expressions e
     JOIN group_members gm ON gm.group_id = e.group_id AND gm.user_id = ?
     WHERE e.attachment_id = ? LIMIT 1`,
    [user.id, attachment.id],
  );
  if (expressionAccess) return true;
  const roleIconAccess = await getDb().get(
    `SELECT 1 AS ok FROM server_roles r
     JOIN group_members gm ON gm.group_id = r.group_id AND gm.user_id = ?
     WHERE r.icon_attachment_id = ? LIMIT 1`,
    [user.id, attachment.id],
  );
  if (roleIconAccess) return true;
  const expressionMessages = await getDb().all(
    `SELECT m.* FROM message_expressions me
     JOIN messages m ON m.id = me.message_id
     WHERE me.attachment_id = ? AND m.deleted_at IS NULL
     ORDER BY m.created_at DESC LIMIT 25`,
    [attachment.id],
  );
  for (const message of expressionMessages) {
    if (await canReadFileMessage(message, user)) return true;
  }
  if (!attachment.message_id) return false;

  const message = await getMessage(attachment.message_id);
  if (!message) return false;
  return canReadFileMessage(message, user);
}

async function canReadFileMessage(message, user) {
  if (message.channel_id) {
    const channel = await getChannel(message.channel_id);
    if (!channel) return false;
    try {
      const context = await groupContext(channel.group_id, user);
      if (!(await canAccessChannel(channel, context))) return false;
      if (channel.type === 'forum') {
        let rootId = message.id;
        for (let depth = 0; depth < 100; depth += 1) {
          const row = await getDb().get(
            'SELECT reply_to_id FROM messages WHERE id = ?',
            [rootId],
          );
          if (!row?.reply_to_id) break;
          rootId = row.reply_to_id;
        }
        const post = await getDb().get(
          'SELECT id, author_id, private FROM forum_posts WHERE root_message_id = ?',
          [rootId],
        );
        if (post?.private && post.author_id !== user.id && !context.permissionBypass) {
          const canManage =
            (await channelPermission(channel, context, 'manageThreads')) ||
            Boolean(
              await getDb().get(
                'SELECT 1 AS ok FROM forum_post_members WHERE post_id = ? AND user_id = ?',
                [post.id, user.id],
              ),
            );
          if (!canManage) return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  if (message.conversation_id) {
    return isConversationMember(message.conversation_id, user.id);
  }
  return false;
}

filesRouter.use((error, _req, res, next) => {
  if (error?.code === 'LIMIT_UNEXPECTED_FILE') {
    return next(badRequest('Unexpected field — send the file as `file`.'));
  }
  return next(error);
});
