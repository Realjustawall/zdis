import express from 'express';
import { asyncRoute, badRequest, forbidden, notFound, conflict } from '../lib/errors.js';
import { parse, z, idSchema } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { writeLimiter } from '../middleware/rateLimit.js';
import {
  createGroup,
  listGroupsForUser,
  listChannels,
  listMembers,
  addMember,
  removeMember,
  setMemberRole,
  deleteGroup,
  createInvite,
  listInvites,
  redeemInvite,
  revokeInvite,
  toGroup,
  toChannel,
  toInvite,
  getChannel,
  invalidateGroup,
  listCategories,
  listDiscoverableGroups,
} from '../services/groups.js';
import {
  groupContext,
  requireGroupPermission,
  canCreateGroup,
  canAccessChannel,
} from '../services/permissions.js';
import { getDb } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { audit, listAuditLogs } from '../services/audit.js';
import { clientIp } from '../middleware/auth.js';
import { findUserById, getPublicUser } from '../services/users.js';
import { emitToGroup, emitToUser, refreshUserRooms, getIo, rooms } from '../realtime/index.js';
import { closeVoiceChannel } from '../realtime/voice.js';
import { createMessage } from '../services/messages.js';
import { canJoinGroup } from '../services/capabilities.js';
import {
  SERVER_PERMISSION_KEYS,
  createServerRole,
  deleteServerRole,
  getServerRole,
  listServerRoles,
  roleStateForMember,
  setServerMemberRole,
  updateServerRole,
} from '../services/serverRoles.js';
import {
  CHANNEL_PERMISSION_KEYS,
  channelPermission,
  deleteCategoryOverride,
  deleteChannelOverride,
  listCategoryOverrides,
  listChannelOverrides,
  setCategoryOverride,
  setChannelOverride,
} from '../services/channelPermissions.js';

export const groupsRouter = express.Router();
groupsRouter.use(requireAuth);

const createSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters.').max(64),
  description: z.string().trim().max(300).optional().nullable(),
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be a hex value like #5865f2.')
    .optional(),
});

function toExpression(row) {
  return {
    id: row.id,
    groupId: row.group_id,
    attachmentId: row.attachment_id,
    name: row.name,
    type: row.type,
    mime: row.mime,
    size: Number(row.size),
    width: row.width === null ? null : Number(row.width),
    height: row.height === null ? null : Number(row.height),
    url: `/api/files/${row.attachment_id}`,
    createdBy: row.created_by,
    createdAt: Number(row.created_at),
  };
}

function toServerEvent(row) {
  return {
    id: row.id,
    groupId: row.group_id,
    channelId: row.channel_id ?? null,
    creatorId: row.creator_id,
    name: row.name,
    description: row.description ?? null,
    location: row.location ?? null,
    startsAt: Number(row.starts_at),
    endsAt: row.ends_at ? Number(row.ends_at) : null,
    status: row.status,
    goingCount: Number(row.going_count ?? 0),
    interestedCount: Number(row.interested_count ?? 0),
    viewerStatus: row.viewer_status ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toSubscriptionTier(row) {
  return {
    id: row.id,
    groupId: row.group_id,
    name: row.name,
    description: row.description ?? null,
    priceMonthly: Number(row.price_monthly),
    benefits: JSON.parse(row.benefits || '[]'),
    active: Boolean(row.active),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toServerSanction(row) {
  return {
    groupId: row.group_id,
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    reason: row.reason ?? null,
    expiresAt: row.expires_at ? Number(row.expires_at) : null,
    createdAt: Number(row.created_at),
  };
}

function toAutoModRule(row) {
  return {
    id: row.id,
    groupId: row.group_id,
    name: row.name,
    triggerType: row.trigger_type,
    triggerValue: row.trigger_value,
    action: row.action,
    timeoutSeconds: Number(row.timeout_seconds),
    enabled: Boolean(row.enabled),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

groupsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    return res.json({ groups: await listGroupsForUser(req.user.id) });
  }),
);

groupsRouter.get(
  '/discover',
  asyncRoute(async (req, res) => {
    const search = String(req.query.search ?? '').slice(0, 100);
    return res.json({ groups: await listDiscoverableGroups(search) });
  }),
);

groupsRouter.post(
  '/discover/:groupId/join',
  writeLimiter,
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const group = await getDb().get('SELECT * FROM chat_groups WHERE id = ? AND discoverable = 1', [groupId]);
    if (!group) throw notFound('Discoverable group not found.');
    await addMember({ groupId, userId: req.user.id, invitedBy: null });
    await refreshUserRooms(req.user.id);
    return res.json({ group: toGroup(group) });
  }),
);

/**
 * Creating a group is the YouTuber's entry point: they get a space of their
 * own and become its owner, then bring their editors/mods in.
 */
groupsRouter.post(
  '/',
  writeLimiter,
  asyncRoute(async (req, res) => {
    if (!(await canCreateGroup(req.user))) {
      throw forbidden('Your role is not allowed to create groups.');
    }
    const body = parse(createSchema, req.body);

    const owned = await getDb().get(
      'SELECT COUNT(*) AS count FROM chat_groups WHERE owner_id = ?',
      [req.user.id],
    );
    if (req.user.role !== 'admin' && Number(owned?.count ?? 0) >= 20) {
      throw badRequest('You have reached the limit of 20 groups.');
    }

    const group = await createGroup({
      name: body.name,
      description: body.description ?? null,
      accentColor: body.accentColor ?? null,
      ownerId: req.user.id,
    });

    await audit({
      actorId: req.user.id,
      action: 'group.create',
      targetType: 'group',
      targetId: group.id,
      meta: { name: group.name },
      ip: clientIp(req),
    });
    await refreshUserRooms(req.user.id);

    const channels = await listChannels(group.id);
    return res.status(201).json({ group: toGroup(group, { memberRole: 'owner' }), channels });
  }),
);

groupsRouter.get(
  '/:groupId',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const context = await groupContext(groupId, req.user);
    const [channels, categories, members, invites, roles] = await Promise.all([
      listChannels(groupId),
      listCategories(groupId),
      listMembers(groupId),
      context.can('createInvite') ? listInvites(groupId) : Promise.resolve([]),
      listServerRoles(groupId),
    ]);

    // Hide private channels the viewer has no seat in.
    const memberIds = new Set(members.map((m) => m.id));
    const privateRows = await getDb().all(
      'SELECT channel_id FROM channel_members WHERE user_id = ?',
      [req.user.id],
    );
    const allowedPrivate = new Set(privateRows.map((row) => row.channel_id));
    const visibleChannels = (
      await Promise.all(
        channels.map(async (channel) => {
          const raw = await getChannel(channel.id);
          const visible =
            await canAccessChannel(
              raw,
              context,
            );
          const privateSeat =
            !channel.isPrivate || context.can('manageChannels') || allowedPrivate.has(channel.id);
          return visible && privateSeat ? channel : null;
        }),
      )
    ).filter(Boolean);

    return res.json({
      group: toGroup(context.group, {
        memberRole: context.role,
        memberCount: memberIds.size,
      }),
      channels: visibleChannels,
      categories,
      members,
      invites,
      roles,
      permissions: {
        administrator: context.can('administrator'),
        manageGroup: context.can('manageGroup'),
        deleteGroup: context.can('deleteGroup'),
        viewAuditLog: context.can('viewAuditLog'),
        manageChannels: context.can('manageChannels'),
        manageMembers: context.can('manageMembers'),
        manageRoles: context.can('manageRoles'),
        createInvite: context.can('createInvite'),
        changeNickname: context.can('changeNickname'),
        manageNicknames: context.can('manageNicknames'),
        deleteAnyMessage: context.can('deleteAnyMessage'),
        pinMessage: context.can('pinMessage'),
        kickMember: context.can('kickMember'),
        banMembers: context.can('banMembers'),
        moderateMembers: context.can('moderateMembers'),
        manageExpressions: context.can('manageExpressions'),
        manageWebhooks: context.can('manageWebhooks'),
        createEvents: context.can('createEvents'),
        manageEvents: context.can('manageEvents'),
        highestRolePosition: context.highestRolePosition,
        effective: context.effectivePermissions,
      },
    });
  }),
);

groupsRouter.get(
  '/:groupId/expressions',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    await groupContext(groupId, req.user);
    const rows = await getDb().all(
      `SELECT e.*, a.mime, a.size, a.width, a.height
       FROM group_expressions e JOIN attachments a ON a.id = e.attachment_id
       WHERE e.group_id = ? AND a.quarantined_at IS NULL
         AND a.scan_status != 'infected'
       ORDER BY e.type, LOWER(e.name)`,
      [groupId],
    );
    return res.json({ expressions: rows.map(toExpression) });
  }),
);

groupsRouter.get(
  '/:groupId/external-expressions',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    await groupContext(groupId, req.user);
    const rows = await getDb().all(
      `SELECT e.*, a.mime, a.size, a.width, a.height, g.name AS source_group_name
       FROM group_expressions e
       JOIN attachments a ON a.id = e.attachment_id
       JOIN chat_groups g ON g.id = e.group_id
       JOIN group_members gm ON gm.group_id = e.group_id AND gm.user_id = ?
       WHERE e.group_id <> ? AND a.quarantined_at IS NULL
         AND a.scan_status != 'infected'
       ORDER BY LOWER(g.name), e.type, LOWER(e.name) LIMIT 500`,
      [req.user.id, groupId],
    );
    return res.json({
      expressions: rows.map((row) => ({
        ...toExpression(row),
        sourceGroupName: row.source_group_name,
      })),
    });
  }),
);

