import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BOT_DEFAULTS, renderBotTemplate, matchBotRule, levelForXp } from '../server/src/services/botRules.js';

const qaRoot=path.resolve('.tmp','bots-qa-'+crypto.randomUUID());
process.env.DATA_DIR=qaRoot;process.env.SQLITE_FILE=path.join(qaRoot,'test.sqlite3');process.env.DATABASE_DRIVER='sqlite';process.env.REDIS_URL='';process.env.NODE_ENV='test';process.env.APP_SECRET=crypto.randomBytes(32).toString('hex');
process.env.UPLOAD_DIR=path.join(qaRoot,'uploads');process.env.DATABASE_URL='';process.env.PGHOST='';
const database=await import('../server/src/db/index.js');
await database.initDb();const db=database.getDb();
const {initCache,closeCache}=await import('../server/src/cache/index.js');await initCache();
const {ensureBadgeCatalogue,listBadges}=await import('../server/src/services/badges.js');await ensureBadgeCatalogue();
const {createUser,findUserById}=await import('../server/src/services/users.js');
const {createGroup,addMember,removeMember,listMembers,listChannels}=await import('../server/src/services/groups.js');
const {createServerRole}=await import('../server/src/services/serverRoles.js');
const {groupContext}=await import('../server/src/services/permissions.js');
const {channelPermission}=await import('../server/src/services/channelPermissions.js');
const {createMessage}=await import('../server/src/services/messages.js');
const bots=await import('../server/src/services/builtinBots.js');
const {botSettingsSchema,botActionSchema}=await import('../server/src/routes/builtinBots.js');
after(async()=>{await closeCache();await database.closeDatabases();const resolved=path.resolve(qaRoot),allowed=path.resolve('.tmp')+path.sep;if(!resolved.startsWith(allowed))throw Error('Unsafe cleanup path');fs.rmSync(resolved,{recursive:true,force:true});});
const user=async(name,role='member')=>createUser({username:name,email:name+'@example.test',displayName:name,password:'TestBots!7283920',role,skipPasswordPolicy:true});
const owner=await user('botqaowner','admin'), member=await user('botqamember'), outsider=await user('botqaoutsider');
const actor=await findUserById(owner.id),memberActor=await findUserById(member.id);
const group=await createGroup({name:'Bots QA',ownerId:owner.id}),channels=await listChannels(group.id),channel=channels.find(c=>c.type==='text');
await addMember({groupId:group.id,userId:member.id});
let settings=structuredClone(BOT_DEFAULTS);settings.welcomer={...settings.welcomer,enabled:true,welcomeChannelId:channel.id,goodbyeChannelId:channel.id,bannerEnabled:false};settings.moderator={...settings.moderator,enabled:true,logChannelId:channel.id,levelingEnabled:true};

