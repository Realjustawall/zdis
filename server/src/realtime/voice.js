import { getDb } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { forbidden, badRequest } from '../lib/errors.js';
import { activeVoiceParticipants } from '../services/metrics.js';
import { config } from '../config.js';
import { getChannel } from '../services/groups.js';
import { canAccessChannel, groupContext } from '../services/permissions.js';
import { channelPermission } from '../services/channelPermissions.js';
import { getSettings } from '../services/settings.js';
import { registerVoiceActivities } from '../services/voiceActivities.js';
import {RoomServiceClient,TrackSource} from 'livekit-server-sdk';

/**
 * Voice/video is a full mesh: every participant holds a peer connection to
 * every other participant, and this module only relays the SDP/ICE traffic.
 * That keeps the server out of the media path entirely (no transcoding, no
 * bandwidth cost) at the price of a practical ceiling on room size.
 */
const voiceCapacity = channelId => config.livekit.url&&!directConversationId(channelId) ? config.livekit.maxParticipants : 8;

/** channelId -> Map<userId, { socketId, muted, deafened, video, screen, joinedAt }> */
const voiceRooms = new Map();
/** socketId -> channelId, so a disconnect can clean up without a lookup. */
const socketChannel = new Map();
export function voiceParticipantCount(channelId) { return voiceRooms.get(channelId)?.size || 0; }

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