groupsRouter.post(
  '/:groupId/expressions',
  writeLimiter,
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const context = await groupContext(groupId, req.user);
    if (!context.can('createExpressions') && !context.can('manageExpressions')) {
      throw forbidden('Create Expressions permission is required.');
    }
    const body = parse(
      z.object({
        name: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{2,32}$/),
        type: z.enum(['emoji', 'sticker', 'sound']),
        attachmentId: idSchema,
      }),
      req.body,
    );
    const attachment = await getDb().get(
      `SELECT * FROM attachments
       WHERE id = ? AND uploader_id = ? AND message_id IS NULL
         AND quarantined_at IS NULL AND scan_status != 'infected'`,
      [body.attachmentId, req.user.id],
    );
    if (!attachment) throw notFound('Uploaded asset not found.');
    const limits = {
      emoji: { prefix: 'image/', bytes: 512 * 1024 },
      sticker: { prefix: 'image/', bytes: 2 * 1024 * 1024 },
      sound: { prefix: 'audio/', bytes: 2 * 1024 * 1024 },
    };
    const limit = limits[body.type];
    if (!attachment.mime.startsWith(limit.prefix)) {
      throw badRequest(`${body.type} assets must be ${limit.prefix.slice(0, -1)} files.`);
    }
    if (Number(attachment.size) > limit.bytes) {
      throw badRequest(`${body.type} asset is too large.`);
    }
    const id = newId();
    try {
      await getDb().run(
        `INSERT INTO group_expressions
           (id, group_id, attachment_id, name, type, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, groupId, attachment.id, body.name, body.type, req.user.id, Date.now()],
      );
    } catch (error) {
      if (/unique|duplicate/i.test(String(error?.message))) {
        throw conflict('That expression name or uploaded asset is already in use.');
      }
      throw error;
    }
    const row = await getDb().get(
      `SELECT e.*, a.mime, a.size, a.width, a.height
       FROM group_expressions e JOIN attachments a ON a.id = e.attachment_id WHERE e.id = ?`,
      [id],
    );
    await audit({
      actorId: req.user.id,
      action: 'group.expression_create',
      targetType: 'group_expression',
      targetId: id,
      meta: { groupId, type: body.type, name: body.name },
    });
    return res.status(201).json({ expression: toExpression(row) });
  }),
);

groupsRouter.delete(
  '/:groupId/expressions/:expressionId',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const expressionId = parse(idSchema, req.params.expressionId);
    const context = await groupContext(groupId, req.user);
    const expression = await getDb().get(
      'SELECT created_by FROM group_expressions WHERE id = ? AND group_id = ?',
      [expressionId, groupId],
    );
    if (!expression) throw notFound('Expression not found.');
    if (
      !context.can('manageExpressions') &&
      !(context.can('createExpressions') && expression.created_by === req.user.id)
    ) {
      throw forbidden('You can only remove expressions you created.');
    }
    const result = await getDb().run(
      'DELETE FROM group_expressions WHERE id = ? AND group_id = ?',
      [expressionId, groupId],
    );
    if (!result.changes) throw notFound('Expression not found.');
    await audit({
      actorId: req.user.id,
      action: 'group.expression_delete',
      targetType: 'group_expression',
      targetId: expressionId,
      meta: { groupId },
    });
    return res.json({ ok: true });
  }),
);

groupsRouter.get(
  '/:groupId/community',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const context = await groupContext(groupId, req.user);
    const now = Date.now();
    const [events, tiers, subscriptions, boostRows] = await Promise.all([
      getDb().all(
        `SELECT e.*,
           SUM(CASE WHEN r.status = 'going' THEN 1 ELSE 0 END) AS going_count,
           SUM(CASE WHEN r.status = 'interested' THEN 1 ELSE 0 END) AS interested_count,
           MAX(CASE WHEN r.user_id = ? THEN r.status ELSE NULL END) AS viewer_status
         FROM server_events e LEFT JOIN event_rsvps r ON r.event_id = e.id
         WHERE e.group_id = ? AND e.status != 'cancelled'
         GROUP BY e.id ORDER BY e.starts_at`,
        [req.user.id, groupId],
      ),
      getDb().all(
        'SELECT * FROM subscription_tiers WHERE group_id = ? AND active = 1 ORDER BY price_monthly, created_at',
        [groupId],
      ),
      getDb().all(
        `SELECT s.*, t.name AS tier_name
         FROM server_subscriptions s JOIN subscription_tiers t ON t.id = s.tier_id
         WHERE s.group_id = ? AND s.user_id = ? AND s.status = 'active'
           AND s.current_period_end > ? ORDER BY s.started_at DESC`,
        [groupId, req.user.id, now],
      ),
      getDb().all(
        `SELECT b.*, u.display_name, u.username
         FROM server_boosts b JOIN users u ON u.id = b.user_id
         WHERE b.group_id = ? AND b.cancelled_at IS NULL AND b.expires_at > ?
         ORDER BY b.started_at`,
        [groupId, now],
      ),
    ]);
    const boostCount = boostRows.length;
    const monetization = context.can('viewCreatorMonetizationAnalytics')
      ? await getDb().get(
          `SELECT COUNT(*) AS active_subscriptions,
             COALESCE(SUM(t.price_monthly), 0) AS monthly_revenue
           FROM server_subscriptions s
           JOIN subscription_tiers t ON t.id = s.tier_id
           WHERE s.group_id = ? AND s.status = 'active' AND s.current_period_end > ?`,
          [groupId, now],
        )
      : null;
    return res.json({
      events: events.map(toServerEvent),
      boosts: {
        count: boostCount,
        level: boostCount >= 14 ? 3 : boostCount >= 7 ? 2 : boostCount >= 2 ? 1 : 0,
        viewerBoosting: boostRows.some((row) => row.user_id === req.user.id),
        supporters: boostRows.map((row) => ({
          userId: row.user_id,
          displayName: row.display_name,
          username: row.username,
          expiresAt: Number(row.expires_at),
        })),
      },
      tiers: tiers.map(toSubscriptionTier),
      subscriptions: subscriptions.map((row) => ({
        id: row.id,
        tierId: row.tier_id,
        tierName: row.tier_name,
        status: row.status,
        startedAt: Number(row.started_at),
        currentPeriodEnd: Number(row.current_period_end),
      })),
      monetization: monetization
        ? {
            activeSubscriptions: Number(monetization.active_subscriptions ?? 0),
            monthlyRevenue: Number(monetization.monthly_revenue ?? 0),
          }
        : null,
    });
  }),
);

groupsRouter.get(
  '/:groupId/insights',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const context = await groupContext(groupId, req.user);
    if (!context.can('viewServerInsights')) {
      throw forbidden('View Server Insights permission is required.');
    }
    const since = Date.now() - 7 * 86400_000;
    const [members, channels, messages, activeMembers] = await Promise.all([
      getDb().get('SELECT COUNT(*) AS count FROM group_members WHERE group_id = ?', [groupId]),
      getDb().get('SELECT COUNT(*) AS count FROM channels WHERE group_id = ?', [groupId]),
      getDb().get(
        `SELECT COUNT(*) AS count FROM messages m
         JOIN channels c ON c.id = m.channel_id
         WHERE c.group_id = ? AND m.created_at >= ? AND m.deleted_at IS NULL`,
        [groupId, since],
      ),
      getDb().get(
        `SELECT COUNT(DISTINCT m.author_id) AS count FROM messages m
         JOIN channels c ON c.id = m.channel_id
         WHERE c.group_id = ? AND m.created_at >= ? AND m.deleted_at IS NULL`,
        [groupId, since],
      ),
    ]);
    return res.json({
      insights: {
        memberCount: Number(members?.count ?? 0),
        channelCount: Number(channels?.count ?? 0),
        messagesLast7Days: Number(messages?.count ?? 0),
        activeMembersLast7Days: Number(activeMembers?.count ?? 0),
        generatedAt: Date.now(),
      },
    });
  }),
);

groupsRouter.post(
  '/:groupId/events',
  writeLimiter,
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const context = await groupContext(groupId, req.user);
    if (!context.can('createEvents')) throw forbidden('Create Events permission is required.');
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(100),
        description: z.string().trim().max(1000).optional().nullable(),
        channelId: idSchema.optional().nullable(),
        location: z.string().trim().max(200).optional().nullable(),
        startsAt: z.number().int(),
        endsAt: z.number().int().optional().nullable(),
      }),
      req.body,
    );
    if (body.startsAt < Date.now() - 60_000) throw badRequest('Event start time must be in the future.');
    if (body.endsAt && body.endsAt <= body.startsAt) throw badRequest('Event end must be after its start.');
    if (body.channelId) {
      const channel = await getChannel(body.channelId);
      if (!channel || channel.group_id !== groupId) throw badRequest('Event channel is not in this server.');
      if (!(await channelPermission(channel, context, 'createEvents'))) {
        throw forbidden('Create Events permission is required in that channel.');
      }
    }
    const id = newId();
    const now = Date.now();
    await getDb().run(
      `INSERT INTO server_events
        (id, group_id, channel_id, creator_id, name, description, location,
         starts_at, ends_at, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
      [
        id,
        groupId,
        body.channelId ?? null,
        req.user.id,
        body.name,
        body.description ?? null,
        body.location ?? null,
        body.startsAt,
        body.endsAt ?? null,
        now,
        now,
      ],
    );
    const event = await getDb().get('SELECT * FROM server_events WHERE id = ?', [id]);
    emitToGroup(groupId, 'server:event-created', { event: toServerEvent(event) });
    await audit({ actorId: req.user.id, action: 'server.event_create', targetType: 'server_event', targetId: id, meta: { groupId } });
    return res.status(201).json({ event: toServerEvent(event) });
  }),
);

groupsRouter.patch(
  '/:groupId/events/:eventId',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const eventId = parse(idSchema, req.params.eventId);
    const context = await groupContext(groupId, req.user);
    const current = await getDb().get(
      'SELECT * FROM server_events WHERE id = ? AND group_id = ?',
      [eventId, groupId],
    );
    if (!current) throw notFound('Event not found.');
    if (
      !context.can('manageEvents') &&
      !(context.can('createEvents') && current.creator_id === req.user.id)
    ) {
      throw forbidden('You can only edit events you created.');
    }
    if (current.channel_id) {
      const eventChannel = await getChannel(current.channel_id);
      const requiredPermission =
        current.creator_id === req.user.id ? 'createEvents' : 'manageEvents';
      if (
        eventChannel &&
        !(await channelPermission(eventChannel, context, requiredPermission))
      ) {
        throw forbidden(`${requiredPermission === 'createEvents' ? 'Create' : 'Manage'} Events permission is required in that channel.`);
      }
    }
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(100).optional(),
        description: z.string().trim().max(1000).nullable().optional(),
        location: z.string().trim().max(200).nullable().optional(),
        startsAt: z.number().int().optional(),
        endsAt: z.number().int().nullable().optional(),
        status: z.enum(['scheduled', 'active', 'completed', 'cancelled']).optional(),
      }),
      req.body,
    );
    await getDb().run(
      `UPDATE server_events SET name = ?, description = ?, location = ?,
       starts_at = ?, ends_at = ?, status = ?, updated_at = ? WHERE id = ?`,
      [
        body.name ?? current.name,
        body.description === undefined ? current.description : body.description,
        body.location === undefined ? current.location : body.location,
        body.startsAt ?? current.starts_at,
        body.endsAt === undefined ? current.ends_at : body.endsAt,
        body.status ?? current.status,
        Date.now(),
        eventId,
      ],
    );
    return res.json({ event: toServerEvent(await getDb().get('SELECT * FROM server_events WHERE id = ?', [eventId])) });
  }),
);