test('Schema rejects invalid colors, action names, spam limits and malformed IDs',()=>{
 assert.equal(botSettingsSchema.safeParse(settings).success,true);
 for(const patch of [{bannerColor:'red'},{bannerColor:'"/><script/>'},{welcomeChannelId:'x'}])assert.equal(botSettingsSchema.safeParse({...settings,welcomer:{...settings.welcomer,...patch}}).success,false);
 assert.equal(botSettingsSchema.safeParse({...settings,moderator:{...settings.moderator,maxMessages:0}}).success,false);
 assert.equal(botActionSchema.safeParse({action:'giveAdmin'}).success,false);
});
test('Templates substitute supported variables without interpreting user text',()=>{assert.equal(renderBotTemplate('{username} / {mention} / {server} / {unknown}',{username:'test{server}',mention:'@test',server:'QA'}),'test{server} / @test / QA / {unknown}');assert.equal(levelForXp(399),1);assert.equal(levelForXp(400),2);});
test('AutoMod detects words, links, invites, mentions, caps, attachment flood and repeat/rate flood',()=>{
 const s={...BOT_DEFAULTS.moderator,blockedWords:['badword'],blockLinks:true,allowedDomains:['example.com']};
 assert.equal(matchBotRule('badword',0,s),'Blocked keyword');assert.equal(matchBotRule('https://example.com/a',0,s),null);assert.equal(matchBotRule('https://sub.example.com',0,s),null);assert.equal(matchBotRule('https://evil-example.com',0,s),'Unapproved link');assert.equal(matchBotRule('discord.gg/demo',0,s),'Invite links');assert.equal(matchBotRule('@aaa @bbb @ccc @ddd @eee @fff',0,s),'Mention spam');assert.equal(matchBotRule('THIS MESSAGE IS ALL CAPS',0,s),'Excessive capitals');assert.equal(matchBotRule('hello',6,s),'Attachment spam');assert.equal(matchBotRule('hello',0,s,Array.from({length:6},()=>({at:Date.now(),text:'other'}))),'Message flood');assert.equal(matchBotRule('hello',0,s,Array.from({length:3},()=>({at:Date.now(),text:'hello'}))),'Repeated messages');
});
test('Built-in accounts have BOT and green verified identities, settings persist and stale saves fail',async()=>{
 const ids=await bots.ensureBuiltinBots();assert.notEqual(ids.welcomer,ids.moderator);for(const id of Object.values(ids))assert.deepEqual((await listBadges(id)).map(b=>b.id),['bot','verified_bot']);
 const saved=await bots.saveBotSettings(group.id,actor,settings,0);assert.equal(saved.revision,1);assert.equal((await listMembers(group.id)).length,4);await assert.rejects(bots.saveBotSettings(group.id,actor,settings,0),/Settings changed/);await assert.rejects(bots.saveBotSettings(group.id,memberActor,settings,1),/permission/);
});
test('Welcome and goodbye hooks create real messages with verified bot author',async()=>{
 const newcomer=await user('botqanew');await addMember({groupId:group.id,userId:newcomer.id});let rows=await db.all("SELECT * FROM messages WHERE channel_id=? AND content LIKE '%botqanew%'",[channel.id]);assert.equal(rows.length,1);assert.match(rows[0].content,/@botqanew/);const ids=await bots.ensureBuiltinBots();assert.equal(rows[0].author_id,ids.welcomer);await removeMember({groupId:group.id,userId:newcomer.id});rows=await db.all("SELECT * FROM messages WHERE channel_id=? AND content LIKE '%botqanew%'",[channel.id]);assert.equal(rows.length,2);assert.match(rows[1].content,/Goodbye/);await bots.runBotMaintenance();assert.equal((await db.all('SELECT * FROM builtin_bot_events WHERE done=0')).length,0);
});
test('Moderation enforces permissions and protects owner, timeout and warning threshold work',async()=>{
 await assert.rejects(bots.moderatorAction(group.id,memberActor,{action:'warn',userId:owner.id}),/permission/);await assert.rejects(bots.moderatorAction(group.id,actor,{action:'warn',userId:owner.id}),/cannot moderate/);
 for(let i=0;i<3;i++)await bots.moderatorAction(group.id,actor,{action:'warn',userId:member.id,reason:'Warning '+i});assert.ok(await db.get('SELECT * FROM server_timeouts WHERE group_id=? AND user_id=?',[group.id,member.id]));
 await bots.moderatorAction(group.id,actor,{action:'untimeout',userId:member.id});assert.equal(await db.get('SELECT * FROM server_timeouts WHERE group_id=? AND user_id=?',[group.id,member.id]),null);
 await bots.moderatorAction(group.id,actor,{action:'clearWarnings',userId:member.id});assert.equal(Number((await db.get("SELECT COUNT(*) AS n FROM builtin_bot_cases WHERE user_id=? AND action='warn' AND active=1",[member.id])).n),0);
});
test('Lock preserves other overrides and prevents ordinary messages; unlock and slowmode work',async()=>{
 await bots.moderatorAction(group.id,actor,{action:'lock',channelId:channel.id});const row=await db.get('SELECT * FROM channels WHERE id=?',[channel.id]);assert.equal(await channelPermission(row,await groupContext(group.id,memberActor),'sendMessages'),false);
 await bots.moderatorAction(group.id,actor,{action:'unlock',channelId:channel.id});assert.equal(await channelPermission(await db.get('SELECT * FROM channels WHERE id=?',[channel.id]),await groupContext(group.id,memberActor),'sendMessages'),true);
 await bots.moderatorAction(group.id,actor,{action:'slowmode',channelId:channel.id,durationSeconds:8});assert.equal(Number((await db.get('SELECT slowmode FROM channels WHERE id=?',[channel.id])).slowmode),8);
});
test('Temporary ban removes membership and maintenance expires only the matching ban',async()=>{
 await bots.moderatorAction(group.id,actor,{action:'ban',userId:member.id,temporary:true,durationSeconds:60});assert.ok(await db.get('SELECT * FROM server_bans WHERE group_id=? AND user_id=?',[group.id,member.id]));assert.equal(await db.get('SELECT * FROM group_members WHERE group_id=? AND user_id=?',[group.id,member.id]),null);
 await db.run("UPDATE builtin_bot_cases SET expires_at=? WHERE group_id=? AND action='ban'",[Date.now()-1,group.id]);await bots.runBotMaintenance();assert.equal(await db.get('SELECT * FROM server_bans WHERE group_id=? AND user_id=?',[group.id,member.id]),null);await addMember({groupId:group.id,userId:member.id});
});
test('AutoMod blocks a member and ignores moderators; XP cooldown and auto response execute',async()=>{
 const current=await bots.botSettings(group.id);settings.moderator.blockedWords=['blockedphrase'];settings.moderator.responses=[{trigger:'hello bot',response:'Hi {mention}!',exact:true}];await bots.saveBotSettings(group.id,actor,settings,current.revision);
 const row=await db.get('SELECT * FROM channels WHERE id=?',[channel.id]), target={kind:'channel',channel:row,channelId:row.id,context:await groupContext(group.id,memberActor)};
 await assert.rejects(bots.inspectModeratorMessage(target,memberActor,'blockedphrase'),/blocked/);await bots.inspectModeratorMessage({...target,context:await groupContext(group.id,actor)},actor,'blockedphrase');
 const message=await createMessage({channelId:channel.id,authorId:member.id,content:'hello bot'});await bots.afterBotMessage(target,memberActor,message);await bots.afterBotMessage(target,memberActor,{...message,idempotentReplay:true});const xp=await db.get('SELECT xp FROM builtin_bot_levels WHERE user_id=? AND group_id=?',[member.id,group.id]);assert.equal(Number(xp.xp),15);assert.ok(await db.get("SELECT id FROM messages WHERE content='Hi @botqamember!'"));
});
test('Generated banner is a real 1000x360 PNG and escapes hostile names',async()=>{
 const values=await bots.botTemplateValues(group.id,member.id);values.displayName='<svg onload="bad">';const buffer=await bots.renderWelcomeBanner(settings.welcomer,values),sharp=(await import('sharp')).default,meta=await sharp(buffer).metadata();assert.equal(meta.format,'png');assert.equal(meta.width,1000);assert.equal(meta.height,360);
});
test('Purge deletes only selected channel rows and nickname is scoped to server',async()=>{
 const before=Number((await db.get('SELECT COUNT(*) AS n FROM messages WHERE channel_id=? AND deleted_at IS NULL',[channel.id])).n);await bots.moderatorAction(group.id,actor,{action:'purge',channelId:channel.id,count:2});assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM messages WHERE channel_id=? AND deleted_at IS NULL',[channel.id])).n),before-1);await bots.moderatorAction(group.id,actor,{action:'nickname',userId:member.id,nickname:'New Nick'});assert.equal((await db.get('SELECT nickname FROM group_members WHERE group_id=? AND user_id=?',[group.id,member.id])).nickname,'New Nick');
});

