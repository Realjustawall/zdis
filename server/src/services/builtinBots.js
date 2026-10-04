import {config} from '../config.js';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { getDb } from '../db/index.js';
import { createUser, findUserById, invalidateUser } from './users.js';
import { groupContext, requireGroupPermission } from './permissions.js';
import { channelPermission, setChannelOverride } from './channelPermissions.js';
import { invalidateGroup, removeMember } from './groups.js';
import { createMessage, deleteMessage } from './messages.js';
import { emitToChannel, emitToGroup, emitToUser, refreshUserRooms, getIo } from '../realtime/index.js';
import { readObjectBuffer } from './storage.js';
import { storeUpload } from './uploads.js';
import { audit } from './audit.js';
import { logger } from '../lib/logger.js';
import { badRequest, forbidden, conflict, notFound } from '../lib/errors.js';
import { BOT_DEFAULTS, BOT_VARIABLES, renderBotTemplate, escapeSvg, matchBotRule, levelForXp, safeSelfRole } from './botRules.js';

export { BOT_VARIABLES };
const recentMessages = new Map();
let installPromise;
export async function ensureBuiltinBots() {
  if(installPromise)return installPromise;
  installPromise=(async()=>{
    const db=getDb(), users={};
    for(const kind of ['welcomer','moderator']) {
      let row=await db.get('SELECT user_id FROM builtin_bot_accounts WHERE kind=?',[kind]);
      if(!row) {
        const username=`zdis_${kind}_bot`, existing=await db.get('SELECT id FROM users WHERE username=?',[username]);
        // Never adopt a pre-existing human account with a matching display name.
        const user=existing ? await createUser({email:`${crypto.randomUUID()}@bots.invalid`,username:`${kind}${crypto.randomBytes(5).toString('hex')}`,displayName:kind==='welcomer'?'Welcomer Bot':'Moderator Bot',password:crypto.randomBytes(48).toString('base64url')+'!Aa1',skipPasswordPolicy:true}) : await createUser({email:`${username}@bots.invalid`,username,displayName:kind==='welcomer'?'Welcomer Bot':'Moderator Bot',password:crypto.randomBytes(48).toString('base64url')+'!Aa1',skipPasswordPolicy:true});
        await db.run('INSERT INTO builtin_bot_accounts(kind,user_id) VALUES (?,?) ON CONFLICT(kind) DO NOTHING',[kind,user.id]);
        row=await db.get('SELECT user_id FROM builtin_bot_accounts WHERE kind=?',[kind]);
      }
      for(const badge of ['bot','verified_bot'])await db.run('INSERT INTO user_badges(user_id,badge_id,granted_at) VALUES (?,?,?) ON CONFLICT(user_id,badge_id) DO NOTHING',[row.user_id,badge,Date.now()]);
      await db.run('UPDATE users SET presence=?, custom_status=? WHERE id=?',['online','Official ZDIS automation',row.user_id]);
      await invalidateUser(row.user_id);users[kind]=row.user_id;
    }
    return users;
  })();
  try{return await installPromise;}catch(error){installPromise=null;throw error;}
}
export async function botSettings(groupId) {
  const row=await getDb().get('SELECT * FROM builtin_bot_settings WHERE group_id=?',[groupId]);
  const saved=row?JSON.parse(row.settings):{};
  return {settings:{welcomer:{...BOT_DEFAULTS.welcomer,...saved.welcomer},moderator:{...BOT_DEFAULTS.moderator,...saved.moderator}},revision:Number(row?.revision||0)};
}
export async function saveBotSettings(groupId, actor, settings, revision) {
  const ctx=await requireGroupPermission(groupId,actor,'manageGroup'), db=getDb();
  for(const channelId of [settings.welcomer.welcomeChannelId,settings.welcomer.goodbyeChannelId,settings.moderator.logChannelId,settings.moderator.starboardChannelId].filter(Boolean)) {
    const channel=await db.get('SELECT * FROM channels WHERE id=? AND group_id=?',[channelId,groupId]);
    if(!channel||!['text','announcement'].includes(channel.type)||!(await channelPermission(channel,ctx,'sendMessages'))||!(await channelPermission(channel,ctx,'viewChannel')))throw badRequest('Choose an accessible text channel in this server.');
  }
  if(settings.welcomer.enabled&&!settings.welcomer.welcomeChannelId)throw badRequest('Select a welcome channel first.');
  for(const roleId of [...settings.welcomer.autoRoleIds,...settings.moderator.levelRewards.map(r=>r.roleId),...settings.moderator.selfRoleIds,...settings.moderator.exemptRoleIds,...(settings.moderator.protectedRoleIds||[]),...settings.moderator.ticketSupportRoleIds]) {
    const role=await db.get('SELECT * FROM server_roles WHERE id=? AND group_id=?',[roleId,groupId]);
    if(!role||role.is_default)throw badRequest('Select a custom role from this server.');
    if(settings.moderator.selfRoleIds.includes(roleId)&&!safeSelfRole(role))throw forbidden('Privileged roles cannot be self-selected.');
    if(settings.welcomer.autoRoleIds.includes(roleId)||settings.moderator.selfRoleIds.includes(roleId)||settings.moderator.levelRewards.some(r=>r.roleId===roleId)) {
      if(!ctx.can('manageRoles')||(!ctx.isPlatformAdmin&&ctx.role!=='owner'&&Number(role.position)>=ctx.highestRolePosition))throw forbidden('You cannot assign this role.');
      if(JSON.parse(role.permissions||'[]').some(p=>!ctx.can(p)))throw forbidden('Auto roles cannot grant permissions you do not have.');
    }
  }
  for(const id of settings.moderator.exemptChannelIds)if(!await db.get('SELECT id FROM channels WHERE id=? AND group_id=?',[id,groupId]))throw badRequest('Invalid exempt channel.');
  if(settings.moderator.temporaryVoiceCategoryId&&!await db.get('SELECT id FROM channel_categories WHERE id=? AND group_id=?',[settings.moderator.temporaryVoiceCategoryId,groupId]))throw badRequest('Invalid temporary voice category.');
  if(settings.moderator.ticketCategoryId&&!await db.get('SELECT id FROM channel_categories WHERE id=? AND group_id=?',[settings.moderator.ticketCategoryId,groupId]))throw badRequest('Invalid ticket category.');
  if(settings.welcomer.backgroundAttachmentId) {
    const file=await db.get('SELECT * FROM attachments WHERE id=? AND uploader_id=? AND message_id IS NULL',[settings.welcomer.backgroundAttachmentId,actor.id]);
    const current=await botSettings(groupId);
    if(!file&&current.settings.welcomer.backgroundAttachmentId!==settings.welcomer.backgroundAttachmentId)throw badRequest('Upload your banner background first.');
    if(file&&(!file.mime.startsWith('image/')||Number(file.size)>8*1024*1024||file.quarantined_at||file.scan_status==='infected'))throw badRequest('Use a safe image smaller than 8 MB.');
  }
  const bots=await ensureBuiltinBots();
  await db.tx(async tx=>{
    const result=revision===0 ? await tx.run('INSERT INTO builtin_bot_settings(group_id,settings,revision,updated_by,updated_at) VALUES (?,?,1,?,?) ON CONFLICT(group_id) DO NOTHING',[groupId,JSON.stringify(settings),actor.id,Date.now()]) : await tx.run('UPDATE builtin_bot_settings SET settings=?,revision=revision+1,updated_by=?,updated_at=? WHERE group_id=? AND revision=?',[JSON.stringify(settings),actor.id,Date.now(),groupId,revision]);
    if(!result.changes)throw conflict('Settings changed in another window. Reload before saving.');
    await tx.run('DELETE FROM builtin_bot_assets WHERE group_id=?',[groupId]);
    if(settings.welcomer.backgroundAttachmentId)await tx.run('INSERT INTO builtin_bot_assets(group_id,attachment_id) VALUES (?,?)',[groupId,settings.welcomer.backgroundAttachmentId]);
    for(const kind of ['welcomer','moderator'])if(settings[kind].enabled)await tx.run('INSERT INTO group_members(group_id,user_id,role,invited_by,joined_at) VALUES (?,?,?,?,?) ON CONFLICT(group_id,user_id) DO NOTHING',[groupId,bots[kind],'member',actor.id,Date.now()]);else await tx.run('DELETE FROM group_members WHERE group_id=? AND user_id=?',[groupId,bots[kind]]);
  });
  await invalidateGroup(groupId);
  await audit({actorId:actor.id,action:'bots.settings_updated',targetType:'group',targetId:groupId});
  emitToGroup(groupId,'group:member-updated',{groupId});
  return botSettings(groupId);
}
export async function botPost(groupId, channelId, content, kind='moderator', attachmentIds=[], clientId=null) {
  if(!channelId)return null;
  const channel=await getDb().get('SELECT * FROM channels WHERE id=? AND group_id=?',[channelId,groupId]);
  if(!channel||!['text','announcement'].includes(channel.type))return null;
  const authorId=(await ensureBuiltinBots())[kind];
  const message=await createMessage({channelId,authorId,content,attachmentIds,clientId});
  if(!message.idempotentReplay)emitToChannel(channelId,'message:created',{message});
  return message;
}
export async function botTemplateValues(groupId,userId) {
  const db=getDb(), user=await db.get('SELECT * FROM users WHERE id=?',[userId]), group=await db.get('SELECT * FROM chat_groups WHERE id=?',[groupId]);
  if(!user||!group)throw notFound('Server or member no longer exists.');
  const count=await db.get('SELECT COUNT(*) AS n FROM group_members WHERE group_id=? AND user_id NOT IN (SELECT user_id FROM builtin_bot_accounts)',[groupId]);
  const membership=await db.get('SELECT joined_at FROM group_members WHERE group_id=? AND user_id=?',[groupId,userId]);
  return {username:user.username,displayName:user.display_name,mention:'@'+user.username,userId,avatar:user.avatar_url||'',server:group.name,memberCount:Number(count.n),joinedAt:membership?.joined_at?new Date(Number(membership.joined_at)).toISOString():'',createdAt:new Date(Number(user.created_at)).toISOString()};
}
export async function renderWelcomeBanner(settings,values,kind='join') {
  const titleText=renderBotTemplate(kind==='leave'?settings.goodbyeTitle:settings.bannerTitle,values).slice(0,75), subtitleText=renderBotTemplate(settings.bannerSubtitle,values).slice(0,110);
  const title=escapeSvg(titleText), subtitle=escapeSvg(subtitleText);
  const textLayout=(text,size)=>{
    const rtl=/[\u0590-\u08ff]/u.test(text),fontSize=Math.min(size,Math.max(12,650/(Math.max(1,Array.from(text).length)*0.7)));
    return `x="${rtl?950:300}" text-anchor="${rtl?'end':'start'}" direction="${rtl?'rtl':'ltr'}" font-size="${fontSize}"${text.length>65?' textLength="650" lengthAdjust="spacingAndGlyphs"':''}`;
  };
  const overlay=Buffer.from(`<svg width="1000" height="360" xmlns="http://www.w3.org/2000/svg"><rect width="1000" height="360" rx="24" fill="${settings.bannerColor}"/><circle cx="160" cy="180" r="100" fill="#ffffff22"/><text x="160" y="203" text-anchor="middle" font-size="72" fill="${settings.textColor}">${escapeSvg(values.displayName.slice(0,2))}</text><text ${textLayout(titleText,36)} y="165" font-family="Segoe UI, Tahoma, sans-serif" font-weight="700" fill="${settings.textColor}">${title}</text><text ${textLayout(subtitleText,21)} y="215" font-family="Segoe UI, Tahoma, sans-serif" fill="${settings.textColor}">${subtitle}</text></svg>`);
  const composites=[];
  let base=sharp({create:{width:1000,height:360,channels:4,background:settings.bannerColor}});
  if(settings.backgroundAttachmentId){const file=await getDb().get('SELECT * FROM attachments WHERE id=? AND quarantined_at IS NULL AND scan_status!=?',[settings.backgroundAttachmentId,'infected']);if(file){base=sharp(await readObjectBuffer(file),{limitInputPixels:20_000_000}).resize(1000,360,{fit:'cover'});const transparentOverlay=overlay.toString().replace(`fill="${settings.bannerColor}"`,`fill="#00000080"`);composites.push({input:Buffer.from(transparentOverlay),top:0,left:0});}}
  if(!composites.length)composites.push({input:overlay,top:0,left:0});
  const avatarId=/^\/api\/files\/([a-zA-Z0-9_-]{8,64})(?:\?|$)/.exec(values.avatar)?.[1];
  if(avatarId){try{const file=await getDb().get('SELECT * FROM attachments WHERE id=? AND quarantined_at IS NULL AND scan_status!=?',[avatarId,'infected']);if(file){const avatar=await sharp(await readObjectBuffer(file),{limitInputPixels:20_000_000}).resize(176,176).composite([{input:Buffer.from('<svg width="176" height="176"><circle cx="88" cy="88" r="88" fill="white"/></svg>'),blend:'dest-in'}]).png().toBuffer();composites.push({input:avatar,top:92,left:72});}}catch(error){logger.warn('Welcomer avatar skipped',{error:error.message});}}
  return base.composite(composites).png().toBuffer();
}
export async function sendWelcome(groupId,userId,kind='join',eventId=null,joinedAt=null) {
  const {settings}=await botSettings(groupId), w=settings.welcomer;
  if(!w.enabled)return null;
  const channelId=kind==='leave'?w.goodbyeChannelId:w.welcomeChannelId;if(!channelId)return null;
  const values=await botTemplateValues(groupId,userId);if(joinedAt)values.joinedAt=new Date(Number(joinedAt)).toISOString();const content=renderBotTemplate(kind==='leave'?w.goodbyeMessage:w.welcomeMessage,values).slice(0,4000), attachments=[];
  if(w.bannerEnabled){try{const buffer=await renderWelcomeBanner(w,values,kind), file=await storeUpload({uploaderId:(await ensureBuiltinBots()).welcomer,file:{buffer,size:buffer.length,mimetype:'image/png',originalname:'welcome.png'}});attachments.push(file.id);}catch(error){logger.warn('Welcomer banner failed; sending text',{error:error.message});}}
  return botPost(groupId,channelId,content||'Welcome', 'welcomer',attachments,eventId);
}
export async function recordMembershipBotEvent(groupId,userId,kind,joinedAt=null) {
  const db=getDb();if(await db.get('SELECT 1 AS ok FROM builtin_bot_accounts WHERE user_id=?',[userId]))return;
  const {settings}=await botSettings(groupId);if(settings.moderator.enabled&&settings.moderator.logsEnabled)await botPost(groupId,settings.moderator.logChannelId,`**Member ${kind}** - ${userId}`);if(!settings.welcomer.enabled)return;
  const id=crypto.randomUUID();await db.run('INSERT INTO builtin_bot_events(id,group_id,user_id,kind,created_at,joined_at) VALUES (?,?,?,?,?,?)',[id,groupId,userId,kind,Date.now(),joinedAt]);
  if(kind==='join')for(const roleId of settings.welcomer.autoRoleIds)await grantAutomationRole(groupId,userId,roleId,'welcomer');
  await processMembershipEvent({id,group_id:groupId,user_id:userId,kind,joined_at:joinedAt});await invalidateGroup(groupId);
}
export async function grantAutomationRole(groupId,userId,roleId,kind,selfSelect=false){
 const db=getDb(), saved=await db.get('SELECT updated_by FROM builtin_bot_settings WHERE group_id=?',[groupId]);
 if(!saved?.updated_by)return;
 const actor=await findUserById(saved.updated_by);if(!actor?.is_active)return;
 let ctx;try{ctx=await groupContext(groupId,actor);}catch(error){logger.warn('Automation role skipped: settings author lost access',{groupId,error:error.message});return;}const role=await db.get('SELECT * FROM server_roles WHERE id=? AND group_id=? AND is_default=0',[roleId,groupId]);
 if(!role||!ctx.can('manageGroup')||!ctx.can('manageRoles')||(!ctx.isPlatformAdmin&&ctx.role!=='owner'&&Number(role.position)>=ctx.highestRolePosition)||JSON.parse(role.permissions||'[]').some(p=>!ctx.can(p)))return;
 if(selfSelect&&!safeSelfRole(role))return;
 if(!await db.get('SELECT 1 AS ok FROM group_members WHERE group_id=? AND user_id=?',[groupId,userId]))return;
 await db.run('INSERT INTO server_member_roles(group_id,user_id,role_id,assigned_by,created_at) VALUES (?,?,?,?,?) ON CONFLICT(group_id,user_id,role_id) DO NOTHING',[groupId,userId,roleId,(await ensureBuiltinBots())[kind],Date.now()]);
 return true;
}
async function processMembershipEvent(event){try{await sendWelcome(event.group_id,event.user_id,event.kind,event.id,event.joined_at);await getDb().run('UPDATE builtin_bot_events SET done=1 WHERE id=?',[event.id]);}catch(error){await getDb().run('UPDATE builtin_bot_events SET attempts=attempts+1 WHERE id=?',[event.id]);logger.warn('Welcomer event delivery pending',{id:event.id,error:error.message});}}
async function recordCase(groupId,userId,actorId,action,reason,expiresAt=null){const id=crypto.randomUUID();await getDb().run('INSERT INTO builtin_bot_cases(id,group_id,user_id,actor_id,action,reason,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)',[id,groupId,userId,actorId,action,reason,expiresAt,Date.now()]);await audit({actorId,action:'bot.'+action,targetType:'user',targetId:userId||groupId,meta:{groupId,reason,caseId:id}});const {settings}=await botSettings(groupId);try{await botPost(groupId,settings.moderator.logChannelId,`**${action}** · Case \`${id.slice(0,8)}\`\n${userId?'User: '+userId+'\n':''}Reason: ${reason}`);}catch(error){logger.warn('Moderator log delivery failed',{caseId:id,error:error.message});}return id;}
export async function moderatorAction(groupId,actor,body) {
  const ctx=await groupContext(groupId,actor),db=getDb(),{settings}=await botSettings(groupId);if(!settings.moderator.enabled)throw badRequest('Enable Moderator Bot first.');
  const {action,userId=null,channelId=null,reason='No reason supplied',durationSeconds=600,count=20}=body;
  if(['timeout','ban'].includes(action)&&(!Number.isInteger(durationSeconds)||durationSeconds<60||durationSeconds>28*86400))throw badRequest('Duration must be between 60 seconds and 28 days.');
  if(action==='unban'&&!userId)throw badRequest('Choose a banned user.');
  if(action==='slowmode'&&durationSeconds>21600)throw badRequest('Slowmode must be between 0 and 21600 seconds.');
  const permissions={move:'moveMembers',bulkRole:'manageRoles',setColor:'manageRoles',setXp:'moderateMembers',setLevel:'moderateMembers',resetXp:'moderateMembers',voiceKick:'moveMembers',muteText:'moderateMembers',unmuteText:'moderateMembers',muteVoice:'muteMembers',unmuteVoice:'muteMembers',pointsSet:'moderateMembers',pointsIncrease:'moderateMembers',pointsDecrease:'moderateMembers',pointsReset:'moderateMembers',removeWarning:'moderateMembers',warn:'moderateMembers',clearWarnings:'moderateMembers',timeout:'moderateMembers',untimeout:'moderateMembers',kick:'kickMember',ban:'banMembers',unban:'banMembers',purge:'deleteAnyMessage',lock:'manageChannels',unlock:'manageChannels',slowmode:'manageChannels',nickname:'manageNicknames',role:'manageRoles'};
  if(!permissions[action]||!ctx.can(permissions[action]))throw forbidden('You do not have permission for this action.');
  const targetActions=['move','setXp','setLevel','resetXp','voiceKick','muteText','unmuteText','muteVoice','unmuteVoice','pointsSet','pointsIncrease','pointsDecrease','pointsReset','removeWarning','warn','clearWarnings','timeout','untimeout','kick','ban','nickname','role'];
  if(targetActions.includes(action)) {
    if(!userId)throw badRequest('Choose a member.');
    const target=await db.get('SELECT * FROM group_members WHERE group_id=? AND user_id=?',[groupId,userId]);
    if(!target||userId===ctx.group.owner_id||userId===actor.id||!(await ctx.outranksMember(userId)))throw forbidden('You cannot moderate this member.');
    const targetUser=await findUserById(userId),targetCtx=await groupContext(groupId,targetUser);if(targetCtx.isPlatformAdmin&&!ctx.isPlatformAdmin)throw forbidden('Platform administrators are protected.');
  }
  if(['purge','lock','unlock','slowmode'].includes(action)) {
    const channel=await db.get('SELECT * FROM channels WHERE id=? AND group_id=?',[channelId,groupId]);
    if(!channel||!(await channelPermission(channel,ctx,'viewChannel'))||!(await channelPermission(channel,ctx,permissions[action])))throw forbidden('Choose an accessible channel you can manage.');
  }
  if(['ban','kick','purge','role','bulkRole','setColor'].includes(action)){const {guardBotAction}=await import('./botProtection.js');await guardBotAction(groupId,actor,body.userIds||[userId].filter(Boolean));}
  if(action==='move'){const {moveVoiceParticipant}=await import('../realtime/voice.js');await moveVoiceParticipant(groupId,actor,userId,channelId,getIo());}
  else if(['setXp','setLevel','resetXp'].includes(action)) {
    const value=action==='resetXp'?0:action==='setLevel'?100*(body.level??0)**2:body.xp??0;
    if(!Number.isInteger(value)||value<0||value>1000000000)throw badRequest('Invalid XP value.');
    if(body.xpType==='voice'){
      const {awardVoiceXp}=await import('./botProfiles.js');await awardVoiceXp(groupId,userId,0);
      await db.run('UPDATE builtin_bot_profiles SET voice_xp=? WHERE group_id=? AND user_id=?',[value,groupId,userId]);
    }else await db.run('INSERT INTO builtin_bot_levels(group_id,user_id,xp,last_xp_at) VALUES (?,?,?,0) ON CONFLICT(group_id,user_id) DO UPDATE SET xp=excluded.xp',[groupId,userId,value]);
  }else if(action==='setColor'){
    const role=await db.get('SELECT * FROM server_roles WHERE id=? AND group_id=? AND is_default=0',[body.roleId,groupId]);
    if(!role||(!ctx.isPlatformAdmin&&ctx.role!=='owner'&&Number(role.position)>=ctx.highestRolePosition))throw forbidden('You cannot modify this role.');
    if(!/^#[0-9a-f]{6}$/i.test(body.color||''))throw badRequest('Choose a valid hex color.');
    await db.run('UPDATE server_roles SET color=?,updated_at=? WHERE id=?',[body.color,Date.now(),role.id]);
  }else if(action==='voiceKick'){const {removeUserFromGroupVoice}=await import('../realtime/voice.js');await removeUserFromGroupVoice(groupId,userId,getIo());}
  else if (['muteText','muteVoice','unmuteText','unmuteVoice'].includes(action)) {
    const kind=action.endsWith('Text')?'text':'voice';
    if(action.startsWith('unmute')) await db.run('DELETE FROM builtin_bot_mutes WHERE group_id=? AND user_id=? AND kind=?',[groupId,userId,kind]);
    else {
      if(!Number.isInteger(durationSeconds)||durationSeconds<60||durationSeconds>28*86400)throw badRequest('Duration must be between 60 seconds and 28 days.');
      await db.run('INSERT INTO builtin_bot_mutes(group_id,user_id,kind,expires_at,actor_id,reason) VALUES (?,?,?,?,?,?) ON CONFLICT(group_id,user_id,kind) DO UPDATE SET expires_at=excluded.expires_at,actor_id=excluded.actor_id,reason=excluded.reason',[groupId,userId,kind,Date.now()+durationSeconds*1000,actor.id,reason]);
    }
    const {enforceVoiceAccess}=await import('../realtime/voice.js');
    await enforceVoiceAccess(getIo(),userId);
  } else if(action.startsWith('points')) {
    const amount=body.points??0;
    if(!Number.isInteger(amount)||amount<0||amount>1000000)throw badRequest('Points must be between 0 and 1000000.');
    await db.tx(async tx=>{
      await tx.run('INSERT INTO builtin_bot_points(group_id,user_id,points) VALUES (?,?,0) ON CONFLICT(group_id,user_id) DO NOTHING',[groupId,userId]);
      const row=await tx.get('SELECT points FROM builtin_bot_points WHERE group_id=? AND user_id=?',[groupId,userId]);
      const value=action==='pointsReset'?0:action==='pointsSet'?amount:action==='pointsIncrease'?Number(row.points)+amount:Math.max(0,Number(row.points)-amount);
      if(value>1000000000)throw badRequest('Points limit reached.');
      await tx.run('UPDATE builtin_bot_points SET points=? WHERE group_id=? AND user_id=?',[value,groupId,userId]);
    });
  } else if(action==='removeWarning') {
    const warning=await db.get("SELECT id FROM builtin_bot_cases WHERE id=? AND group_id=? AND user_id=? AND action='warn' AND active=1",[body.warningId,groupId,userId]);
    if(!warning)throw notFound('Active warning not found.');
    await db.run('UPDATE builtin_bot_cases SET active=0 WHERE id=?',[warning.id]);
  } else if(action==='warn'||action==='clearWarnings') {
    if(action==='clearWarnings')await db.run("UPDATE builtin_bot_cases SET active=0 WHERE group_id=? AND user_id=? AND action='warn'",[groupId,userId]);
    else {
      await recordCase(groupId,userId,actor.id,'warn',reason);
      const warnings=await db.get("SELECT COUNT(*) AS n FROM builtin_bot_cases WHERE group_id=? AND user_id=? AND action='warn' AND active=1",[groupId,userId]);
      if(Number(warnings.n)>=settings.moderator.warningThreshold){await moderatorAction(groupId,actor,{action:'timeout',userId,reason:'Warning threshold reached',durationSeconds:settings.moderator.timeoutSeconds});}
      return {ok:true,warnings:Number(warnings.n)};
    }
  } else if(action==='timeout') await db.run('INSERT INTO server_timeouts(group_id,user_id,reason,expires_at,created_by,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(group_id,user_id) DO UPDATE SET reason=excluded.reason,expires_at=excluded.expires_at,created_by=excluded.created_by',[groupId,userId,reason,Date.now()+durationSeconds*1000,actor.id,Date.now()]);
  else if(action==='untimeout')await db.run('DELETE FROM server_timeouts WHERE group_id=? AND user_id=?',[groupId,userId]);
  else if(action==='kick') {await removeMember({groupId,userId});await refreshUserRooms(userId);}
  else if(action==='ban') {await db.run('INSERT INTO server_bans(group_id,user_id,reason,banned_by,created_at) VALUES (?,?,?,?,?) ON CONFLICT(group_id,user_id) DO UPDATE SET reason=excluded.reason,banned_by=excluded.banned_by,created_at=excluded.created_at',[groupId,userId,reason,actor.id,Date.now()]);await removeMember({groupId,userId});await refreshUserRooms(userId);}
  else if(action==='unban')await db.run('DELETE FROM server_bans WHERE group_id=? AND user_id=?',[groupId,userId]);
  else if(action==='purge'){const rows=await db.all('SELECT m.id FROM messages m WHERE channel_id=? AND deleted_at IS NULL'+(body.userId?' AND author_id=?':'')+(body.botsOnly?' AND EXISTS (SELECT 1 FROM builtin_bot_accounts b WHERE b.user_id=m.author_id)':'')+' ORDER BY created_at DESC LIMIT ?',body.userId?[channelId,body.userId,count]:[channelId,count]);for(const row of rows){const {listAttachmentsForMessage}=await import('./messages.js'),{deleteAttachments}=await import('./uploads.js');const attachments=await listAttachmentsForMessage(row.id);await deleteMessage(row.id,actor.id);await deleteAttachments(attachments);emitToChannel(channelId,'message:deleted',{messageId:row.id});}}
  else if(action==='lock'||action==='unlock') {
    const prior=await db.get("SELECT * FROM channel_permission_overrides WHERE channel_id=? AND target_type='everyone' AND target_id=?",[channelId,groupId]);
    const allow=JSON.parse(prior?.allow_permissions||'[]').filter(p=>p!=='sendMessages'),deny=JSON.parse(prior?.deny_permissions||'[]').filter(p=>p!=='sendMessages');if(action==='lock')deny.push('sendMessages');
    await db.run('UPDATE channels SET permissions_synced=0 WHERE id=?',[channelId]);
    await setChannelOverride({groupId,channelId,targetType:'everyone',targetId:groupId,allow,deny,updatedBy:actor.id});
  } else if(action==='slowmode')await db.run('UPDATE channels SET slowmode=?,updated_at=? WHERE id=?',[durationSeconds,Date.now(),channelId]);
  else if(action==='nickname')await db.run('UPDATE group_members SET nickname=? WHERE group_id=? AND user_id=?',[body.nickname||null,groupId,userId]);
  else if(action==='role'||action==='bulkRole'){
    const role=await db.get('SELECT * FROM server_roles WHERE id=? AND group_id=? AND is_default=0',[body.roleId,groupId]);
    if(!role||(!ctx.isPlatformAdmin&&ctx.role!=='owner'&&Number(role.position)>=ctx.highestRolePosition)||JSON.parse(role.permissions||'[]').some(p=>!ctx.can(p)))throw forbidden('You cannot assign this role.');
    const targets=action==='bulkRole'?[...new Set(body.userIds||[])]:[userId];
    if(!targets.length||targets.length>100)throw badRequest('Choose between 1 and 100 members.');
    await db.tx(async tx=>{
      for(const id of targets){
        const member=await tx.get('SELECT user_id FROM group_members WHERE group_id=? AND user_id=?',[groupId,id]);
        if(!member||id===actor.id||id===ctx.group.owner_id||!await ctx.outranksMember(id))throw forbidden('You cannot manage one of these members.');
        const targetUser=await findUserById(id),targetCtx=await groupContext(groupId,targetUser);
        if(targetCtx.isPlatformAdmin&&!ctx.isPlatformAdmin)throw forbidden('Platform administrators are protected.');
      }
      for(const id of targets){
        if(body.remove)await tx.run('DELETE FROM server_member_roles WHERE group_id=? AND user_id=? AND role_id=?',[groupId,id,role.id]);
        else await tx.run('INSERT INTO server_member_roles(group_id,user_id,role_id,assigned_by,created_at) VALUES (?,?,?,?,?) ON CONFLICT(group_id,user_id,role_id) DO NOTHING',[groupId,id,role.id,actor.id,Date.now()]);
      }
    });
    for(const id of targets)await refreshUserRooms(id);
  }
  await invalidateGroup(groupId);emitToGroup(groupId,'group:member-updated',{groupId});
  if(['kick','ban'].includes(action)){emitToUser(userId,'group:left',{groupId});const {removeUserFromGroupVoice}=await import('../realtime/voice.js');await removeUserFromGroupVoice(groupId,userId,getIo());}
  const expiresAt=action==='ban'&&body.temporary?Date.now()+durationSeconds*1000:null;
  const caseId=await recordCase(groupId,userId,actor.id,action,reason,expiresAt);return {ok:true,caseId};
}
export async function inspectModeratorMessage(target,user,content,attachmentCount=0) {
  if(target.kind!=='channel')return;
  const groupId=target.channel.group_id,{settings}=await botSettings(groupId), m=settings.moderator;
  if(!m.enabled||target.context.can('manageGroup')||target.context.can('moderateMembers')||m.exemptChannelIds.includes(target.channelId)||target.context.serverRoles.some(r=>m.exemptRoleIds.includes(r.id))||await getDb().get('SELECT 1 AS ok FROM builtin_bot_accounts WHERE user_id=?',[user.id]))return;
  const key=groupId+':'+user.id, now=Date.now(), history=recentMessages.get(key)||[];
  const reason=matchBotRule(content,attachmentCount,m,history,now);history.push({at:now,text:content.normalize('NFKC').toLocaleLowerCase()});recentMessages.set(key,history.filter(item=>now-item.at<m.windowSeconds*1000).slice(-100));
  if(recentMessages.size>10000)for(const [k,v]of recentMessages)if(!v.length||now-v.at(-1).at>60000)recentMessages.delete(k);
  if(reason){const botId=(await ensureBuiltinBots()).moderator;if(m.action==='timeout')await getDb().run('INSERT INTO server_timeouts(group_id,user_id,reason,expires_at,created_by,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(group_id,user_id) DO UPDATE SET reason=excluded.reason,expires_at=excluded.expires_at,created_by=excluded.created_by',[groupId,user.id,reason,now+m.timeoutSeconds*1000,botId,now]);await recordCase(groupId,user.id,botId,'automod-'+m.action,reason);throw forbidden('Moderator Bot blocked this message: '+reason);}
}
export async function afterBotMessage(target,user,message) {
  if(target.kind!=='channel'||message.type==='encrypted'||message.idempotentReplay)return;
  const groupId=target.channel.group_id,{settings}=await botSettings(groupId),m=settings.moderator;if(!m.enabled)return;
  if(await getDb().get('SELECT 1 AS ok FROM builtin_bot_accounts WHERE user_id=?',[user.id]))return;
  if(m.levelingEnabled){const db=getDb(),now=Date.now();await db.run('INSERT INTO builtin_bot_levels(group_id,user_id,xp,last_xp_at) VALUES (?,?,0,0) ON CONFLICT(group_id,user_id) DO NOTHING',[groupId,user.id]);const result=await db.tx(async tx=>{const result=await tx.run('UPDATE builtin_bot_levels SET xp=xp+?,last_xp_at=? WHERE group_id=? AND user_id=? AND last_xp_at<=?',[m.xpPerMessage,now,groupId,user.id,now-m.xpCooldownSeconds*1000]);if(result.changes)await tx.run("INSERT INTO builtin_bot_xp_events(id,group_id,user_id,kind,xp,created_at) VALUES (?,?,?,'text',?,?)",[crypto.randomUUID(),groupId,user.id,m.xpPerMessage,now]);return result;});if(result.changes){const row=await db.get('SELECT xp FROM builtin_bot_levels WHERE group_id=? AND user_id=?',[groupId,user.id]);for(const reward of m.levelRewards)if((reward.type||'text')==='text'&&levelForXp(row.xp)>=reward.level){await grantAutomationRole(groupId,user.id,reward.roleId,'moderator');}await invalidateGroup(groupId);if(m.levelRewards.length){await refreshUserRooms(user.id);emitToGroup(groupId,'group:member-updated',{groupId,userId:user.id});}}}
  const response=m.responses.find(r=>r.exact?message.content.toLocaleLowerCase()===r.trigger.toLocaleLowerCase():message.content.toLocaleLowerCase().includes(r.trigger.toLocaleLowerCase()));
  if(response)await botPost(groupId,target.channelId,renderBotTemplate(response.response,await botTemplateValues(groupId,user.id)).slice(0,4000));
  const command=/^\/(warn|warnings|clearwarnings|timeout|untimeout|mutevoice|unmutevoice|mute|unmute|kick|ban|tempban|unban|purge|lock|unlock|slowmode|nickname|role|move|moveme|colors|color|tempvoice|templink|profile|credits|daily|rep|title|roll|user|avatar|server|roles|rank|top|bothelp)\b\s*(.*)$/i.exec(message.content);if(!command||!(await channelPermission(target.channel,target.context,'useApplicationCommands')))return;
  const name=command[1].toLowerCase(),args=command[2].trim().split(/\s+/);
  try {
    if(name==='bothelp'){await botPost(groupId,target.channelId,'**Moderator Bot**\n/warn @user reason · /warnings @user · /clearwarnings @user · /timeout @user seconds reason · /untimeout @user · /kick @user reason · /ban @user reason · /unban @user · /purge count · /lock · /unlock · /slowmode seconds · /rank · /top\nAll moderation commands enforce your permissions and role hierarchy.');return;}
    if(name==='rank'||name==='top'){
      const kind=args.includes('voice')?'voice':'text',period=args.find(a=>['day','week','month'].includes(a)),days={day:1,week:7,month:30};let rows;
      if(name==='rank'){const {botProfile}=await import('./botProfiles.js');const profile=await botProfile(groupId,user.id);rows=[{xp:kind==='voice'?profile.voice_xp:profile.text_xp,display_name:user.display_name}];}
      else if(period)rows=await getDb().all('SELECT SUM(e.xp) AS xp,u.display_name FROM builtin_bot_xp_events e JOIN users u ON u.id=e.user_id JOIN group_members m ON m.user_id=e.user_id AND m.group_id=e.group_id WHERE e.group_id=? AND e.kind=? AND e.created_at>? GROUP BY e.user_id,u.display_name ORDER BY xp DESC LIMIT 10',[groupId,kind,Date.now()-days[period]*86400000]);
      else rows=kind==='voice'?await getDb().all('SELECT p.voice_xp AS xp,u.display_name FROM builtin_bot_profiles p JOIN users u ON u.id=p.user_id JOIN group_members m ON m.user_id=p.user_id AND m.group_id=p.group_id WHERE p.group_id=? ORDER BY p.voice_xp DESC LIMIT 10',[groupId]):await getDb().all('SELECT l.xp,u.display_name FROM builtin_bot_levels l JOIN users u ON u.id=l.user_id JOIN group_members m ON m.user_id=l.user_id AND m.group_id=l.group_id WHERE l.group_id=? ORDER BY l.xp DESC LIMIT 10',[groupId]);
      await botPost(groupId,target.channelId,rows.length?rows.map((r,i)=>`${i+1}. ${r.display_name} - Level ${levelForXp(r.xp)} - ${r.xp} ${kind} XP`).join('\n'):'No XP recorded yet.');return;
    }
    const member=await getDb().get('SELECT id FROM users WHERE username=? OR id=?',[args[0]?.replace(/^@/,''),args[0]]);
    if(name==='moveme'){const channel=await getDb().get('SELECT id FROM channels WHERE group_id=? AND (id=? OR name=?)',[groupId,args[0],args[0]]);if(!channel)throw badRequest('Choose a destination voice channel.');const {moveVoiceParticipant}=await import('../realtime/voice.js');await moveVoiceParticipant(groupId,user,user.id,channel.id,getIo(),true);return;}
    if(name==='colors'||name==='color'){const {listBotSelfRoles,selectBotSelfRole}=await import('./botSelfRoles.js');const choices=(await listBotSelfRoles(groupId,user)).filter(r=>r.color);if(name==='colors'){await botPost(groupId,target.channelId,choices.map((r,i)=>`${i+1}. ${r.name} ? ${r.color}`).join('\n')||'No self-selectable colors.');}else{const chosen=choices[Number(args[0])-1];if(!chosen)throw badRequest('Choose a color number from /colors.');for(const role of choices)if(role.assigned&&role.id!==chosen.id)await selectBotSelfRole(groupId,user,role.id,true);await selectBotSelfRole(groupId,user,chosen.id);await botPost(groupId,target.channelId,`Color: ${chosen.name}`);}return;}
    if(name==='tempvoice'||name==='templink'){const {createTemporaryVoice,temporaryInvite}=await import('./botTemporary.js');if(name==='tempvoice'){const c=await createTemporaryVoice(groupId,user,args.join(' ')||undefined);await botPost(groupId,target.channelId,`Temporary voice: <#${c.id}>`);}else{const invite=await temporaryInvite(groupId,user,1,1);await botPost(groupId,target.channelId,`Temporary invite: ${config.publicUrl||''}/?invite=${invite.code} ? 1 use ? expires in 1 hour`);}return;}
    if(['profile','credits','daily','rep','title','roll','user','avatar','server','roles'].includes(name)){
      const {botProfile,profileAction}=await import('./botProfiles.js');
      if(name==='roll'){const max=Math.min(1000000,Math.max(1,Number(args[0])||100));await botPost(groupId,target.channelId,`Rolled: ${crypto.randomInt(1,Math.floor(max)+1)}`);return;}
      if(name==='server'){await botPost(groupId,target.channelId,`**${target.context.group.name}**\nMembers: ${(await getDb().get('SELECT COUNT(*) AS n FROM group_members WHERE group_id=?',[groupId])).n}`);return;}
      if(name==='roles'){const rows=await getDb().all('SELECT name FROM server_roles WHERE group_id=? ORDER BY position DESC',[groupId]);await botPost(groupId,target.channelId,rows.map(r=>r.name).join('\n')||'No roles.');return;}
      if(name==='user'||name==='avatar'){const chosen=await findUserById(member?.id||user.id);await botPost(groupId,target.channelId,name==='avatar'?(chosen.avatar_url||'No avatar uploaded.'):`@${chosen.username} ? ${chosen.display_name} ? ID ${chosen.id}`);return;}
      if(name==='daily'||name==='rep'||name==='title'||(name==='credits'&&args[1]))await profileAction(groupId,user,{action:name==='credits'?'transfer':name,userId:member?.id,title:args.join(' '),amount:Number(args[1])});
      const profile=await botProfile(groupId,(name==='profile'||name==='credits')?(member?.id||user.id):user.id);
      await botPost(groupId,target.channelId,`**Profile**\n${profile.title}\nCredits: ${profile.credits} ? Reputation: ${profile.reputation}\nText XP: ${profile.text_xp} ? Voice XP: ${profile.voice_xp}`);return;
    }
    if(name==='warnings'){if(!target.context.can('moderateMembers'))throw forbidden('Moderate Members permission required.');const rows=await getDb().all("SELECT * FROM builtin_bot_cases WHERE group_id=? AND user_id=? AND action='warn' AND active=1 ORDER BY created_at DESC LIMIT 20",[groupId,member?.id||user.id]);await botPost(groupId,target.channelId,rows.length?rows.map(r=>`${r.id.slice(0,8)} · ${r.reason}`).join('\n'):'No active warnings.');return;}
    const duration=Number(args[1]||600), action=({clearwarnings:'clearWarnings',mute:'muteText',unmute:'unmuteText',mutevoice:'muteVoice',unmutevoice:'unmuteVoice',tempban:'ban'})[name]||name;
    const timedArgument=['timeout','mute','mutevoice','tempban'].includes(name);
    if(timedArgument&&args[1]&&(!Number.isInteger(duration)||duration<60||duration>28*86400))throw badRequest('Duration must be 60–2419200 seconds.');
    let roleId;
    if(name==='role'){
      const role=await getDb().get('SELECT id FROM server_roles WHERE group_id=? AND (id=? OR LOWER(name)=LOWER(?))',[groupId,args[1]||'',args[1]||'']);
      if(!role)throw badRequest('Choose a valid role ID or single-word role name.');roleId=role.id;
    }
    await moderatorAction(groupId,user,{action,userId:member?.id,channelId:name==='move'?args[1]:target.channelId,count:Math.min(100,Math.max(1,Number(args[0])||20)),durationSeconds:name==='slowmode'?Math.min(21600,Math.max(0,Number(args[0])||0)):Math.min(28*86400,Math.max(60,Number.isFinite(duration)?duration:600)),reason:args.slice(timedArgument?2:1).join(' ').slice(0,500)||'Chat command',temporary:name==='tempban',nickname:name==='nickname'?args.slice(1).join(' ').slice(0,32):undefined,roleId,remove:name==='role'&&args[2]==='remove'});
    await botPost(groupId,target.channelId,`Completed: **${action}**.`);
  } catch(error){await botPost(groupId,target.channelId,error.message.slice(0,500));}
}
export async function runBotMaintenance(){const db=getDb();const {cleanupTemporaryVoice}=await import('./botTemporary.js');await cleanupTemporaryVoice();const {voiceXpCandidates}=await import('../realtime/voice.js');const {awardVoiceXp}=await import('./botProfiles.js');for(const candidate of await voiceXpCandidates()){const {settings}=await botSettings(candidate.groupId);if(settings.moderator.enabled&&settings.moderator.levelingEnabled&&settings.moderator.voiceXpPerMinute>0){const result=await awardVoiceXp(candidate.groupId,candidate.userId,settings.moderator.voiceXpPerMinute);if(result.awarded){for(const reward of settings.moderator.levelRewards)if(reward.type==='voice'&&levelForXp(result.voice_xp)>=reward.level)await grantAutomationRole(candidate.groupId,candidate.userId,reward.roleId,'moderator');await invalidateGroup(candidate.groupId);}}}const expiredMutes=await db.all('SELECT DISTINCT user_id FROM builtin_bot_mutes WHERE expires_at<=?',[Date.now()]);await db.run('DELETE FROM builtin_bot_mutes WHERE expires_at<=?',[Date.now()]);if(expiredMutes.length){const {enforceVoiceAccess}=await import('../realtime/voice.js');for(const row of expiredMutes)await enforceVoiceAccess(getIo(),row.user_id);}for(const event of await db.all('SELECT * FROM builtin_bot_events WHERE done=0 AND attempts<5 ORDER BY created_at LIMIT 30'))await processMembershipEvent(event);for(const row of await db.all("SELECT * FROM builtin_bot_cases WHERE action='ban' AND active=1 AND expires_at IS NOT NULL AND expires_at<=?",[Date.now()])){const ban=await db.get('SELECT * FROM server_bans WHERE group_id=? AND user_id=?',[row.group_id,row.user_id]);if(ban&&Number(ban.created_at)<=Number(row.created_at))await db.run('DELETE FROM server_bans WHERE group_id=? AND user_id=?',[row.group_id,row.user_id]);await db.run('UPDATE builtin_bot_cases SET active=0 WHERE id=?',[row.id]);}}
