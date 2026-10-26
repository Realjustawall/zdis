import { Server } from 'socket.io';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { getRedis } from '../cache/index.js';
import { resolveSession } from '../services/sessions.js';
import { findUserById, touchLastSeen, toPublicUser } from '../services/users.js';
import { listGroupsForUser } from '../services/groups.js';
import { getDb } from '../db/index.js';
import { registerVoiceHandlers, dropUserFromVoice, voiceSnapshot, enforceVoiceAccess } from './voice.js';
import { registerTypingHandlers } from './typing.js';
import { activeSockets } from '../services/metrics.js';
import { groupContext, canAccessChannel } from '../services/permissions.js';

let io = null;

/** Room helpers — one room per entity so fan-out stays cheap. */
export const rooms = {
  user: (id) => `user:${id}`,
  group: (id) => `group:${id}`,
  channel: (id) => `channel:${id}`,
  conversation: (id) => `conversation:${id}`,
};

/** Tracks how many live sockets each user has, to drive presence. */
const socketsByUser = new Map();

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

export async function initRealtime(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: config.clientOrigins,
      credentials: true,
    },
    allowRequest: (req, done) => {
      const origin = req.headers.origin;
      done(null, !origin || config.clientOrigins.includes(origin));
    },
    maxHttpBufferSize: 1e6,
    pingTimeout: 25_000,
    pingInterval: 20_000,
    transports: ['websocket', 'polling'],
  });

  // With Redis present, multiple server processes share one event bus.
  const redis = getRedis();
  if (redis) {
    try {
      const { createAdapter } = await import('@socket.io/redis-adapter');
      const subClient = redis.duplicate();
      io.adapter(createAdapter(redis, subClient));
      logger.info('realtime: redis adapter enabled');
    } catch (error) {
      logger.warn('realtime: redis adapter unavailable', { error: error.message });
    }
  }

  // Authenticate on the handshake — the same session cookie the REST API uses.
  io.use(async (socket, next) => {
    try {
      const cookies = parseCookies(socket.request.headers.cookie);
      const session = await resolveSession(cookies[config.cookieName]);
      if (!session) return next(new Error('unauthorized'));

      const user = await findUserById(session.userId);
      if (!user || !user.is_active || user.banned_at || user.must_change_password ||
        (user.suspended_until && Number(user.suspended_until) > Date.now())) return next(new Error('unauthorized'));

      socket.data.userId = user.id;
      socket.data.sessionId = session.id;
      socket.data.role = user.role;
      socket.data.sessionExpiresAt = session.expiresAt;
      return next();
    } catch (error) {
      logger.warn('socket auth failed', { error: error.message });
      return next(new Error('unauthorized'));
    }
  });

  io.on('connection', async (socket) => {
    const { userId } = socket.data;
    activeSockets.inc();
    const expiryTimer = setTimeout(() => socket.disconnect(true), Math.max(1, Math.min(2_147_483_647, socket.data.sessionExpiresAt - Date.now())));
    expiryTimer.unref?.();

    socket.use(async ([event], next) => {
      try {
        const session = await getDb().get(
          'SELECT revoked_at, expires_at FROM sessions WHERE id = ? AND user_id = ?',
          [socket.data.sessionId, userId],
        );
        const fresh = await findUserById(userId);
        if (
          !session || session.revoked_at || Number(session.expires_at) <= Date.now() ||
          !fresh || !fresh.is_active || fresh.must_change_password ||
          fresh.banned_at ||
          (fresh.suspended_until && Number(fresh.suspended_until) > Date.now())
        ) {
          socket.emit('session:revoked', { reason: 'account_restricted' });
          socket.disconnect(true);
          return next(new Error('account_restricted'));
        }
        socket.data.role = fresh.role;
        return next();
      } catch (error) {
        logger.warn('socket validation failed', { error: error.message });
        socket.disconnect(true);
        return next(new Error('unauthorized'));
      }
    });

    const previous = socketsByUser.get(userId) ?? 0;
    socketsByUser.set(userId, previous + 1);
    socket.on('disconnect', async () => {
      clearTimeout(expiryTimer);
      activeSockets.dec();
      const remaining = (socketsByUser.get(userId) ?? 1) - 1;
      // Update the local count before awaiting the adapter: simultaneous closes
      // must not both observe the same count and leave a phantom online user.
      if (remaining <= 0) socketsByUser.delete(userId);
      else socketsByUser.set(userId, remaining);
      const connectedElsewhere = await io.in(rooms.user(userId)).fetchSockets();
      if (connectedElsewhere.length === 0) {
        await touchLastSeen(userId, 'offline');
        broadcastPresence(userId, 'offline');
      }
      dropUserFromVoice(socket, io);
    });
    socket.join(rooms.user(userId));
    registerTypingHandlers(socket);
    registerVoiceHandlers(socket, io);
    await joinUserRooms(socket, userId);

    if (!socket.connected) return;
    if (previous === 0) {
      await touchLastSeen(userId, 'online');
      broadcastPresence(userId, 'online');
    }

    socket.emit('ready', {
      userId,
      voice: await voiceSnapshot(userId),
      presence: Object.fromEntries((await getDb().all('SELECT id, presence FROM users WHERE is_active = 1')).map(row => [row.id, row.presence])),
      activities: Object.fromEntries((await getDb().all(
        `SELECT a.* FROM user_activities a JOIN users u ON u.id = a.user_id
         WHERE u.is_active = 1 AND (a.expires_at IS NULL OR a.expires_at > ?)`, [Date.now()],
      )).map(row => [row.user_id, {type: row.type, name: row.name, details: row.details, state: row.state, startedAt: row.started_at, expiresAt: row.expires_at}])),
    });

    socket.on('presence:set', async (payload) => {
      const presence = ['online', 'idle', 'dnd', 'offline'].includes(payload?.presence)
        ? payload.presence
        : 'online';
      await touchLastSeen(userId, presence);
      broadcastPresence(userId, presence);
    });

    // Lets the client subscribe to a room it just gained access to without a
    // full reconnect (e.g. right after joining a group via invite).
    socket.on('rooms:refresh', async () => {
      await joinUserRooms(socket, userId);
    });
  });

  logger.info('realtime ready');
  return io;
}