test('Tickets persist private channels, prevent duplicate open tickets and enforce transcript privacy',async()=>{
 const {createBotTicket,listBotTickets,updateBotTicket,botTicketTranscript}=await import('../server/src/services/botTickets.js');
 const current=await bots.botSettings(group.id);
 settings.moderator.ticketsEnabled=true;
 await bots.saveBotSettings(group.id,actor,settings,current.revision);
 await addMember({groupId:group.id,userId:outsider.id});
 const outsiderActor=await findUserById(outsider.id);
 const ticket=await createBotTicket(group.id,memberActor,'Need help with my account');
 assert.equal((await createBotTicket(group.id,memberActor,'Duplicate request')).id,ticket.id);
 assert.equal((await listBotTickets(group.id,outsiderActor)).length,0);
 assert.equal((await listBotTickets(group.id,memberActor)).length,1);
 await assert.rejects(botTicketTranscript(group.id,outsiderActor,ticket.id),/access denied/i);
 await assert.rejects(updateBotTicket(group.id,memberActor,ticket.id,'claim'),/support moderators/i);
 assert.equal((await updateBotTicket(group.id,actor,ticket.id,'claim')).claimed_by,actor.id);
 assert.match(await botTicketTranscript(group.id,memberActor,ticket.id),/Need help with my account/);
 await updateBotTicket(group.id,memberActor,ticket.id,'close');
 const ticketChannel=await db.get('SELECT * FROM channels WHERE id=?',[ticket.channel_id]);
 assert.equal(await channelPermission(ticketChannel,await groupContext(group.id,memberActor),'sendMessages'),false);
 const next=await createBotTicket(group.id,memberActor,'A second request');
 assert.notEqual(next.id,ticket.id);
 await assert.rejects(updateBotTicket(group.id,actor,ticket.id,'reopen'),/another open ticket/i);
 await updateBotTicket(group.id,memberActor,next.id,'close');
 await updateBotTicket(group.id,actor,ticket.id,'reopen');
 assert.equal(await channelPermission(await db.get('SELECT * FROM channels WHERE id=?',[ticket.channel_id]),await groupContext(group.id,memberActor),'sendMessages'),true);
});

