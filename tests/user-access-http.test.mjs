import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {io}=createRequire(new URL('../client/package.json',import.meta.url))('socket.io-client');
const base=process.env.TEST_BASE_URL||'http://localhost:18080';
class Client{
 cookies=new Map();csrf=null;
 async request(method,path,body){const headers={cookie:[...this.cookies].map(([k,v])=>k+'='+v).join('; ')};if(this.csrf)headers['x-csrf-token']=this.csrf;if(body!==undefined&&!(body instanceof FormData))headers['content-type']='application/json';const response=await fetch(base+path,{method,headers,body:body instanceof FormData?body:body===undefined?undefined:JSON.stringify(body)});for(const value of response.headers.getSetCookie()){const pair=value.split(';')[0],i=pair.indexOf('=');this.cookies.set(pair.slice(0,i),pair.slice(i+1));}return {status:response.status,data:await response.json()};}
 async ok(method,path,body,status=200){const r=await this.request(method,path,body);assert.equal(r.status,status,JSON.stringify(r.data));return r.data;}
 async login(identifier,password){const a=await this.ok('POST','/api/auth/login',{identifier,password});this.csrf=a.csrfToken;}
}
const admin=new Client(),member=new Client();let user,group,restrictedGroup,badge,socket;let checks=0;
function pass(message){checks++;console.log('  PASS  '+message);}
try{
 await admin.login(process.env.SEED_ADMIN_EMAIL||'office@intesho.com',process.env.SEED_ADMIN_PASSWORD||'cNL2*8o$1F;"');
 const username='accesshttp'+Date.now().toString(36),password='AccessHttp!7382930';({user}=await admin.ok('POST','/api/admin/users',{username,email:username+'@example.test',displayName:'Access HTTP',password,role:'member',mustChangePassword:false},201));await member.login(username,password);
 const defaults=await admin.ok('GET',`/api/admin/users/${user.id}/access`);assert.equal(defaults.defaults.maxOwnedGroups,10);assert.equal(defaults.defaults.maxJoinedGroups,50);
 assert.equal((await member.request('PUT',`/api/admin/users/${user.id}/access`,{sendImages:true})).status,403);assert.equal((await admin.request('PUT',`/api/admin/users/${user.id}/access`,{speak:'yes'})).status,400);assert.equal((await admin.request('PUT',`/api/admin/users/${user.id}/access`,{maxOwnedGroups:-1})).status,400);pass('Admin-only access policy API validates types and quotas');
 await admin.ok('PUT',`/api/admin/users/${user.id}/access`,{maxOwnedGroups:0});assert.equal((await member.request('POST','/api/groups',{name:'Forbidden group'})).status,403);await admin.ok('PUT',`/api/admin/users/${user.id}/access`,{maxOwnedGroups:1,maxCreatedChannels:2});
 ({group}=await member.ok('POST','/api/groups',{name:'Access HTTP QA'},201));assert.equal((await member.request('POST','/api/groups',{name:'Second denied'})).status,403);pass('Real group creation honors per-user zero and one limits');
 const created=await Promise.all(Array.from({length:8},(_,i)=>member.request('POST',`/api/groups/${group.id}/channels`,{name:'concurrent-'+i})));assert.equal(created.filter(r=>r.status===201).length,2);assert.equal(created.filter(r=>r.status===403).length,6);pass('Eight concurrent HTTP channel creations cannot exceed quota two');
 const channels=(await member.ok('GET',`/api/groups/${group.id}`)).channels;const text=channels.find(c=>c.type==='text'),voice=channels.find(c=>c.type==='voice');
 await admin.ok('PUT',`/api/admin/users/${user.id}/access`,{sendImages:false,connectVoice:false});
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8X8AAAAASUVORK5CYII=','base64');const form=new FormData();form.append('file',new Blob([png],{type:'image/png'}),'image.png');assert.equal((await member.request('POST','/api/files',form)).status,403);pass('Image upload forbidden by account policy even for server owner');
 socket=io(base,{transports:['websocket'],extraHeaders:{cookie:[...member.cookies].map(([k,v])=>k+'='+v).join('; ')},reconnection:false});await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('socket timeout')),6000);socket.once('ready',()=>{clearTimeout(t);resolve();});socket.once('connect_error',reject);});
 let ack=await new Promise(resolve=>socket.emit('voice:join',{channelId:voice.id},resolve));assert.equal(ack.ok,false);await admin.ok('PUT',`/api/admin/users/${user.id}/access`,{speak:false});ack=await new Promise(resolve=>socket.emit('voice:join',{channelId:voice.id},resolve));assert.equal(ack.ok,false);assert.match(ack.error,/LiveKit/);pass('WebSocket enforces voice join denial and prevents restricted P2P publication');
 await admin.ok('PUT',`/api/admin/users/${user.id}/access`,{});
 const restricted=await admin.ok('POST','/api/groups',{name:'Role permissions QA'},201);restrictedGroup=restricted.group;
 await admin.ok('POST',`/api/groups/${restrictedGroup.id}/members`,{userId:user.id},201);
 assert.equal((await member.request('POST',`/api/groups/${restrictedGroup.id}/channels`,{name:'Forbidden channel'})).status,403);
 const {channel:privateChannel}=await admin.ok('POST',`/api/groups/${restrictedGroup.id}/channels`,{name:'private-role-channel',isPrivate:true},201);
 const {role}=await admin.ok('POST',`/api/groups/${restrictedGroup.id}/roles`,{name:'Reader',permissions:[]},201);
 await admin.ok('PUT',`/api/groups/${restrictedGroup.id}/channels/${privateChannel.id}/overrides`,{targetType:'role',targetId:role.id,allow:['viewChannel','readMessageHistory'],deny:[]});
 await admin.ok('PUT',`/api/groups/${restrictedGroup.id}/members/${user.id}/roles/${role.id}`,{granted:true});
 assert.ok((await member.ok('GET',`/api/groups/${restrictedGroup.id}`)).channels.some(c=>c.id===privateChannel.id));
 const marker='hidden_search_'+Date.now();await admin.ok('POST',`/api/channels/${privateChannel.id}/messages`,{content:marker},201);
 await admin.ok('PUT',`/api/groups/${restrictedGroup.id}/channels/${privateChannel.id}/overrides`,{targetType:'member',targetId:user.id,allow:[],deny:['viewChannel']});
 assert.equal((await member.ok('GET',`/api/groups/${restrictedGroup.id}`)).channels.some(c=>c.id===privateChannel.id),false);
 assert.equal((await member.request('GET',`/api/channels/${privateChannel.id}/messages`)).status,404);
  assert.equal((await member.ok('GET','/api/search?q='+marker)).messages.some(m=>m.content===marker),false);
 pass('Role unlocks private channel; member deny wins and blocks direct reads and global search');
 ({badge}=await admin.ok('POST','/api/admin/badges',{label:'Custom HTTP',icon:'star',color:'#123456'},201));await admin.ok('PUT',`/api/admin/users/${user.id}/badges`,{badgeIds:[badge.id]});const me=await member.ok('GET','/api/auth/me');assert.ok(me.user.badges.some(b=>b.id===badge.id));assert.equal((await member.request('GET','/api/admin/settings')).status,403);await admin.ok('DELETE',`/api/admin/badges/${badge.id}`);assert.equal((await member.ok('GET','/api/auth/me')).user.badges.some(b=>b.id===badge.id),false);badge=null;pass('Custom badge creation, grant, display and deletion do not grant administrator access');
 console.log(`\nUser access HTTP: ${checks} passed`);
}finally{socket?.disconnect();if(restrictedGroup)await admin.request('DELETE',`/api/groups/${restrictedGroup.id}`);if(group)await admin.request('DELETE',`/api/groups/${group.id}`);if(badge)await admin.request('DELETE',`/api/admin/badges/${badge.id}`);if(user)await admin.request('DELETE',`/api/admin/users/${user.id}`);}