groupsRouter.delete(
  '/:groupId/events/:eventId',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const eventId = parse(idSchema, req.params.eventId);
    const context = await groupContext(groupId, req.user);
    const event = await getDb().get(
      'SELECT * FROM server_events WHERE id = ? AND group_id = ?',
      [eventId, groupId],
    );
    if (!event) throw notFound('Event not found.');
    if (
      !context.can('manageEvents') &&
      !(context.can('createEvents') && event.creator_id === req.user.id)
    ) {
      throw forbidden('You can only delete events you created.');
    }
    if (event.channel_id) {
      const eventChannel = await getChannel(event.channel_id);
      const requiredPermission =
        event.creator_id === req.user.id ? 'createEvents' : 'manageEvents';
      if (
        eventChannel &&
        !(await channelPermission(eventChannel, context, requiredPermission))
      ) {
        throw forbidden(`${requiredPermission === 'createEvents' ? 'Create' : 'Manage'} Events permission is required in that channel.`);
      }
    }
    await getDb().tx(async (tx) => {
      await tx.run('DELETE FROM event_rsvps WHERE event_id = ?', [eventId]);
      await tx.run('DELETE FROM server_events WHERE id = ? AND group_id = ?', [eventId, groupId]);
    });
    emitToGroup(groupId, 'server:event-deleted', { groupId, eventId });
    await audit({
      actorId: req.user.id,
      action: 'server.event_delete',
      targetType: 'server_event',
      targetId: eventId,
      meta: { groupId },
    });
    return res.json({ ok: true });
  }),
);

groupsRouter.put(
  '/:groupId/events/:eventId/rsvp',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const eventId = parse(idSchema, req.params.eventId);
    await groupContext(groupId, req.user);
    const body = parse(z.object({ status: z.enum(['interested', 'going']).nullable() }), req.body);
    const event = await getDb().get('SELECT id FROM server_events WHERE id = ? AND group_id = ?', [eventId, groupId]);
    if (!event) throw notFound('Event not found.');
    if (body.status) {
      await getDb().run(
        `INSERT INTO event_rsvps (event_id, user_id, status, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (event_id, user_id)
         DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
        [eventId, req.user.id, body.status, Date.now()],
      );
    } else {
      await getDb().run('DELETE FROM event_rsvps WHERE event_id = ? AND user_id = ?', [eventId, req.user.id]);
    }
    return res.json({ status: body.status });
  }),
);

groupsRouter.post(
  '/:groupId/boosts',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    await groupContext(groupId, req.user);
    const active = await getDb().get(
      `SELECT id FROM server_boosts WHERE user_id = ? AND cancelled_at IS NULL AND expires_at > ?`,
      [req.user.id, Date.now()],
    );
    if (active) throw conflict('You already have an active server boost.');
    const id = newId();
    await getDb().run(
      'INSERT INTO server_boosts (id, group_id, user_id, started_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      [id, groupId, req.user.id, Date.now(), Date.now() + 30 * 86400_000],
    );
    await audit({ actorId: req.user.id, action: 'server.boost', targetType: 'group', targetId: groupId });
    return res.status(201).json({ boost: { id, expiresAt: Date.now() + 30 * 86400_000 } });
  }),
);

groupsRouter.delete(
  '/:groupId/boosts/mine',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    await groupContext(groupId, req.user);
    await getDb().run(
      `UPDATE server_boosts SET cancelled_at = ?
       WHERE group_id = ? AND user_id = ? AND cancelled_at IS NULL`,
      [Date.now(), groupId, req.user.id],
    );
    return res.json({ ok: true });
  }),
);

groupsRouter.post(
  '/:groupId/subscription-tiers',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const context = await groupContext(groupId, req.user);
    if (!context.can('manageGroup')) throw forbidden('Manage Server permission is required.');
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(64),
        description: z.string().trim().max(300).optional().nullable(),
        priceMonthly: z.number().int().min(0).max(100_000_000).default(0),
        benefits: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
      }),
      req.body,
    );
    const id = newId();
    try {
      await getDb().run(
        `INSERT INTO subscription_tiers
          (id, group_id, name, description, price_monthly, benefits, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [id, groupId, body.name, body.description ?? null, body.priceMonthly, JSON.stringify(body.benefits), Date.now(), Date.now()],
      );
    } catch (error) {
      if (/unique|duplicate/i.test(String(error?.message))) throw conflict('That subscription tier already exists.');
      throw error;
    }
    return res.status(201).json({ tier: toSubscriptionTier(await getDb().get('SELECT * FROM subscription_tiers WHERE id = ?', [id])) });
  }),
);

groupsRouter.post(
  '/:groupId/subscriptions',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    await groupContext(groupId, req.user);
    const body = parse(z.object({ tierId: idSchema }), req.body);
    const tier = await getDb().get(
      'SELECT * FROM subscription_tiers WHERE id = ? AND group_id = ? AND active = 1',
      [body.tierId, groupId],
    );
    if (!tier) throw notFound('Subscription tier not found.');
    const id = newId();
    const now = Date.now();
    await getDb().run(
      `INSERT INTO server_subscriptions
        (id, tier_id, group_id, user_id, status, started_at, current_period_end)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      [id, tier.id, groupId, req.user.id, now, now + 30 * 86400_000],
    );
    return res.status(201).json({ subscription: { id, tierId: tier.id, currentPeriodEnd: now + 30 * 86400_000 } });
  }),
);

groupsRouter.delete(
  '/:groupId/subscriptions/:subscriptionId',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const subscriptionId = parse(idSchema, req.params.subscriptionId);
    await groupContext(groupId, req.user);
    const result = await getDb().run(
      `UPDATE server_subscriptions SET status = 'cancelled', cancelled_at = ?
       WHERE id = ? AND group_id = ? AND user_id = ? AND status = 'active'`,
      [Date.now(), subscriptionId, groupId, req.user.id],
    );
    if (!result.changes) throw notFound('Active subscription not found.');
    return res.json({ ok: true });
  }),
);

groupsRouter.get(
  '/:groupId/moderation',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const context = await groupContext(groupId, req.user);
    if (
      !context.can('viewAuditLog') &&
      !context.can('banMembers') &&
      !context.can('moderateMembers')
    ) {
      throw forbidden('Moderation permission is required.');
    }
    const [bans, timeouts, rules, actions, auditRows] = await Promise.all([
      getDb().all(
        `SELECT b.*, u.username, u.display_name FROM server_bans b
         JOIN users u ON u.id = b.user_id WHERE b.group_id = ? ORDER BY b.created_at DESC`,
        [groupId],
      ),
      getDb().all(
        `SELECT t.*, u.username, u.display_name FROM server_timeouts t
         JOIN users u ON u.id = t.user_id WHERE t.group_id = ? AND t.expires_at > ?
         ORDER BY t.expires_at`,
        [groupId, Date.now()],
      ),
      getDb().all('SELECT * FROM automod_rules WHERE group_id = ? ORDER BY created_at DESC', [groupId]),
      getDb().all(
        `SELECT a.*, u.username, u.display_name, r.name AS rule_name
         FROM automod_actions a JOIN users u ON u.id = a.user_id
         LEFT JOIN automod_rules r ON r.id = a.rule_id
         WHERE a.group_id = ? ORDER BY a.created_at DESC LIMIT 100`,
        [groupId],
      ),
      listAuditLogs({ limit: 500 }),
    ]);
    return res.json({
      bans: bans.map(toServerSanction),
      timeouts: timeouts.map(toServerSanction),
      rules: rules.map(toAutoModRule),
      actions: actions.map((row) => ({
        id: row.id,
        userId: row.user_id,
        username: row.username,
        displayName: row.display_name,
        ruleName: row.rule_name ?? null,
        action: row.action,
        matchedValue: row.matched_value,
        createdAt: Number(row.created_at),
      })),
      audit: auditRows.filter((entry) => entry.meta?.groupId === groupId).slice(0, 100),
    });
  }),
);

groupsRouter.put(
  '/:groupId/members/:userId/timeout',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const userId = parse(idSchema, req.params.userId);
    const context = await requireGroupPermission(groupId, req.user, 'moderateMembers');
    const body = parse(
      z.object({
        durationSeconds: z.number().int().min(0).max(28 * 86400),
        reason: z.string().trim().max(300).optional().nullable(),
      }),
      req.body,
    );
    if (!(await context.outranksMember(userId))) {
      throw forbidden('You can only timeout members below your highest role.');
    }
    if (body.durationSeconds === 0) {
      await getDb().run('DELETE FROM server_timeouts WHERE group_id = ? AND user_id = ?', [groupId, userId]);
    } else {
      await getDb().run(
        `INSERT INTO server_timeouts
          (group_id, user_id, reason, expires_at, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (group_id, user_id)
         DO UPDATE SET reason = excluded.reason, expires_at = excluded.expires_at,
           created_by = excluded.created_by, created_at = excluded.created_at`,
        [groupId, userId, body.reason ?? null, Date.now() + body.durationSeconds * 1000, req.user.id, Date.now()],
      );
    }
    await audit({ actorId: req.user.id, action: body.durationSeconds ? 'group.member_timeout' : 'group.member_untimeout', targetType: 'user', targetId: userId, meta: { groupId, reason: body.reason } });
    return res.json({ ok: true });
  }),
);

groupsRouter.put(
  '/:groupId/bans/:userId',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const userId = parse(idSchema, req.params.userId);
    const context = await requireGroupPermission(groupId, req.user, 'banMembers');
    const body = parse(z.object({ reason: z.string().trim().max(300).optional().nullable() }), req.body ?? {});
    const target = await getDb().get('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, userId]);
    if (!target) throw notFound('Server member not found.');
    if (!(await context.outranksMember(userId))) {
      throw forbidden('You can only ban members below your highest role.');
    }
    await getDb().tx(async (tx) => {
      await tx.run(
        `INSERT INTO server_bans (group_id, user_id, reason, banned_by, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (group_id, user_id)
         DO UPDATE SET reason = excluded.reason, banned_by = excluded.banned_by, created_at = excluded.created_at`,
        [groupId, userId, body.reason ?? null, req.user.id, Date.now()],
      );
      await tx.run(
        'DELETE FROM server_member_roles WHERE group_id = ? AND user_id = ?',
        [groupId, userId],
      );
      await tx.run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, userId]);
    });
    await refreshUserRooms(userId);
    await audit({ actorId: req.user.id, action: 'group.member_ban', targetType: 'user', targetId: userId, meta: { groupId, reason: body.reason } });
    return res.json({ ok: true });
  }),
);

groupsRouter.delete(
  '/:groupId/bans/:userId',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const userId = parse(idSchema, req.params.userId);
    await requireGroupPermission(groupId, req.user, 'banMembers');
    const result = await getDb().run('DELETE FROM server_bans WHERE group_id = ? AND user_id = ?', [groupId, userId]);
    if (!result.changes) throw notFound('Ban not found.');
    await audit({ actorId: req.user.id, action: 'group.member_unban', targetType: 'user', targetId: userId, meta: { groupId } });
    return res.json({ ok: true });
  }),
);

groupsRouter.post(
  '/:groupId/automod-rules',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const context = await groupContext(groupId, req.user);
    if (!context.can('manageGroup')) throw forbidden('Manage Server permission is required.');
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(80),
        triggerType: z.enum(['keyword', 'regex']).default('keyword'),
        triggerValue: z.string().trim().min(1).max(500),
        action: z.enum(['block', 'timeout']).default('block'),
        timeoutSeconds: z.number().int().min(60).max(28 * 86400).default(600),
      }),
      req.body,
    );
    if (body.triggerType === 'regex') {
      try { new RegExp(body.triggerValue, 'iu'); } catch { throw badRequest('AutoMod regular expression is invalid.'); }
    }
    const id = newId();
    await getDb().run(
      `INSERT INTO automod_rules
        (id, group_id, name, trigger_type, trigger_value, action, timeout_seconds,
         enabled, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [id, groupId, body.name, body.triggerType, body.triggerValue, body.action, body.timeoutSeconds, req.user.id, Date.now(), Date.now()],
    );
    return res.status(201).json({ rule: toAutoModRule(await getDb().get('SELECT * FROM automod_rules WHERE id = ?', [id])) });
  }),
);

groupsRouter.delete(
  '/:groupId/automod-rules/:ruleId',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const ruleId = parse(idSchema, req.params.ruleId);
    const context = await groupContext(groupId, req.user);
    if (!context.can('manageGroup')) throw forbidden('Manage Server permission is required.');
    const result = await getDb().run('DELETE FROM automod_rules WHERE id = ? AND group_id = ?', [ruleId, groupId]);
    if (!result.changes) throw notFound('AutoMod rule not found.');
    return res.json({ ok: true });
  }),
);