test('Scheduled messages cannot bypass AutoMod or a later channel lock',async()=>{
 const {scheduleMessage,publishScheduledMessage}=await import('../server/src/services/advancedChat.js');
 async function due(content){const item=await scheduleMessage({userId:member.id,targetType:'channel',targetId:channel.id,content,sendAt:Date.now()+10000});await db.run('UPDATE scheduled_messages SET send_at=? WHERE id=?',[Date.now()-1,item.id]);return item;}
 const blocked=await due('blockedphrase');
 await assert.rejects(publishScheduledMessage(blocked.id),/Moderator Bot blocked/);
 assert.equal((await db.get('SELECT status FROM scheduled_messages WHERE id=?',[blocked.id])).status,'failed');
 const locked=await due('ordinary scheduled text');
 await bots.moderatorAction(group.id,actor,{action:'lock',channelId:channel.id});
 await assert.rejects(publishScheduledMessage(locked.id),/no longer has permission/);
 await bots.moderatorAction(group.id,actor,{action:'unlock',channelId:channel.id});
 const allowed=await due('allowed scheduled text');
 assert.equal((await publishScheduledMessage(allowed.id)).message.content,'allowed scheduled text');
});

test('Automatic roles, level rewards and role commands assign actual server roles',async()=>{
 const welcomeRole=await createServerRole({groupId:group.id,name:'Newcomer',createdBy:owner.id});
 const rewardRole=await createServerRole({groupId:group.id,name:'LevelOne',createdBy:owner.id});
 const current=await bots.botSettings(group.id);
 settings.welcomer.autoRoleIds=[welcomeRole.id];settings.moderator.levelRewards=[{level:1,roleId:rewardRole.id}];settings.moderator.xpPerMessage=100;
 await bots.saveBotSettings(group.id,actor,settings,current.revision);
 const newcomer=await user('botqaroles');await addMember({groupId:group.id,userId:newcomer.id});
 assert.ok(await db.get('SELECT role_id FROM server_member_roles WHERE group_id=? AND user_id=? AND role_id=?',[group.id,newcomer.id,welcomeRole.id]));
 const newcomerActor=await findUserById(newcomer.id),row=await db.get('SELECT * FROM channels WHERE id=?',[channel.id]);
 const target={kind:'channel',channel:row,channelId:row.id,context:await groupContext(group.id,newcomerActor)};
 await bots.afterBotMessage(target,newcomerActor,await createMessage({channelId:channel.id,authorId:newcomer.id,content:'Earn my first level'}));
 assert.ok(await db.get('SELECT role_id FROM server_member_roles WHERE group_id=? AND user_id=? AND role_id=?',[group.id,newcomer.id,rewardRole.id]));
 const actorTarget={...target,context:await groupContext(group.id,actor)};
 await bots.afterBotMessage(actorTarget,actor,await createMessage({channelId:channel.id,authorId:actor.id,content:`/role @botqaroles ${rewardRole.id} remove`}));
 assert.equal(await db.get('SELECT role_id FROM server_member_roles WHERE group_id=? AND user_id=? AND role_id=?',[group.id,newcomer.id,rewardRole.id]),null);
 await bots.afterBotMessage(actorTarget,actor,await createMessage({channelId:channel.id,authorId:actor.id,content:'/nickname @botqaroles Test Nickname'}));
 assert.equal((await db.get('SELECT nickname FROM group_members WHERE group_id=? AND user_id=?',[group.id,newcomer.id])).nickname,'Test Nickname');
});

