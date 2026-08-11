import express from 'express';
import { asyncRoute, badRequest, forbidden, notFound } from '../lib/errors.js';
import { parse, z, idSchema } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { writeLimiter } from '../middleware/rateLimit.js';
import {
  openDirectMessage,
  createGroupDm,
  listConversations,
  getConversation,
  getConversationMembers,
  getConversationMemberIds,
  closeConversation,
  addToGroupDm,
  leaveGroupDm,
  toConversation,
} from '../services/conversations.js';
import { isConversationMember } from '../services/permissions.js';
import { getDb } from '../db/index.js';
import { refreshUserRooms, emitToConversation, emitToUser, getIo, rooms } from '../realtime/index.js';
import { getPublicUser } from '../services/users.js';

export const conversationsRouter = express.Router();
conversationsRouter.use(requireAuth);

conversationsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    return res.json({ conversations: await listConversations(req.user.id) });
  }),
);

/** Idempotent: calling it twice for the same pair returns the same DM. */
conversationsRouter.post(
  '/dm',
  writeLimiter,
  asyncRoute(async (req, res) => {
    const body = parse(z.object({ userId: idSchema }), req.body);
    const conversation = await openDirectMessage(req.user.id, body.userId);

    await refreshUserRooms(req.user.id);
    await refreshUserRooms(body.userId);

    const members = await getConversationMembers(conversation.id);
    const payload = toConversation(conversation, {
      members,
      otherMembers: members.filter((m) => m.id !== req.user.id),
      lastMessage: null,
    });

    emitToUser(body.userId, 'conversation:created', {
      conversation: {
        ...payload,
        otherMembers: members.filter((m) => m.id !== body.userId),
      },
    });

    return res.status(201).json({ conversation: payload });
  }),
);

conversationsRouter.post(
  '/group',
  writeLimiter,
  asyncRoute(async (req, res) => {
    const body = parse(
      z.object({
        userIds: z.array(idSchema).min(2, 'Pick at least two other people.').max(24),
        name: z.string().trim().max(48).nullable().optional(),
      }),
      req.body,
    );

    const conversation = await createGroupDm({
      creatorId: req.user.id,
      memberIds: body.userIds,
      name: body.name ?? null,
    });

    const memberIds = await getConversationMemberIds(conversation.id);
    for (const userId of memberIds) await refreshUserRooms(userId);

    const members = await getConversationMembers(conversation.id);
    const payload = toConversation(conversation, { members, lastMessage: null });

    for (const userId of memberIds) {
      emitToUser(userId, 'conversation:created', {
        conversation: { ...payload, otherMembers: members.filter((m) => m.id !== userId) },
      });
    }

    return res.status(201).json({ conversation: payload });
  }),
);

conversationsRouter.get(
  '/:conversationId',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.conversationId);
    if (!(await isConversationMember(id, req.user.id))) throw notFound('Conversation not found.');

    const conversation = await getConversation(id);
    const members = await getConversationMembers(id);
    return res.json({
      conversation: toConversation(conversation, {
        members,
        otherMembers: members.filter((m) => m.id !== req.user.id),
      }),
    });
  }),
);

conversationsRouter.patch(
  '/:conversationId',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.conversationId);
    if (!(await isConversationMember(id, req.user.id))) throw notFound('Conversation not found.');

    const conversation = await getConversation(id);
    if (conversation.type !== 'group_dm') throw badRequest('A 1:1 DM cannot be renamed.');
    if (conversation.owner_id !== req.user.id) throw forbidden('Only the creator can rename this.');

    const body = parse(z.object({ name: z.string().trim().max(48).nullable() }), req.body);
    await getDb().run('UPDATE conversations SET name = ?, updated_at = ? WHERE id = ?', [
      body.name,
      Date.now(),
      id,
    ]);

    const updated = await getConversation(id);
    const members = await getConversationMembers(id);
    const payload = toConversation(updated, { members });
    emitToConversation(id, 'conversation:updated', { conversation: payload });
    return res.json({ conversation: payload });
  }),
);

conversationsRouter.post(
  '/:conversationId/members',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.conversationId);
    if (!(await isConversationMember(id, req.user.id))) throw notFound('Conversation not found.');
    const body = parse(z.object({ userId: idSchema }), req.body);

    await addToGroupDm(id, body.userId);
    await refreshUserRooms(body.userId);

    const member = await getPublicUser(body.userId);
    emitToConversation(id, 'conversation:member-added', { conversationId: id, member });
    emitToUser(body.userId, 'conversation:created', {
      conversation: toConversation(await getConversation(id), {
        members: await getConversationMembers(id),
      }),
    });
    return res.json({ ok: true });
  }),
);

conversationsRouter.delete(
  '/:conversationId/members/:userId',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.conversationId);
    const userId = parse(idSchema, req.params.userId);
    if (!(await isConversationMember(id, req.user.id))) throw notFound('Conversation not found.');

    const conversation = await getConversation(id);
    if (conversation.type !== 'group_dm') throw badRequest('You cannot remove people from a 1:1 DM.');

    const removingSelf = userId === req.user.id;
    if (!removingSelf && conversation.owner_id !== req.user.id) {
      throw forbidden('Only the creator can remove people.');
    }

    await leaveGroupDm(id, userId);
    emitToConversation(id, 'conversation:member-removed', { conversationId: id, userId });
    emitToUser(userId, 'conversation:removed', { conversationId: id });

    const io = getIo();
    if (io) {
      const sockets = await io.in(rooms.user(userId)).fetchSockets();
      for (const socket of sockets) socket.leave(rooms.conversation(id));
    }
    return res.json({ ok: true });
  }),
);

/** Hides a DM from the sidebar without destroying the history. */
conversationsRouter.delete(
  '/:conversationId',
  asyncRoute(async (req, res) => {
    const id = parse(idSchema, req.params.conversationId);
    if (!(await isConversationMember(id, req.user.id))) throw notFound('Conversation not found.');

    const conversation = await getConversation(id);
    if (conversation.type === 'group_dm') {
      await leaveGroupDm(id, req.user.id);
      emitToConversation(id, 'conversation:member-removed', {
        conversationId: id,
        userId: req.user.id,
      });
      await refreshUserRooms(req.user.id);
    } else {
      await closeConversation(id, req.user.id);
    }
    return res.json({ ok: true });
  }),
);
