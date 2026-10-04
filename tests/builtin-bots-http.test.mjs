import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
const {io}=createRequire(new URL('../client/package.json',import.meta.url))('socket.io-client');
const base=process.env.TEST_BASE_URL||'http://localhost:8080';
class Client{
 cookies=new Map();csrf=null;
 async request(method,path,body){
  const headers={cookie:[...this.cookies].map(([key,value])=>`${key}=${value}`).join('; ')};
  if(this.csrf)headers['x-csrf-token']=this.csrf;
  if(body!==undefined&&!(body instanceof FormData))headers['content-type']='application/json';
  const response=await fetch(base+path,{method,headers,body:body instanceof FormData?body:body===undefined?undefined:JSON.stringify(body)});
  for(const value of response.headers.getSetCookie()){const pair=value.split(';')[0],index=pair.indexOf('=');this.cookies.set(pair.slice(0,index),pair.slice(index+1));}
  const bytes=Buffer.from(await response.arrayBuffer());let data;try{data=JSON.parse(bytes.toString());}catch{data=bytes;}
  return {status:response.status,data,bytes,headers:response.headers};
 }
 async ok(method,path,body,status=200){const response=await this.request(method,path,body);assert.equal(response.status,status,`${method} ${path}: ${JSON.stringify(response.data)}`);return response.data;}
 async login(username,password){const result=await this.ok('POST','/api/auth/login',{identifier:username,password});this.csrf=result.csrfToken;return result.user;}
}
const admin=new Client(),member=new Client(),stranger=new Client(),anonymous=new Client();
const suffix=Date.now().toString(36),password='BotHttp!Test7283920';
const users=[];let group,socket,strangerSocket,checks=0;
function checked(label){checks++;console.log('  PASS  '+label);}
try{
 await admin.login(process.env.SEED_ADMIN_EMAIL||'office@intesho.com',process.env.SEED_ADMIN_PASSWORD||'cNL2*8o$1F;"');
 for(const [label,client] of [['member',member],['stranger',stranger]]){
  const username=`bot${label}${suffix}`;
  const {user}=await admin.ok('POST','/api/admin/users',{username,email:username+'@example.test',displayName:label,password,role:'member',mustChangePassword:false},201);
  users.push(user);await client.login(username,password);
 }
 const created=await admin.ok('POST','/api/groups',{name:'Bot HTTP QA '+suffix},201);group=created.group;
 const channel=created.channels.find(c=>c.type==='text'),log=created.channels.find(c=>c.type==='announcement')||channel;
 const path=`/api/builtin-bots/groups/${group.id}`;
 assert.equal((await anonymous.request('GET',path)).status,401);
 const config=await admin.ok('GET',path),settings=structuredClone(config.defaults);
 const {role}=await admin.ok('POST',`/api/groups/${group.id}/roles`,{name:'Gaming',permissions:[]},201);
 settings.welcomer={...settings.welcomer,enabled:true,welcomeChannelId:channel.id,goodbyeChannelId:channel.id,bannerEnabled:false};
 settings.moderator={...settings.moderator,enabled:true,logChannelId:log.id,blockedWords:['zdis_forbidden_token'],levelingEnabled:true,ticketsEnabled:true,selfRoleIds:[role.id],responses:[{trigger:'hello bot',response:'Hello {mention}!',exact:true}]};
 assert.equal((await admin.request('PUT',path,{settings:{...settings,welcomer:{...settings.welcomer,bannerColor:'invalid'}},revision:0})).status,400);
 const saved=await admin.ok('PUT',path,{settings,revision:0});assert.equal(saved.revision,1);
 assert.equal((await admin.request('PUT',path,{settings,revision:0})).status,409);checked('HTTP authentication, validation, persistence and stale revision protection');
 socket=io(base,{transports:['websocket'],extraHeaders:{cookie:[...admin.cookies].map(([key,value])=>`${key}=${value}`).join('; ')},reconnection:false});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Socket connection timeout')),6000);socket.once('ready',()=>{clearTimeout(timer);resolve();});socket.once('connect_error',error=>{clearTimeout(timer);reject(error);});});
 const welcome=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Welcome realtime delivery timeout')),6000);const listener=payload=>{if(payload.message?.content?.includes('@'+users[0].username)){clearTimeout(timer);socket.off('message:created',listener);resolve(payload.message);}};socket.on('message:created',listener);});
 await admin.ok('POST',`/api/groups/${group.id}/members`,{userId:users[0].id},201);
 const message=await welcome;assert.ok(message.author.badges.some(badge=>badge.id==='bot'));assert.ok(message.author.badges.some(badge=>badge.id==='verified_bot'));checked('Actual welcome message broadcasts over WebSocket with BOT and green verification badges');
 assert.equal((await member.request('GET',path)).status,403);
 assert.equal((await stranger.request('GET',path+'/status')).status,404);
 const preview=await admin.request('POST',path+'/preview',{settings,kind:'join'});assert.equal(preview.status,200);assert.equal(preview.bytes.subarray(1,4).toString(),'PNG');checked('Real PNG preview and server-management access checks');
 const messagesPath=`/api/channels/${channel.id}/messages`;
 assert.equal((await member.request('POST',messagesPath,{content:'zdis_forbidden_token'})).status,403);
 const posted=await member.ok('POST',messagesPath,{content:'hello bot'},201);
 assert.equal((await member.request('PATCH',`${messagesPath}/${posted.message.id}`,{content:'zdis_forbidden_token'})).status,403);
 const history=await member.ok('GET',messagesPath);assert.ok(history.messages.some(item=>item.content==='Hello @'+users[0].username+'!'));
 assert.ok((await member.ok('GET',path+'/leaderboard')).members.some(item=>item.user_id===users[0].id&&Number(item.xp)>0));checked('Member AutoMod, edit protection, automated response and real XP');
 const selected=await member.ok('POST',path+'/self-roles',{roleId:role.id});assert.equal(selected.roles[0].assigned,true);
 assert.equal((await member.ok('POST',path+'/self-roles',{roleId:role.id,remove:true})).roles[0].assigned,false);checked('Self-role selection and removal through authenticated HTTP');
 await admin.ok('POST',`/api/groups/${group.id}/members`,{userId:users[1].id},201);
 strangerSocket=io(base,{transports:['websocket'],extraHeaders:{cookie:[...stranger.cookies].map(([key,value])=>`${key}=${value}`).join('; ')},reconnection:false});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Stranger socket connection timeout')),6000);strangerSocket.once('ready',()=>{clearTimeout(timer);resolve();});strangerSocket.once('connect_error',error=>{clearTimeout(timer);reject(error);});});
 let privateChannelLeaked=false;strangerSocket.on('channel:created',payload=>{if(payload.channel?.name?.startsWith('ticket-'))privateChannelLeaked=true;});
 const concurrentTickets=await Promise.all(Array.from({length:20},()=>member.ok('POST',path+'/tickets',{topic:'Private account support request'},201)));
 assert.equal(new Set(concurrentTickets.map(result=>result.ticket.id)).size,1);const {ticket}=concurrentTickets[0];
 assert.equal((await member.ok('POST',path+'/tickets',{topic:'Repeated request'},201)).ticket.id,ticket.id);
 assert.equal((await stranger.ok('GET',path+'/tickets')).tickets.length,0);
 assert.ok([403,404].includes((await stranger.request('GET',path+`/tickets/${ticket.id}/transcript`)).status));
 const transcript=await member.request('GET',path+`/tickets/${ticket.id}/transcript`);assert.equal(transcript.status,200);assert.match(transcript.bytes.toString(),/Private account support request/);
 assert.equal(privateChannelLeaked,false,'Private ticket metadata leaked over WebSocket');
 await member.ok('PATCH',path+`/tickets/${ticket.id}`,{action:'close'});
 assert.equal((await member.request('POST',`/api/channels/${ticket.channel_id}/messages`,{content:'Should be closed'})).status,403);
 await admin.ok('PATCH',path+`/tickets/${ticket.id}`,{action:'reopen'});
 await member.ok('POST',`/api/channels/${ticket.channel_id}/messages`,{content:'Reopened successfully'},201);checked('Private tickets, duplicate prevention, transcript privacy, close and reopen');
 const bytes=await fs.readFile(new URL('../client/public/media-presets/gifs/hello.gif',import.meta.url)),form=new FormData();form.append('file',new Blob([bytes],{type:'image/gif'}),'custom.gif');
 const upload=await admin.ok('POST','/api/files',form,201);
 await admin.ok('POST',`/api/groups/${group.id}/expressions`,{name:'custom_gif',type:'gif',attachmentId:upload.attachment.id},201);
 await member.ok('POST',messagesPath,{content:`<gif:custom_gif:${upload.attachment.id}>`},201);
 assert.equal((await member.request('GET',`/api/files/${upload.attachment.id}`)).status,200);checked('Actual custom GIF upload, expression creation, message and authorised file delivery');
 await admin.ok('POST',path+'/actions',{action:'timeout',userId:users[0].id,durationSeconds:60});
 assert.equal((await member.request('POST',messagesPath,{content:'Timed out'})).status,403);
 await admin.ok('POST',path+'/actions',{action:'untimeout',userId:users[0].id});
 await member.ok('POST',messagesPath,{content:'Timeout removed'},201);checked('Moderator timeout and removal affect the real send-message route');
 console.log(`${checks} bot HTTP/realtime scenarios passed`);
}finally{
 socket?.disconnect();strangerSocket?.disconnect();
 if(group)await admin.request('DELETE',`/api/groups/${group.id}`);
 for(const user of users)await admin.request('DELETE',`/api/admin/users/${user.id}`);
}
