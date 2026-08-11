import express from 'express';
import crypto from 'node:crypto';
import { asyncRoute, badRequest, forbidden, notFound } from '../lib/errors.js';
import { parse, z, idSchema, messageContentSchema, paginationSchema } from '../lib/validate.js';
import { requireAuth, clientIp } from '../middleware/auth.js';
import { writeLimiter } from '../middleware/rateLimit.js';
import {
  createMessage,
  listMessages,
  getMessage,
  editMessage,
  deleteMessage,
  toggleReaction,
  setPinned,
  listPinned,
  searchMessages,
  markRead,
  getUnreadSummary,
  hydrateMessage,
  listAttachmentsForMessage,
} from '../services/messages.js';
import { deleteAttachments } from '../services/uploads.js';
import { getChannel } from '../services/groups.js';
import {
  activeServerTimeout,
  groupContext,
  canAccessChannel,
  isConversationMember,
} from '../services/permissions.js';
import {
  getConversation,
  getConversationMemberIds,
  touchConversation,
  syncConversationAfterMessageDeletion,
} from '../services/conversations.js';
import { getDb } from '../db/index.js';
import { cache } from '../cache/index.js';
import { emitToChannel, emitToConversation, emitToUser } from '../realtime/index.js';
import { getSettings } from '../services/settings.js';
import { audit } from '../services/audit.js';
import { notify } from '../services/notifications.js';
import { createReport } from '../services/moderation.js';
import { messagesCreated } from '../services/metrics.js';
import { inspectDlp } from '../services/dlp.js';
import { enqueue } from '../jobs/queue.js';
import {
  saveDraft,
  getDraft,
  deleteDraft,
  scheduleMessage,
  listScheduledMessages,
  cancelScheduledMessage,
  createPoll,
  updatePoll,
  getPollAnalytics,
  closePoll,
  votePoll,
  saveMessage,
  unsaveMessage,
  listSavedMessageIds,
  listThread,
} from '../services/advancedChat.js';
import { dispatchWebhookEvent, recordSyncEvent } from '../services/integrations.js';
import { searchOpenSearch } from '../services/search.js';
import { channelPermission } from '../services/channelPermissions.js';

export const messagesRouter = express.Router();
messagesRouter.use(requireAuth);

/**
 * Resolves the target of a message request and proves the caller is allowed to
 * read it. Every route below funnels through this so authorisation lives in
 * exactly one place.
 */
async function resolveTarget(req) {
  const { channelId, conversationId } = req.params;

  if (channelId) {
    const id = parse(idSchema, channelId);
    const channel = await getChannel(id);
    if (!channel) throw notFound('Channel not found.');

    const context = await groupContext(channel.group_id, req.user);
    if (!(await canAccessChannel(channel, context))) throw notFound('Channel not found.');

    return {
      kind: 'channel',
      channelId: id,
      conversationId: null,
      channel,
      context,
      canModerate: await channelPermission(channel, context, 'deleteAnyMessage'),
      canPin: await channelPermission(channel, context, 'pinMessage'),
      emit: (event, payload) => emitToChannel(id, event, payload),
      audienceIds: null,
    };
  }

  const id = parse(idSchema, conversationId);
  const conversation = await getConversation(id);
  if (!conversation) throw notFound('Conversation not found.');
  if (!(await isConversationMember(id, req.user.id))) throw notFound('Conversation not found.');

  return {
    kind: 'conversation',
    channelId: null,
    conversationId: id,
    conversation,
    context: null,
    canModerate: conversation.type === 'group_dm' && conversation.owner_id === req.user.id,
    canPin: true,
    emit: (event, payload) => emitToConversation(id, event, payload),
    audienceIds: await getConversationMemberIds(id),
  };
}

async function validateEncryptedMessage(target, userId, content) {
  if (target.kind !== 'conversation') throw badRequest('End-to-end encryption is available only in private conversations.');
  if (!/^e2ee:v1:[A-Za-z0-9_-]{20,65520}$/.test(content)) throw badRequest('Invalid encrypted message envelope.');
  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(content.slice(8), 'base64url').toString('utf8'));
  } catch {
    throw badRequest('Encrypted message envelope is not valid JSON.');
  }
  if (envelope?.v !== 1 || envelope.alg !== 'ECDH-P256+A256GCM+ES256' ||
      envelope.sender !== userId || typeof envelope.signature !== 'string' ||
      !envelope.senderPublic || !envelope.keys || typeof envelope.keys !== 'object') {
    throw badRequest('Encrypted message sender identity is invalid.');
  }
  const identity = await getDb().get('SELECT public_key FROM e2ee_identities WHERE user_id = ?', [userId]);
  if (!identity) throw badRequest('Publish an encryption identity before sending encrypted messages.');
  const published = JSON.parse(identity.public_key);
  if (published.encryption?.x !== envelope.senderPublic.encryption?.x ||
      published.encryption?.y !== envelope.senderPublic.encryption?.y ||
      published.signing?.x !== envelope.senderPublic.signing?.x ||
      published.signing?.y !== envelope.senderPublic.signing?.y) {
    throw badRequest('Encrypted message key does not match the published identity.');
  }
  try {
    const { signature, ...signedBody } = envelope;
    const signingKey = await crypto.webcrypto.subtle.importKey(
      'jwk', published.signing, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
    );
    const valid = await crypto.webcrypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, signingKey,
      Buffer.from(signature, 'base64url'), Buffer.from(JSON.stringify(signedBody), 'utf8'),
    );
    if (!valid) throw new Error('invalid signature');
  } catch {
    throw badRequest('Encrypted message signature is invalid.');
  }
  if (!target.audienceIds.every((id) => envelope.keys?.[id]?.iv && envelope.keys?.[id]?.ciphertext)) {
    throw badRequest('Encrypted message does not include every conversation participant.');
  }
}

async function validateEncryptedAttachments(attachmentIds, userId) {
  if (!attachmentIds.length) return;
  const rows = await getDb().all(
    `SELECT id, mime FROM attachments WHERE id IN (${attachmentIds.map(() => '?').join(', ')})
       AND uploader_id = ? AND message_id IS NULL`,
    [...attachmentIds, userId],
  );
  if (rows.length !== attachmentIds.length ||
      rows.some((row) => row.mime !== 'application/vnd.zdis.encrypted')) {
    throw badRequest('End-to-end encrypted messages may contain only encrypted attachments.');
  }
}

async function forumPostForMessage(messageId) {
  let rootId = messageId;
  for (let depth = 0; depth < 100; depth += 1) {
    const row = await getDb().get('SELECT reply_to_id FROM messages WHERE id = ?', [rootId]);
    if (!row?.reply_to_id) break;
    rootId = row.reply_to_id;
  }
  return getDb().get('SELECT * FROM forum_posts WHERE root_message_id = ?', [rootId]);
}