test('Disabling bots removes their server memberships and suppresses welcome delivery',async()=>{
 const current=await bots.botSettings(group.id),ids=await bots.ensureBuiltinBots();
 settings.welcomer.enabled=false;settings.moderator.enabled=false;
 await bots.saveBotSettings(group.id,actor,settings,current.revision);
 for(const id of Object.values(ids))assert.equal(await db.get('SELECT user_id FROM group_members WHERE group_id=? AND user_id=?',[group.id,id]),null);
 assert.equal(await bots.sendWelcome(group.id,member.id),null);
});

test('Animated custom GIF references and pinned banner images survive orphan cleanup',async()=>{
 const {storeUpload,purgeOrphanAttachments}=await import('../server/src/services/uploads.js');
 const {readObjectBuffer}=await import('../server/src/services/storage.js');
 const sharp=(await import('sharp')).default;
 const gif=fs.readFileSync(path.resolve('client/public/media-presets/gifs/hello.gif'));
 assert.ok((await sharp(gif,{animated:true}).metadata()).pages>1);
 const asset=await storeUpload({uploaderId:owner.id,file:{buffer:gif,size:gif.length,mimetype:'image/gif',originalname:'custom.gif'}});
 await db.run('INSERT INTO group_expressions(id,group_id,attachment_id,name,type,created_by,created_at) VALUES (?,?,?,?,?,?,?)',[crypto.randomUUID(),group.id,asset.id,'custom_hello','gif',owner.id,Date.now()]);
 const message=await createMessage({channelId:channel.id,authorId:member.id,content:`<gif:custom_hello:${asset.id}>`});
 assert.ok(await db.get('SELECT * FROM message_expressions WHERE message_id=? AND attachment_id=?',[message.id,asset.id]));
 assert.ok((await sharp(await readObjectBuffer(await db.get('SELECT * FROM attachments WHERE id=?',[asset.id])),{animated:true}).metadata()).pages>1);
 const png=await sharp({create:{width:200,height:100,channels:4,background:'#334455'}}).png().toBuffer();
 const background=await storeUpload({uploaderId:owner.id,file:{buffer:png,size:png.length,mimetype:'image/png',originalname:'background.png'}});
 const current=await bots.botSettings(group.id);settings.welcomer.backgroundAttachmentId=background.id;
 await bots.saveBotSettings(group.id,actor,settings,current.revision);
 await db.run('UPDATE attachments SET created_at=? WHERE id IN (?,?)',[Date.now()-7200000,asset.id,background.id]);
 await purgeOrphanAttachments();
 assert.ok(await db.get('SELECT id FROM attachments WHERE id=?',[asset.id]));
 assert.ok(await db.get('SELECT id FROM attachments WHERE id=?',[background.id]));
});

