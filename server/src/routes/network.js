import express from 'express';
import { asyncRoute, badRequest, forbidden, notFound } from '../lib/errors.js';
import {
  parse,
  z,
  idSchema,
  emailSchema,
  usernameSchema,
  displayNameSchema,
} from '../lib/validate.js';
import { requireAuth, clientIp } from '../middleware/auth.js';
import { writeLimiter } from '../middleware/rateLimit.js';
import { audit } from '../services/audit.js';
import {
  listFriendships,
  requestFriendship,
  respondToFriendship,
  removeFriendship,
  listCollabs,
  createCollab,
  respondToCollab,
  cancelCollab,
  listAccessRequests,
  createAccessRequest,
  respondToAccessRequest,
  revokeAccessRequest,
  listLinkedAccounts,
  createLinkedAccount,
  updateLinkedAccount,
  deleteLinkedAccount,
  LINKED_PLATFORMS,
} from '../services/network.js';
import { createUser, findUserByUsername, getPublicUser } from '../services/users.js';
import { notify } from '../services/notifications.js';
import { passwordProblems, suggestPassword } from '../lib/password.js';
import { getDb } from '../db/index.js';
import {
  BADGE_CATALOGUE,
  SECONDARY_BADGE_IDS,
  grantBadge,
  listBadgeIds,
  listBadges,
  requireSecondaryBadgeControl,
  revokeBadge,
} from '../services/badges.js';
import { can, isStreamer, CAPABILITIES } from '../services/capabilities.js';
import { emitToUser, refreshUserRooms } from '../realtime/index.js';
import { cacheMode } from '../cache/index.js';

export const networkRouter = express.Router();
networkRouter.use(requireAuth);

networkRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const [friendships, collabs, accessRequests, linkedAccounts] = await Promise.all([
      listFriendships(req.user.id),
      listCollabs(req.user.id),
      listAccessRequests(req.user.id),
      listLinkedAccounts(req.user.id),
    ]);
    return res.json({ friendships, collabs, accessRequests, linkedAccounts });
  }),
);

// Discord-style add: the sender only needs the exact public username. Keep the
// ID route below for profile cards and backwards-compatible clients.
networkRouter.post(
  '/friends',
  writeLimiter,
  asyncRoute(async (req, res) => {
    const { username: input } = parse(
      z.object({ username: z.string().trim().min(1).max(33) }),
      req.body,
    );
    const username = parse(usernameSchema, input.replace(/^@/, ''));
    const target = await findUserByUsername(username);
    if (!target || !target.is_active) throw notFound('No account has that username.');

    const friendship = await requestFriendship(req.user.id, target.id);
    const requester = await getPublicUser(req.user.id);
    emitToUser(target.id, 'network:updated', {
      type: 'friendship',
      action: friendship.status === 'accepted' ? 'accepted' : 'requested',
      id: friendship.id,
      user: requester,
    });
    if (friendship.status !== 'accepted') {
      await notify({
        userId: target.id,
        type: 'friend_request',
        title: 'New friend request',
        body: `${requester?.displayName ?? 'Someone'} sent you a friend request.`,
        data: { friendshipId: friendship.id, requesterId: req.user.id },
      });
    }
    await audit({
      actorId: req.user.id,
      action: 'network.friend_requested',
      targetType: 'user',
      targetId: target.id,
      ip: clientIp(req),
    });
    return res.status(201).json({ friendship });
  }),
);

networkRouter.get(
  '/runtime',
  asyncRoute(async (req, res) => {
    if (!(await can(req.user, CAPABILITIES.DEBUG))) {
      throw forbidden('The developer capability is required.');
    }
    return res.json({
      database: getDb().dialect,
      cache: cacheMode(),
      uptimeSeconds: Math.round(process.uptime()),
      node: process.version,
    });
  }),
);

// ---------------------------------------------------------------- friendships

networkRouter.get(
  '/friends',
  asyncRoute(async (req, res) =>
    res.json({ friendships: await listFriendships(req.user.id) }),
  ),
);

networkRouter.post(
  '/friends/:userId',
  writeLimiter,
  asyncRoute(async (req, res) => {
    const userId = parse(idSchema, req.params.userId);
    const friendship = await requestFriendship(req.user.id, userId);
    const requester = await getPublicUser(req.user.id);
    emitToUser(userId, 'network:updated', {
      type: 'friendship',
      action: friendship.status === 'accepted' ? 'accepted' : 'requested',
      id: friendship.id,
      user: requester,
    });
    if (friendship.status !== 'accepted') {
      await notify({
        userId,
        type: 'friend_request',
        title: 'New friend request',
        body: `${requester?.displayName ?? 'Someone'} sent you a friend request.`,
        data: { friendshipId: friendship.id, requesterId: req.user.id },
      });
    }
    await audit({
      actorId: req.user.id,
      action: 'network.friend_requested',
      targetType: 'user',
      targetId: userId,
      ip: clientIp(req),
    });
    return res.status(201).json({ friendship });
  }),
);