async function ensureForumMessageAccess(target, messageId, userId) {
  if (target.kind !== 'channel' || target.channel.type !== 'forum') return;
  const post = await forumPostForMessage(messageId);
  if (!post?.private || post.author_id === userId || target.context.permissionBypass) return;
  if (await channelPermission(target.channel, target.context, 'manageThreads')) return;
  const membership = await getDb().get(
    'SELECT 1 AS ok FROM forum_post_members WHERE post_id = ? AND user_id = ?',
    [post.id, userId],
  );
  if (!membership) throw notFound('Message not found.');
}

async function enforceExpressionPermissions(target, content) {
  if (target.kind !== 'channel' || !content) return;
  const tokens = [];
  const pattern =
    /<(?:(:)([a-z0-9_]{2,32})|(sticker|sound):([a-z0-9_]{2,32})):([a-zA-Z0-9_-]{8,64})>/gi;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    tokens.push({
      type: match[1] ? 'emoji' : match[3],
      attachmentId: match[5],
    });
  }
  if (!tokens.length) return;
  const uniqueIds = [...new Set(tokens.map((token) => token.attachmentId))];
  const placeholders = uniqueIds.map(() => '?').join(', ');
  const rows = await getDb().all(
    `SELECT attachment_id, group_id, type FROM group_expressions
     WHERE attachment_id IN (${placeholders})`,
    uniqueIds,
  );
  const expressions = new Map(rows.map((row) => [row.attachment_id, row]));
  for (const token of tokens) {
    const expression = expressions.get(token.attachmentId);
    if (!expression || expression.type !== token.type) continue;
    if (expression.group_id === target.channel.group_id) continue;
    const sourceMembership = await getDb().get(
      'SELECT 1 AS ok FROM group_members WHERE group_id = ? AND user_id = ?',
      [expression.group_id, target.context.userId],
    );
    if (!sourceMembership) {
      throw forbidden(`You do not have access to that external ${token.type}.`);
    }
    const permission =
      token.type === 'emoji'
        ? 'useExternalEmojis'
        : token.type === 'sticker'
          ? 'useExternalStickers'
          : 'useExternalSounds';
    if (!(await channelPermission(target.channel, target.context, permission))) {
      throw forbidden(`You do not have permission to use external ${token.type}s.`);
    }
  }
}

async function resolveRoleMentionRecipients(target, content) {
  if (target.kind !== 'channel' || !content) return [];
  const mentionsEveryone = /(^|\s)@(everyone|here)\b/i.test(content);
  const roleIds = [
    ...new Set(
      [...content.matchAll(/<@&([a-zA-Z0-9_-]{8,64})>/g)].map((match) => match[1]),
    ),
  ].slice(0, 20);
  if (!roleIds.length && !mentionsEveryone) return [];
  const placeholders = roleIds.map(() => '?').join(', ');
  const roles = roleIds.length ? await getDb().all(
    `SELECT id, mentionable FROM server_roles
     WHERE group_id = ? AND id IN (${placeholders}) AND is_default = 0`,
    [target.channel.group_id, ...roleIds],
  ) : [];
  const canMentionAny = await channelPermission(
    target.channel,
    target.context,
    'mentionEveryone',
  );
  for (const role of roles) {
    if (!role.mentionable && !canMentionAny) {
      throw forbidden('You cannot mention one or more of those roles.');
    }
  }
  const memberPlaceholders = roles.map(() => '?').join(', ');
  const rows = roles.length ? await getDb().all(
    `SELECT DISTINCT user_id FROM server_member_roles
     WHERE group_id = ? AND role_id IN (${memberPlaceholders})`,
    [target.channel.group_id, ...roles.map((role) => role.id)],
  ) : [];
  if (mentionsEveryone) {
    const everyoneRows = await getDb().all('SELECT user_id FROM group_members WHERE group_id = ?', [target.channel.group_id]);
    rows.push(...everyoneRows);
  }
  return [...new Set(rows.map((row) => row.user_id))].filter((userId) => userId !== target.context.userId);
}