groupsRouter.get(
  '/:groupId/channel-follows',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const context = await groupContext(groupId, req.user);
    if (!context.can('manageChannels')) throw forbidden('Manage Channels permission is required.');
    const rows = await getDb().all(
      `SELECT f.source_channel_id, f.target_channel_id, f.created_at,
              sc.name AS source_name, tc.name AS target_name
       FROM channel_follows f
       JOIN channels sc ON sc.id = f.source_channel_id
       JOIN channels tc ON tc.id = f.target_channel_id
       WHERE tc.group_id = ? ORDER BY f.created_at DESC`,
      [groupId],
    );
    return res.json({
      follows: rows.map((row) => ({
        sourceChannelId: row.source_channel_id,
        sourceName: row.source_name,
        targetChannelId: row.target_channel_id,
        targetName: row.target_name,
        createdAt: Number(row.created_at),
      })),
    });
  }),
);

groupsRouter.post(
  '/:groupId/channel-follows',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const context = await groupContext(groupId, req.user);
    if (!context.can('manageChannels')) throw forbidden('Manage Channels permission is required.');
    const body = parse(
      z.object({ sourceChannelId: idSchema, targetChannelId: idSchema }),
      req.body,
    );
    const [source, target] = await Promise.all([
      getChannel(body.sourceChannelId),
      getChannel(body.targetChannelId),
    ]);
    if (!source || source.type !== 'announcement') throw badRequest('Source must be an announcement channel.');
    if (!target || target.group_id !== groupId || target.type !== 'text') {
      throw badRequest('Target must be a text channel in this server.');
    }
    await groupContext(source.group_id, req.user);
    await getDb().run(
      `INSERT INTO channel_follows
        (source_channel_id, target_channel_id, followed_by, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (source_channel_id, target_channel_id) DO NOTHING`,
      [source.id, target.id, req.user.id, Date.now()],
    );
    return res.status(201).json({ followed: true });
  }),
);

groupsRouter.delete(
  '/:groupId/channel-follows/:sourceChannelId/:targetChannelId',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const sourceChannelId = parse(idSchema, req.params.sourceChannelId);
    const targetChannelId = parse(idSchema, req.params.targetChannelId);
    const context = await groupContext(groupId, req.user);
    if (!context.can('manageChannels')) throw forbidden('Manage Channels permission is required.');
    await getDb().run(
      `DELETE FROM channel_follows
       WHERE source_channel_id = ? AND target_channel_id = ?
         AND target_channel_id IN (SELECT id FROM channels WHERE group_id = ?)`,
      [sourceChannelId, targetChannelId, groupId],
    );
    return res.json({ ok: true });
  }),
);

const updateGroupSchema = z.object({
  name: z.string().trim().min(2).max(64).optional(),
  description: z.string().trim().max(300).nullable().optional(),
  iconUrl: z.string().trim().max(300).nullable().optional(),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  requestDiscovery: z.boolean().optional(),
  require2faModeration: z.boolean().optional(),
});

groupsRouter.patch(
  '/:groupId',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    await requireGroupPermission(groupId, req.user, 'manageGroup');
    const body = parse(updateGroupSchema, req.body);
    if (body.require2faModeration && !req.user.totp_enabled) {
      throw badRequest('Enable two-factor authentication on your account first.');
    }

    const columns = { name: 'name', description: 'description', iconUrl: 'icon_url', accentColor: 'accent_color' };
    const sets = [];
    const params = [];
    for (const [key, column] of Object.entries(columns)) {
      if (body[key] === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(body[key]);
    }
    if (body.requestDiscovery !== undefined) {
      sets.push('discovery_requested = ?', 'discoverable = ?', 'discovery_verified_by = NULL', 'discovery_verified_at = NULL');
      params.push(body.requestDiscovery ? 1 : 0, 0);
    }
    if (body.require2faModeration !== undefined) {
      sets.push('require_2fa_moderation = ?');
      params.push(body.require2faModeration ? 1 : 0);
    }
    if (!sets.length) throw badRequest('Nothing to update.');
    sets.push('updated_at = ?');
    params.push(Date.now(), groupId);

    await getDb().run(`UPDATE chat_groups SET ${sets.join(', ')} WHERE id = ?`, params);
    await invalidateGroup(groupId);

    const updated = await getDb().get('SELECT * FROM chat_groups WHERE id = ?', [groupId]);
    emitToGroup(groupId, 'group:updated', { group: toGroup(updated) });
    await audit({ actorId: req.user.id, action: 'group.update', targetType: 'group', targetId: groupId });
    return res.json({ group: toGroup(updated) });
  }),
);

groupsRouter.put(
  '/:groupId/icon',
  writeLimiter,
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    await requireGroupPermission(groupId, req.user, 'manageGroup');
    const { attachmentId } = parse(
      z.object({ attachmentId: idSchema.nullable() }),
      req.body,
    );

    let iconUrl = null;
    if (attachmentId) {
      const attachment = await getDb().get(
        `SELECT * FROM attachments
         WHERE id = ? AND uploader_id = ? AND message_id IS NULL
           AND quarantined_at IS NULL AND scan_status != 'infected'`,
        [attachmentId, req.user.id],
      );
      if (!attachment) throw notFound('Uploaded server icon not found.');
      if (!attachment.mime.startsWith('image/')) {
        throw badRequest('Server icons must be image files.');
      }
      if (Number(attachment.size) > 8 * 1024 * 1024) {
        throw badRequest('Server icons must be 8 MB or smaller.');
      }
      iconUrl = `/api/files/${attachment.id}`;
    }

    await getDb().run(
      'UPDATE chat_groups SET icon_url = ?, updated_at = ? WHERE id = ?',
      [iconUrl, Date.now(), groupId],
    );
    await invalidateGroup(groupId);
    const updated = await getDb().get('SELECT * FROM chat_groups WHERE id = ?', [groupId]);
    const group = toGroup(updated);
    emitToGroup(groupId, 'group:updated', { group });
    await audit({
      actorId: req.user.id,
      action: attachmentId ? 'group.icon.update' : 'group.icon.remove',
      targetType: 'group',
      targetId: groupId,
      meta: attachmentId ? { attachmentId } : null,
    });
    return res.json({ group });
  }),
);

const channelOverrideSchema = z.object({
  targetType: z.enum(['everyone', 'role', 'member']),
  targetId: idSchema.optional(),
  allow: z.array(z.enum(CHANNEL_PERMISSION_KEYS)).max(CHANNEL_PERMISSION_KEYS.length).default([]),
  deny: z.array(z.enum(CHANNEL_PERMISSION_KEYS)).max(CHANNEL_PERMISSION_KEYS.length).default([]),
});

async function requireChannelManagement(groupId, channelId, user) {
  const [context, channel] = await Promise.all([
    groupContext(groupId, user),
    getChannel(channelId),
  ]);
  if (!channel || channel.group_id !== groupId) throw notFound('Channel not found.');
  if (!(await channelPermission(channel, context, 'manageChannels'))) {
    throw forbidden('Manage Channels permission is required for this channel.');
  }
  return { context, channel };
}

groupsRouter.get(
  '/:groupId/channels/:channelId/overrides',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const channelId = parse(idSchema, req.params.channelId);
    await requireChannelManagement(groupId, channelId, req.user);
    const channel = await getChannel(channelId);
    if (!channel || channel.group_id !== groupId) throw notFound('Channel not found.');
    return res.json({ overrides: await listChannelOverrides(groupId, channelId) });
  }),
);

