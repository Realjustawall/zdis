import {test,expect} from './test-fixtures';
import {createRequire} from 'node:module';
import path from 'node:path';
import {RoomServiceClient} from 'livekit-server-sdk';
const require=createRequire(path.resolve('client/package.json'));
const {io}=require('socket.io-client');
test.use({bypassCSP:true,permissions:['local-network-access']});
test('Private SFU calls enforce listener grants, live media revocation and block checks',async({browser,context,page})=>{
 test.skip(!process.env.LIVEKIT_URL,'Requires local LiveKit; see docs/PERMISSIONS.md');
 test.setTimeout(90000);
 const base='http://127.0.0.1:'+(process.env.TEST_E2E_PORT||'18081');
 const login=await context.request.post(base+'/api/auth/login',{data:{identifier:'admin',password:process.env.SFU_QA_ADMIN_PASSWORD||'cNL2*8o$1F;"'}});expect(login.ok()).toBeTruthy();const auth=await login.json(),headers={'x-csrf-token':auth.csrfToken};
 const username='sfuperm'+Date.now(),password='SFU!Permission7283920';const added=await context.request.post(base+'/api/admin/users',{headers,data:{username,email:username+'@example.test',displayName:'SFU member',password,role:'member',mustChangePassword:false}});expect(added.status()).toBe(201);const {user}=await added.json();
 const created=await context.request.post(base+'/api/groups',{headers,data:{name:'SFU media permission QA'}});expect(created.status()).toBe(201);const {group,channels}=await created.json(),unusedChannel=channels.find((c:any)=>c.type==='voice');
 const dm=await context.request.post(base+'/api/conversations/dm',{headers,data:{userId:user.id}});expect(dm.status()).toBe(201);const {conversation}=await dm.json();const channel={id:'dm:'+conversation.id};
 const memberContext=await browser.newContext({bypassCSP:true,permissions:['local-network-access']}),memberPage=await memberContext.newPage();let ownerSocket:any,memberSocket:any;
 const service=new RoomServiceClient(process.env.LIVEKIT_API_URL||process.env.LIVEKIT_URL!,process.env.LIVEKIT_API_KEY!,process.env.LIVEKIT_API_SECRET!);
 try{
  expect((await context.request.post(base+`/api/groups/${group.id}/members`,{headers,data:{userId:user.id}})).status()).toBe(201);
  expect((await context.request.put(base+`/api/admin/users/${user.id}/access`,{headers,data:{speak:false,screenShare:false,video:true}})).status()).toBe(200);
  const memberLogin=await memberContext.request.post(base+'/api/auth/login',{data:{identifier:username,password}});expect(memberLogin.ok()).toBeTruthy();const memberAuth=await memberLogin.json(),memberHeaders={'x-csrf-token':memberAuth.csrfToken};
  const ownerToken=await context.request.post(base+`/api/voice/direct/${conversation.id}/token`,{headers,data:{}}),memberToken=await memberContext.request.post(base+`/api/voice/direct/${conversation.id}/token`,{headers:memberHeaders,data:{}});expect(ownerToken.status()).toBe(200);expect(memberToken.status()).toBe(200);const ownerCredentials=await ownerToken.json(),memberCredentials=await memberToken.json();expect(memberCredentials).toMatchObject({canSpeak:false,canUseVideo:true,canScreenShare:false});
  async function register(ctx:any){const cookie=(await ctx.cookies()).map((c:any)=>c.name+'='+c.value).join('; ');const socket=io(base,{transports:['websocket'],extraHeaders:{cookie},reconnection:false});await new Promise<void>((resolve,reject)=>{const t=setTimeout(()=>reject(Error('socket timeout')),8000);socket.once('ready',()=>{clearTimeout(t);resolve();});socket.once('connect_error',reject);});const ack:any=await new Promise(resolve=>socket.emit('voice:join',{channelId:channel.id,sfu:true},resolve));expect(ack.ok).toBeTruthy();return socket;}
  ownerSocket=await register(context);memberSocket=await register(memberContext);
  for(const [target,credentials]of [[page,ownerCredentials],[memberPage,memberCredentials]] as const){
   await target.goto(base);
   const capturePermissions=await target.evaluate(async()=>Promise.all(['microphone','camera'].map(async name=>(await navigator.permissions.query({name:name as PermissionName})).state)));
   expect(capturePermissions).not.toContain('granted');
   await target.evaluate(()=>{const w=window as any,Native=w.RTCPeerConnection;w.qaPcs=[];w.qaSnapshots=[];w.RTCPeerConnection=class extends Native{constructor(config:any){super(config);w.qaPcs.push(this);const timer=setInterval(async()=>{if(this.connectionState==='closed'){clearInterval(timer);return;}const entries:any[]=[];(await this.getStats()).forEach((s:any)=>{if(['candidate-pair','local-candidate','remote-candidate'].includes(s.type))entries.push(s);});w.qaSnapshots.push({connection:this.connectionState,ice:this.iceConnectionState,entries});w.qaSnapshots=w.qaSnapshots.slice(-3);},500);}};});
   await target.addScriptTag({path:require.resolve('livekit-client')});
   try{await target.evaluate(async(c)=>{const w=window as any;w.qaRoom=new w.LivekitClient.Room();await w.qaRoom.connect(c.url,c.token);w.qaSources=w.LivekitClient.Track.Source;},credentials);}
   catch(error){console.error('SFU ICE diagnostics:',JSON.stringify(await target.evaluate(()=>(window as any).qaSnapshots.map((s:any)=>({connection:s.connection,ice:s.ice,pairs:s.entries.filter((e:any)=>e.type==='candidate-pair').map((e:any)=>({state:e.state,requestsSent:e.requestsSent,responsesReceived:e.responsesReceived,bytesReceived:e.bytesReceived}))})))));throw error;}
  }
  await page.evaluate(async()=>{const w=window as any,room=w.qaRoom;w.qaAudio=new AudioContext();const dest=w.qaAudio.createMediaStreamDestination(),osc=w.qaAudio.createOscillator();osc.connect(dest);osc.start();await w.qaAudio.resume();await room.localParticipant.publishTrack(dest.stream.getAudioTracks()[0],{source:w.qaSources.Microphone});for(const source of [w.qaSources.Camera,w.qaSources.ScreenShare]){const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;const ctx=canvas.getContext('2d')!;const interval=setInterval(()=>{ctx.fillStyle='hsl('+Date.now()%360+',70%,50%)';ctx.fillRect(0,0,320,180);},50);(w.qaTimers??=[]).push(interval);await room.localParticipant.publishTrack(canvas.captureStream(15).getVideoTracks()[0],{source});}});
  await expect.poll(()=>memberPage.evaluate(()=>(window as any).qaRoom.remoteParticipants.values().next().value?.trackPublications.size||0)).toBe(3);
  await expect.poll(()=>memberPage.evaluate(async()=>{
   const w=window as any,delivered=new Map();
   for(const participant of w.qaRoom.remoteParticipants.values())for(const pub of participant.trackPublications.values()){
    if(!pub.track)continue;
    let bytes=0,frames=0;
    (await pub.track.getRTCStatsReport())?.forEach((s:any)=>{if(s.type==='inbound-rtp'){bytes+=s.bytesReceived||0;frames+=s.framesDecoded||0;}});
    delivered.set(pub.source,bytes>0&&(pub.source===w.qaSources.Microphone||frames>0));
   }
   return [w.qaSources.Microphone,w.qaSources.Camera,w.qaSources.ScreenShare].map(source=>delivered.get(source)===true);
  })).toEqual([true,true,true]);
  const denied=await memberPage.evaluate(async()=>{const w=window as any;const audio=new AudioContext(),dest=audio.createMediaStreamDestination();let blocked=false;try{await w.qaRoom.localParticipant.publishTrack(dest.stream.getAudioTracks()[0],{source:w.qaSources.Microphone});}catch{blocked=true;}await audio.close();return blocked;});expect(denied).toBeTruthy();
  await memberPage.evaluate(async()=>{const w=window as any;const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;const ctx=canvas.getContext('2d')!;w.qaTimer=setInterval(()=>{ctx.fillStyle='#5865f2';ctx.fillRect(0,0,320,180);},50);await w.qaRoom.localParticipant.publishTrack(canvas.captureStream(15).getVideoTracks()[0],{source:w.qaSources.Camera});});
  await expect.poll(async()=>{const participants=await service.listParticipants('direct-'+conversation.id);return participants.find(p=>p.identity===user.id)?.tracks.some(t=>t.source===1)||false;}).toBeTruthy();
  expect((await context.request.put(base+`/api/admin/users/${user.id}/access`,{headers,data:{speak:true,video:false,screenShare:false}})).status()).toBe(200);
  await expect.poll(async()=>{const participants=await service.listParticipants('direct-'+conversation.id);return participants.find(p=>p.identity===user.id)?.permission?.canPublishSources;}).toEqual([2]);
  await expect.poll(async()=>{const participants=await service.listParticipants('direct-'+conversation.id);return participants.find(p=>p.identity===user.id)?.tracks.some(t=>t.source===1)||false;}).toBeFalsy();
  expect((await context.request.put(base+`/api/admin/users/${user.id}/access`,{headers,data:{connectVoice:false}})).status()).toBe(200);
  await expect.poll(async()=>(await service.listParticipants('direct-'+conversation.id)).some(p=>p.identity===user.id)).toBeFalsy();
  expect((await context.request.post(base+`/api/users/${user.id}/block`,{headers,data:{}})).status()).toBe(200);
  expect((await context.request.post(base+`/api/voice/direct/${conversation.id}/token`,{headers,data:{}})).status()).toBe(403);
 }finally{ownerSocket?.disconnect();memberSocket?.disconnect();for(const target of [page,memberPage])await target.evaluate(()=>{const w=window as any;w.qaRoom?.disconnect();w.qaAudio?.close();for(const id of w.qaTimers||[])clearInterval(id);clearInterval(w.qaTimer);}).catch(()=>{});await memberContext.close();await context.request.delete(base+'/api/groups/'+group.id,{headers});await context.request.delete(base+'/api/admin/users/'+user.id,{headers});await service.deleteRoom('direct-'+conversation.id).catch(()=>{});}
});