networkRouter.patch(
  '/friends/:id',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.id);
    const { status } = parse(z.object({ status: z.enum(['accepted', 'rejected']) }), req.body);
    const friendship = await respondToFriendship(id, req.user.id, status);
    const responder = await getPublicUser(req.user.id);
    emitToUser(friendship.requester_id, 'network:updated', {
      type: 'friendship',
      action: status,
      id,
      user: responder,
    });
    if (status === 'accepted') {
      await notify({
        userId: friendship.requester_id,
        type: 'friend_request_accepted',
        title: 'Friend request accepted',
        body: `${responder?.displayName ?? 'Your new friend'} accepted your friend request.`,
        data: { friendshipId: id, userId: req.user.id },
      });
    }
    return res.json({ friendship });
  }),
);

networkRouter.delete(
  '/friends/:id',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.id);
    const friendship = await removeFriendship(id, req.user.id);
    const otherId =
      friendship.requester_id === req.user.id
        ? friendship.addressee_id
        : friendship.requester_id;
    emitToUser(otherId, 'network:updated', { type: 'friendship', id });
    return res.json({ ok: true });
  }),
);

// --------------------------------------------------------------- collabs

networkRouter.get(
  '/collabs',
  asyncRoute(async (req, res) => res.json({ collabs: await listCollabs(req.user.id) })),
);

networkRouter.post(
  '/collabs',
  writeLimiter,
  asyncRoute(async (req, res) => {
    const body = parse(
      z.object({
        partnerId: idSchema,
        title: z.string().trim().min(2).max(64).nullable().optional(),
        note: z.string().trim().max(300).nullable().optional(),
      }),
      req.body,
    );
    const collab = await createCollab({
      initiator: req.user,
      partnerId: body.partnerId,
      title: body.title ?? null,
      note: body.note ?? null,
    });
    emitToUser(body.partnerId, 'network:updated', { type: 'collab', id: collab.id });
    await audit({
      actorId: req.user.id,
      action: 'network.collab_requested',
      targetType: 'user',
      targetId: body.partnerId,
      meta: { title: body.title },
      ip: clientIp(req),
    });
    return res.status(201).json({ collab });
  }),
);

networkRouter.patch(
  '/collabs/:id',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.id);
    const { status } = parse(z.object({ status: z.enum(['accepted', 'rejected']) }), req.body);
    const result = await respondToCollab(id, req.user, status);
    emitToUser(result.collab.initiator_id, 'network:updated', { type: 'collab', id });
    if (result.group) {
      await refreshUserRooms(req.user.id);
      emitToUser(result.collab.initiator_id, 'group:joined', { groupId: result.group.id });
      emitToUser(req.user.id, 'group:joined', { groupId: result.group.id });
    }
    await audit({
      actorId: req.user.id,
      action: `network.collab_${status}`,
      targetType: 'collab',
      targetId: id,
      meta: { groupId: result.group?.id ?? null },
      ip: clientIp(req),
    });
    return res.json(result);
  }),
);

networkRouter.delete(
  '/collabs/:id',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.id);
    const row = await cancelCollab(id, req.user.id);
    emitToUser(row.partner_id, 'network:updated', { type: 'collab', id });
    return res.json({ ok: true });
  }),
);

// --------------------------------------------------------- roster access

networkRouter.get(
  '/access-requests',
  asyncRoute(async (req, res) =>
    res.json({ accessRequests: await listAccessRequests(req.user.id) }),
  ),
);

networkRouter.post(
  '/access-requests',
  writeLimiter,
  asyncRoute(async (req, res) => {
    const body = parse(
      z.object({
        userId: idSchema,
        message: z.string().trim().max(280).nullable().optional(),
      }),
      req.body,
    );
    const request = await createAccessRequest({
      streamer: req.user,
      userId: body.userId,
      message: body.message ?? null,
    });
    emitToUser(body.userId, 'network:updated', { type: 'access', id: request.id });
    return res.status(201).json({ request });
  }),
);

networkRouter.patch(
  '/access-requests/:id',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.id);
    const { status } = parse(z.object({ status: z.enum(['accepted', 'rejected']) }), req.body);
    const request = await respondToAccessRequest(id, req.user.id, status);
    emitToUser(request.streamer_id, 'network:updated', { type: 'access', id });
    return res.json({ request });
  }),
);

networkRouter.delete(
  '/access-requests/:id',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.id);
    const request = await revokeAccessRequest(id, req.user.id);
    const otherId =
      request.streamer_id === req.user.id ? request.user_id : request.streamer_id;
    emitToUser(otherId, 'network:updated', { type: 'access', id });
    return res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------- roster