groupsRouter.put(
  '/:groupId/channels/:channelId/overrides',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const channelId = parse(idSchema, req.params.channelId);
    await requireChannelManagement(groupId, channelId, req.user);
    const body = parse(channelOverrideSchema, req.body);
    const channel = await getChannel(channelId);
    if (!channel || channel.group_id !== groupId) throw notFound('Channel not found.');
    const targetId = body.targetType === 'everyone' ? groupId : body.targetId;
    if (!targetId) throw badRequest('Choose a role or member for this override.');
    if (body.targetType === 'role') {
      const role = await getServerRole(groupId, targetId);
      if (role.isDefault) throw badRequest('Use the @everyone override for the default role.');
    }
    if (body.targetType === 'member') {
      const member = await getDb().get(
        'SELECT 1 AS ok FROM group_members WHERE group_id = ? AND user_id = ?',
        [groupId, targetId],
      );
      if (!member) throw badRequest('That member is not in this server.');
    }
    await setChannelOverride({
      groupId,
      channelId,
      targetType: body.targetType,
      targetId,
      allow: body.allow,
      deny: body.deny,
      updatedBy: req.user.id,
    });
    const affectedMembers = await getDb().all(
      'SELECT user_id FROM group_members WHERE group_id = ?',
      [groupId],
    );
    await Promise.all(affectedMembers.map((member) => refreshUserRooms(member.user_id)));
    emitToGroup(groupId, 'channel:permissions-updated', { groupId, channelId });
    return res.json({ overrides: await listChannelOverrides(groupId, channelId) });
  }),
);

groupsRouter.delete(
  '/:groupId/channels/:channelId/overrides/:targetType/:targetId',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const channelId = parse(idSchema, req.params.channelId);
    await requireChannelManagement(groupId, channelId, req.user);
    const targetType = parse(z.enum(['everyone', 'role', 'member']), req.params.targetType);
    const targetId = parse(idSchema, req.params.targetId);
    const channel = await getChannel(channelId);
    if (!channel || channel.group_id !== groupId) throw notFound('Channel not found.');
    await deleteChannelOverride(channelId, targetType, targetId);
    const affectedMembers = await getDb().all(
      'SELECT user_id FROM group_members WHERE group_id = ?',
      [groupId],
    );
    await Promise.all(affectedMembers.map((member) => refreshUserRooms(member.user_id)));
    emitToGroup(groupId, 'channel:permissions-updated', { groupId, channelId });
    return res.json({ ok: true });
  }),
);

groupsRouter.post(
  '/:groupId/channels/:channelId/permissions/sync',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const channelId = parse(idSchema, req.params.channelId);
    await requireChannelManagement(groupId, channelId, req.user);
    const channel = await getChannel(channelId);
    if (!channel || channel.group_id !== groupId) throw notFound('Channel not found.');
    if (!channel.category_id) throw badRequest('Move this channel into a category before syncing permissions.');
    await getDb().tx(async (tx) => {
      await tx.run('DELETE FROM channel_permission_overrides WHERE channel_id = ?', [channelId]);
      await tx.run(
        'UPDATE channels SET permissions_synced = 1, updated_at = ? WHERE id = ?',
        [Date.now(), channelId],
      );
    });
    const affectedMembers = await getDb().all(
      'SELECT user_id FROM group_members WHERE group_id = ?',
      [groupId],
    );
    await Promise.all(affectedMembers.map((member) => refreshUserRooms(member.user_id)));
    emitToGroup(groupId, 'channel:permissions-updated', { groupId, channelId });
    return res.json({ channel: toChannel(await getChannel(channelId)) });
  }),
);

groupsRouter.get(
  '/:groupId/categories/:categoryId/overrides',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const categoryId = parse(idSchema, req.params.categoryId);
    await requireGroupPermission(groupId, req.user, 'manageChannels');
    const category = await getDb().get(
      'SELECT id FROM channel_categories WHERE id = ? AND group_id = ?',
      [categoryId, groupId],
    );
    if (!category) throw notFound('Category not found.');
    return res.json({ overrides: await listCategoryOverrides(groupId, categoryId) });
  }),
);

groupsRouter.put(
  '/:groupId/categories/:categoryId/overrides',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const categoryId = parse(idSchema, req.params.categoryId);
    await requireGroupPermission(groupId, req.user, 'manageChannels');
    const body = parse(channelOverrideSchema, req.body);
    const category = await getDb().get(
      'SELECT id FROM channel_categories WHERE id = ? AND group_id = ?',
      [categoryId, groupId],
    );
    if (!category) throw notFound('Category not found.');
    const targetId = body.targetType === 'everyone' ? groupId : body.targetId;
    if (!targetId) throw badRequest('Choose a role or member for this override.');
    if (body.targetType === 'role') await getServerRole(groupId, targetId);
    if (body.targetType === 'member') {
      const member = await getDb().get(
        'SELECT 1 AS ok FROM group_members WHERE group_id = ? AND user_id = ?',
        [groupId, targetId],
      );
      if (!member) throw badRequest('That member is not in this server.');
    }
    await setCategoryOverride({
      groupId,
      categoryId,
      targetType: body.targetType,
      targetId,
      allow: body.allow,
      deny: body.deny,
      updatedBy: req.user.id,
    });
    const affectedMembers = await getDb().all(
      'SELECT user_id FROM group_members WHERE group_id = ?',
      [groupId],
    );
    await Promise.all(affectedMembers.map((member) => refreshUserRooms(member.user_id)));
    emitToGroup(groupId, 'category:permissions-updated', { groupId, categoryId });
    return res.json({ overrides: await listCategoryOverrides(groupId, categoryId) });
  }),
);

groupsRouter.delete(
  '/:groupId/categories/:categoryId/overrides/:targetType/:targetId',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const categoryId = parse(idSchema, req.params.categoryId);
    await requireGroupPermission(groupId, req.user, 'manageChannels');
    const targetType = parse(z.enum(['everyone', 'role', 'member']), req.params.targetType);
    const targetId = parse(idSchema, req.params.targetId);
    await deleteCategoryOverride(categoryId, targetType, targetId);
    const affectedMembers = await getDb().all(
      'SELECT user_id FROM group_members WHERE group_id = ?',
      [groupId],
    );
    await Promise.all(affectedMembers.map((member) => refreshUserRooms(member.user_id)));
    emitToGroup(groupId, 'category:permissions-updated', { groupId, categoryId });
    return res.json({ ok: true });
  }),
);

groupsRouter.delete(
  '/:groupId',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const context = await requireGroupPermission(groupId, req.user, 'deleteGroup');

    const channels = await listChannels(groupId);
    await deleteGroup(groupId);
    for (const channel of channels) closeVoiceChannel(channel.id, getIo());

    emitToGroup(groupId, 'group:deleted', { groupId });
    await audit({
      actorId: req.user.id,
      action: 'group.delete',
      targetType: 'group',
      targetId: groupId,
      meta: { name: context.group.name },
      ip: clientIp(req),
    });
    return res.json({ ok: true });
  }),
);

// ------------------------------------------------------------------ server roles

const serverPermissionSchema = z.enum(SERVER_PERMISSION_KEYS);
const optionalRoleColor = z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional();
const serverRoleCreateSchema = z.object({
  name: z.string().trim().min(1).max(64),
  color: optionalRoleColor,
  secondaryColor: optionalRoleColor,
  tertiaryColor: optionalRoleColor,
  unicodeEmoji: z.string().trim().min(1).max(16).nullable().optional(),
  iconAttachmentId: idSchema.nullable().optional(),
  hoist: z.boolean().optional().default(false),
  mentionable: z.boolean().optional().default(false),
  inPrompt: z.boolean().optional().default(false),
  permissions: z.array(serverPermissionSchema).max(SERVER_PERMISSION_KEYS.length).default([]),
});
const serverRoleUpdateSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  color: optionalRoleColor,
  secondaryColor: optionalRoleColor,
  tertiaryColor: optionalRoleColor,
  unicodeEmoji: z.string().trim().min(1).max(16).nullable().optional(),
  iconAttachmentId: idSchema.nullable().optional(),
  position: z.coerce.number().int().min(0).max(999_999).optional(),
  hoist: z.boolean().optional(),
  mentionable: z.boolean().optional(),
  inPrompt: z.boolean().optional(),
  permissions: z.array(serverPermissionSchema).max(SERVER_PERMISSION_KEYS.length).optional(),
});

function assertGrantablePermissions(context, permissions) {
  for (const permission of permissions ?? []) {
    if (!context.can(permission)) {
      throw forbidden(`You cannot grant the ${permission} permission because you do not have it.`);
    }
  }
}

async function assertRoleIcon(iconAttachmentId, userId) {
  if (!iconAttachmentId) return;
  const attachment = await getDb().get(
    `SELECT id FROM attachments
     WHERE id = ? AND uploader_id = ? AND message_id IS NULL
       AND mime LIKE 'image/%' AND quarantined_at IS NULL
       AND scan_status != 'infected'`,
    [iconAttachmentId, userId],
  );
  if (!attachment) throw badRequest('Role icon upload was not found.');
}

function baseMemberPosition(role) {
  if (role === 'owner') return Number.MAX_SAFE_INTEGER;
  if (role === 'admin') return 2_000_000;
  if (role === 'moderator') return 1_000_000;
  return 0;
}

groupsRouter.get(
  '/:groupId/roles',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    await groupContext(groupId, req.user);
    return res.json({ roles: await listServerRoles(groupId) });
  }),
);

groupsRouter.post(
  '/:groupId/roles',
  writeLimiter,
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const context = await requireGroupPermission(groupId, req.user, 'manageRoles');
    const body = parse(serverRoleCreateSchema, req.body);
    await assertRoleIcon(body.iconAttachmentId, req.user.id);
    assertGrantablePermissions(context, body.permissions);
    const role = await createServerRole({
      groupId,
      ...body,
      createdBy: req.user.id,
      maxPosition: context.highestRolePosition,
    });
    await invalidateGroup(groupId);
    emitToGroup(groupId, 'group:roles-updated', { groupId });
    await audit({
      actorId: req.user.id,
      action: 'group.role_created',
      targetType: 'server_role',
      targetId: role.id,
      meta: { groupId, name: role.name, permissions: role.permissions },
      ip: clientIp(req),
    });
    return res.status(201).json({ role });
  }),
);

