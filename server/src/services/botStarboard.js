import crypto from 'node:crypto';
import { getDb } from '../db/index.js';
import { botSettings, ensureBuiltinBots } from './builtinBots.js';
import { createMessage, hydrateMessage } from './messages.js';
import { emitToChannel } from '../realtime/index.js';

export async function updateBotStarboard(groupId,messageId) {
 const db=getDb(),{settings}=await botSettings(groupId),m=settings.moderator;
 if(!m.enabled||!m.starboardEnabled||!m.starboardChannelId)return;
 const source=await db.get('SELECT m.*,c.is_private,c.type AS channel_type,c.category_id,c.group_id,u.shadow_banned_at FROM messages m JOIN channels c ON c.id=m.channel_id JOIN users u ON u.id=m.author_id WHERE m.id=? AND c.group_id=?',[messageId,groupId]);
 if(!source||source.deleted_at||source.type==='encrypted'||source.shadow_banned_at||source.is_private||source.channel_type==='forum'||source.channel_id===m.starboardChannelId)return;
 // Never copy from a restricted source into a more widely visible channel.
 const overrides=await db.all('SELECT allow_permissions,deny_permissions FROM channel_permission_overrides WHERE channel_id=? UNION ALL SELECT allow_permissions,deny_permissions FROM category_permission_overrides WHERE category_id=?',[source.channel_id,source.category_id]);
 if(overrides.some(r=>JSON.parse(r.deny_permissions).some(p=>['viewChannel','readMessageHistory'].includes(p))))return;
 const destination=await db.get('SELECT id FROM channels WHERE id=? AND group_id=? AND type IN (?,?)',[m.starboardChannelId,groupId,'text','announcement']);if(!destination)return;
 const stars=Number((await db.get('SELECT COUNT(DISTINCT r.user_id) AS n FROM reactions r JOIN group_members gm ON gm.user_id=r.user_id AND gm.group_id=? JOIN users u ON u.id=r.user_id WHERE r.message_id=? AND r.emoji=? AND r.user_id<>? AND u.is_active=1 AND NOT EXISTS (SELECT 1 FROM builtin_bot_accounts b WHERE b.user_id=r.user_id)',[groupId,messageId,m.starboardEmoji||'⭐',source.author_id])).n);
 const existing=await db.get('SELECT posted_message_id FROM builtin_bot_starboard WHERE message_id=?',[messageId]);
 if(stars<(m.starboardThreshold||3)&&!existing?.posted_message_id)return;
 const content=`⭐ **${stars}** · <#${source.channel_id}> · @${(await db.get('SELECT username FROM users WHERE id=?',[source.author_id])).username}\n${source.content.slice(0,3500)}`;
 let message,created=false;
 await db.tx(async tx=>{
  await tx.run('INSERT INTO builtin_bot_starboard(message_id,group_id,stars) VALUES (?,?,?) ON CONFLICT(message_id) DO UPDATE SET stars=excluded.stars',[messageId,groupId,stars]);
  if(db.dialect==='postgres')await tx.get('SELECT message_id FROM builtin_bot_starboard WHERE message_id=? FOR UPDATE',[messageId]);
  const row=await tx.get('SELECT posted_message_id FROM builtin_bot_starboard WHERE message_id=?',[messageId]);
  if(row.posted_message_id){
   await tx.run('UPDATE messages SET content=?,edited_at=? WHERE id=? AND deleted_at IS NULL',[content,Date.now(),row.posted_message_id]);message=await hydrateMessage(row.posted_message_id);
  }else{
   const clientId=crypto.createHash('sha256').update('starboard:'+messageId).digest('hex');
   message=await createMessage({channelId:m.starboardChannelId,authorId:(await ensureBuiltinBots()).moderator,content,clientId});
   await tx.run('UPDATE builtin_bot_starboard SET posted_message_id=? WHERE message_id=?',[message.id,messageId]);created=!message.idempotentReplay;
  }
 });
 if(message)emitToChannel(m.starboardChannelId,created?'message:created':'message:updated',{message});
}