networkRouter.get(
  '/roster',
  asyncRoute(async (req, res) => {
    if (!(await isStreamer(req.user))) throw forbidden('Only streamers have a roster.');
    const rows = await getDb().all(
      `SELECT id FROM users WHERE owner_streamer_id = ?
       ORDER BY is_active DESC, LOWER(display_name) ASC`,
      [req.user.id],
    );
    const users = (
      await Promise.all(rows.map((row) => getPublicUser(row.id)))
    ).filter(Boolean);
    return res.json({
      users,
      quota: {
        used: users.length,
        limit: req.user.role === 'admin' ? null : 10,
      },
    });
  }),
);

networkRouter.get(
  '/roster/suggest-password',
  asyncRoute(async (req, res) => {
    if (!(await isStreamer(req.user))) throw forbidden('Only streamers can provision accounts.');
    return res.json({ password: suggestPassword() });
  }),
);

networkRouter.post(
  '/roster',
  writeLimiter,
  asyncRoute(async (req, res) => {
    if (!(await isStreamer(req.user))) throw forbidden('Only streamers can provision accounts.');
    if (req.user.role !== 'admin') {
      const rosterSize = await getDb().get(
        'SELECT COUNT(*) AS count FROM users WHERE owner_streamer_id = ?',
        [req.user.id],
      );
      if (Number(rosterSize?.count ?? 0) >= 10) {
        throw forbidden('Content creators can provision up to 10 roster accounts.');
      }
    }
    const body = parse(
      z.object({
        email: emailSchema,
        username: usernameSchema,
        displayName: displayNameSchema,
        password: z.string().min(1).max(200),
        bio: z.string().trim().max(300).nullable().optional(),
        mustChangePassword: z.boolean().default(true),
      }),
      req.body,
    );
    const problems = passwordProblems(body.password);
    if (problems.length) throw badRequest('Password does not meet the policy.', problems);
    const user = await createUser({
      ...body,
      role: 'member',
      createdBy: req.user.id,
      ownerStreamerId: req.user.id,
    });
    await audit({
      actorId: req.user.id,
      action: 'network.roster_account_created',
      targetType: 'user',
      targetId: user.id,
      ip: clientIp(req),
    });
    return res.status(201).json({ user: await getPublicUser(user.id) });
  }),
);

// --------------------------------------------------------- linked profiles

networkRouter.get(
  '/linked-accounts/:userId',
  asyncRoute(async (req, res) => {
    const userId = parse(idSchema, req.params.userId);
    if (!(await getPublicUser(userId))) throw notFound('User not found.');
    return res.json({ linkedAccounts: await listLinkedAccounts(userId) });
  }),
);

const linkedSchema = z.object({
  platform: z.enum([...LINKED_PLATFORMS]),
  handle: z.string().trim().min(1).max(80),
  url: z.string().trim().url().max(300).nullable().optional(),
});

networkRouter.post(
  '/linked-accounts',
  asyncRoute(async (req, res) => {
    const body = parse(linkedSchema, req.body);
    const linkedAccount = await createLinkedAccount({
      userId: req.user.id,
      ...body,
      url: body.url ?? null,
    });
    return res.status(201).json({ linkedAccount });
  }),
);

networkRouter.patch(
  '/linked-accounts/:id',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.id);
    const body = parse(linkedSchema.omit({ platform: true }), req.body);
    const linkedAccount = await updateLinkedAccount({
      id,
      userId: req.user.id,
      handle: body.handle,
      url: body.url ?? null,
    });
    return res.json({ linkedAccount });
  }),
);

networkRouter.delete(
  '/linked-accounts/:id',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.id);
    await deleteLinkedAccount(id, req.user.id);
    return res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------- badges

networkRouter.get('/badges', (_req, res) => res.json({ badges: BADGE_CATALOGUE }));

networkRouter.put(
  '/badges/:userId/secondary',
  asyncRoute(async (req, res) => {
    const userId = parse(idSchema, req.params.userId);
    const { badgeIds } = parse(
      z.object({ badgeIds: z.array(z.enum(SECONDARY_BADGE_IDS)).max(SECONDARY_BADGE_IDS.length) }),
      req.body,
    );
    await requireSecondaryBadgeControl(req.user, userId);
    const target = await getPublicUser(userId);
    if (!target) throw notFound('User not found.');
    const wanted = new Set(badgeIds);
    const current = new Set(
      (await listBadgeIds(userId)).filter((id) => SECONDARY_BADGE_IDS.includes(id)),
    );
    for (const id of current) {
      if (!wanted.has(id)) await revokeBadge({ userId, badgeId: id });
    }
    for (const id of wanted) {
      if (!current.has(id)) {
        await grantBadge({ userId, badgeId: id, grantedBy: req.user.id });
      }
    }
    emitToUser(userId, 'profile:updated', { userId });
    return res.json({ badges: await listBadges(userId) });
  }),
);
