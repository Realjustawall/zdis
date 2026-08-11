import { getDb } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { activeVoiceParticipants } from '../services/metrics.js';
import { config } from '../config.js';
import { getChannel } from '../services/groups.js';
import { canAccessChannel, groupContext } from '../services/permissions.js';
import { channelPermission } from '../services/channelPermissions.js';
import { getSettings } from '../services/settings.js';

/**
 * Voice/video is a full mesh: every participant holds a peer connection to
 * every other participant, and this module only relays the SDP/ICE traffic.
 * That keeps the server out of the media path entirely (no transcoding, no
 * bandwidth cost) at the price of a practical ceiling on room size.
 */
const MAX_PARTICIPANTS = config.livekit.url ? config.livekit.maxParticipants : 8;

/** channelId -> Map<userId, { socketId, muted, deafened, video, screen, joinedAt }> */
const voiceRooms = new Map();
/** socketId -> channelId, so a disconnect can clean up without a lookup. */
const socketChannel = new Map();

const voiceRoomKey = (channelId) => `voice:${channelId}`;
const DIRECT_ROOM_PREFIX = 'dm:';

function directConversationId(channelId) {
  return channelId.startsWith(DIRECT_ROOM_PREFIX)
    ? channelId.slice(DIRECT_ROOM_PREFIX.length)
    : null;
}

function audienceRoom(channelId) {
  const conversationId = directConversationId(channelId);
  return conversationId ? `conversation:${conversationId}` : `channel:${channelId}`;
}

function broadcastVoiceState(io, channelId) {
  io.to(audienceRoom(channelId)).emit('voice:state', {
    channelId,
    participants: participantsOf(channelId).map(({ socketId, ...rest }) => rest),
  });
}

function participantsOf(channelId) {
  const room = voiceRooms.get(channelId);
  if (!room) return [];
  return [...room.entries()].map(([userId, state]) => ({ userId, ...state }));
}

/** Full picture of who is in which voice channel, sent on connect. */
export async function voiceSnapshot(userId) {
  const out = {};
  for (const channelId of voiceRooms.keys()) {
    if (await canJoinChannel(userId, channelId)) {
      out[channelId] = participantsOf(channelId).map(({ socketId, ...rest }) => rest);
    }
  }
  return out;
}

async function canJoinChannel(userId, channelId) {
  return voicePermission(userId, channelId, 'connectVoice');
}

async function voicePermission(userId, channelId, permission) {
  const conversationId = directConversationId(channelId);
  if (conversationId) {
    if (permission !== 'connectVoice' || !(await getSettings()).feature_voice_calls) return false;
    const membership = await getDb().get(
      `SELECT c.id, c.type
       FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id
       JOIN users u ON u.id = cm.user_id
       WHERE c.id = ? AND cm.user_id = ? AND u.is_active = 1`,
      [conversationId, userId],
    );
    if (!membership) return false;

    // A block in either direction also blocks starting or joining a 1:1 call.
    if (membership.type === 'dm') {
      const blocked = await getDb().get(
        `SELECT 1 AS blocked
         FROM conversation_members other
         JOIN user_blocks b ON
           (b.user_id = ? AND b.blocked_id = other.user_id)
           OR (b.user_id = other.user_id AND b.blocked_id = ?)
         WHERE other.conversation_id = ? AND other.user_id <> ?
         LIMIT 1`,
        [userId, userId, conversationId, userId],
      );
      if (blocked) return false;
    }
    return true;
  }

  const user = await getDb().get(
    `SELECT u.id, u.role
     FROM users u JOIN channels c ON c.id = ?
     JOIN group_members m ON m.group_id = c.group_id AND m.user_id = u.id
     WHERE u.id = ? AND u.is_active = 1`,
    [channelId, userId],
  );
  const channel = await getChannel(channelId);
  if (!user || !channel || !['voice', 'stage'].includes(channel.type)) return false;
  try {
    const context = await groupContext(channel.group_id, user);
    return (
      (await canAccessChannel(channel, context)) &&
      (await channelPermission(channel, context, permission))
    );
  } catch {
    return false;
  }
}

