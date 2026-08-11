import express from 'express';
import { asyncRoute } from '../lib/errors.js';
import { parse, z, idSchema } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import { newId } from '../lib/ids.js';
import {
  getChannelNotificationPreference,
  getNotificationPreferences,
  listNotifications,
  markNotificationRead,
  updateNotificationPreferences,
  updateChannelNotificationPreference,
} from '../services/notifications.js';
import { config } from '../config.js';
import { getChannel } from '../services/groups.js';
import { groupContext, canAccessChannel, isConversationMember } from '../services/permissions.js';
import { notFound } from '../lib/errors.js';

export const notificationsRouter = express.Router();
notificationsRouter.use(requireAuth);

notificationsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const query = parse(
      z.object({
        before: idSchema.optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
      req.query,
    );
    const notifications = await listNotifications(req.user.id, query);
    const unread = await getDb().get(
      'SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND read_at IS NULL',
      [req.user.id],
    );
    return res.json({ notifications, unread: Number(unread?.count ?? 0) });
  }),
);

notificationsRouter.post(
  '/read',
  asyncRoute(async (req, res) => {
    const body = parse(z.object({ id: idSchema.nullable().optional() }), req.body ?? {});
    await markNotificationRead(req.user.id, body.id ?? null);
    return res.json({ ok: true });
  }),
);

notificationsRouter.get(
  '/preferences',
  asyncRoute(async (req, res) =>
    res.json({
      preferences: await getNotificationPreferences(req.user.id),
      vapidPublicKey: config.vapid.publicKey || null,
    }),
  ),
);

notificationsRouter.patch(
  '/preferences',
  asyncRoute(async (req, res) => {
    const body = parse(
      z.object({
        inApp: z.boolean().optional(),
        email: z.boolean().optional(),
        push: z.boolean().optional(),
        mentions: z.boolean().optional(),
        directMessages: z.boolean().optional(),
        moderation: z.boolean().optional(),
        quietStart: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
        quietEnd: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
        timezone: z.string().trim().min(1).max(80).optional(),
        digestFrequency: z.enum(['immediate', 'hourly', 'daily', 'off']).optional(),
        digestHour: z.number().int().min(0).max(23).optional(),
      }),
      req.body,
    );
    return res.json({
      preferences: await updateNotificationPreferences(req.user.id, body),
    });
  }),
);

notificationsRouter.get(
  '/channels/:targetType/:targetId',
  asyncRoute(async (req, res) => {
    const targetType = parse(z.enum(['channel', 'conversation']), req.params.targetType);
    const targetId = parse(idSchema, req.params.targetId);
    await requireNotificationTarget(req, targetType, targetId);
    return res.json({
      preference: await getChannelNotificationPreference(req.user.id, targetType, targetId),
    });
  }),
);

notificationsRouter.put(
  '/channels/:targetType/:targetId',
  asyncRoute(async (req, res) => {
    const targetType = parse(z.enum(['channel', 'conversation']), req.params.targetType);
    const targetId = parse(idSchema, req.params.targetId);
    await requireNotificationTarget(req, targetType, targetId);
    const body = parse(
      z.object({
        level: z.enum(['all', 'mentions', 'none']),
        email: z.boolean().default(true),
        push: z.boolean().default(true),
      }),
      req.body,
    );
    return res.json({
      preference: await updateChannelNotificationPreference({
        userId: req.user.id,
        targetType,
        targetId,
        ...body,
      }),
    });
  }),
);

notificationsRouter.post(
  '/push-subscriptions',
  asyncRoute(async (req, res) => {
    const body = parse(
      z.object({
        endpoint: z.string().url().max(2048),
        keys: z.object({
          p256dh: z.string().min(16).max(512),
          auth: z.string().min(8).max(256),
        }),
      }),
      req.body,
    );
    const now = Date.now();
    await getDb().run(
      `INSERT INTO push_subscriptions
        (id, user_id, endpoint, p256dh, auth, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET
        user_id = excluded.user_id, p256dh = excluded.p256dh,
        auth = excluded.auth, last_used_at = excluded.last_used_at`,
      [newId(), req.user.id, body.endpoint, body.keys.p256dh, body.keys.auth, now, now],
    );
    return res.status(201).json({ ok: true });
  }),
);

notificationsRouter.delete(
  '/push-subscriptions',
  asyncRoute(async (req, res) => {
    const body = parse(z.object({ endpoint: z.string().url().max(2048) }), req.body);
    await getDb().run(
      'DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?',
      [req.user.id, body.endpoint],
    );
    return res.json({ ok: true });
  }),
);

async function requireNotificationTarget(req, targetType, targetId) {
  if (targetType === 'conversation') {
    if (!(await isConversationMember(targetId, req.user.id))) throw notFound('Target not found.');
    return;
  }
  const channel = await getChannel(targetId);
  if (!channel) throw notFound('Target not found.');
  const context = await groupContext(channel.group_id, req.user);
  if (!(await canAccessChannel(channel, context))) throw notFound('Target not found.');
}