function mountAt(prefix, paramName) {
  const router = express.Router({ mergeParams: true });

  router.get(
    '/messages',
    asyncRoute(async (req, res) => {
      const target = await resolveTarget(req);
      if (target.kind === 'channel') {
        if (!(await channelPermission(target.channel, target.context, 'readMessageHistory'))) {
          throw forbidden('You do not have permission to read message history in this channel.');
        }
      }
      const query = parse(paginationSchema, req.query);
      let messages = await listMessages({
        channelId: target.channelId,
        conversationId: target.conversationId,
        before: query.before,
        after: query.after,
        limit: query.limit,
        viewerId: req.user.id,
      });
      if (target.kind === 'channel' && target.channel.type === 'forum') {
        const visible = [];
        for (const message of messages) {
          try {
            await ensureForumMessageAccess(target, message.id, req.user.id);
            visible.push(message);
          } catch {
            // Private threads are invisible to non-members.
          }
        }
        messages = visible;
      }
      return res.json({ messages, hasMore: messages.length === query.limit });
    }),
  );

  router.post(
    '/messages',
    writeLimiter,
    asyncRoute(async (req, res) => {
      const target = await resolveTarget(req);
      if (target.kind === 'channel') {
        const timeout = await activeServerTimeout(target.channel.group_id, req.user.id);
        if (timeout) {
          throw forbidden(
            `You are timed out in this server until ${new Date(Number(timeout.expires_at)).toISOString()}.`,
          );
        }
      }
      if (
        target.kind === 'channel' &&
        target.channel.type !== 'forum' &&
        !(await channelPermission(target.channel, target.context, 'sendMessages'))
      ) {
        throw forbidden('You do not have permission to send messages in this channel.');
      }
      const body = parse(
        z.object({
          content: z.string().max(65_536).default(''),
          clientId: z.string().trim().min(16).max(64).regex(/^[a-z0-9]+$/).optional(),
          encrypted: z.boolean().optional().default(false),
          tts: z.boolean().optional().default(false),
          replyToId: idSchema.optional().nullable(),
          attachmentIds: z.array(idSchema).max(10).optional().default([]),
          expiresInSeconds: z.number().int().min(10).max(30 * 24 * 3600).optional().nullable(),
        }),
        req.body,
      );
      if (body.tts && (body.encrypted || target.kind !== 'channel')) {
        throw badRequest('Text-to-speech messages are only available in server channels.');
      }
      if (
        body.tts &&
        !(await channelPermission(target.channel, target.context, 'sendTtsMessages'))
      ) {
        throw forbidden('You do not have permission to send text-to-speech messages.');
      }
      if (
        target.kind === 'channel' &&
        body.attachmentIds.length > 0 &&
        !(await channelPermission(target.channel, target.context, 'attachFiles'))
      ) {
        throw forbidden('You do not have permission to attach files in this channel.');
      }
      if (target.kind === 'channel' && body.attachmentIds.length > 0) {
        const placeholders = body.attachmentIds.map(() => '?').join(', ');
        const voiceAttachment = await getDb().get(
          `SELECT 1 AS ok FROM attachments
           WHERE id IN (${placeholders}) AND uploader_id = ? AND message_id IS NULL
             AND kind = 'voice' LIMIT 1`,
          [...body.attachmentIds, req.user.id],
        );
        if (
          voiceAttachment &&
          !(await channelPermission(target.channel, target.context, 'sendVoiceMessages'))
        ) {
          throw forbidden('You do not have permission to send voice messages.');
        }
      }
      if (
        target.kind === 'channel' &&
        !body.encrypted &&
        /(^|\s)@(everyone|here)\b/i.test(body.content) &&
        !(await channelPermission(target.channel, target.context, 'mentionEveryone'))
      ) {
        throw forbidden('You do not have permission to mention @everyone or @here.');
      }
      await enforceExpressionPermissions(target, body.content);
      const roleMentionRecipientIds = await resolveRoleMentionRecipients(
        target,
        body.content,
      );
      let forumPost = null;
      if (target.kind === 'channel' && target.channel.type === 'forum') {
        if (
          !(await channelPermission(
            target.channel,
            target.context,
            'sendMessagesInThreads',
          ))
        ) {
          throw forbidden('You do not have permission to send messages in threads.');
        }
        if (!body.replyToId) throw badRequest('Forum messages must belong to a post.');
        let rootId = body.replyToId;
        for (let depth = 0; depth < 100; depth += 1) {
          const parent = await getDb().get('SELECT reply_to_id FROM messages WHERE id = ?', [rootId]);
          if (!parent?.reply_to_id) break;
          rootId = parent.reply_to_id;
        }
        forumPost = await getDb().get(
          'SELECT * FROM forum_posts WHERE channel_id = ? AND root_message_id = ?',
          [target.channelId, rootId],
        );
        if (!forumPost) throw badRequest('That forum post no longer exists.');
        await ensureForumMessageAccess(target, rootId, req.user.id);
        if (forumPost.locked && !target.canModerate) throw forbidden('This forum post is locked.');
        if (forumPost.archived) throw badRequest('Unarchive this forum post before replying.');
      }

      if (target.kind === 'channel' && !body.encrypted && body.content.trim() &&
          !target.context.can('manageGroup')) {
        const rules = await getDb().all(
          'SELECT * FROM automod_rules WHERE group_id = ? AND enabled = 1 ORDER BY created_at',
          [target.channel.group_id],
        );
        const lowered = body.content.toLowerCase();
        const matched = rules.find((rule) => {
          if (rule.trigger_type === 'keyword') {
            return lowered.includes(String(rule.trigger_value).toLowerCase());
          }
          try {
            return new RegExp(rule.trigger_value, 'iu').test(body.content);
          } catch {
            return false;
          }
        });
        if (matched) {
          await getDb().run(
            `INSERT INTO automod_actions
              (id, group_id, rule_id, user_id, channel_id, action, matched_value, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              crypto.randomUUID(),
              target.channel.group_id,
              matched.id,
              req.user.id,
              target.channelId,
              matched.action,
              String(matched.trigger_value).slice(0, 500),
              Date.now(),
            ],
          );
          if (matched.action === 'timeout') {
            await getDb().run(
              `INSERT INTO server_timeouts
                (group_id, user_id, reason, expires_at, created_by, created_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT (group_id, user_id)
               DO UPDATE SET reason = excluded.reason, expires_at = excluded.expires_at,
                 created_by = excluded.created_by, created_at = excluded.created_at`,
              [
                target.channel.group_id,
                req.user.id,
                `AutoMod: ${matched.name}`,
                Date.now() + Number(matched.timeout_seconds) * 1000,
                req.user.id,
                Date.now(),
              ],
            );
          }
          await audit({
            actorId: req.user.id,
            action: 'group.automod_action',
            targetType: 'automod_rule',
            targetId: matched.id,
            meta: { groupId: target.channel.group_id, channelId: target.channelId, action: matched.action },
          });
          throw badRequest(
            matched.action === 'timeout'
              ? 'AutoMod blocked this message and temporarily timed you out.'
              : 'AutoMod blocked this message.',
          );
        }
      }

      const runtimeSettings = await getSettings();
      if (body.encrypted) {
        if (!runtimeSettings.feature_e2ee) throw badRequest('End-to-end encryption is disabled.');
        await validateEncryptedMessage(target, req.user.id, body.content);
        await validateEncryptedAttachments(body.attachmentIds, req.user.id);
      } else if (target.kind === 'conversation' && runtimeSettings.e2ee_required_for_dms) {
        throw badRequest('This private conversation requires end-to-end encryption.');
      } else if (body.content.length > 4000) {
        throw badRequest('Message is too long.');
      }
      const blockedTerm = !body.encrypted && runtimeSettings.blocked_terms
        .split(/[\n,]/)
        .map((term) => term.trim().toLowerCase())
        .filter((term) => term.length >= 2)
        .find((term) => body.content.toLowerCase().includes(term));
      if (blockedTerm) {
        throw badRequest('This message contains content blocked by server moderation.');
      }
      if (!body.encrypted) await inspectDlp(body.content, {
        source: 'message', actorId: req.user.id, ip: clientIp(req),
      });

      if (
        target.kind === 'channel' &&
        Number(target.channel.slowmode) > 0 &&
        !(await channelPermission(target.channel, target.context, 'bypassSlowmode'))
      ) {
        const key = `slowmode:${target.channelId}:${req.user.id}`;
        if (await cache.get(key)) {
          throw badRequest(`Slow mode is on — wait ${target.channel.slowmode}s between messages.`);
        }
        await cache.set(key, 1, Number(target.channel.slowmode));
      }
      if (
        Number(req.user.send_interval_seconds ?? 0) > 0 &&
        Number(req.user.send_restricted_until ?? 0) > Date.now()
      ) {
        const seconds = Number(req.user.send_interval_seconds);
        const key = `user-slow:${req.user.id}`;
        if (await cache.get(key)) {
          throw badRequest(`Your account is in slow mode. Wait ${seconds}s between messages.`);
        }
        await cache.set(key, 1, seconds);
      }

      if (body.content.trim() && !body.encrypted) {
        const fingerprint = crypto
          .createHash('sha256')
          .update(`${target.channelId ?? target.conversationId}\0${body.content.trim().toLowerCase()}`)
          .digest('hex')
          .slice(0, 24);
        const repeats = await cache.incr(`spam:${req.user.id}:${fingerprint}`, 30);
        if (repeats > runtimeSettings.spam_messages_per_30s) {
          throw badRequest('Repeated messages were blocked as spam.');
        }
      }

      const message = await createMessage({
        channelId: target.channelId,
        conversationId: target.conversationId,
        authorId: req.user.id,
        content: body.content,
        replyToId: body.replyToId ?? null,
        attachmentIds: body.attachmentIds,
        scopeUserIds: target.audienceIds,
        mentionUserIds: roleMentionRecipientIds,
        expiresAt: body.expiresInSeconds
          ? Date.now() + body.expiresInSeconds * 1000
          : null,
        suppressEmbeds:
          target.kind === 'channel' &&
          /https?:\/\/[^\s<]+/i.test(body.content) &&
          !(await channelPermission(target.channel, target.context, 'embedLinks')),
        type: body.encrypted ? 'encrypted' : body.tts ? 'tts' : 'user',
        clientId: body.clientId ?? null,
      });
      if (message.idempotentReplay) {
        const { idempotentReplay: _replayed, ...existingMessage } = message;
        return res.status(200).json({ message: existingMessage });
      }
      if (forumPost) {
        await getDb().run('UPDATE forum_posts SET updated_at = ? WHERE id = ?', [
          Date.now(),
          forumPost.id,
        ]);
      }
      if (!body.encrypted && !forumPost?.private) {
        await recordMessageEvent(target, 'message.created', message);
      }
      if (!forumPost?.private) {
        void dispatchWebhookEvent({
          targetType: target.kind,
          targetId: target.channelId ?? target.conversationId,
          eventType: 'message.created',
          payload: { message: body.encrypted ? { ...message, content: '[encrypted]' } : message },
        }).catch(() => {});
      }
      messagesCreated.inc({ target: target.kind });

      if (target.kind === 'conversation') await touchConversation(target.conversationId);

      const shadowed = Boolean(req.user.shadow_banned_at);
      if (shadowed) emitToUser(req.user.id, 'message:created', { message });
      else if (!(await emitPrivateForumEvent(target, 'message:created', { message }, message.id))) {
        target.emit('message:created', { message });
      }
      await markRead({
        userId: req.user.id,
        targetType: target.kind,
        targetId: target.channelId ?? target.conversationId,
        messageId: message.id,
      });

      let recipients = shadowed
        ? []
        :
        target.kind === 'conversation'
          ? target.audienceIds.filter((id) => id !== req.user.id)
          : (
              await getDb().all('SELECT user_id FROM mentions WHERE message_id = ?', [message.id])
            ).map((row) => row.user_id);
      recipients = [...new Set([...recipients, ...roleMentionRecipientIds])];
      if (forumPost?.private) {
        const allowedRows = await getDb().all(
          `SELECT user_id FROM forum_post_members WHERE post_id = ?
           UNION SELECT ? AS user_id`,
          [forumPost.id, forumPost.author_id],
        );
        const allowed = new Set(allowedRows.map((row) => row.user_id));
        recipients = recipients.filter((userId) => allowed.has(userId));
      }
      const notificationType = target.kind === 'conversation' ? 'direct_message' : 'mention';
      for (const userId of new Set(recipients)) {
        void notify({
          userId,
          type: notificationType,
          title:
            target.kind === 'conversation'
              ? `New message from ${req.user.display_name}`
              : `${req.user.display_name} mentioned you`,
          body: body.encrypted ? 'Sent an end-to-end encrypted message' : message.content.slice(0, 180) || 'Sent an attachment',
          data: {
            messageId: message.id,
            channelId: target.channelId,
            conversationId: target.conversationId,
          },
        }).catch(() => {});
      }

      return res.status(201).json({ message });
    }),
  );

  router.get(
    '/draft',
    asyncRoute(async (req, res) => {
      const target = await resolveTarget(req);
      const targetId = target.channelId ?? target.conversationId;
      const draft = await getDraft(req.user.id, target.kind, targetId);
      return res.json({ draft });
    }),
  );

  router.put(
    '/draft',
    asyncRoute(async (req, res) => {
      const target = await resolveTarget(req);
      if (target.kind === 'conversation' && (await getSettings()).e2ee_required_for_dms) {
        throw badRequest('Server-side drafts are disabled because this conversation requires end-to-end encryption.');
      }
      const body = parse(
        z.object({
          content: z.string().max(4000).default(''),
          replyToId: idSchema.optional().nullable(),
          attachmentIds: z.array(idSchema).max(10).default([]),
        }),
        req.body,
      );
      const draft = await saveDraft({
        userId: req.user.id,
        targetType: target.kind,
        targetId: target.channelId ?? target.conversationId,
        ...body,
      });
      return res.json({ draft });
    }),
  );

  router.delete(
    '/draft',
    asyncRoute(async (req, res) => {
      const target = await resolveTarget(req);
      await deleteDraft(
        req.user.id,
        target.kind,
        target.channelId ?? target.conversationId,
      );
      return res.json({ ok: true });
    }),
  );

  router.get(
    '/scheduled',
    asyncRoute(async (req, res) => {
      const target = await resolveTarget(req);
      const targetId = target.channelId ?? target.conversationId;
      const scheduled = (await listScheduledMessages(req.user.id)).filter(
        (item) => item.targetType === target.kind && item.targetId === targetId,
      );
      return res.json({ scheduled });
    }),
  );

  router.post(
    '/scheduled',
    writeLimiter,
    asyncRoute(async (req, res) => {
      const target = await resolveTarget(req);
      const body = parse(
        z.object({
          content: z.string().max(65_536).default(''),
          encrypted: z.boolean().optional().default(false),
          replyToId: idSchema.optional().nullable(),
          attachmentIds: z.array(idSchema).max(10).default([]),
          sendAt: z.number().int(),
          expiresAt: z.number().int().optional().nullable(),
        }),
        req.body,
      );
      const settings = await getSettings();
      if (body.encrypted) {
        if (!settings.feature_e2ee) throw badRequest('End-to-end encryption is disabled.');
        await validateEncryptedMessage(target, req.user.id, body.content);
        await validateEncryptedAttachments(body.attachmentIds, req.user.id);
      } else if (target.kind === 'conversation' && settings.e2ee_required_for_dms) {
        throw badRequest('This private conversation requires end-to-end encryption.');
      } else if (body.content.length > 4000) {
        throw badRequest('Message is too long.');
      }
      if (!body.encrypted) await inspectDlp(body.content, {
        source: 'scheduled_message',
        actorId: req.user.id,
        ip: clientIp(req),
      });
      const scheduled = await scheduleMessage({
        userId: req.user.id,
        targetType: target.kind,
        targetId: target.channelId ?? target.conversationId,
        ...body,
      });
      await enqueue(
        'message.publish-scheduled',
        { scheduledMessageId: scheduled.id },
        { jobId: `scheduled-${scheduled.id}`, delay: Math.max(0, scheduled.sendAt - Date.now()) },
      );
      return res.status(201).json({ scheduled });
    }),
  );

  router.delete(
    '/scheduled/:scheduledId',
    asyncRoute(async (req, res) => {
      await resolveTarget(req);
      const scheduledId = parse(idSchema, req.params.scheduledId);
      await cancelScheduledMessage(scheduledId, req.user.id);
      return res.json({ ok: true });
    }),
  );

  router.post(
    '/polls',
    writeLimiter,
    asyncRoute(async (req, res) => {
      const target = await resolveTarget(req);
      if (target.kind === 'channel') {
        const timeout = await activeServerTimeout(target.channel.group_id, req.user.id);
        if (timeout) throw forbidden('You cannot create polls while timed out.');
      }
      if (
        target.kind === 'channel' &&
        !(await channelPermission(target.channel, target.context, 'sendPolls'))
      ) {
        throw forbidden('You do not have permission to create polls in this channel.');
      }
      const body = parse(
        z.object({
          question: z.string().trim().min(1).max(300),
          options: z.array(z.string().trim().min(1).max(120)).min(2).max(10),
          encrypted: z.boolean().optional().default(false),
          content: z.string().max(65_536).optional(),
          multiple: z.boolean().default(false),
          anonymous: z.boolean().default(false),
          examMode: z.boolean().default(false),
          correctOptionIndexes: z.array(z.number().int().min(0).max(9)).max(1).default([]),
          closesAt: z.number().int().optional().nullable(),
        }),
        req.body,
      );
      const settings = await getSettings();
      if (body.encrypted) {
        if (!settings.feature_e2ee || !body.content) throw badRequest('Encrypted poll content is missing.');
        await validateEncryptedMessage(target, req.user.id, body.content);
      } else if (target.kind === 'conversation' && settings.e2ee_required_for_dms) {
        throw badRequest('This private conversation requires an encrypted poll.');
      }
      if (body.closesAt && body.closesAt < Date.now() + 10_000) {
        throw badRequest('Poll closing time must be in the future.');
      }
      const created = await createMessage({
        channelId: target.channelId,
        conversationId: target.conversationId,
        authorId: req.user.id,
        content: body.encrypted ? body.content : body.question,
        type: body.encrypted ? 'encrypted' : 'poll',
        scopeUserIds: target.audienceIds,
      });
      const message = await createPoll({ messageId: created.id, creatorId: req.user.id, ...body });
      const publicMessage = publicPollMessage(message);
      await recordMessageEvent(target, 'message.created', publicMessage);
      void dispatchWebhookEvent({
        targetType: target.kind,
        targetId: target.channelId ?? target.conversationId,
        eventType: 'message.created',
        payload: { message: publicMessage },
      }).catch(() => {});
      void dispatchWebhookEvent({
        targetType: target.kind,
        targetId: target.channelId ?? target.conversationId,
        eventType: 'poll.created',
        payload: { message: publicMessage },
      }).catch(() => {});
      emitModerated(target, req, 'message:created', { message: publicMessage });
      return res.status(201).json({ message });
    }),
  );

  router.patch(
    '/messages/:messageId',
    asyncRoute(async (req, res) => {
      const target = await resolveTarget(req);
      const messageId = parse(idSchema, req.params.messageId);
      const body = parse(z.object({ content: messageContentSchema }), req.body);
      await inspectDlp(body.content, {
        source: 'message',
        actorId: req.user.id,
        ip: clientIp(req),
      });

      const existing = await getMessage(messageId);
      if (!existing || !belongsTo(existing, target)) throw notFound('Message not found.');
      await ensureForumMessageAccess(target, messageId, req.user.id);
      if (existing.deleted_at) throw badRequest('That message was deleted.');
      if (existing.type === 'encrypted') throw badRequest('Encrypted messages cannot be edited; delete and resend instead.');
      // Editing is authorship, not moderation — nobody may rewrite someone
      // else's words, not even an admin.
      if (existing.author_id !== req.user.id) throw forbidden('You can only edit your own messages.');

      const settings = await getSettings();
      const window = Number(settings.message_edit_window_minutes ?? 0);
      if (window > 0 && Date.now() - Number(existing.created_at) > window * 60_000) {
        throw badRequest(`Messages can only be edited within ${window} minutes.`);
      }

      const message = await editMessage(messageId, body.content);
      await recordMessageEvent(target, 'message.updated', message);
      void dispatchWebhookEvent({
        targetType: target.kind,
        targetId: target.channelId ?? target.conversationId,
        eventType: 'message.updated',
        payload: { message },
      }).catch(() => {});
      if (
        !(await emitPrivateForumEvent(
          target,
          'message:updated',
          { message },
          messageId,
        ))
      ) {
        emitModerated(target, req, 'message:updated', { message });
      }
      return res.json({ message });
    }),
  );

  router.patch(
    '/messages/:messageId/poll',
    writeLimiter,
    asyncRoute(async (req, res) => {
      const target = await resolveTarget(req);
      const messageId = parse(idSchema, req.params.messageId);
      const existing = await getMessage(messageId);
      if (!existing || !belongsTo(existing, target) || existing.type !== 'poll') throw notFound('Poll not found.');
      const body = parse(z.object({
        question: z.string().trim().min(1).max(300),
        options: z.array(z.string().trim().min(1).max(120)).min(2).max(10),
        multiple: z.boolean(),
        anonymous: z.boolean(),
        examMode: z.boolean().default(false),
        correctOptionIndexes: z.array(z.number().int().min(0).max(9)).max(1).default([]),
        closesAt: z.number().int().optional().nullable(),
      }), req.body);
      if (body.closesAt && body.closesAt < Date.now() + 10_000) throw badRequest('Poll closing time must be in the future.');
      const message = await updatePoll({ messageId, creatorId: req.user.id, ...body });
      const publicMessage = publicPollMessage(message);
      await recordMessageEvent(target, 'message.updated', publicMessage);
      void dispatchWebhookEvent({ targetType: target.kind, targetId: target.channelId ?? target.conversationId, eventType: 'message.updated', payload: { message: publicMessage } }).catch(() => {});
      void dispatchWebhookEvent({ targetType: target.kind, targetId: target.channelId ?? target.conversationId, eventType: 'poll.updated', payload: { message: publicMessage } }).catch(() => {});
      emitModerated(target, req, 'message:updated', { message: publicMessage });
      return res.json({ message });
    }),
  );

  router.get(
    '/messages/:messageId/poll/analytics',
    asyncRoute(async (req, res) => {
      const target = await resolveTarget(req);
      const messageId = parse(idSchema, req.params.messageId);
      const existing = await getMessage(messageId);
      if (!existing || !belongsTo(existing, target) || existing.type !== 'poll') throw notFound('Poll not found.');
      await ensureForumMessageAccess(target, messageId, req.user.id);
      return res.json({ analytics: await getPollAnalytics({ messageId, creatorId: req.user.id }) });
    }),
  );

  router.post(
    '/messages/:messageId/poll/close',
    writeLimiter,
    asyncRoute(async (req, res) => {
      const target = await resolveTarget(req);
      const messageId = parse(idSchema, req.params.messageId);
      const existing = await getMessage(messageId);
      if (!existing || !belongsTo(existing, target) || existing.type !== 'poll') throw notFound('Poll not found.');
      const message = await closePoll({ messageId, creatorId: req.user.id });
      const publicMessage = publicPollMessage(message);
      await recordMessageEvent(target, 'message.updated', publicMessage);
      emitModerated(target, req, 'message:updated', { message: publicMessage });
      void dispatchWebhookEvent({ targetType: target.kind, targetId: target.channelId ?? target.conversationId, eventType: 'poll.updated', payload: { message: publicMessage, action: 'closed' } }).catch(() => {});
      return res.json({ message });
    }),
  );

  router.delete(
    '/messages/:messageId',
    asyncRoute(async (req, res) => {
      const target = await resolveTarget(req);
      const messageId = parse(idSchema, req.params.messageId);

      const existing = await getMessage(messageId);
      if (!existing || !belongsTo(existing, target)) throw notFound('Message not found.');
      await ensureForumMessageAccess(target, messageId, req.user.id);
      if (existing.deleted_at) {
        const conversationState = target.kind === 'conversation'
          ? await syncConversationAfterMessageDeletion(target.conversationId)
          : null;
        return res.json({
          ok: true,
          deletion: {
            messageId,
            channelId: target.channelId,
            conversationId: target.conversationId,
            lastMessage: conversationState?.lastMessage,
            conversationUpdatedAt: conversationState?.updatedAt,
          },
        });
      }

      const isAuthor = existing.author_id === req.user.id;
      if (!isAuthor && !target.canModerate) {
        throw forbidden('You can only delete your own messages.');
      }

      const attachments = await listAttachmentsForMessage(messageId);
      await deleteMessage(messageId, req.user.id);
      await deleteAttachments(attachments);
      const conversationState = target.kind === 'conversation'
        ? await syncConversationAfterMessageDeletion(target.conversationId)
        : null;
      await recordMessageEvent(target, 'message.deleted', {
        id: messageId,
        channelId: target.channelId,
        conversationId: target.conversationId,
      });
      void dispatchWebhookEvent({
        targetType: target.kind,
        targetId: target.channelId ?? target.conversationId,
        eventType: 'message.deleted',
        payload: { messageId },
      }).catch(() => {});

      const deletedPayload = {
        messageId,
        channelId: target.channelId,
        conversationId: target.conversationId,
        lastMessage: conversationState?.lastMessage,
        conversationUpdatedAt: conversationState?.updatedAt,
      };
      if (
        !(await emitPrivateForumEvent(
          target,
          'message:deleted',
          deletedPayload,
          messageId,
        ))
      ) {
        emitModerated(target, req, 'message:deleted', deletedPayload);
      }

      if (!isAuthor) {
        await audit({
          actorId: req.user.id,
          action: 'message.moderated_delete',
          targetType: 'message',
          targetId: messageId,
          meta: { authorId: existing.author_id },
        });
      }
      return res.json({ ok: true, deletion: deletedPayload });
    }),
  );

  router.post(
    '/messages/:messageId/report',
    writeLimiter,
    asyncRoute(async (req, res) => {
      const target = await resolveTarget(req);
      const messageId = parse(idSchema, req.params.messageId);
      const message = await getMessage(messageId);
      if (!message || !belongsTo(message, target)) throw notFound('Message not found.');
      await ensureForumMessageAccess(target, messageId, req.user.id);
      const body = parse(
        z.object({
          reason: z.enum(['spam', 'harassment', 'hate', 'sexual', 'violence', 'malware', 'other']),
          details: z.string().trim().max(1000).nullable().optional(),
          decryptedEvidence: z.string().max(65_536).optional(),
        }),
        req.body,
      );
      const report = await createReport({
        messageId,
        reporterId: req.user.id,
        reason: body.reason,
        details: body.details ?? null,
        decryptedEvidence: body.decryptedEvidence,
      });
      await audit({
        actorId: req.user.id,
        action: 'message.reported',
        targetType: 'message',
        targetId: messageId,
        meta: { reportId: report.id, reason: body.reason },
      });
      const moderators = await getDb().all(
        `SELECT id FROM users WHERE role = 'admin' AND is_active = 1
         UNION
         SELECT u.id FROM users u
         JOIN user_badges ub ON ub.user_id = u.id
         WHERE ub.badge_id = 'staff' AND u.is_active = 1`,
      );
      for (const moderator of moderators) {
        void notify({
          userId: moderator.id,
          type: 'moderation',
          title: 'New message report',
          body: `${req.user.username} reported a message for ${body.reason}.`,
          data: { reportId: report.id, messageId },
        }).catch(() => {});
      }
      return res.status(201).json({ reportId: report.id });
    }),
  );

  router.put(
    '/messages/:messageId/reactions/:emoji',
    writeLimiter,
    asyncRoute(async (req, res) => {
      const target = await resolveTarget(req);
      const messageId = parse(idSchema, req.params.messageId);
      const emoji = decodeURIComponent(req.params.emoji ?? '');
      if (!isReasonableEmoji(emoji)) throw badRequest('That is not a usable reaction.');

      const existing = await getMessage(messageId);
      if (!existing || !belongsTo(existing, target)) throw notFound('Message not found.');
      await ensureForumMessageAccess(target, messageId, req.user.id);
      if (existing.deleted_at) throw badRequest('That message was deleted.');
      if (target.kind === 'channel') {
        const timeout = await activeServerTimeout(target.channel.group_id, req.user.id);
        const alreadyReacted = await getDb().get(
          'SELECT 1 AS ok FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?',
          [messageId, req.user.id, emoji],
        );
        const reactionExists = alreadyReacted || await getDb().get(
          'SELECT 1 AS ok FROM reactions WHERE message_id = ? AND emoji = ? LIMIT 1',
          [messageId, emoji],
        );
        if (timeout && !alreadyReacted) {
          throw forbidden('You cannot add reactions while timed out.');
        }
        if (
          !alreadyReacted &&
          !reactionExists &&
          !(await channelPermission(target.channel, target.context, 'addReactions'))
        ) {
          throw forbidden('You do not have permission to add reactions in this channel.');
        }
      }

      const result = await toggleReaction({ messageId, userId: req.user.id, emoji });
      const reactionPayload = {
        messageId,
        channelId: target.channelId,
        conversationId: target.conversationId,
        reactions: result.reactions,
      };
      if (
        !(await emitPrivateForumEvent(
          target,
          'message:reaction',
          reactionPayload,
          messageId,
        ))
      ) {
        emitModerated(target, req, 'message:reaction', reactionPayload);
      }
      return res.json(result);
    }),
  );

  router.get(
    '/messages/:messageId/thread',
    asyncRoute(async (req, res) => {
      const target = await resolveTarget(req);
      const messageId = parse(idSchema, req.params.messageId);
      const existing = await getMessage(messageId);
      if (!existing || !belongsTo(existing, target)) throw notFound('Message not found.');
      await ensureForumMessageAccess(target, messageId, req.user.id);
      return res.json(await listThread(messageId, req.user.id));
    }),
  );

  router.put(
    '/messages/:messageId/poll-vote',
    writeLimiter,
    asyncRoute(async (req, res) => {
      const target = await resolveTarget(req);
      if (
        target.kind === 'channel' &&
        (await activeServerTimeout(target.channel.group_id, req.user.id))
      ) {
        throw forbidden('You cannot vote in polls while timed out.');
      }
      const messageId = parse(idSchema, req.params.messageId);
      const existing = await getMessage(messageId);
      if (!existing || !belongsTo(existing, target)) throw notFound('Message not found.');
      await ensureForumMessageAccess(target, messageId, req.user.id);
      const body = parse(z.object({ optionIds: z.array(idSchema).max(10) }), req.body);
      const message = await votePoll({
        messageId,
        userId: req.user.id,
        optionIds: body.optionIds,
      });
      // The HTTP response may identify the current viewer's anonymous choices.
      // Realtime and webhook payloads must never reveal that viewer-specific state.
      const publicMessage = publicPollMessage(message);
      if (
        !(await emitPrivateForumEvent(
          target,
          'message:poll',
          { message: publicMessage },
          messageId,
        ))
      ) {
        emitModerated(target, req, 'message:poll', { message: publicMessage });
      }
      void dispatchWebhookEvent({
        targetType: target.kind,
        targetId: target.channelId ?? target.conversationId,
        eventType: 'poll.voted',
        payload: { message: publicMessage },
      }).catch(() => {});
      return res.json({ message });
    }),
  );

  router.put(
    '/messages/:messageId/saved',
    asyncRoute(async (req, res) => {
      const target = await resolveTarget(req);
      const messageId = parse(idSchema, req.params.messageId);
      const existing = await getMessage(messageId);
      if (!existing || !belongsTo(existing, target)) throw notFound('Message not found.');
      await ensureForumMessageAccess(target, messageId, req.user.id);
      const body = parse(z.object({ saved: z.boolean() }), req.body);
      if (body.saved) await saveMessage(req.user.id, messageId);
      else await unsaveMessage(req.user.id, messageId);
      return res.json({ saved: body.saved });
    }),
  );

  router.put(
    '/messages/:messageId/pin',
    asyncRoute(async (req, res) => {
      const target = await resolveTarget(req);
      if (!target.canPin) throw forbidden('You do not have permission to pin messages here.');
      const messageId = parse(idSchema, req.params.messageId);
      const body = parse(z.object({ pinned: z.boolean() }), req.body);

      const existing = await getMessage(messageId);
      if (!existing || !belongsTo(existing, target)) throw notFound('Message not found.');
      await ensureForumMessageAccess(target, messageId, req.user.id);

      const message = await setPinned(messageId, body.pinned);
      if (
        !(await emitPrivateForumEvent(
          target,
          'message:pinned',
          { message, pinned: body.pinned },
          messageId,
        ))
      ) {
        emitModerated(target, req, 'message:pinned', { message, pinned: body.pinned });
      }
      return res.json({ message });
    }),
  );

  router.post(
    '/messages/:messageId/publish',
    asyncRoute(async (req, res) => {
      const target = await resolveTarget(req);
      const messageId = parse(idSchema, req.params.messageId);
      if (target.kind !== 'channel' || target.channel.type !== 'announcement') {
        throw badRequest('Only announcement-channel messages can be published.');
      }
      if (
        !(await channelPermission(
          target.channel,
          target.context,
          'deleteAnyMessage',
        ))
      ) {
        throw forbidden('Manage Messages permission is required to publish announcements.');
      }
      const source = await getMessage(messageId);
      if (!source || !belongsTo(source, target) || source.deleted_at) {
        throw notFound('Message not found.');
      }
      const followers = await getDb().all(
        'SELECT target_channel_id FROM channel_follows WHERE source_channel_id = ?',
        [target.channelId],
      );
      let publishedCount = 0;
      for (const follower of followers) {
        const existing = await getDb().get(
          `SELECT 1 AS ok FROM message_publications
           WHERE source_message_id = ? AND target_channel_id = ?`,
          [messageId, follower.target_channel_id],
        );
        if (existing) continue;
        const published = await createMessage({
          channelId: follower.target_channel_id,
          authorId: source.author_id,
          content: `📢 **${target.channel.name}**\n${source.content}`,
          type: 'system',
        });
        await getDb().run(
          `INSERT INTO message_publications
            (source_message_id, target_channel_id, published_message_id, published_by, published_at)
           VALUES (?, ?, ?, ?, ?)`,
          [messageId, follower.target_channel_id, published.id, req.user.id, Date.now()],
        );
        emitToChannel(follower.target_channel_id, 'message:created', { message: published });
        publishedCount += 1;
      }
      await audit({
        actorId: req.user.id,
        action: 'message.published',
        targetType: 'message',
        targetId: messageId,
        meta: { channelId: target.channelId, publishedCount },
      });
      return res.json({ publishedCount });
    }),
  );

  router.get(
    '/pins',
    asyncRoute(async (req, res) => {
      const target = await resolveTarget(req);
      let messages = await listPinned({
        channelId: target.channelId,
        conversationId: target.conversationId,
      });
      if (target.kind === 'channel' && target.channel.type === 'forum') {
        const visible = [];
        for (const message of messages) {
          try {
            await ensureForumMessageAccess(target, message.id, req.user.id);
            visible.push(message);
          } catch {
            // Hide pins that belong to private threads.
          }
        }
        messages = visible;
      }
      return res.json({ messages });
    }),
  );

  router.post(
    '/read',
    asyncRoute(async (req, res) => {
      const target = await resolveTarget(req);
      const body = parse(z.object({ messageId: idSchema.optional() }), req.body ?? {});
      await markRead({
        userId: req.user.id,
        targetType: target.kind,
        targetId: target.channelId ?? target.conversationId,
        messageId: body.messageId ?? null,
      });
      return res.json({ ok: true });
    }),
  );

  messagesRouter.use(`${prefix}/:${paramName}`, router);
}

function publicPollMessage(message) {
  if (!message?.poll) return message;
  return {
    ...message,
    poll: {
      ...message.poll,
      viewerOptionIds: [],
      correctOptionIds: message.poll.closed ? message.poll.correctOptionIds : [],
    },
  };
}

function belongsTo(message, target) {
  return target.channelId
    ? message.channel_id === target.channelId
    : message.conversation_id === target.conversationId;
}

/** Rejects reaction payloads that are really arbitrary text. */
function isReasonableEmoji(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.normalize('NFC');
  if (normalized !== value.trim() || normalized.length === 0 || normalized.length > 64) {
    return false;
  }

  // Emoji are grapheme clusters, not single code points. Flags are pairs of
  // regional indicators, keycaps contain a combining mark, and family/skin
  // tone emoji can be fairly long ZWJ sequences. The previous 16-code-unit
  // pictograph check rejected all of those valid reactions.
  const graphemes = [
    ...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(normalized),
  ];
  if (graphemes.length !== 1) return false;

  const isEmoji =
    /\p{Extended_Pictographic}/u.test(normalized) ||
    /\p{Regional_Indicator}/u.test(normalized) ||
    /\u20e3/u.test(normalized);
  return isEmoji || /^[\p{L}\p{N}_+-]{1,12}$/u.test(normalized);
}

function emitModerated(target, req, event, payload) {
  if (req.user.shadow_banned_at) emitToUser(req.user.id, event, payload);
  else target.emit(event, payload);
}

async function emitPrivateForumEvent(target, event, payload, messageId) {
  if (target.kind !== 'channel' || target.channel.type !== 'forum') return false;
  const post = await forumPostForMessage(messageId);
  if (!post?.private) return false;
  const rows = await getDb().all(
    `SELECT user_id FROM forum_post_members WHERE post_id = ?
     UNION SELECT ? AS user_id`,
    [post.id, post.author_id],
  );
  for (const row of rows) emitToUser(row.user_id, event, payload);
  return true;
}

async function recordMessageEvent(target, eventType, message) {
  await recordSyncEvent({
    targetType: target.kind,
    targetId: target.channelId ?? target.conversationId,
    eventType,
    entityId: message.id,
    payload: message,
  });
  await enqueue(
    eventType === 'message.deleted' ? 'search.delete-message' : 'search.index-message',
    { messageId: message.id },
  );
}

mountAt('/channels', 'channelId');
mountAt('/conversations', 'conversationId');

// -------------------------------------------------------- cross-cutting API

messagesRouter.get(
  '/search',
  asyncRoute(async (req, res) => {
    const query = parse(
      z.object({ q: z.string().trim().min(2, 'Search for at least 2 characters.').max(80) }),
      req.query,
    );
    const db = getDb();

    // Scope the search to exactly what this user is allowed to read.
    const channelRows = await db.all(
      `SELECT c.id, c.is_private FROM channels c
       JOIN group_members m ON m.group_id = c.group_id AND m.user_id = ?
       WHERE c.type = 'text'`,
      [req.user.id],
    );
    const privateRows = await db.all('SELECT channel_id FROM channel_members WHERE user_id = ?', [
      req.user.id,
    ]);
    const allowedPrivate = new Set(privateRows.map((row) => row.channel_id));
    const channelIds = channelRows
      .filter((row) => !row.is_private || allowedPrivate.has(row.id))
      .map((row) => row.id);

    const conversationRows = await db.all(
      'SELECT conversation_id FROM conversation_members WHERE user_id = ?',
      [req.user.id],
    );

    const conversationIds = conversationRows.map((row) => row.conversation_id);
    const messages =
      (await searchOpenSearch({
        term: query.q,
        channelIds,
        conversationIds,
      })) ??
      (await searchMessages({
        term: query.q,
        channelIds,
        conversationIds,
        viewerId: req.user.id,
      }));
    return res.json({ messages });
  }),
);

messagesRouter.get(
  '/unread',
  asyncRoute(async (req, res) => {
    return res.json(await getUnreadSummary(req.user.id));
  }),
);

messagesRouter.get(
  '/mentions',
  asyncRoute(async (req, res) => {
    const rows = await getDb().all(
      `SELECT m.id FROM mentions mn JOIN messages m ON m.id = mn.message_id
       JOIN users author ON author.id = m.author_id
       WHERE mn.user_id = ? AND m.deleted_at IS NULL
         AND (author.shadow_banned_at IS NULL OR m.author_id = ?)
       ORDER BY m.id DESC LIMIT 50`,
      [req.user.id, req.user.id],
    );
    const messages = [];
    for (const row of rows) {
      const message = await hydrateMessage(row.id);
      if (message && (await canReadHydratedMessage(req, message))) messages.push(message);
    }
    return res.json({ messages });
  }),
);

messagesRouter.get(
  '/saved',
  asyncRoute(async (req, res) => {
    const rows = await listSavedMessageIds(req.user.id);
    const messages = [];
    for (const row of rows) {
      const message = await hydrateMessage(row.message_id);
      if (!message || message.deleted || (message.expiresAt && message.expiresAt <= Date.now())) {
        continue;
      }
      if (await canReadHydratedMessage(req, message)) messages.push(message);
    }
    return res.json({ messages });
  }),
);

async function canReadHydratedMessage(req, message) {
  if (message.channelId) {
    const channel = await getChannel(message.channelId);
    if (!channel) return false;
    const context = await groupContext(channel.group_id, req.user);
    if (!(await canAccessChannel(channel, context))) return false;
    if (channel.type === 'forum') {
      try {
        await ensureForumMessageAccess(
          { kind: 'channel', channel, context },
          message.id,
          req.user.id,
        );
      } catch {
        return false;
      }
    }
    return true;
  }
  return isConversationMember(message.conversationId, req.user.id);
}
