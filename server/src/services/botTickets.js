import { getDb } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { badRequest, forbidden, notFound, conflict } from '../lib/errors.js';
import { groupContext, canAccessChannel } from './permissions.js';
import { botSettings, ensureBuiltinBots } from './builtinBots.js';
import { setChannelOverride } from './channelPermissions.js';
import { createMessage } from './messages.js';
import { invalidateGroup, toChannel } from './groups.js';
import { emitToUser, emitToChannel, refreshUserRooms } from '../realtime/index.js';
import { audit } from './audit.js';
import {assertUserLimit} from './userAccess.js';

function supportAccess(context,settings){return context.can('moderateMembers')||context.serverRoles.some(role=>settings.moderator.ticketSupportRoleIds.includes(role.id));}
async function publishTicketChannel(groupId,channelId,event){
 const db=getDb(),channel=await db.get('SELECT * FROM channels WHERE id=?',[channelId]);
 const members=await db.all('SELECT u.* FROM users u JOIN group_members m ON m.user_id=u.id WHERE m.group_id=? AND u.is_active=1',[groupId]);
 for(const user of members){
  const context=await groupContext(groupId,user);
  if(await canAccessChannel(channel,context)){
   await refreshUserRooms(user.id);
   emitToUser(user.id,event,{channel:toChannel(channel)});
  }
 }
}
export async function listBotTickets(groupId,user){
 const ctx=await groupContext(groupId,user),{settings}=await botSettings(groupId),support=supportAccess(ctx,settings);
 return getDb().all('SELECT t.*,u.username FROM builtin_bot_tickets t LEFT JOIN users u ON u.id=t.user_id WHERE t.group_id=?'+(support?'':' AND t.user_id=?')+' ORDER BY t.created_at DESC LIMIT 100',support?[groupId]:[groupId,user.id]);
}
export async function createBotTicket(groupId,user,topic){
 const ctx=await groupContext(groupId,user),{settings}=await botSettings(groupId),db=getDb();
 if(!ctx.can('useApplicationCommands'))throw forbidden('Application Commands permission is required.');
 if(!settings.moderator.enabled||!settings.moderator.ticketsEnabled)throw badRequest('Tickets are disabled.');
 const existing=await db.get("SELECT * FROM builtin_bot_tickets WHERE group_id=? AND user_id=? AND status!='closed'",[groupId,user.id]);
 if(existing)return existing;
 const id=newId(),channelId=newId(),now=Date.now();
 let duplicate=null;
 try{await db.tx(async tx=>{
  if(db.dialect==='postgres')await tx.get('SELECT id FROM users WHERE id=? FOR UPDATE',[ctx.group.owner_id]);
  duplicate=await tx.get("SELECT * FROM builtin_bot_tickets WHERE group_id=? AND user_id=? AND status!='closed'",[groupId,user.id]);if(duplicate)return;
  await assertUserLimit(ctx.group.owner_id,'maxChannelsPerGroup',Number((await tx.get('SELECT COUNT(*) AS count FROM channels WHERE group_id=?',[groupId])).count),tx);
  await tx.run('INSERT INTO channels(id,group_id,category_id,name,topic,type,is_private,permissions_synced,created_at,updated_at) VALUES (?,?,?,?,?,?,1,0,?,?)',[channelId,groupId,settings.moderator.ticketCategoryId,'ticket-'+user.username.slice(0,20),topic,'text',now,now]);
  await tx.run('INSERT INTO channel_members(channel_id,user_id,added_at) VALUES (?,?,?)',[channelId,user.id,now]);
  await tx.run('INSERT INTO builtin_bot_tickets(id,group_id,channel_id,user_id,created_at) VALUES (?,?,?,?,?)',[id,groupId,channelId,user.id,now]);
  await tx.run("INSERT INTO channel_permission_overrides(channel_id,group_id,target_type,target_id,allow_permissions,deny_permissions,updated_by,updated_at) VALUES (?,?,'member',?,?,?, ?,?)",[channelId,groupId,user.id,JSON.stringify(['viewChannel','sendMessages','readMessageHistory']), '[]',user.id,now]);
  for(const roleId of settings.moderator.ticketSupportRoleIds)await tx.run("INSERT INTO channel_permission_overrides(channel_id,group_id,target_type,target_id,allow_permissions,deny_permissions,updated_by,updated_at) VALUES (?,?,'role',?,?,?, ?,?)",[channelId,groupId,roleId,JSON.stringify(['viewChannel','sendMessages','readMessageHistory']), '[]',ctx.group.owner_id,now]);
 });}catch(error){const concurrent=await db.get("SELECT * FROM builtin_bot_tickets WHERE group_id=? AND user_id=? AND status!='closed'",[groupId,user.id]);if(concurrent)return concurrent;throw error;}
 if(duplicate)return duplicate;
 const message=await createMessage({channelId,authorId:(await ensureBuiltinBots()).moderator,content:`**Support ticket**\n@${user.username}: ${topic}`});
 await invalidateGroup(groupId);
 await publishTicketChannel(groupId,channelId,'channel:created');
 emitToChannel(channelId,'message:created',{message});
 await audit({actorId:user.id,action:'bot.ticket_created',targetType:'channel',targetId:channelId,meta:{groupId,ticketId:id}});
 return db.get('SELECT * FROM builtin_bot_tickets WHERE id=?',[id]);
}
export async function updateBotTicket(groupId,user,ticketId,action){
 const ctx=await groupContext(groupId,user),{settings}=await botSettings(groupId),db=getDb(),ticket=await db.get('SELECT * FROM builtin_bot_tickets WHERE id=? AND group_id=?',[ticketId,groupId]);
 if(!ticket)throw notFound('Ticket not found.');
 const channel=await db.get('SELECT * FROM channels WHERE id=?',[ticket.channel_id]);
 if(!(await canAccessChannel(channel,ctx)))throw forbidden('Ticket access denied.');
 if(!supportAccess(ctx,settings)&&!(action==='close'&&ticket.user_id===user.id))throw forbidden('Only support moderators can do that.');
 if(action==='claim'){
  const changed=await db.run("UPDATE builtin_bot_tickets SET claimed_by=?,status='claimed' WHERE id=? AND status!='closed' AND (claimed_by IS NULL OR claimed_by=?)",[user.id,ticketId,user.id]);
  if(!changed.changes)throw conflict('This ticket is closed or claimed by another moderator.');
 }else{
  const closed=action==='close';
  if(!closed&&ticket.status==='closed'&&ticket.user_id&&await db.get("SELECT id FROM builtin_bot_tickets WHERE group_id=? AND user_id=? AND status!='closed' AND id!=?",[groupId,ticket.user_id,ticketId]))throw conflict('This member already has another open ticket.');
  await db.tx(async tx=>{
   await tx.run('UPDATE builtin_bot_tickets SET status=?,closed_at=? WHERE id=?',[closed?'closed':'open',closed?Date.now():null,ticketId]);
   if(ticket.user_id)await setChannelOverride({groupId,channelId:ticket.channel_id,targetType:'member',targetId:ticket.user_id,allow:closed?['viewChannel','readMessageHistory']:['viewChannel','readMessageHistory','sendMessages'],deny:closed?['sendMessages']:[],updatedBy:user.id},tx);
  });
 }
 await audit({actorId:user.id,action:'bot.ticket_'+action,targetType:'channel',targetId:ticket.channel_id,meta:{groupId,ticketId}});
 await publishTicketChannel(groupId,ticket.channel_id,'channel:updated');
 return db.get('SELECT * FROM builtin_bot_tickets WHERE id=?',[ticketId]);
}
export async function botTicketTranscript(groupId,user,ticketId){
 const ctx=await groupContext(groupId,user),db=getDb(),ticket=await db.get('SELECT * FROM builtin_bot_tickets WHERE id=? AND group_id=?',[ticketId,groupId]);
 if(!ticket)throw notFound('Ticket not found.');
 const channel=await db.get('SELECT * FROM channels WHERE id=?',[ticket.channel_id]);if(!await canAccessChannel(channel,ctx))throw forbidden('Ticket access denied.');
 const rows=await db.all('SELECT m.content,m.created_at,u.username FROM messages m LEFT JOIN users u ON u.id=m.author_id WHERE channel_id=? AND deleted_at IS NULL ORDER BY m.created_at,m.id LIMIT 10000',[ticket.channel_id]);
 return `Ticket ${ticket.id}\nStatus: ${ticket.status}\n\n`+rows.map(row=>`[${new Date(Number(row.created_at)).toISOString()}] ${row.username||'Deleted user'}: ${row.content}`).join('\n');
}