groupsRouter.put(
  '/:groupId/roles/reorder',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const context = await requireGroupPermission(groupId, req.user, 'manageRoles');
    const { roleIds } = parse(
      z.object({ roleIds: z.array(idSchema).min(1).max(250) }),
      req.body,
    );
    if (new Set(roleIds).size !== roleIds.length) throw badRequest('Role order contains duplicates.');
    const roles = await listServerRoles(groupId);
    if (roles.length !== roleIds.length || roles.some((role) => !roleIds.includes(role.id))) {
      throw badRequest('Role order must include every server role exactly once.');
    }
    const defaultRole = roles.find((role) => role.isDefault);
    if (defaultRole && roleIds.at(-1) !== defaultRole.id) {
      throw badRequest('The @everyone role must remain at the bottom of the role list.');
    }
    if (!context.isPlatformAdmin && context.role !== 'owner') {
      const currentOrder = roles.map((role) => role.id);
      const protectedRoles = roles.filter(
        (role) => !role.isDefault && role.position >= context.highestRolePosition,
      );
      if (
        protectedRoles.some(
          (role) => currentOrder.indexOf(role.id) !== roleIds.indexOf(role.id),
        )
      ) {
        throw forbidden('You can only reorder roles below your highest role.');
      }
    }
    const customRoleCount = roles.filter((role) => !role.isDefault).length;
    await getDb().tx(async (tx) => {
      for (let index = 0; index < roleIds.length; index += 1) {
        const role = roles.find((item) => item.id === roleIds[index]);
        await tx.run(
          'UPDATE server_roles SET position = ?, updated_at = ? WHERE id = ? AND group_id = ?',
          [role?.isDefault ? 0 : customRoleCount - index, Date.now(), roleIds[index], groupId],
        );
      }
    });
    await invalidateGroup(groupId);
    emitToGroup(groupId, 'group:roles-updated', { groupId });
    return res.json({ roles: await listServerRoles(groupId) });
  }),
);

groupsRouter.patch(
  '/:groupId/roles/:roleId',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const roleId = parse(idSchema, req.params.roleId);
    const context = await requireGroupPermission(groupId, req.user, 'manageRoles');
    const existing = await getServerRole(groupId, roleId);
    if (!context.isPlatformAdmin && context.role !== 'owner' && existing.position >= context.highestRolePosition) {
      throw forbidden('You can only edit roles below your highest role.');
    }
    const body = parse(serverRoleUpdateSchema, req.body);
    await assertRoleIcon(body.iconAttachmentId, req.user.id);
    if (
      body.position !== undefined &&
      !context.isPlatformAdmin &&
      context.role !== 'owner' &&
      body.position >= context.highestRolePosition
    ) {
      throw forbidden('You cannot move a role to or above your highest role.');
    }
    assertGrantablePermissions(context, body.permissions);
    const role = await updateServerRole(groupId, roleId, body);
    await invalidateGroup(groupId);
    emitToGroup(groupId, 'group:roles-updated', { groupId });
    await audit({
      actorId: req.user.id,
      action: 'group.role_updated',
      targetType: 'server_role',
      targetId: roleId,
      meta: { groupId, ...body },
    });
    return res.json({ role });
  }),
);

groupsRouter.delete(
  '/:groupId/roles/:roleId',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const roleId = parse(idSchema, req.params.roleId);
    const context = await requireGroupPermission(groupId, req.user, 'manageRoles');
    const role = await getServerRole(groupId, roleId);
    if (!context.isPlatformAdmin && context.role !== 'owner' && role.position >= context.highestRolePosition) {
      throw forbidden('You can only delete roles below your highest role.');
    }
    await deleteServerRole(groupId, roleId);
    await invalidateGroup(groupId);
    emitToGroup(groupId, 'group:roles-updated', { groupId });
    await audit({
      actorId: req.user.id,
      action: 'group.role_deleted',
      targetType: 'server_role',
      targetId: roleId,
      meta: { groupId, name: role.name },
    });
    return res.json({ ok: true });
  }),
);

groupsRouter.put(
  '/:groupId/members/:userId/roles/:roleId',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const userId = parse(idSchema, req.params.userId);
    const roleId = parse(idSchema, req.params.roleId);
    const context = await requireGroupPermission(groupId, req.user, 'manageRoles');
    const { granted } = parse(z.object({ granted: z.boolean() }), req.body);
    const [role, target, targetRoleState] = await Promise.all([
      getServerRole(groupId, roleId),
      getDb().get('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, userId]),
      roleStateForMember(groupId, userId),
    ]);
    if (!target) throw notFound('That user is not in this server.');
    if (role.managed) {
      throw forbidden('Integration-managed roles can only be assigned by their integration.');
    }
    if (target.role === 'owner') throw forbidden('The server owner role cannot be changed.');
    const targetPosition = Math.max(baseMemberPosition(target.role), targetRoleState.highestPosition);
    if (
      !context.isPlatformAdmin &&
      context.role !== 'owner' &&
      (role.position >= context.highestRolePosition || targetPosition >= context.highestRolePosition)
    ) {
      throw forbidden('You can only manage members and roles below your highest role.');
    }
    assertGrantablePermissions(context, role.permissions);
    await setServerMemberRole({ groupId, userId, roleId, assignedBy: req.user.id, granted });
    await invalidateGroup(groupId);
    emitToGroup(groupId, 'group:member-roles-updated', { groupId, userId, roleId, granted });
    await audit({
      actorId: req.user.id,
      action: 'group.member_role_changed',
      targetType: 'user',
      targetId: userId,
      meta: { groupId, roleId, granted },
    });
    return res.json({ ok: true });
  }),
);

groupsRouter.put(
  '/:groupId/onboarding/roles/:roleId',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const roleId = parse(idSchema, req.params.roleId);
    const context = await groupContext(groupId, req.user);
    if (context.timedOutUntil) {
      throw forbidden('You cannot change onboarding roles while timed out.');
    }
    const role = await getServerRole(groupId, roleId);
    if (role.isDefault || role.managed || !role.inPrompt) {
      throw forbidden('That role is not available in server onboarding.');
    }
    const body = parse(z.object({ assigned: z.boolean() }), req.body);
    await setServerMemberRole({
      groupId,
      userId: req.user.id,
      roleId,
      assignedBy: req.user.id,
      granted: body.assigned,
    });
    await invalidateGroup(groupId);
    await refreshUserRooms(req.user.id);
    emitToGroup(groupId, 'group:member-updated', {
      groupId,
      userId: req.user.id,
    });
    await audit({
      actorId: req.user.id,
      action: body.assigned ? 'group.onboarding_role_added' : 'group.onboarding_role_removed',
      targetType: 'server_role',
      targetId: roleId,
      meta: { groupId },
    });
    return res.json({ assigned: body.assigned });
  }),
);

// ------------------------------------------------------------------ members

groupsRouter.get(
  '/:groupId/members',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    await groupContext(groupId, req.user);
    return res.json({ members: await listMembers(groupId) });
  }),
);

/**
 * Direct add — this is the flow the brief calls for: a YouTuber picks people
 * from the directory and grants them access to their group immediately.
 */
groupsRouter.post(
  '/:groupId/members',
  writeLimiter,
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const context = await requireGroupPermission(groupId, req.user, 'manageMembers');
    const body = parse(
      z.object({
        userId: idSchema,
        role: z.enum(['admin', 'moderator', 'member']).default('member'),
      }),
      req.body,
    );
    if (
      body.role === 'admin' &&
      !context.isPlatformAdmin &&
      context.role !== 'owner'
    ) {
      throw forbidden('Only the server owner can add another legacy administrator.');
    }

    const target = await findUserById(body.userId);
    if (!target) throw notFound('User not found.');
    if (!(await canJoinGroup(target, context.group))) {
      throw forbidden('That account belongs to another streamer roster. Request access first.');
    }

    await addMember({
      groupId,
      userId: body.userId,
      role: body.role,
      invitedBy: req.user.id,
    });

    // System message so the channel history explains itself.
    const [firstChannel] = await listChannels(groupId);
    if (firstChannel) {
      await createMessage({
        channelId: firstChannel.id,
        authorId: req.user.id,
        content: `${target.display_name} was added to the group.`,
        type: 'system',
      }).catch(() => {});
    }

    await refreshUserRooms(body.userId);
    const member = await getPublicUser(body.userId);
    emitToGroup(groupId, 'group:member-added', { groupId, member: { ...member, memberRole: body.role, serverRoles: [] } });
    emitToUser(body.userId, 'group:joined', { groupId });

    await audit({
      actorId: req.user.id,
      action: 'group.member_added',
      targetType: 'user',
      targetId: body.userId,
      meta: { groupId, role: body.role },
      ip: clientIp(req),
    });

    return res.status(201).json({ member: { ...member, memberRole: body.role, serverRoles: [] } });
  }),
);

groupsRouter.patch(
  '/:groupId/members/:userId',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const userId = parse(idSchema, req.params.userId);
    const context = await groupContext(groupId, req.user);
    const editingSelf = userId === req.user.id;
    const body = parse(
      z.object({
        nickname: z.string().trim().max(32).nullable().optional(),
        role: z.enum(['admin', 'moderator', 'member']).optional(),
      }),
      req.body,
    );
    if (
      body.nickname !== undefined &&
      ((!editingSelf && !context.can('manageNicknames')) ||
        (editingSelf && !context.can('changeNickname') && !context.can('manageNicknames')))
    ) {
      throw forbidden('You do not have permission to change that nickname.');
    }
    if (body.role !== undefined && !context.can('manageMembers')) {
      throw forbidden('You do not have permission to change member access.');
    }
    if (
      body.role === 'admin' &&
      !context.isPlatformAdmin &&
      context.role !== 'owner'
    ) {
      throw forbidden('Only the server owner can appoint a legacy administrator.');
    }
    if (body.nickname === undefined && body.role === undefined) {
      throw badRequest('Nothing to update.');
    }

    const target = await getDb().get(
      'SELECT * FROM group_members WHERE group_id = ? AND user_id = ?',
      [groupId, userId],
    );
    if (!target) throw notFound('That user is not in this group.');
    if (!editingSelf && target.role === 'owner') {
      throw forbidden('The server owner nickname cannot be managed by another member.');
    }
    if (!editingSelf && !(await context.outranksMember(userId))) {
      throw forbidden('You can only manage members below your highest role.');
    }

    if (body.nickname !== undefined) {
      await getDb().run(
        'UPDATE group_members SET nickname = ? WHERE group_id = ? AND user_id = ?',
        [body.nickname, groupId, userId],
      );
      await invalidateGroup(groupId);
    }
    if (body.role !== undefined) {
      if (target.role === 'owner' || editingSelf) {
        throw forbidden('You cannot change that member’s legacy access level.');
      }
      if (
        !context.isPlatformAdmin &&
        context.role !== 'owner' &&
        (target.role === 'admin' || (context.role !== 'admin' && body.role !== 'member'))
      ) {
        throw forbidden('You can only change access levels below your own.');
      }
      await setMemberRole({ groupId, userId, role: body.role });
    }

    emitToGroup(groupId, 'group:member-updated', {
      groupId,
      userId,
      memberRole: body.role ?? target.role,
      nickname: body.nickname ?? target.nickname ?? null,
    });
    await audit({
      actorId: req.user.id,
      action: 'group.member_updated',
      targetType: 'user',
      targetId: userId,
      meta: {
        groupId,
        nicknameChanged: body.nickname !== undefined,
        role: body.role,
      },
    });

    return res.json({ ok: true });
  }),
);