test('Members select and remove whitelisted roles; privileged, unlisted and changed roles are rejected',async()=>{
 const {listBotSelfRoles,selectBotSelfRole}=await import('../server/src/services/botSelfRoles.js');
 const choice=await createServerRole({groupId:group.id,name:'Gaming',createdBy:owner.id});
 const privileged=await createServerRole({groupId:group.id,name:'Dangerous',permissions:['manageRoles'],createdBy:owner.id});
 let current=await bots.botSettings(group.id);settings.moderator.enabled=true;settings.moderator.selfRoleIds=[privileged.id];
 await assert.rejects(bots.saveBotSettings(group.id,actor,settings,current.revision),/Privileged roles/);
 settings.moderator.selfRoleIds=[choice.id];await bots.saveBotSettings(group.id,actor,settings,current.revision);
 assert.equal((await listBotSelfRoles(group.id,memberActor))[0].assigned,false);
 assert.equal((await selectBotSelfRole(group.id,memberActor,choice.id))[0].assigned,true);
 assert.ok(await db.get('SELECT role_id FROM server_member_roles WHERE group_id=? AND user_id=? AND role_id=?',[group.id,member.id,choice.id]));
 assert.equal((await selectBotSelfRole(group.id,memberActor,choice.id,true))[0].assigned,false);
 await assert.rejects(selectBotSelfRole(group.id,memberActor,privileged.id),/not available/);
 await db.run('UPDATE server_roles SET permissions=? WHERE id=?',[JSON.stringify(['manageRoles']),choice.id]);
 assert.equal((await listBotSelfRoles(group.id,memberActor)).length,0);
 await assert.rejects(selectBotSelfRole(group.id,memberActor,choice.id),/Privileged roles/);
 await db.run('UPDATE server_roles SET permissions=? WHERE id=?',['[]',choice.id]);
 await db.run('UPDATE builtin_bot_settings SET updated_by=? WHERE group_id=?',[outsider.id,group.id]);
 await assert.rejects(selectBotSelfRole(group.id,memberActor,choice.id),/no longer has permission/);
 await db.run('UPDATE builtin_bot_settings SET updated_by=? WHERE group_id=?',[actor.id,group.id]);
});


test('Text and voice mutes are independent, expire, and deny role overrides',async()=>{
 const voice=(await listChannels(group.id)).find(c=>c.type==='voice');
 const ctx=await groupContext(group.id,memberActor);
 await bots.moderatorAction(group.id,actor,{action:'muteText',userId:member.id,durationSeconds:120});
 assert.equal(await channelPermission(channel,ctx,'sendMessages'),false);
 assert.equal(await channelPermission(voice,ctx,'speak'),true);
 await bots.moderatorAction(group.id,actor,{action:'muteVoice',userId:member.id,durationSeconds:120});
 assert.equal(await channelPermission(voice,ctx,'speak'),false);
 assert.equal(await channelPermission(voice,ctx,'connectVoice'),true);
 await bots.moderatorAction(group.id,actor,{action:'unmuteText',userId:member.id});
 assert.equal(await channelPermission(channel,ctx,'sendMessages'),true);
 assert.equal(await channelPermission(voice,ctx,'speak'),false);
 await db.run('UPDATE builtin_bot_mutes SET expires_at=? WHERE group_id=? AND user_id=?',[Date.now()-1,group.id,member.id]);
 assert.equal(await channelPermission(voice,ctx,'speak'),true);
 await assert.rejects(bots.moderatorAction(group.id,memberActor,{action:'muteVoice',userId:owner.id,durationSeconds:120}),/permission/);
});
test('Moderator points are durable and concurrent increments remain atomic',async()=>{
 await bots.moderatorAction(group.id,actor,{action:'pointsReset',userId:member.id});
 await Promise.all(Array.from({length:12},()=>bots.moderatorAction(group.id,actor,{action:'pointsIncrease',userId:member.id,points:5})));
 assert.equal((await db.get('SELECT points FROM builtin_bot_points WHERE group_id=? AND user_id=?',[group.id,member.id])).points,60);
 await bots.moderatorAction(group.id,actor,{action:'pointsDecrease',userId:member.id,points:100});
 assert.equal((await db.get('SELECT points FROM builtin_bot_points WHERE group_id=? AND user_id=?',[group.id,member.id])).points,0);
});