export async function voicePermission(userId, channelId, permission) {
  const {userAccess}=await import('../services/userAccess.js');
  const feature={connectVoice:'connectVoice',speak:'speak',video:'video',screenShare:'screenShare'}[permission];
  if(feature && !(await userAccess(userId)).effective[feature])return false;
  const conversationId = directConversationId(channelId);
  if (conversationId) {
    if (!(await getSettings()).feature_voice_calls) return false;
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
      if(!config.livekit.url){
        const direct=Boolean(directConversationId(channelId));
        const {userAccess}=await import('../services/userAccess.js');
        const account=(await userAccess(userId)).effective;
        const allowed=direct?account.speak&&account.video&&account.screenShare:
          await voicePermission(userId,channelId,'speak')&&await voicePermission(userId,channelId,'video')&&await voicePermission(userId,channelId,'screenShare');
        if(!allowed)return ack?.({ok:false,error:'Restricted media permissions require a configured LiveKit SFU; peer-to-peer voice cannot enforce publication restrictions.'});
      }

      // One voice channel at a time, mirroring Discord's behaviour.
      leaveCurrent(socket, io);

      if (!voiceRooms.has(channelId)) voiceRooms.set(channelId, new Map());
      const room = voiceRooms.get(channelId);
      const startingDirectCall = Boolean(directConversationId(channelId) && room.size === 0);

      if (room.size >= voiceCapacity(channelId) && !room.has(userId)) {
        return ack?.({ ok: false, error: `This voice channel is full (${voiceCapacity(channelId)} max).` });
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

      return ack?.({ ok: true, channelId, peers, max: voiceCapacity(channelId) });
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
    // SFU channels must never accept mesh signalling, even from a modified client.
    if(config.livekit.url)return;
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

  registerVoiceActivities(socket, { getDb, channelForSocket: id => socketChannel.get(id), hasPermission: voicePermission, broadcast: (channelId, activity) => io.to(voiceRoomKey(channelId)).emit('voice:activity', { channelId, activity }) });
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

export async function voiceXpCandidates() {
 const candidates=[];
 for(const [channelId,participants] of voiceRooms){
  if(directConversationId(channelId)||participants.size<2)continue;
  const channel=await getChannel(channelId);if(!channel)continue;
  for(const [userId,state] of participants){
   if(!state.muted&&!state.deafened&&await voicePermission(userId,channelId,'speak'))candidates.push({groupId:channel.group_id,userId});
  }
 }
 return candidates;
}

export async function moveVoiceParticipant(groupId,actor,userId,destinationId,io,selfMove=false){
 if(selfMove&&actor.id!==userId)throw forbidden('You can only move yourself.');
 const destination=await getChannel(destinationId);
 if(!destination||destination.group_id!==groupId||!['voice','stage'].includes(destination.type)||!await canJoinChannel(userId,destinationId))throw forbidden('The member cannot join the destination.');
 const ctx=await groupContext(groupId,actor);
 if(!selfMove&&(!ctx.can('moveMembers')||!await ctx.outranksMember(userId)||!await channelPermission(destination,ctx,'moveMembers')))throw forbidden('Move Members permission and role hierarchy are required.');
 if(!config.livekit.url&&(!await voicePermission(userId,destinationId,'speak')||!await voicePermission(userId,destinationId,'video')||!await voicePermission(userId,destinationId,'screenShare')))throw forbidden('Restricted media requires the server media service.');
 if(voiceParticipantCount(destinationId)>=voiceCapacity(destinationId))throw badRequest('The destination is full.');
 for(const [channelId,participants] of voiceRooms){
  const state=participants.get(userId);if(!state)continue;
  const source=await getChannel(channelId);if(source?.group_id!==groupId)continue;
  if(!selfMove&&!await channelPermission(source,ctx,'moveMembers'))throw forbidden('You cannot move members from this channel.');
  if(channelId===destinationId)return;
  const socket=io?.sockets.sockets.get(state.socketId);if(!socket)throw badRequest('The member is no longer connected.');
  if(config.livekit.url){
   const room=await getDb().get('SELECT preferred_region FROM call_rooms WHERE channel_id=?',[channelId]);
   const region=config.livekit.regions.find(r=>r.name===room?.preferred_region);
   const service=new RoomServiceClient((region?.apiUrl||config.livekit.apiUrl||config.livekit.url).replace(/^ws/,'http'),config.livekit.apiKey,config.livekit.apiSecret);
   await service.removeParticipant('channel-'+channelId,userId);
  }
  leaveCurrent(socket,io);socket.emit('voice:moved',{fromChannelId:channelId,channelId:destinationId});return;
 }
 throw badRequest('The member is not in a voice channel in this server.');
}

export async function enforceVoiceAccess(io,userId=null){
 for(const [channelId,participants] of [...voiceRooms]){
  for(const [id,state] of [...participants]){
   if(userId&&id!==userId)continue;
   const direct=Boolean(directConversationId(channelId));
   const canJoin=await voicePermission(id,channelId,'connectVoice');
   const {userAccess}=await import('../services/userAccess.js');
   const account=(await userAccess(id)).effective;
   const speak=direct?account.speak:await voicePermission(id,channelId,'speak');
   const video=direct?account.video:await voicePermission(id,channelId,'video');
   const screenShare=video&&(direct?account.screenShare:await voicePermission(id,channelId,'screenShare'));
   if(!config.livekit.url){
    if(!canJoin||!speak||!video||!screenShare){const socket=io?.sockets.sockets.get(state.socketId);if(socket){socket.emit('voice:closed',{channelId});leaveCurrent(socket,io);}}
    continue;
   }
   const room=direct?null:await getDb().get('SELECT host_id,preferred_region FROM call_rooms WHERE channel_id=?',[channelId]);
   const mediaRoom=direct?'direct-'+directConversationId(channelId):'channel-'+channelId;
   const region=config.livekit.regions.find(r=>r.name===room?.preferred_region)||{apiUrl:config.livekit.apiUrl};
   const client=new RoomServiceClient((region.apiUrl||region.url||config.livekit.url).replace(/^ws/,'http'),config.livekit.apiKey,config.livekit.apiSecret);
   try{
    if(!canJoin){await client.removeParticipant(mediaRoom,id);const socket=io?.sockets.sockets.get(state.socketId);if(socket){socket.emit('voice:closed',{channelId});leaveCurrent(socket,io);}continue;}
    const channel=await getChannel(channelId);const stage=channel?.type==='stage'&&room?.host_id!==id?(await getDb().get('SELECT role FROM stage_members WHERE channel_id=? AND user_id=?',[channelId,id]))?.role==='speaker':true;
    const sources=stage?[...(speak?[TrackSource.MICROPHONE]:[]),...(video?[TrackSource.CAMERA]:[]),...(screenShare?[TrackSource.SCREEN_SHARE,TrackSource.SCREEN_SHARE_AUDIO]:[])]:[];
    const currentParticipant = await client.getParticipant(mediaRoom,id);
    await client.updateParticipant(mediaRoom,id,undefined,{canPublish:sources.length>0,canPublishSources:sources,canSubscribe:currentParticipant.permission?.canSubscribe ?? true,canPublishData:true});
   }catch(error){logger.warn('Voice access refresh failed',{channelId,userId:id,error:error.message});}
  }
 }
}

export async function removeUserFromGroupVoice(groupId,userId,io){
 if(!io)return;
 for(const [channelId,participants] of voiceRooms){
  const participant=participants.get(userId);if(!participant)continue;
  const channel=await getChannel(channelId);if(channel?.group_id!==groupId)continue;
  const socket=io.sockets.sockets.get(participant.socketId);
  if(config.livekit.url){
   const room=await getDb().get('SELECT preferred_region FROM call_rooms WHERE channel_id=?',[channelId]);
   const region=config.livekit.regions.find(r=>r.name===room?.preferred_region);
   const client=new RoomServiceClient((region?.apiUrl||config.livekit.apiUrl||config.livekit.url).replace(/^ws/,'http'),config.livekit.apiKey,config.livekit.apiSecret);
   await client.removeParticipant('channel-'+channelId,userId).catch(error=>logger.warn('Voice participant removal failed',{channelId,userId,error:error.message}));
  }
  if(socket){socket.emit('voice:closed',{channelId});leaveCurrent(socket,io);}
 }
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