async function joinUserRooms(socket, userId) {
  const groups = await listGroupsForUser(userId);
  for (const group of groups) socket.join(rooms.group(group.id));

  const channels = await visibleChannelsForUser(userId, groups);
  for (const channel of channels) socket.join(rooms.channel(channel.id));

  const conversations = await getDb().all(
    'SELECT conversation_id FROM conversation_members WHERE user_id = ?',
    [userId],
  );
  for (const row of conversations) socket.join(rooms.conversation(row.conversation_id));
}

function broadcastPresence(userId, presence) {
  if (!io) return;
  io.emit('presence:update', { userId, presence, at: Date.now() });
}

export function broadcastActivity(userId, activity) {
  io?.emit('presence:activity', { userId, activity, at: Date.now() });
}

export function getIo() {
  return io;
}

/** Fire-and-forget emit helpers used by the REST routes. */
export function emitToChannel(channelId, event, payload) {
  io?.to(rooms.channel(channelId)).emit(event, payload);
}

export function emitToConversation(conversationId, event, payload) {
  io?.to(rooms.conversation(conversationId)).emit(event, payload);
}

export function emitToGroup(groupId, event, payload) {
  io?.to(rooms.group(groupId)).emit(event, payload);
}

export function emitToUser(userId, event, payload) {
  io?.to(rooms.user(userId)).emit(event, payload);
}

export function emitToUsers(userIds, event, payload) {
  for (const userId of userIds) emitToUser(userId, event, payload);
}

/** Forces every socket of a user to re-subscribe (membership changed). */
export async function refreshUserRooms(userId) {
  if (!io) return;
  await enforceVoiceAccess(io,userId);
  const sockets = await io.in(rooms.user(userId)).fetchSockets();
  for (const socket of sockets) {
    const desired = new Set([rooms.user(userId), socket.id]);
    const groups = await listGroupsForUser(userId);
    for (const group of groups) desired.add(rooms.group(group.id));
    const channels = await visibleChannelsForUser(userId, groups);
    for (const channel of channels) desired.add(rooms.channel(channel.id));
    const conversations = await getDb().all(
      'SELECT conversation_id FROM conversation_members WHERE user_id = ?',
      [userId],
    );
    for (const row of conversations) desired.add(rooms.conversation(row.conversation_id));

    for (const room of socket.rooms) {
      if (
        !desired.has(room) &&
        /^(group|channel|conversation):/.test(room)
      ) {
        await socket.leave(room);
      }
    }
    for (const room of desired) await socket.join(room);
  }
}

async function visibleChannelsForUser(userId, groups = null) {
  const user = await findUserById(userId);
  if (!user) return [];
  const memberships = groups ?? (await listGroupsForUser(userId));
  const visible = [];
  for (const group of memberships) {
    const context = await groupContext(group.id, user);
    const channels = await getDb().all('SELECT * FROM channels WHERE group_id = ?', [group.id]);
    for (const channel of channels) {
      if (await canAccessChannel(channel, context)) visible.push(channel);
    }
  }
  return visible;
}

export async function leaveRoom(userId, room) {
  if (!io) return;
  const sockets = await io.in(rooms.user(userId)).fetchSockets();
  for (const socket of sockets) socket.leave(room);
}

export { toPublicUser };
