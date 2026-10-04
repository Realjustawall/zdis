import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
const root=path.resolve('.tmp','access-qa-'+crypto.randomUUID());
Object.assign(process.env,{NODE_ENV:'test',DATA_DIR:root,SQLITE_FILE:path.join(root,'test.sqlite3'),UPLOAD_DIR:path.join(root,'uploads'),DATABASE_DRIVER:'sqlite',DATABASE_URL:'',PGHOST:'',REDIS_URL:'',APP_SECRET:crypto.randomBytes(32).toString('hex')});
const database=await import('../server/src/db/index.js');await database.initDb();const db=database.getDb();
const cache=await import('../server/src/cache/index.js');await cache.initCache();
const badges=await import('../server/src/services/badges.js');await badges.ensureBadgeCatalogue();
const {createUser,findUserById}=await import('../server/src/services/users.js');
const groups=await import('../server/src/services/groups.js');
const settings=await import('../server/src/services/settings.js');
const access=await import('../server/src/services/userAccess.js');
const {groupContext}=await import('../server/src/services/permissions.js');
const {channelPermission,setChannelOverride}=await import('../server/src/services/channelPermissions.js');
const owner=await createUser({username:'accessowner',email:'owner@access.test',displayName:'Owner',password:'AccessTest!783020',role:'admin',skipPasswordPolicy:true});
const member=await createUser({username:'accessmember',email:'member@access.test',displayName:'Member',password:'AccessTest!783020',skipPasswordPolicy:true});
async function policy(userId,body){await db.run('INSERT INTO user_access_policies(user_id,policy,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET policy=excluded.policy',[userId,JSON.stringify(body),Date.now()]);}
after(async()=>{await cache.closeCache();await database.closeDatabases();if(!root.startsWith(path.resolve('.tmp')+path.sep))throw Error('Unsafe cleanup');fs.rmSync(root,{recursive:true,force:true});});
test('Defaults and explicit overrides inherit changes and zero denies new resources',async()=>{
 const initial=await access.userAccess(member.id);assert.equal(initial.effective.maxOwnedGroups,10);assert.equal(initial.effective.maxJoinedGroups,50);assert.equal(initial.effective.maxCreatedChannels,10);
 await policy(member.id,{sendImages:false,maxOwnedGroups:0});await settings.updateSettings({default_sendVideos:false});
 const current=await access.userAccess(member.id);assert.equal(current.effective.sendImages,false);assert.equal(current.effective.sendVideos,false);
 await assert.rejects(groups.createGroup({name:'Denied',ownerId:member.id}),/limit/);await assert.rejects(access.assertUploadAccess(member.id,'image/png'),/sendImages/);await assert.rejects(access.assertUploadAccess(member.id,'application/vnd.zdis.encrypted'),/sendImages/);
 await policy(member.id,{});await settings.updateSettings({default_sendVideos:true});
});
test('Concurrent creation cannot exceed per-user group quota',async()=>{
 await policy(member.id,{maxOwnedGroups:1});const results=await Promise.allSettled(Array.from({length:8},(_,i)=>groups.createGroup({name:'Concurrent '+i,ownerId:member.id})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(Number((await db.get('SELECT COUNT(*) AS count FROM chat_groups WHERE owner_id=?',[member.id])).count),1);
});
test('All membership paths enforce a quota including concurrent additions',async()=>{
 await policy(member.id,{maxJoinedGroups:2});const list=await Promise.all([groups.createGroup({name:'A',ownerId:owner.id}),groups.createGroup({name:'B',ownerId:owner.id})]);
 const results=await Promise.allSettled(list.map(g=>groups.addMember({groupId:g.id,userId:member.id})));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const remaining=list.find((g,index)=>results[index].status==='rejected');const invite=await groups.createInvite({groupId:remaining.id,createdBy:owner.id});await assert.rejects(groups.redeemInvite(invite.code,member.id),/limit/);
});
test('Account denials override even server owner and channel allow overrides',async()=>{
 const group=await groups.createGroup({name:'Permissions',ownerId:owner.id});const channel=(await groups.listChannels(group.id))[0];const raw=await db.get('SELECT * FROM channels WHERE id=?',[channel.id]);const context=await groupContext(group.id,await findUserById(owner.id));
 await policy(owner.id,{sendFiles:false,connectVoice:false,speak:false,video:false,screenShare:false});
 for(const key of ['attachFiles','connectVoice','speak','video','screenShare'])assert.equal(await channelPermission(raw,context,key),false);
 await policy(owner.id,{});await groups.addMember({groupId:group.id,userId:member.id}).catch(()=>{});
 await policy(member.id,{maxJoinedGroups:50,sendImages:false});await groups.addMember({groupId:group.id,userId:member.id}).catch(()=>{});
 await setChannelOverride({groupId:group.id,channelId:channel.id,targetType:'member',targetId:member.id,allow:['sendImages'],deny:[],updatedBy:owner.id});assert.equal(await channelPermission(raw,await groupContext(group.id,await findUserById(member.id)),'sendImages'),false);
});
test('Custom badge persists across catalogue loading, grants no capability and can be deleted',async()=>{
 const badge=await badges.createCustomBadge({label:'QA VIP',icon:'star',color:'#123456'});await badges.grantBadge({userId:member.id,badgeId:badge.id,grantedBy:owner.id});assert.ok((await badges.listBadges(member.id)).some(b=>b.id===badge.id));
 await badges.ensureBadgeCatalogue();assert.ok(badges.PRIMARY_BADGE_IDS.includes(badge.id));const {capabilitiesOf}=await import('../server/src/services/capabilities.js');assert.equal((await capabilitiesOf(member)).size,0);
 await assert.rejects(badges.deleteCustomBadge('admin'),/custom/);await badges.deleteCustomBadge(badge.id);assert.equal((await badges.listBadges(member.id)).some(b=>b.id===badge.id),false);
});

test('Editing a text message cannot bypass an account image restriction',async()=>{
 const {createMessage,editMessage}=await import('../server/src/services/messages.js');
 await policy(owner.id,{});
 const group=await groups.createGroup({name:'Edit media policy',ownerId:owner.id});
 const channel=(await groups.listChannels(group.id))[0];
 const message=await createMessage({authorId:owner.id,channelId:channel.id,content:'Plain text'});
 await policy(owner.id,{sendImages:false});
 await assert.rejects(editMessage(message.id,'<gif:test>'),/sendImages/);
 assert.equal((await db.get('SELECT content FROM messages WHERE id=?',[message.id])).content,'Plain text');
 await policy(owner.id,{});
});
test('Runtime configuration rejects an invalid patch atomically and preserves blank secrets',async()=>{
 const runtime=await import('../server/src/services/runtimeConfiguration.js');
 const {config}=await import('../server/src/config.js');
 const before=config.livekit.url;
 await assert.rejects(runtime.updateRuntimeConfiguration({'livekit.url':'ws://localhost:18880','livekit.apiUrl':'file:///unsafe'},owner.id),/invalid/);
 assert.equal(config.livekit.url,before);
 assert.equal(await db.get('SELECT * FROM runtime_configuration WHERE key=?',['livekit.url']),null);
 await runtime.updateRuntimeConfiguration({'livekit.apiSecret':'test-secret'},owner.id);
 await runtime.updateRuntimeConfiguration({'livekit.apiSecret':''},owner.id);
 assert.equal(config.livekit.apiSecret,'test-secret');
});

