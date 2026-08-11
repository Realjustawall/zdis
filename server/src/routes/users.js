import express from 'express';
import { asyncRoute, notFound, badRequest } from '../lib/errors.js';
import { parse, z, idSchema } from '../lib/validate.js';
import { listUsers, getPublicUser, findUserById, toPublicUser } from '../services/users.js';
import { getDb } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { listGroupsForUser } from '../services/groups.js';
import { broadcastActivity, emitToUser } from '../realtime/index.js';
import { createUserReport } from '../services/moderation.js';
import { audit } from '../services/audit.js';
import { writeLimiter } from '../middleware/rateLimit.js';

export const usersRouter = express.Router();

usersRouter.use(requireAuth);

const listSchema = z.object({
  search: z.string().trim().max(64).optional().default(''),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/** The member directory — every account can see every other account. */
usersRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const query = parse(listSchema, req.query);
    const users = await listUsers(query);
    return res.json({ users });
  }),
);

usersRouter.post(
  '/:id/report',
  writeLimiter,
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.id);
    const body = parse(z.object({
      reason: z.enum(['spam', 'harassment', 'hate', 'sexual', 'violence', 'malware', 'impersonation', 'other']),
      details: z.string().trim().max(1000).nullable().optional(),
    }), req.body);
    const report = await createUserReport({ reportedUserId: id, reporterId: req.user.id, ...body });
    await audit({ actorId: req.user.id, action: 'user.reported', targetType: 'user', targetId: id, meta: { reportId: report.id, reason: body.reason } });
    return res.status(201).json({ reportId: report.id });
  }),
);

usersRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.id);
    const user = await getPublicUser(id);
    if (!user) throw notFound('User not found.');

    // Groups the viewer and the target have in common — useful context, and it
    // never reveals spaces the viewer is not already in.
    const shared = await getDb().all(
      `SELECT g.id, g.name, g.slug, g.icon_url, g.accent_color
       FROM chat_groups g
       JOIN group_members a ON a.group_id = g.id AND a.user_id = ?
       JOIN group_members b ON b.group_id = g.id AND b.user_id = ?`,
      [req.user.id, id],
    );

    return res.json({
      user,
      sharedGroups: shared.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        iconUrl: row.icon_url ?? null,
        accentColor: row.accent_color ?? null,
      })),
    });
  }),
);

usersRouter.post(
  '/:id/block',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.id);
    if (id === req.user.id) throw badRequest('You cannot block yourself.');
    const target = await findUserById(id);
    if (!target) throw notFound('User not found.');

    await getDb().tx(async (tx) => {
      await tx.run(
        `INSERT INTO user_blocks (user_id, blocked_id, created_at) VALUES (?, ?, ?)
         ON CONFLICT (user_id, blocked_id) DO NOTHING`,
        [req.user.id, id, Date.now()],
      );
      await tx.run(
        `DELETE FROM friendships
         WHERE (requester_id = ? AND addressee_id = ?)
            OR (requester_id = ? AND addressee_id = ?)`,
        [req.user.id, id, id, req.user.id],
      );
    });
    emitToUser(id, 'network:updated', { type: 'friendship', action: 'removed' });
    return res.json({ ok: true });
  }),
);

usersRouter.delete(
  '/:id/block',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.id);
    await getDb().run('DELETE FROM user_blocks WHERE user_id = ? AND blocked_id = ?', [
      req.user.id,
      id,
    ]);
    return res.json({ ok: true });
  }),
);

usersRouter.get(
  '/me/blocks',
  asyncRoute(async (req, res) => {
    const rows = await getDb().all(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, u.banner_color, u.bio,
        u.presence, u.custom_status, u.is_active, u.last_seen_at, u.created_at, u.role
       FROM user_blocks b JOIN users u ON u.id = b.blocked_id WHERE b.user_id = ?`,
      [req.user.id],
    );
    return res.json({ blocked: rows.map(toPublicUser) });
  }),
);

usersRouter.get(
  '/me/groups',
  asyncRoute(async (req, res) => {
    return res.json({ groups: await listGroupsForUser(req.user.id) });
  }),
);

usersRouter.put(
  '/me/activity',
  asyncRoute(async (req, res) => {
    const body = parse(
      z.object({
        type: z.enum(['playing', 'streaming', 'listening', 'watching', 'custom']).default('custom'),
        name: z.string().trim().min(1).max(100),
        details: z.string().trim().max(200).optional().nullable(),
        state: z.string().trim().max(200).optional().nullable(),
        expiresAt: z.number().int().optional().nullable(),
      }),
      req.body,
    );
    const now = Date.now();
    await getDb().run(
      `INSERT INTO user_activities
        (user_id, type, name, details, state, started_at, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id)
       DO UPDATE SET type = excluded.type, name = excluded.name,
         details = excluded.details, state = excluded.state,
         started_at = excluded.started_at, expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
      [req.user.id, body.type, body.name, body.details ?? null, body.state ?? null, now, body.expiresAt ?? null, now],
    );
    const activity = { ...body, startedAt: now };
    broadcastActivity(req.user.id, activity);
    return res.json({ activity });
  }),
);

usersRouter.delete(
  '/me/activity',
  asyncRoute(async (req, res) => {
    await getDb().run('DELETE FROM user_activities WHERE user_id = ?', [req.user.id]);
    broadcastActivity(req.user.id, null);
    return res.json({ ok: true });
  }),
);