export function registerVoiceHandlers(socket, io) {
  const { userId } = socket.data;

  socket.on('voice:join', async (payload, ack) => {
    try {
      const channelId = String(payload?.channelId ?? '');
      if (!(await canJoinChannel(userId, channelId))) {
        return ack?.({ ok: false, error: 'You cannot join that voice channel.' });
      }

      // One voice channel at a time, mirroring Discord's behaviour.
      leaveCurrent(socket, io);

      if (!voiceRooms.has(channelId)) voiceRooms.set(channelId, new Map());
      const room = voiceRooms.get(channelId);
      const startingDirectCall = Boolean(directConversationId(channelId) && room.size === 0);

      if (room.size >= MAX_PARTICIPANTS && !room.has(userId)) {
        return ack?.({ ok: false, error: `This voice channel is full (${MAX_PARTICIPANTS} max).` });
      }

      const state = {
        socketId: socket.id,
        muted: Boolean(payload?.muted),
        deafened: false,
        video: Boolean(payload?.video),
        screen: false,
        priority: false,
        joinedAt: Date.now(),
      };
      room.set(userId, state);
      activeVoiceParticipants.inc();
      socketChannel.set(socket.id, channelId);
      socket.join(voiceRoomKey(channelId));

      const peers = participantsOf(channelId)
        .filter((peer) => peer.userId !== userId)
        .map(({ socketId, ...rest }) => rest);

      // Existing members are told to expect an offer from the newcomer; the
      // newcomer initiates, so exactly one side creates the offer per pair.
      socket.to(voiceRoomKey(channelId)).emit('voice:peer-joined', {
        channelId,
        userId,
        state: publicState(state),
      });

      broadcastVoiceState(io, channelId);

      const conversationId = directConversationId(channelId);
      if (startingDirectCall && conversationId) {
        socket.to(`conversation:${conversationId}`).emit('voice:incoming', {
          channelId,
          conversationId,
          fromUserId: userId,
          video: state.video,
          startedAt: state.joinedAt,
        });
      }

      return ack?.({ ok: true, channelId, peers, max: MAX_PARTICIPANTS });
    } catch (error) {
      logger.warn('voice:join failed', { error: error.message });
      return ack?.({ ok: false, error: 'Could not join the voice channel.' });
    }
  });

  socket.on('voice:leave', () => leaveCurrent(socket, io));

  socket.on('voice:decline', async (payload) => {
    const channelId = String(payload?.channelId ?? '');
    const conversationId = directConversationId(channelId);
    if (!conversationId || !(await canJoinChannel(userId, channelId))) return;
    io.to(voiceRoomKey(channelId)).emit('voice:declined', {
      channelId,
      userId,
    });
  });

  // ------------------------------------------------------- signalling relay

  const relay = (event) => (payload) => {
    const channelId = socketChannel.get(socket.id);
    if (!channelId) return;
    const room = voiceRooms.get(channelId);
    const target = room?.get(String(payload?.to ?? ''));
    // Only relay between two people already in the same room.
    if (!target) return;
    io.to(target.socketId).emit(event, {
      channelId,
      from: userId,
      payload: payload?.payload,
    });
  };

  socket.on('voice:offer', relay('voice:offer'));
  socket.on('voice:answer', relay('voice:answer'));
  socket.on('voice:ice', relay('voice:ice'));

  socket.on('voice:update', (payload) => {
    const channelId = socketChannel.get(socket.id);
    if (!channelId) return;
    const room = voiceRooms.get(channelId);
    const state = room?.get(userId);
    if (!state) return;

    if (typeof payload?.muted === 'boolean') state.muted = payload.muted;
    if (typeof payload?.deafened === 'boolean') state.deafened = payload.deafened;
    if (typeof payload?.video === 'boolean') state.video = payload.video;
    if (typeof payload?.screen === 'boolean') state.screen = payload.screen;
    if (typeof payload?.speaking === 'boolean') state.speaking = payload.speaking;

    io.to(voiceRoomKey(channelId)).emit('voice:peer-updated', {
      channelId,
      userId,
      state: publicState(state),
    });
    broadcastVoiceState(io, channelId);
  });

  socket.on('voice:priority', async (payload) => {
    const channelId = socketChannel.get(socket.id);
    if (!channelId) return;
    const active = Boolean(payload?.active);
    if (active && !(await voicePermission(userId, channelId, 'prioritySpeaker'))) return;
    const room = voiceRooms.get(channelId);
    const state = room?.get(userId);
    if (!state) return;
    state.priority = active;
    io.to(voiceRoomKey(channelId)).emit('voice:peer-updated', {
      channelId,
      userId,
      state: publicState(state),
    });
    broadcastVoiceState(io, channelId);
  });

  socket.on('voice:soundboard', async (payload) => {
    const channelId = socketChannel.get(socket.id);
    const expressionId = String(payload?.expressionId ?? '');
    if (
      !channelId ||
      !expressionId ||
      !(await voicePermission(userId, channelId, 'useSoundboard'))
    ) return;
    const expression = await getDb().get(
      `SELECT e.id, e.name, e.attachment_id, e.group_id AS expression_group_id,
         c.group_id AS channel_group_id
       FROM group_expressions e CROSS JOIN channels c
       WHERE e.id = ? AND e.type = 'sound' AND c.id = ?`,
      [expressionId, channelId],
    );
    if (!expression) return;
    if (expression.expression_group_id !== expression.channel_group_id) {
      if (!(await voicePermission(userId, channelId, 'useExternalSounds'))) return;
      const sourceMembership = await getDb().get(
        'SELECT 1 AS ok FROM group_members WHERE group_id = ? AND user_id = ?',
        [expression.expression_group_id, userId],
      );
      if (!sourceMembership) return;
    }
    io.to(voiceRoomKey(channelId)).emit('voice:soundboard', {
      channelId,
      userId,
      expressionId: expression.id,
      name: expression.name,
      attachmentId: expression.attachment_id,
    });
  });

  socket.on('voice:activity', async (payload) => {
    const channelId = socketChannel.get(socket.id);
    if (
      !channelId ||
      !(await voicePermission(userId, channelId, 'useEmbeddedActivities'))
    ) return;
    const action = payload?.action === 'end' ? 'end' : 'start';
    if (action === 'end') {
      await getDb().run('DELETE FROM voice_activities WHERE channel_id = ?', [channelId]);
      io.to(voiceRoomKey(channelId)).emit('voice:activity', { channelId, activity: null });
      return;
    }
    const activity = ['watch-together', 'chess', 'poker', 'whiteboard'].includes(payload?.activity)
      ? payload.activity
      : 'watch-together';
    const now = Date.now();
    await getDb().run(
      `INSERT INTO voice_activities
        (channel_id, activity, started_by, state, created_at, updated_at)
       VALUES (?, ?, ?, '{}', ?, ?)
       ON CONFLICT (channel_id)
       DO UPDATE SET activity = excluded.activity, started_by = excluded.started_by,
         state = '{}', created_at = excluded.created_at, updated_at = excluded.updated_at`,
      [channelId, activity, userId, now, now],
    );
    io.to(voiceRoomKey(channelId)).emit('voice:activity', {
      channelId,
      activity: { name: activity, startedBy: userId, state: {}, createdAt: now, updatedAt: now },
    });
  });
}

