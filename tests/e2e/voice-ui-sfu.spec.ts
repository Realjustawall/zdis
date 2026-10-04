import {test,expect} from './test-fixtures';
import type {Page} from '@playwright/test';
test.use({launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required']}});

test('Production voice UI sends audio and camera, displays a screen stream, and applies live camera denial',async({browser,baseURL},testInfo)=>{
 test.skip(!process.env.LIVEKIT_URL||testInfo.project.name!=='chromium','Requires local SFU and desktop media controls');
 test.setTimeout(90000);
 const contexts=[];
 for(let i=0;i<2;i++){
  const context=await browser.newContext({baseURL,viewport:{width:1280,height:900},permissions:['microphone','camera','local-network-access']});contexts.push(context);
  await context.addInitScript(()=>{
   localStorage.setItem('zdis.locale','en');
   const w=window as any,Native=w.RTCPeerConnection;w.qaPeers=[];
   w.RTCPeerConnection=class extends Native{constructor(config:any){super(config);w.qaPeers.push(this);}};
   // Generated screen stream exercises the production sharing path without an OS chooser.
   navigator.mediaDevices.getDisplayMedia=async()=>{
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;
    const ctx=canvas.getContext('2d')!;
    const timer=setInterval(()=>{ctx.fillStyle='#23a55a';ctx.fillRect(0,0,640,360);ctx.fillStyle='#fff';ctx.fillText('Screen '+Date.now(),30,50);},50);
    const stream=canvas.captureStream(15);stream.getVideoTracks()[0].addEventListener('ended',()=>clearInterval(timer));
    return stream;
   };
  });
 }
 const [admin,member]=contexts;
 let userId:string|undefined,groupId:string|undefined;
 const login=await admin.request.post('/api/auth/login',{data:{identifier:'admin',password:process.env.SFU_QA_ADMIN_PASSWORD||'cNL2*8o$1F;"'}});
 expect(login.ok()).toBeTruthy();const auth=await login.json(),headers={'x-csrf-token':auth.csrfToken};
 try{
  const username='voiceui'+Date.now(),password='VoiceUI!7482930';
  const added=await admin.request.post('/api/admin/users',{headers,data:{username,email:username+'@example.test',displayName:'Voice UI peer',password,role:'member',mustChangePassword:false}});expect(added.status()).toBe(201);const {user}=await added.json();userId=user.id;
  const created=await admin.request.post('/api/groups',{headers,data:{name:'Voice UI SFU '+Date.now()}});expect(created.status()).toBe(201);const {group,channels}=await created.json();groupId=group.id;
  const voice=channels.find((c:any)=>c.type==='voice');
  expect((await admin.request.post(`/api/groups/${groupId}/members`,{headers,data:{userId}})).status()).toBe(201);
  expect((await member.request.post('/api/auth/login',{data:{identifier:username,password}})).ok()).toBeTruthy();
  const pages=await Promise.all(contexts.map(context=>context.newPage()));
  for(const page of pages){
   await page.goto('/');
   await page.getByTitle(group.name,{exact:true}).click();
   await page.locator('.sidebar').getByText(voice.name,{exact:true}).click();
   await page.getByRole('button',{name:'Join voice',exact:true}).click();
   await expect(page.locator('.voice-controls').getByRole('button',{name:'Disconnect',exact:true})).toBeVisible();
  }
  async function received(page:Page,kind:string){return page.evaluate(async(kind)=>{
   let total=0;
   for(const pc of (window as any).qaPeers){if(pc.connectionState==='closed')continue;(await pc.getStats()).forEach((s:any)=>{if(s.type==='inbound-rtp'&&s.kind===kind)total+=kind==='audio'?(s.bytesReceived||0):(s.framesDecoded||0);});}
   return total;
  },kind);}
  for(const page of pages)await expect.poll(()=>received(page,'audio'),{timeout:15000}).toBeGreaterThan(1000);
  for(const page of pages)await page.getByTitle('Turn camera on',{exact:true}).click();
  for(const page of pages)await expect.poll(()=>received(page,'video'),{timeout:15000}).toBeGreaterThan(5);
  const [a,b]=pages;
  await a.getByTitle('Share your screen',{exact:true}).click();
  await expect(a.getByTitle('Stop sharing',{exact:true})).toBeVisible();
  const screen=b.locator('.voice-tile.screen-share video');
  await expect.poll(()=>screen.count()).toBeGreaterThan(0);
  await expect.poll(()=>screen.first().evaluate((v:HTMLVideoElement)=>v.videoWidth)).toBeGreaterThan(0);
  const before=await screen.first().evaluate((v:HTMLVideoElement)=>v.currentTime);
  await expect.poll(()=>screen.first().evaluate((v:HTMLVideoElement)=>v.currentTime)).toBeGreaterThan(before);
  expect((await admin.request.put(`/api/admin/users/${userId}/access`,{headers,data:{video:false,screenShare:false}})).status()).toBe(200);
  await expect(b.getByTitle('Turn camera on',{exact:true})).toBeVisible();
  await a.getByTitle('Stop sharing',{exact:true}).click();
  await expect(b.locator('.voice-tile.screen-share')).toHaveCount(0);
  await b.locator('.voice-controls').getByRole('button',{name:'Disconnect',exact:true}).click();
  expect((await admin.request.put(`/api/admin/users/${userId}/access`,{headers,data:{speak:false,video:false,screenShare:false}})).status()).toBe(200);
  await b.evaluate(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw new Error('Listen-only must not capture microphone or camera');};});
  await b.getByRole('button',{name:'Join voice',exact:true}).click();
  await expect(b.locator('.voice-controls').getByRole('button',{name:'Disconnect',exact:true})).toBeVisible();
  await expect.poll(()=>received(b,'audio'),{timeout:15000}).toBeGreaterThan(1000);
  for(const page of pages)await page.locator('.voice-controls').getByRole('button',{name:'Disconnect',exact:true}).click();
 }finally{
  for(const context of contexts)for(const page of context.pages())await page.close();
  if(groupId)await admin.request.delete('/api/groups/'+groupId,{headers}).catch(()=>{});
  if(userId)await admin.request.delete('/api/admin/users/'+userId,{headers}).catch(()=>{});
  for(const context of contexts)await context.close();
 }
});