groupsRouter.delete(
  '/:groupId/members/:userId',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const userId = parse(idSchema, req.params.userId);
    const context = await groupContext(groupId, req.user);

    const leavingSelf = userId === req.user.id;
    if (!leavingSelf && !context.can('kickMember')) {
      throw forbidden('You do not have permission to remove members.');
    }

    const target = await getDb().get(
      'SELECT * FROM group_members WHERE group_id = ? AND user_id = ?',
      [groupId, userId],
    );
    if (!target) throw notFound('That user is not in this group.');
    if (target.role === 'owner') {
      throw badRequest('The owner cannot leave. Transfer ownership or delete the group.');
    }
    if (!leavingSelf) {
      const targetRoleState = await roleStateForMember(groupId, userId);
      const targetPosition = Math.max(baseMemberPosition(target.role), targetRoleState.highestPosition);
      if (
        !context.isPlatformAdmin &&
        context.role !== 'owner' &&
        context.highestRolePosition <= targetPosition
      ) {
        throw forbidden('You can only remove members below your highest role.');
      }
    }

    await removeMember({ groupId, userId });

    emitToGroup(groupId, 'group:member-removed', { groupId, userId });
    emitToUser(userId, 'group:left', { groupId });
    // Drop their socket subscriptions for this group's rooms.
    const io = getIo();
    if (io) {
      const sockets = await io.in(rooms.user(userId)).fetchSockets();
      const channels = await listChannels(groupId);
      for (const socket of sockets) {
        socket.leave(rooms.group(groupId));
        for (const channel of channels) socket.leave(rooms.channel(channel.id));
      }
    }

    await audit({
      actorId: req.user.id,
      action: leavingSelf ? 'group.member_left' : 'group.member_removed',
      targetType: 'user',
      targetId: userId,
      meta: { groupId },
      ip: clientIp(req),
    });

    return res.json({ ok: true });
  }),
);

groupsRouter.post(
  '/:groupId/transfer',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const context = await groupContext(groupId, req.user);
    if (context.role !== 'owner' && !context.isPlatformAdmin) {
      throw forbidden('Only the owner can transfer a group.');
    }
    const body = parse(z.object({ userId: idSchema }), req.body);

    const target = await getDb().get(
      'SELECT * FROM group_members WHERE group_id = ? AND user_id = ?',
      [groupId, body.userId],
    );
    if (!target) throw notFound('That user is not in this group.');

    const db = getDb();
    await db.tx(async (tx) => {
      await tx.run("UPDATE group_members SET role = 'member' WHERE group_id = ? AND role = 'owner'", [
        groupId,
      ]);
      await tx.run("UPDATE group_members SET role = 'owner' WHERE group_id = ? AND user_id = ?", [
        groupId,
        body.userId,
      ]);
      await tx.run('UPDATE chat_groups SET owner_id = ?, updated_at = ? WHERE id = ?', [
        body.userId,
        Date.now(),
        groupId,
      ]);
    });
    await invalidateGroup(groupId);

    emitToGroup(groupId, 'group:ownership-transferred', { groupId, ownerId: body.userId });
    await audit({
      actorId: req.user.id,
      action: 'group.transfer_ownership',
      targetType: 'group',
      targetId: groupId,
      meta: { newOwner: body.userId },
      ip: clientIp(req),
    });
    return res.json({ ok: true });
  }),
);

// ------------------------------------------------------------------ invites

groupsRouter.get(
  '/:groupId/invites',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    await requireGroupPermission(groupId, req.user, 'createInvite');
    return res.json({ invites: await listInvites(groupId) });
  }),
);

groupsRouter.post(
  '/:groupId/invites',
  writeLimiter,
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    await requireGroupPermission(groupId, req.user, 'createInvite');
    const body = parse(
      z.object({
        maxUses: z.coerce.number().int().min(1).max(1000).nullable().optional(),
        expiresInHours: z.coerce.number().int().min(1).max(24 * 90).nullable().optional(),
      }),
      req.body ?? {},
    );

    const invite = await createInvite({
      groupId,
      createdBy: req.user.id,
      maxUses: body.maxUses ?? null,
      expiresInHours: body.expiresInHours ?? null,
    });
    await audit({
      actorId: req.user.id,
      action: 'group.invite_created',
      targetType: 'group',
      targetId: groupId,
    });
    return res.status(201).json({ invite: toInvite(invite) });
  }),
);

groupsRouter.delete(
  '/:groupId/invites/:inviteId',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const inviteId = parse(idSchema, req.params.inviteId);
    await requireGroupPermission(groupId, req.user, 'createInvite');
    await revokeInvite(inviteId);
    return res.json({ ok: true });
  }),
);

groupsRouter.post(
  '/join/:code',
  writeLimiter,
  asyncRoute(async (req, res) => {
    const code = String(req.params.code ?? '').trim();
    if (!/^[0-9a-z]{4,16}$/i.test(code)) throw badRequest('That invite code is malformed.');

    const invitedGroup = await getDb().get(
      `SELECT g.* FROM group_invites i
       JOIN chat_groups g ON g.id = i.group_id WHERE i.code = ?`,
      [code],
    );
    if (!invitedGroup) throw notFound('That invite does not exist.');
    if (!(await canJoinGroup(req.user, invitedGroup))) {
      throw forbidden('This invite is outside your streamer roster.');
    }
    const group = await redeemInvite(code, req.user.id);
    await refreshUserRooms(req.user.id);

    const member = await getPublicUser(req.user.id);
    emitToGroup(group.id, 'group:member-added', {
      groupId: group.id,
      member: { ...member, memberRole: 'member', serverRoles: [] },
    });
    await audit({
      actorId: req.user.id,
      action: 'group.invite_redeemed',
      targetType: 'group',
      targetId: group.id,
      ip: clientIp(req),
    });

    return res.json({ group: toGroup(group, { memberRole: 'member' }) });
  }),
);

// --------------------------------------------------------------- categories

groupsRouter.post(
  '/:groupId/categories',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    await requireGroupPermission(groupId, req.user, 'manageChannels');
    const { name } = parse(
      z.object({ name: z.string().trim().min(1).max(48) }),
      req.body,
    );
    const count = await getDb().get(
      'SELECT COUNT(*) AS count FROM channel_categories WHERE group_id = ?',
      [groupId],
    );
    if (Number(count?.count ?? 0) >= 50) {
      throw badRequest('This group has reached 50 channel categories.');
    }
    const category = {
      id: newId(),
      groupId,
      name,
      position: Number(count?.count ?? 0),
      createdAt: Date.now(),
    };
    await getDb().run(
      `INSERT INTO channel_categories (id, group_id, name, position, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [category.id, groupId, name, category.position, category.createdAt],
    );
    emitToGroup(groupId, 'category:created', { category });
    return res.status(201).json({ category });
  }),
);

groupsRouter.patch(
  '/:groupId/categories/:categoryId',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const categoryId = parse(idSchema, req.params.categoryId);
    await requireGroupPermission(groupId, req.user, 'manageChannels');
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(48).optional(),
        position: z.coerce.number().int().min(0).max(100).optional(),
      }),
      req.body,
    );
    const existing = await getDb().get(
      'SELECT * FROM channel_categories WHERE id = ? AND group_id = ?',
      [categoryId, groupId],
    );
    if (!existing) throw notFound('Category not found.');
    if (body.name === undefined && body.position === undefined) {
      throw badRequest('Nothing to update.');
    }
    const name = body.name ?? existing.name;
    const position = body.position ?? Number(existing.position);
    await getDb().run(
      'UPDATE channel_categories SET name = ?, position = ? WHERE id = ?',
      [name, position, categoryId],
    );
    const category = {
      id: categoryId,
      groupId,
      name,
      position,
      createdAt: Number(existing.created_at),
    };
    emitToGroup(groupId, 'category:updated', { category });
    return res.json({ category });
  }),
);

groupsRouter.delete(
  '/:groupId/categories/:categoryId',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const categoryId = parse(idSchema, req.params.categoryId);
    await requireGroupPermission(groupId, req.user, 'manageChannels');
    const existing = await getDb().get(
      'SELECT id FROM channel_categories WHERE id = ? AND group_id = ?',
      [categoryId, groupId],
    );
    if (!existing) throw notFound('Category not found.');
    await getDb().tx(async (tx) => {
      await tx.run(
        'UPDATE channels SET category_id = NULL, permissions_synced = 0 WHERE category_id = ?',
        [categoryId],
      );
      await tx.run('DELETE FROM category_permission_overrides WHERE category_id = ?', [categoryId]);
      await tx.run('DELETE FROM channel_categories WHERE id = ?', [categoryId]);
    });
    emitToGroup(groupId, 'category:deleted', { groupId, categoryId });
    return res.json({ ok: true });
  }),
);

// ----------------------------------------------------------------- channels

const channelSchema = z.object({
  name: z.string().trim().min(1).max(48),
  topic: z.string().trim().max(200).nullable().optional(),
  type: z.enum(['text', 'voice', 'forum', 'stage', 'announcement']).default('text'),
  isPrivate: z.boolean().default(false),
  slowmode: z.coerce.number().int().min(0).max(3600).default(0),
  memberIds: z.array(idSchema).max(200).optional(),
  categoryId: idSchema.nullable().optional(),
});

async function setPrivateChannelView({
  groupId,
  channelId,
  targetType,
  targetId,
  state,
  updatedBy,
}) {
  const current = (await listChannelOverrides(groupId, channelId)).find(
    (entry) => entry.targetType === targetType && entry.targetId === targetId,
  );
  const allow = new Set(current?.allow ?? []);
  const deny = new Set(current?.deny ?? []);
  allow.delete('viewChannel');
  deny.delete('viewChannel');
  if (state === 'allow') allow.add('viewChannel');
  if (state === 'deny') deny.add('viewChannel');
  if (!allow.size && !deny.size) {
    if (current) await deleteChannelOverride(channelId, targetType, targetId);
    return;
  }
  await setChannelOverride({
    groupId,
    channelId,
    targetType,
    targetId,
    allow: [...allow],
    deny: [...deny],
    updatedBy,
  });
}

groupsRouter.post(
  '/:groupId/channels',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    await requireGroupPermission(groupId, req.user, 'manageChannels');
    const body = parse(channelSchema, req.body);

    const count = await getDb().get('SELECT COUNT(*) AS count FROM channels WHERE group_id = ?', [
      groupId,
    ]);
    if (Number(count?.count ?? 0) >= 100) throw badRequest('This group has reached 100 channels.');

    const id = newId();
    const now = Date.now();
    const position = Number(count?.count ?? 0);

    if (body.categoryId) {
      const category = await getDb().get(
        'SELECT id FROM channel_categories WHERE id = ? AND group_id = ?',
        [body.categoryId, groupId],
      );
      if (!category) throw badRequest('Category does not belong to this group.');
    }

    await getDb().run(
      `INSERT INTO channels
       (id, group_id, category_id, name, topic, type, position, is_private,
        slowmode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        groupId,
        body.categoryId ?? null,
        body.name,
        body.topic ?? null,
        body.type,
        position,
        body.isPrivate ? 1 : 0,
        body.slowmode,
        now,
        now,
      ],
    );

    if (body.isPrivate) {
      const seats = new Set([req.user.id, ...(body.memberIds ?? [])]);
      await setPrivateChannelView({
        groupId,
        channelId: id,
        targetType: 'everyone',
        targetId: groupId,
        state: 'deny',
        updatedBy: req.user.id,
      });
      for (const userId of seats) {
        await getDb().run(
          'INSERT INTO channel_members (channel_id, user_id, added_at) VALUES (?, ?, ?)',
          [id, userId, now],
        );
        await setPrivateChannelView({
          groupId,
          channelId: id,
          targetType: 'member',
          targetId: userId,
          state: 'allow',
          updatedBy: req.user.id,
        });
      }
    }

    const channel = toChannel(await getChannel(id));
    emitToGroup(groupId, 'channel:created', { channel });

    const affectedMembers = await getDb().all(
      'SELECT user_id FROM group_members WHERE group_id = ?',
      [groupId],
    );
    await Promise.all(
      affectedMembers.map((member) => refreshUserRooms(member.user_id)),
    );

    await audit({
      actorId: req.user.id,
      action: 'channel.create',
      targetType: 'channel',
      targetId: id,
      meta: { groupId, name: body.name, type: body.type },
    });
    return res.status(201).json({ channel });
  }),
);