function publicState(state) {
  return {
    muted: state.muted,
    deafened: state.deafened,
    video: state.video,
    screen: state.screen,
    speaking: Boolean(state.speaking),
    priority: Boolean(state.priority),
    joinedAt: state.joinedAt,
  };
}

function leaveCurrent(socket, io) {
  const channelId = socketChannel.get(socket.id);
  if (!channelId) return;
  const { userId } = socket.data;

  const room = voiceRooms.get(channelId);
  if (room) {
    const state = room.get(userId);
    // Only remove if this socket is the one that owns the slot; a second tab
    // joining elsewhere must not evict the first.
    if (state?.socketId === socket.id) {
      room.delete(userId);
      activeVoiceParticipants.dec();
    }
    if (!room.size) {
      voiceRooms.delete(channelId);
      const conversationId = directConversationId(channelId);
      if (conversationId) {
        io.to(`conversation:${conversationId}`).emit('voice:ended', {
          channelId,
          conversationId,
        });
      }
    }
  }

  socketChannel.delete(socket.id);
  socket.leave(voiceRoomKey(channelId));

  io.to(voiceRoomKey(channelId)).emit('voice:peer-left', { channelId, userId });
  broadcastVoiceState(io, channelId);
}

export function dropUserFromVoice(socket, io) {
  leaveCurrent(socket, io);
}

/** Called when a channel or group is deleted so nobody is stranded. */
export function closeVoiceChannel(channelId, io) {
  const room = voiceRooms.get(channelId);
  if (!room) return;
  for (const [, state] of room) socketChannel.delete(state.socketId);
  activeVoiceParticipants.dec(room.size);
  voiceRooms.delete(channelId);
  io?.to(voiceRoomKey(channelId)).emit('voice:closed', { channelId });
}
