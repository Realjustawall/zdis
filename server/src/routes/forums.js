import express from 'express';
import { asyncRoute, badRequest, forbidden, notFound } from '../lib/errors.js';
import { parse, z, idSchema } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { writeLimiter } from '../middleware/rateLimit.js';
import { getDb } from '../db/index.js';
import { getChannel } from '../services/groups.js';
import {
  activeServerTimeout,
  groupContext,
  canAccessChannel,
} from '../services/permissions.js';
import { channelPermission } from '../services/channelPermissions.js';
import { createMessage, hydrateMessage } from '../services/messages.js';
import { newId } from '../lib/ids.js';
import { emitToChannel } from '../realtime/index.js';

export const forumsRouter = express.Router();
forumsRouter.use(requireAuth);

async function access(channelId, user) {
  const channel = await getChannel(channelId);
  if (!channel || channel.type !== 'forum') throw notFound('Forum channel not found.');
  const context = await groupContext(channel.group_id, user);
  if (!(await canAccessChannel(channel, context))) throw notFound('Forum channel not found.');
  return { channel, context };
}

function tags(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function canManageThreads(channel, context) {
  return (
    context.permissionBypass ||
    (await channelPermission(channel, context, 'manageThreads')) ||
    (await channelPermission(channel, context, 'manageChannels'))
  );
}

async function canAccessPost(post, channel, context, userId) {
  if (!post.private || post.author_id === userId || (await canManageThreads(channel, context))) {
    return true;
  }
  return Boolean(
    await getDb().get(
      'SELECT 1 AS ok FROM forum_post_members WHERE post_id = ? AND user_id = ?',
      [post.id, userId],
    ),
  );
}

forumsRouter.get(
  '/:channelId/posts',
  asyncRoute(async (req, res) => {
    const channelId = parse(idSchema, req.params.channelId);
    const { channel, context } = await access(channelId, req.user);
    const moderator = await canManageThreads(channel, context);
    const includeArchived = String(req.query.archived ?? '') === '1';
    const rows = await getDb().all(
      `SELECT p.*, u.username, u.display_name, u.avatar_url, u.banner_color,
        (SELECT COUNT(*) FROM messages r
         WHERE r.reply_to_id = p.root_message_id AND r.deleted_at IS NULL) AS reply_count,
        (SELECT COUNT(*) FROM forum_post_members pm WHERE pm.post_id = p.id) AS member_count
       FROM forum_posts p JOIN users u ON u.id = p.author_id
       WHERE p.channel_id = ? AND (? = 1 OR p.archived = 0)
         AND (? = 1 OR p.private = 0 OR p.author_id = ? OR EXISTS (
           SELECT 1 FROM forum_post_members access
           WHERE access.post_id = p.id AND access.user_id = ?
         ))
       ORDER BY p.updated_at DESC LIMIT 200`,
      [channelId, includeArchived ? 1 : 0, moderator ? 1 : 0, req.user.id, req.user.id],
    );
    return res.json({
      posts: rows.map((row) => ({
        id: row.id,
        channelId: row.channel_id,
        rootMessageId: row.root_message_id,
        authorId: row.author_id,
        title: row.title,
        tags: tags(row.tags),
        locked: Boolean(row.locked),
        archived: Boolean(row.archived),
        private: Boolean(row.private),
        memberCount: Number(row.member_count ?? 0),
        canManageMembers: moderator || row.author_id === req.user.id,
        replyCount: Number(row.reply_count ?? 0),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        author: {
          username: row.username,
          displayName: row.display_name,
          avatarUrl: row.avatar_url ?? null,
          bannerColor: row.banner_color ?? null,
        },
      })),
    });
  }),
);

forumsRouter.post(
  '/:channelId/posts',
  writeLimiter,
  asyncRoute(async (req, res) => {
    const channelId = parse(idSchema, req.params.channelId);
    const { channel, context } = await access(channelId, req.user);
    if (await activeServerTimeout(channel.group_id, req.user.id)) {
      throw forbidden('You cannot create forum posts while timed out.');
    }
    if (!(await channelPermission(channel, context, 'sendMessages'))) {
      throw forbidden('You cannot create posts in this forum.');
    }
    const body = parse(
      z.object({
        title: z.string().trim().min(1).max(120),
        content: z.string().trim().min(1).max(4000),
        tags: z.array(z.string().trim().min(1).max(24)).max(5).default([]),
        private: z.boolean().default(false),
      }),
      req.body,
    );
    const createPermission = body.private
      ? 'createPrivateThreads'
      : 'createPublicThreads';
    if (!(await channelPermission(channel, context, createPermission))) {
      throw forbidden(
        body.private
          ? 'You do not have permission to create private threads.'
          : 'You do not have permission to create public threads.',
      );
    }
    if (
      /(^|\s)@(everyone|here)\b/i.test(body.content) &&
      !(await channelPermission(channel, context, 'mentionEveryone'))
    ) {
      throw forbidden('You do not have permission to mention @everyone or @here.');
    }
    const root = await createMessage({
      channelId,
      authorId: req.user.id,
      content: body.content,
      scopeUserIds: null,
    });
    const id = newId();
    const now = Date.now();
    await getDb().run(
      `INSERT INTO forum_posts
        (id, channel_id, root_message_id, author_id, title, tags, private, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        channelId,
        root.id,
        req.user.id,
        body.title,
        JSON.stringify([...new Set(body.tags)]),
        body.private ? 1 : 0,
        now,
        now,
      ],
    );
    if (body.private) {
      await getDb().run(
        `INSERT INTO forum_post_members (post_id, user_id, added_by, added_at)
         VALUES (?, ?, ?, ?) ON CONFLICT (post_id, user_id) DO NOTHING`,
        [id, req.user.id, req.user.id, now],
      );
    }
    emitToChannel(channelId, 'forum:post-created', { channelId, postId: id });
    return res.status(201).json({ id, rootMessage: root });
  }),
);

forumsRouter.patch(
  '/:channelId/posts/:postId',
  asyncRoute(async (req, res) => {
    const channelId = parse(idSchema, req.params.channelId);
    const postId = parse(idSchema, req.params.postId);
    const { channel, context } = await access(channelId, req.user);
    const post = await getDb().get('SELECT * FROM forum_posts WHERE id = ? AND channel_id = ?', [
      postId,
      channelId,
    ]);
    if (!post) throw notFound('Forum post not found.');
    if (!(await canAccessPost(post, channel, context, req.user.id))) {
      throw notFound('Forum post not found.');
    }
    const body = parse(
      z.object({
        title: z.string().trim().min(1).max(120).optional(),
        tags: z.array(z.string().trim().min(1).max(24)).max(5).optional(),
        locked: z.boolean().optional(),
        archived: z.boolean().optional(),
      }),
      req.body,
    );
    const moderator = await canManageThreads(channel, context);
    if (
      (await activeServerTimeout(channel.group_id, req.user.id)) &&
      !moderator
    ) {
      throw forbidden('You cannot edit forum posts while timed out.');
    }
    if (!moderator && post.author_id !== req.user.id) throw forbidden('You cannot edit this post.');
    if (!moderator && body.locked !== undefined) throw forbidden('Only moderators can lock posts.');
    await getDb().run(
      `UPDATE forum_posts SET title = ?, tags = ?, locked = ?, archived = ?, updated_at = ?
       WHERE id = ?`,
      [
        body.title ?? post.title,
        JSON.stringify(body.tags ?? tags(post.tags)),
        body.locked === undefined ? post.locked : body.locked ? 1 : 0,
        body.archived === undefined ? post.archived : body.archived ? 1 : 0,
        Date.now(),
        postId,
      ],
    );
    emitToChannel(channelId, 'forum:post-updated', { channelId, postId });
    return res.json({ ok: true });
  }),
);

forumsRouter.get(
  '/:channelId/posts/:postId/root',
  asyncRoute(async (req, res) => {
    const channelId = parse(idSchema, req.params.channelId);
    const { channel, context } = await access(channelId, req.user);
    const post = await getDb().get('SELECT * FROM forum_posts WHERE id = ? AND channel_id = ?', [
      parse(idSchema, req.params.postId),
      channelId,
    ]);
    if (!post) throw notFound('Forum post not found.');
    if (!(await canAccessPost(post, channel, context, req.user.id))) {
      throw notFound('Forum post not found.');
    }
    return res.json({ message: await hydrateMessage(post.root_message_id) });
  }),
);

forumsRouter.post(
  '/:channelId/posts/:postId/members',
  asyncRoute(async (req, res) => {
    const channelId = parse(idSchema, req.params.channelId);
    const postId = parse(idSchema, req.params.postId);
    const { channel, context } = await access(channelId, req.user);
    const post = await getDb().get(
      'SELECT * FROM forum_posts WHERE id = ? AND channel_id = ?',
      [postId, channelId],
    );
    if (!post || !post.private) throw notFound('Private thread not found.');
    if (post.author_id !== req.user.id && !(await canManageThreads(channel, context))) {
      throw forbidden('Only the thread owner or a moderator can invite members.');
    }
    const body = parse(
      z.object({ username: z.string().trim().toLowerCase().min(3).max(32) }),
      req.body,
    );
    const member = await getDb().get(
      `SELECT u.id, u.username, u.display_name
       FROM users u JOIN group_members gm ON gm.user_id = u.id
       WHERE gm.group_id = ? AND u.username = ? AND u.is_active = 1`,
      [channel.group_id, body.username],
    );
    if (!member) throw notFound('Server member not found.');
    await getDb().run(
      `INSERT INTO forum_post_members (post_id, user_id, added_by, added_at)
       VALUES (?, ?, ?, ?) ON CONFLICT (post_id, user_id) DO NOTHING`,
      [postId, member.id, req.user.id, Date.now()],
    );
    return res.status(201).json({
      member: {
        userId: member.id,
        username: member.username,
        displayName: member.display_name,
      },
    });
  }),
);

forumsRouter.delete(
  '/:channelId/posts/:postId/members/:userId',
  asyncRoute(async (req, res) => {
    const channelId = parse(idSchema, req.params.channelId);
    const postId = parse(idSchema, req.params.postId);
    const userId = parse(idSchema, req.params.userId);
    const { channel, context } = await access(channelId, req.user);
    const post = await getDb().get(
      'SELECT * FROM forum_posts WHERE id = ? AND channel_id = ?',
      [postId, channelId],
    );
    if (!post || !post.private) throw notFound('Private thread not found.');
    const selfLeaving = userId === req.user.id && userId !== post.author_id;
    if (
      !selfLeaving &&
      post.author_id !== req.user.id &&
      !(await canManageThreads(channel, context))
    ) {
      throw forbidden('You cannot remove members from this thread.');
    }
    if (userId === post.author_id) throw badRequest('The thread owner cannot be removed.');
    await getDb().run(
      'DELETE FROM forum_post_members WHERE post_id = ? AND user_id = ?',
      [postId, userId],
    );
    return res.json({ ok: true });
  }),
);