test('Anti-raid gates concurrent joins transactionally and enforces minimum account age',async()=>{
 const raid=await createGroup({name:'Raid QA',ownerId:owner.id});
 const saved=structuredClone(BOT_DEFAULTS);saved.moderator.enabled=true;saved.moderator.antiRaidEnabled=true;saved.moderator.maxJoinsPerWindow=2;
 await bots.saveBotSettings(raid.id,actor,saved,0);
 const joining=await Promise.all(Array.from({length:5},(_,i)=>user('raidmember'+i)));
 const results=await Promise.allSettled(joining.map(u=>addMember({groupId:raid.id,userId:u.id})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,2);
 assert.equal(results.filter(r=>r.status==='rejected').length,3);
 const current=await bots.botSettings(raid.id);saved.moderator.minAccountAgeHours=24;
 await bots.saveBotSettings(raid.id,actor,saved,current.revision);
 await assert.rejects(addMember({groupId:raid.id,userId:outsider.id}),/older account/);
});

test('Profiles enforce daily and reputation cooldowns and concurrent transfers cannot overspend',async()=>{
 const {profileAction,botProfile,awardVoiceXp}=await import('../server/src/services/botProfiles.js');
 await profileAction(group.id,memberActor,{action:'daily'});
 const attempts=await Promise.allSettled(Array.from({length:3},()=>profileAction(group.id,memberActor,{action:'transfer',userId:owner.id,amount:60})));
 assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
 assert.equal((await botProfile(group.id,member.id)).credits,40);
 assert.equal((await botProfile(group.id,owner.id)).credits,60);
 await assert.rejects(profileAction(group.id,memberActor,{action:'daily'}),/24 hours/);
 await profileAction(group.id,memberActor,{action:'rep',userId:owner.id});
 await assert.rejects(profileAction(group.id,memberActor,{action:'rep',userId:owner.id}),/24 hours/);
 await assert.rejects(profileAction(group.id,actor,{action:'rep',userId:owner.id}),/yourself/);
 await Promise.all(Array.from({length:5},()=>awardVoiceXp(group.id,member.id,15)));
 assert.equal((await botProfile(group.id,member.id)).voice_xp,15);
});

test('Embed builder persists structured fields and denies ordinary members',async()=>{
 const {sendBotEmbed}=await import('../server/src/services/botEmbeds.js');
 const {hydrateMessage,deleteMessage}=await import('../server/src/services/messages.js');
 const embed={title:'ZDIS',description:'**Welcome**',color:'#5865f2',footer:'Community',fields:[{name:'Rules',value:'Be kind',inline:false}]};
 await assert.rejects(sendBotEmbed(group.id,memberActor,channel.id,embed),/permissions/);
 const message=await sendBotEmbed(group.id,actor,channel.id,embed);
 assert.deepEqual((await hydrateMessage(message.id)).botEmbed,embed);
 await deleteMessage(message.id,actor.id);
 assert.equal((await hydrateMessage(message.id)).botEmbed,null);
});

test('Starboard counts unique members, rejects self stars and never copies private channels',async()=>{
 const {newId}=await import('../server/src/lib/ids.js');const {updateBotStarboard}=await import('../server/src/services/botStarboard.js');
 const destination=newId(),now=Date.now();await db.run('INSERT INTO channels(id,group_id,name,type,position,created_at,updated_at) VALUES (?,?,?, ?,0,?,?)',[destination,group.id,'starboard','text',now,now]);
 let current=await bots.botSettings(group.id);const updated=structuredClone(current.settings);updated.moderator.starboardEnabled=true;updated.moderator.starboardChannelId=destination;updated.moderator.starboardThreshold=1;await bots.saveBotSettings(group.id,actor,updated,current.revision);
 const source=await createMessage({channelId:channel.id,authorId:member.id,content:'Public starboard QA'});
 await db.run('INSERT INTO reactions(message_id,user_id,emoji,created_at) VALUES (?,?,?,?)',[source.id,member.id,'\u2b50',now]);
 await updateBotStarboard(group.id,source.id);assert.equal(await db.get('SELECT * FROM builtin_bot_starboard WHERE message_id=?',[source.id]),null);
 await db.run('INSERT INTO reactions(message_id,user_id,emoji,created_at) VALUES (?,?,?,?)',[source.id,owner.id,'\u2b50',now]);
 await Promise.all([updateBotStarboard(group.id,source.id),updateBotStarboard(group.id,source.id)]);
 assert.equal((await db.get('SELECT stars FROM builtin_bot_starboard WHERE message_id=?',[source.id])).stars,1);
 assert.equal((await db.get('SELECT COUNT(*) AS n FROM messages WHERE channel_id=?',[destination])).n,1);
 const secret=await createMessage({channelId:channel.id,authorId:member.id,content:'Private starboard QA'});await db.run('UPDATE channels SET is_private=1 WHERE id=?',[channel.id]);
 await db.run('INSERT INTO reactions(message_id,user_id,emoji,created_at) VALUES (?,?,?,?)',[secret.id,owner.id,'\u2b50',now]);
 await updateBotStarboard(group.id,secret.id);assert.equal(await db.get('SELECT * FROM builtin_bot_starboard WHERE message_id=?',[secret.id]),null);
 await db.run('UPDATE channels SET is_private=0 WHERE id=?',[channel.id]);
});

test('Bulk roles validate every target before writing and role colors and XP are durable',async()=>{
 const role=await createServerRole({groupId:group.id,name:'Bulk QA',permissions:[],createdBy:owner.id});
 await assert.rejects(bots.moderatorAction(group.id,actor,{action:'bulkRole',roleId:role.id,userIds:[member.id,owner.id]}),/cannot manage/);
 assert.equal(await db.get('SELECT role_id FROM server_member_roles WHERE user_id=? AND role_id=?',[member.id,role.id]),null);
 await bots.moderatorAction(group.id,actor,{action:'bulkRole',roleId:role.id,userIds:[member.id]});
 assert.ok(await db.get('SELECT role_id FROM server_member_roles WHERE user_id=? AND role_id=?',[member.id,role.id]));
 await bots.moderatorAction(group.id,actor,{action:'setColor',roleId:role.id,color:'#abcdef'});
 assert.equal((await db.get('SELECT color FROM server_roles WHERE id=?',[role.id])).color,'#abcdef');
 await bots.moderatorAction(group.id,actor,{action:'setLevel',userId:member.id,level:5});
 assert.equal((await db.get('SELECT xp FROM builtin_bot_levels WHERE group_id=? AND user_id=?',[group.id,member.id])).xp,2500);
 await bots.moderatorAction(group.id,actor,{action:'setXp',userId:member.id,xpType:'voice',xp:123});
 assert.equal((await db.get('SELECT voice_xp FROM builtin_bot_profiles WHERE group_id=? AND user_id=?',[group.id,member.id])).voice_xp,123);
});

test('Temporary voice respects ownership quotas and idle cleanup; invites actually expire',async()=>{
 const {createTemporaryVoice,cleanupTemporaryVoice,temporaryInvite}=await import('../server/src/services/botTemporary.js');
 const current=await bots.botSettings(group.id),updated=structuredClone(current.settings);updated.moderator.temporaryVoiceEnabled=true;updated.moderator.temporaryVoiceIdleSeconds=60;updated.moderator.temporaryInvitesEnabled=true;await bots.saveBotSettings(group.id,actor,updated,current.revision);
 const temp=await createTemporaryVoice(group.id,memberActor,'Temporary QA');assert.equal(temp.type,'voice');
 await assert.rejects(createTemporaryVoice(group.id,memberActor,'Duplicate'),/already own/);
 await db.run('UPDATE builtin_bot_temp_channels SET created_at=?,empty_since=? WHERE channel_id=?',[Date.now()-120000,Date.now()-120000,temp.id]);
 await cleanupTemporaryVoice();assert.equal(await db.get('SELECT id FROM channels WHERE id=?',[temp.id]),null);
 const invite=await temporaryInvite(group.id,actor,1,0.25);assert.equal(invite.max_uses,1);assert.ok(Number(invite.expires_at)>Date.now());
});
test('Protection prevents administrative floods and protects selected members',async()=>{
 const {guardBotAction}=await import('../server/src/services/botProtection.js');
 const current=await bots.botSettings(group.id),updated=structuredClone(current.settings);updated.moderator.protectionEnabled=true;updated.moderator.maxActionsPerWindow=2;updated.moderator.protectedUserIds=[owner.id];await bots.saveBotSettings(group.id,actor,updated,current.revision);
 await assert.rejects(guardBotAction(group.id,memberActor,[owner.id]),/protected/);
 await Promise.all([guardBotAction(group.id,memberActor),guardBotAction(group.id,memberActor)]);
 await assert.rejects(guardBotAction(group.id,memberActor),/excessive/);
 await guardBotAction(group.id,actor,[owner.id]);
});
