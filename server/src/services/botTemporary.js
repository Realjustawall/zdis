import {getDb} from '../db/index.js';
import {newId} from '../lib/ids.js';
import {botSettings} from './builtinBots.js';
import {groupContext,canAccessChannel} from './permissions.js';
import {channelPermission} from './channelPermissions.js';
import {assertUserLimit,assertUserFeature} from './userAccess.js';
import {forbidden,badRequest} from '../lib/errors.js';
import {invalidateGroup,toChannel,createInvite} from './groups.js';
import {emitToUser,refreshUserRooms,getIo} from '../realtime/index.js';
import {closeVoiceChannel,voiceParticipantCount} from '../realtime/voice.js';
import {config} from '../config.js';
import {RoomServiceClient} from 'livekit-server-sdk';

export async function createTemporaryVoice(groupId,user,name){
 const ctx=await groupContext(groupId,user),db=getDb(),{settings}=await botSettings(groupId),m=settings.moderator;
 if(!m.enabled||!m.temporaryVoiceEnabled||!ctx.can('useApplicationCommands'))throw forbidden('Temporary voice channels are disabled.');
 await assertUserFeature(user.id,'connectVoice');
 const category=m.temporaryVoiceCategoryId?await db.get('SELECT * FROM channel_categories WHERE id=? AND group_id=?',[m.temporaryVoiceCategoryId,groupId]):null;
 if(m.temporaryVoiceCategoryId&&!category)throw badRequest('Temporary channel category not found.');
 const probe={group_id:groupId,type:'voice',category_id:category?.id||null,permissions_synced:1};
 if(!await channelPermission(probe,ctx,'connectVoice'))throw forbidden('You cannot join voice in this category.');
 const id=newId(),now=Date.now();
 await db.tx(async tx=>{
  if(db.dialect==='postgres')await tx.get('SELECT id FROM users WHERE id=? FOR UPDATE',[user.id]);
  if(db.dialect==='postgres')await tx.get('SELECT id FROM chat_groups WHERE id=? FOR UPDATE',[groupId]);
  if(await tx.get('SELECT channel_id FROM builtin_bot_temp_channels WHERE group_id=? AND owner_id=?',[groupId,user.id]))throw badRequest('You already own a temporary voice channel.');
  await assertUserLimit(user.id,'maxCreatedChannels',Number((await tx.get('SELECT COUNT(*) AS n FROM channels WHERE created_by=?',[user.id])).n));
  await assertUserLimit(ctx.group.owner_id,'maxChannelsPerGroup',Number((await tx.get('SELECT COUNT(*) AS n FROM channels WHERE group_id=?',[groupId])).n));
  await tx.run('INSERT INTO channels(id,group_id,category_id,name,type,position,created_by,permissions_synced,created_at,updated_at) VALUES (?,?,?,?,?,0,?,1,?,?)',[id,groupId,category?.id||null,String(name||user.username+' voice').slice(0,64),'voice',user.id,now,now]);
  await tx.run('INSERT INTO builtin_bot_temp_channels(channel_id,group_id,owner_id,created_at,empty_since) VALUES (?,?,?,?,?)',[id,groupId,user.id,now,now]);
 });
 await invalidateGroup(groupId);
 const channel=await db.get('SELECT * FROM channels WHERE id=?',[id]);
 for(const member of await db.all('SELECT u.* FROM users u JOIN group_members m ON m.user_id=u.id WHERE m.group_id=? AND u.is_active=1',[groupId])){
  if(await canAccessChannel(channel,await groupContext(groupId,member))){await refreshUserRooms(member.id);emitToUser(member.id,'channel:created',{channel:toChannel(channel)});}
 }
 return toChannel(channel);
}

export async function temporaryInvite(groupId,user,maxUses=1,expiresInHours=1){
 const ctx=await groupContext(groupId,user),{settings}=await botSettings(groupId);
 if(!settings.moderator.enabled||!settings.moderator.temporaryInvitesEnabled||!ctx.can('createInvite')||!ctx.can('useApplicationCommands'))throw forbidden('Temporary invites are disabled or not permitted.');
 return createInvite({groupId,createdBy:user.id,maxUses,expiresInHours});
}

export async function cleanupTemporaryVoice(){
 const db=getDb();
 for(const row of await db.all('SELECT * FROM builtin_bot_temp_channels WHERE created_at<?',[Date.now()-60000])){
  const {settings}=await botSettings(row.group_id),idleSeconds=settings.moderator.temporaryVoiceIdleSeconds??300;
  if(voiceParticipantCount(row.channel_id)){await db.run('UPDATE builtin_bot_temp_channels SET empty_since=NULL WHERE channel_id=?',[row.channel_id]);continue;}
  if(!row.empty_since){await db.run('UPDATE builtin_bot_temp_channels SET empty_since=? WHERE channel_id=?',[Date.now(),row.channel_id]);continue;}
  if(Date.now()-Number(row.empty_since)<idleSeconds*1000)continue;
  if(config.livekit.url){
   const call=await db.get('SELECT preferred_region FROM call_rooms WHERE channel_id=?',[row.channel_id]);
   const region=config.livekit.regions.find(r=>r.name===call?.preferred_region);
   const service=new RoomServiceClient((region?.apiUrl||config.livekit.apiUrl||config.livekit.url).replace(/^ws/,'http'),config.livekit.apiKey,config.livekit.apiSecret);
   // API failures keep the channel; a missing room is safely treated as empty.
   try{if((await service.listParticipants('channel-'+row.channel_id)).length)continue;}catch(error){if(error.code!=='not_found')continue;}
   await service.deleteRoom('channel-'+row.channel_id).catch(()=>{});
  }
  closeVoiceChannel(row.channel_id,getIo());
  await db.run('DELETE FROM channels WHERE id=?',[row.channel_id]);await invalidateGroup(row.group_id);
  for(const member of await db.all('SELECT user_id FROM group_members WHERE group_id=?',[row.group_id])){emitToUser(member.user_id,'channel:deleted',{groupId:row.group_id,channelId:row.channel_id});await refreshUserRooms(member.user_id);}
 }
}