groupsRouter.patch(
  '/:groupId/channels/:channelId',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const channelId = parse(idSchema, req.params.channelId);
    await requireChannelManagement(groupId, channelId, req.user);
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(48).optional(),
        topic: z.string().trim().max(200).nullable().optional(),
        position: z.coerce.number().int().min(0).max(200).optional(),
        slowmode: z.coerce.number().int().min(0).max(3600).optional(),
        categoryId: idSchema.nullable().optional(),
        isPrivate: z.boolean().optional(),
      }),
      req.body,
    );

    const channel = await getChannel(channelId);
    if (!channel || channel.group_id !== groupId) throw notFound('Channel not found.');

    if (body.categoryId) {
      const category = await getDb().get(
        'SELECT id FROM channel_categories WHERE id = ? AND group_id = ?',
        [body.categoryId, groupId],
      );
      if (!category) throw badRequest('Category does not belong to this group.');
    }
    const columns = {
      name: 'name',
      topic: 'topic',
      position: 'position',
      slowmode: 'slowmode',
      categoryId: 'category_id',
      isPrivate: 'is_private',
    };
    const sets = [];
    const params = [];
    for (const [key, column] of Object.entries(columns)) {
      if (body[key] === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(key === 'isPrivate' ? (body[key] ? 1 : 0) : body[key]);
    }
    if (!sets.length) throw badRequest('Nothing to update.');
    if (
      body.categoryId !== undefined &&
      body.categoryId !== channel.category_id
    ) {
      sets.push('permissions_synced = ?');
      params.push(body.categoryId ? 1 : 0);
      await getDb().run(
        'DELETE FROM channel_permission_overrides WHERE channel_id = ?',
        [channelId],
      );
    }
    sets.push('updated_at = ?');
    params.push(Date.now(), channelId);

    await getDb().run(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`, params);
    if (
      body.isPrivate !== undefined &&
      body.isPrivate !== Boolean(channel.is_private)
    ) {
      if (body.isPrivate) {
        await getDb().run(
          `INSERT INTO channel_members (channel_id, user_id, added_at)
           VALUES (?, ?, ?) ON CONFLICT (channel_id, user_id) DO NOTHING`,
          [channelId, req.user.id, Date.now()],
        );
        await setPrivateChannelView({
          groupId,
          channelId,
          targetType: 'everyone',
          targetId: groupId,
          state: 'deny',
          updatedBy: req.user.id,
        });
        await setPrivateChannelView({
          groupId,
          channelId,
          targetType: 'member',
          targetId: req.user.id,
          state: 'allow',
          updatedBy: req.user.id,
        });
      } else {
        await getDb().run('DELETE FROM channel_members WHERE channel_id = ?', [
          channelId,
        ]);
        await setPrivateChannelView({
          groupId,
          channelId,
          targetType: 'everyone',
          targetId: groupId,
          state: null,
          updatedBy: req.user.id,
        });
      }
      const affectedMembers = await getDb().all(
        'SELECT user_id FROM group_members WHERE group_id = ?',
        [groupId],
      );
      await Promise.all(
        affectedMembers.map((member) => refreshUserRooms(member.user_id)),
      );
    }
    const updated = toChannel(await getChannel(channelId));
    emitToGroup(groupId, 'channel:updated', { channel: updated });
    return res.json({ channel: updated });
  }),
);

groupsRouter.delete(
  '/:groupId/channels/:channelId',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const channelId = parse(idSchema, req.params.channelId);
    await requireChannelManagement(groupId, channelId, req.user);

    const channel = await getChannel(channelId);
    if (!channel || channel.group_id !== groupId) throw notFound('Channel not found.');

    const remaining = await getDb().get(
      "SELECT COUNT(*) AS count FROM channels WHERE group_id = ? AND type IN ('text', 'forum')",
      [groupId],
    );
    if (['text', 'forum'].includes(channel.type) && Number(remaining?.count ?? 0) <= 1) {
      throw badRequest('A group needs at least one text channel.');
    }

    const db = getDb();
    await db.tx(async (tx) => {
      await tx.run(
        'DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)',
        [channelId],
      );
      await tx.run(
        'DELETE FROM mentions WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)',
        [channelId],
      );
      await tx.run(
        'DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)',
        [channelId],
      );
      await tx.run('DELETE FROM messages WHERE channel_id = ?', [channelId]);
      await tx.run('DELETE FROM forum_posts WHERE channel_id = ?', [channelId]);
      await tx.run('DELETE FROM channel_members WHERE channel_id = ?', [channelId]);
      await tx.run('DELETE FROM stage_members WHERE channel_id = ?', [channelId]);
      await tx.run('DELETE FROM channel_permission_overrides WHERE channel_id = ?', [channelId]);
      await tx.run("DELETE FROM read_states WHERE target_type = 'channel' AND target_id = ?", [
        channelId,
      ]);
      await tx.run('DELETE FROM channels WHERE id = ?', [channelId]);
    });

    closeVoiceChannel(channelId, getIo());
    emitToGroup(groupId, 'channel:deleted', { groupId, channelId });
    await audit({
      actorId: req.user.id,
      action: 'channel.delete',
      targetType: 'channel',
      targetId: channelId,
      meta: { groupId },
    });
    return res.json({ ok: true });
  }),
);

groupsRouter.get(
  '/:groupId/channels/:channelId/members',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const channelId = parse(idSchema, req.params.channelId);
    await requireChannelManagement(groupId, channelId, req.user);
    const channel = await getChannel(channelId);
    if (!channel || channel.group_id !== groupId) throw notFound('Channel not found.');
    const rows = await getDb().all(
      'SELECT user_id FROM channel_members WHERE channel_id = ? ORDER BY added_at',
      [channelId],
    );
    return res.json({ memberIds: rows.map((row) => row.user_id) });
  }),
);

groupsRouter.post(
  '/:groupId/channels/:channelId/members',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const channelId = parse(idSchema, req.params.channelId);
    await requireChannelManagement(groupId, channelId, req.user);
    const body = parse(z.object({ userId: idSchema }), req.body);

    const channel = await getChannel(channelId);
    if (!channel || channel.group_id !== groupId) throw notFound('Channel not found.');
    if (!channel.is_private) throw badRequest('That channel is open to the whole group.');

    const inGroup = await getDb().get(
      'SELECT 1 AS ok FROM group_members WHERE group_id = ? AND user_id = ?',
      [groupId, body.userId],
    );
    if (!inGroup) throw badRequest('Add them to the group first.');

    await getDb().run(
      `INSERT INTO channel_members (channel_id, user_id, added_at) VALUES (?, ?, ?)
       ON CONFLICT (channel_id, user_id) DO NOTHING`,
      [channelId, body.userId, Date.now()],
    );
    await setPrivateChannelView({
      groupId,
      channelId,
      targetType: 'member',
      targetId: body.userId,
      state: 'allow',
      updatedBy: req.user.id,
    });
    await refreshUserRooms(body.userId);
    emitToUser(body.userId, 'channel:access-granted', { groupId, channelId });
    return res.json({ ok: true });
  }),
);

groupsRouter.delete(
  '/:groupId/channels/:channelId/members/:userId',
  asyncRoute(async (req, res) => {
    const groupId = parse(idSchema, req.params.groupId);
    const channelId = parse(idSchema, req.params.channelId);
    const userId = parse(idSchema, req.params.userId);
    await requireChannelManagement(groupId, channelId, req.user);

    await getDb().run('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?', [
      channelId,
      userId,
    ]);
    await setPrivateChannelView({
      groupId,
      channelId,
      targetType: 'member',
      targetId: userId,
      state: null,
      updatedBy: req.user.id,
    });
    await refreshUserRooms(userId);
    emitToUser(userId, 'channel:access-revoked', { groupId, channelId });
    return res.json({ ok: true });
  }),
);
